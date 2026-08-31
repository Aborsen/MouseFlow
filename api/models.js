/* Which models this deployment can actually reach, asked of the providers themselves.
 *
 * The allowlist in api/_provider.js was written from memory, which is exactly how a wrong model id ships and
 * fails at the first real request. This route asks each provider for its own list and returns the ids that
 * look like current chat models, so the allowlist can be set from fact.
 *
 * Session-required, because it proves which keys this deployment holds - a fact worth knowing but not worth
 * publishing. It spends nothing: /models is not a completion.
 *
 * A diagnostic, not part of the product. It exists because "gpt-5.6-luna or gpt-5.6 or 5.6-luna?" is not a
 * question to answer by trying one in production.
 */
/* WRITER_MODELS тоже: это модели, которые развёртывание ЗОВЁТ, не предлагая в меню (сейчас - писатель
 * документов). Без них проверка досягаемости молчала ровно про то, из-за чего документ мог не написаться. */
import { keyFor, MODELS, PROVIDERS, WRITER_MODELS } from './_provider.js';
import { whoIsCalling } from './_session.js';
/* Server-side crashes reach Sentry from here. See api/_report.js — no dependency, and it
 * deliberately sends the route and the message, never the query string or the body. */
import { report, wrap } from './_report.js';

const UPSTREAM = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/models?limit=200',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    ids: (body) => (body.data || []).map((m) => m.id),
  },
  openai: {
    url: 'https://api.openai.com/v1/models',
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    ids: (body) => (body.data || []).map((m) => m.id),
  },
};

async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: { message: 'GET' } });
    return;
  }

  const who = await whoIsCalling(req);
  if (!who) {
    res.status(401).json({ ok: false, error: { message: 'sign in first' } });
    return;
  }

  const out = {};
  for (const provider of PROVIDERS) {
    const key = keyFor(provider);
    if (!key) {
      out[provider] = { hasKey: false, allowlisted: MODELS[provider], writers: WRITER_MODELS[provider] || [],
        upstream: null, note: 'no key on this deployment' };
      continue;
    }
    const spec = UPSTREAM[provider];
    try {
      const upstream = await fetch(spec.url, { headers: spec.headers(key) });
      const text = await upstream.text();
      if (!upstream.ok) {
        let detail = text.slice(0, 300);
        try { detail = JSON.parse(text).error?.message || detail; } catch (_) { /* raw text it is */ }
        out[provider] = { hasKey: true, allowlisted: MODELS[provider], upstream: null, note: `${upstream.status}: ${detail}` };
        continue;
      }
      const ids = spec.ids(JSON.parse(text));
      out[provider] = {
        hasKey: true,
        allowlisted: MODELS[provider],
        /* Everything, so a name that does not match the guessed pattern is still visible - the whole point
         * is to stop guessing. Sorted, because a list of 80 ids is only useful if it reads in order. */
        upstream: ids.sort(),
        // And the subset that looks like a current chat model, which is what an allowlist wants.
        likely: ids.filter((id) => /^(gpt-[5-9]|o[1-9]|claude-)/.test(id) && !/audio|realtime|image|tts|whisper|embedding|moderation/.test(id)).sort(),
        reachable: MODELS[provider].filter((id) => ids.includes(id)),
        missing: MODELS[provider].filter((id) => !ids.includes(id)),
        /* НЕ В МЕНЮ, НО ЗОВЁТСЯ - и потому проверяется отдельно и называется отдельно. Живой отчёт:
         * документ не написался, ответ модели пересказал причину общими словами, и первое, что нужно было
         * знать, - есть ли эта модель на ключе вообще. Теперь это видно здесь. */
        writers: (WRITER_MODELS[provider] || []).map((id) => ({
          id,
          reachable: ids.includes(id),
          usedFor: 'process documents',
        })),
      };
    } catch (err) {
      out[provider] = { hasKey: true, allowlisted: MODELS[provider], upstream: null, note: String(err && err.message) };
    }
  }

  res.status(200).json({ ok: true, providers: out });
}

/* The outer net: anything thrown before or around the handler's own try block. */
export default wrap(handler, 'models');
