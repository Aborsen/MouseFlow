/* One account, one set of flows and runs, wherever you are looking from.
 *
 *   GET    /api/sync              your flows and your recent runs
 *   POST   /api/sync              push flows and runs (upsert)
 *   POST   /api/sync?issue=1      mint a device token, shown once  (session only)
 *   GET    /api/sync?tokens=1     list your paired devices          (session only)
 *   DELETE /api/sync?token=<id>   revoke one                        (session only)
 *
 * The extension holds skills in its own storage and the page holds its own; neither can see the
 * other, because a page and an extension are separate origins with separate storage. That is a
 * browser guarantee, not an oversight - so the only place they can meet is an account.
 *
 * A flow carries the half it came from: `web` from the extension, which points at page elements, and
 * `desktop` from the local agent, which points at screen coordinates. Both sync, both are returned to
 * both clients, and each client offers Run only on the ones it can actually replay.
 *
 * Everything here is private to its owner. Nothing is served without a session or a device token
 * that identifies one, and there is no route that lists another user's anything. Publishing to the
 * gallery stays a separate, deliberate act; see api/gallery.js.
 *
 * Minting a token requires a SESSION specifically, not a device token. A device that could mint
 * another device would turn one leaked token into permanent access, and revoking the one you knew
 * about would achieve nothing.
 */

import { neon } from '@neondatabase/serverless';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { whoIsCalling, hashToken, DEVICE_TOKEN_PREFIX } from './_session.js';
/* Server-side crashes reach Sentry from here. See api/_report.js — no dependency, and it
 * deliberately sends the route and the message, never the query string or the body. */
import { report, wrap } from './_report.js';

const FLOWS_MAX = 300;        // per push
const RUNS_MAX = 100;
const RUNS_RETURNED = 60;
/* СКОЛЬКО МОЖЕТ ВЕСИТЬ ОДНА ЗАПИСЬ, и почему прежнее число было не потолком, а обрывом.
 *
 * Было 400_000 без объяснения. Человек записал полтора часа работы - 34 722 события, 525 кликов, 2098КБ, -
 * и запись не уехала никуда: push отказал, транскрипт строится на сервере, а сервер её не видел, поэтому
 * панель сказала «no recording with that id on this account». Час работы остался в браузере и не читался.
 *
 * Полтора часа - это не злоупотребление, это ровно то, что продукт предлагает делать: «нажмите стоп, когда
 * задача закончена». Потолок, который режет обычное использование, - не защита, а поломка.
 *
 * Число взято из измерений, а не из головы. На живом аккаунте 2098КБ / 92 минуты ≈ 23КБ в минуту, значит:
 *   час      ≈ 1.4МБ
 *   три часа ≈ 4.1МБ
 *   шесть    ≈ 8МБ
 * Восемь мегабайт - это запись длиннее рабочего дня; дальше упирается сам рекордер, а не это число.
 *
 * ПОЧЕМУ ЭТО НЕ ЛОМАЕТ ЗАПРОС. У платформы тело ограничено 4.5МБ, и 8МБ JSON туда бы не влезли. Поэтому
 * рядом появился `payloadZ`: события мыши сжимаются примерно в десять раз (замерено на настоящих записях
 * аккаунта - 381КБ → 35КБ, 125КБ → 13КБ), так что шестичасовая запись едет мегабайтом. Проверяется всегда
 * РАЗВЁРНУТЫЙ размер: сжатие меняет цену перевозки, а не то, сколько места это займёт у нас. */
export const PAYLOAD_MAX_BYTES = 8_000_000;

/* Столько же плюс запас - предел, до которого вообще разворачивается присланное. Стоит ОТДЕЛЬНО от
 * проверки выше и раньше неё: проверять размер после распаковки значит сперва распаковать, а «сжатые
 * несколько килобайт, которые разворачиваются в гигабайт» - это не гипотеза, это стандартный приём.
 * gunzipSync с maxOutputLength обрывает такое на пороге, а не в памяти. */
const INFLATE_MAX_BYTES = PAYLOAD_MAX_BYTES + 64_000;

/** Развёрнутый payload, или null с причиной. Ничего не бросает: отказ - это строка для пользователя. */
export function inflatePayload(said) {
  if (typeof said !== 'string' || !said) return { why: 'the compressed payload was not a string' };
  let raw;
  try {
    raw = gunzipSync(Buffer.from(said, 'base64'), { maxOutputLength: INFLATE_MAX_BYTES });
  } catch (err) {
    /* И «не gzip», и «больше потолка» приходят сюда одинаково, поэтому причина называется по размеру
     * присланного, а не по тексту ошибки zlib, который читателю ничего не говорит. */
    return { why: 'the compressed payload could not be read, or unpacks to more than '
      + Math.round(PAYLOAD_MAX_BYTES / 1024) + 'KB' };
  }
  const text = raw.toString('utf8');
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object') return { why: 'the compressed payload was not an object' };
    return { value, encoded: text };
  } catch (_) {
    return { why: 'the compressed payload was not valid JSON' };
  }
}

function cors(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin',
    /^chrome-extension:\/\//.test(origin) ? origin : 'https://mouse-agent.vercel.app');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  /* No Allow-Credentials, as everywhere else here: the page is same-origin so CORS does not apply to
   * it, and the extension sends an explicit header. Not setting it is what stops a cross-site page
   * spending someone's session. */
  res.setHeader('Access-Control-Max-Age', '86400');
}

const fail = (res, status, message) =>
  res.status(status).json({ error: { type: 'sync_error', message } });

const text = (value, max) => (value == null ? null : String(value).slice(0, max));

async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!process.env.DATABASE_URL) return fail(res, 503, 'This deployment has no database configured.');

  const sql = neon(process.env.DATABASE_URL);
  const query = req.query || {};

  let who;
  try {
    who = await whoIsCalling(req, sql);
  } catch (err) {
    await report(err, req, { route: 'sync' });
    return fail(res, 500, 'could not check who is calling: ' + err.message);
  }
  if (!who) {
    return fail(res, 401, 'sign in on the web app, or pair this extension with a device token');
  }

  try {
    if (query.issue) {
      if (who.via !== 'session') return fail(res, 403, 'only a signed-in browser can pair a device');
      return await issueToken(req, res, sql, who);
    }
    if (query.tokens) {
      if (who.via !== 'session') return fail(res, 403, 'only a signed-in browser can list devices');
      return await listTokens(res, sql, who);
    }
    if (req.method === 'DELETE') {
      if (who.via !== 'session') return fail(res, 403, 'only a signed-in browser can revoke a device');
      return await revokeToken(req, res, sql, who);
    }
    /* ОДИН PAYLOAD, ПО ПРОСЬБЕ. Список их больше не везёт (см. pull), а нужны они там, где с записью
     * действительно что-то делают: забирают в браузер, переименовывают, публикуют, открывают. Все эти
     * случаи - действие человека, а не открытие страницы, и лишний запрос там незаметен. */
    if (req.method === 'GET' && query.flow) return await onePayload(res, sql, who, query.flow);
    if (req.method === 'GET') return await pull(res, sql, who);
    if (req.method === 'PATCH') return await setPref(req, res, sql, who);
    if (req.method === 'POST') return await push(req, res, sql, who);
    return fail(res, 405, 'GET, POST or DELETE');
  } catch (err) {
    await report(err, req, { route: 'sync' });
    return fail(res, 500, err.message);
  }
}

/* ------------------------------------------------------------------ pairing a device */

async function issueToken(req, res, sql, who) {
  const label = text((req.body && req.body.label) || 'Chrome extension', 60);
  /* 32 bytes, which is not a number anyone guesses. Shown once and never stored: only its hash goes
   * in the table, so this response is the single moment the token exists in readable form. */
  const token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const id = 'dev_' + randomBytes(6).toString('hex');

  await sql`
    insert into device_token (id, user_id, token_hash, label)
    values (${id}, ${who.id}, ${hashToken(token)}, ${label})
  `;
  return res.status(201).json({
    ok: true,
    token,
    device: { id, label, createdAt: new Date().toISOString() },
    note: 'This is shown once. Paste it into the extension under Skills.',
  });
}

/* One preference, written by the person it belongs to.
 *
 * Deliberately narrow: a key and a short string, both bounded. This is a place for "the tour has been
 * seen", not a general store somebody can put a megabyte in. */
async function setPref(req, res, sql, who) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const key = String(body.key || '').slice(0, 60);
  const value = String(body.value == null ? '' : body.value).slice(0, 200);
  if (!/^[a-z0-9_.-]+$/i.test(key)) return fail(res, 400, 'which preference?');
  await sql`
    insert into user_pref (user_id, key, value) values (${who.id}, ${key}, ${value})
    on conflict (user_id, key) do update set value = excluded.value, updated_at = now()
  `;
  return res.status(200).json({ ok: true });
}

async function listTokens(res, sql, who) {
  const rows = await sql`
    select id, label, created_at, last_used_at from device_token
    where user_id = ${who.id} and revoked_at is null
    order by created_at desc limit 20
  `;
  return res.status(200).json({
    ok: true,
    devices: rows.map((r) => ({
      id: r.id, label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at,
    })),
    you: { name: who.name, image: who.image },
  });
}

async function revokeToken(req, res, sql, who) {
  const id = String((req.query && req.query.token) || '');
  if (!id) return fail(res, 400, 'which device?');
  // The owner check is inside the WHERE clause so no code path can forget it.
  const rows = await sql`
    update device_token set revoked_at = now()
    where id = ${id} and user_id = ${who.id} and revoked_at is null
    returning id
  `;
  if (!rows.length) return fail(res, 404, 'not your device, or already revoked');
  return res.status(200).json({ ok: true, revoked: id });
}

/* ----------------------------------------------------------------------- reading */

async function pull(res, sql, who) {
  /* СОБЫТИЯ НЕ ЕДУТ В СПИСКЕ, и это разница между 3.2МБ и 8КБ на каждую загрузку приложения.
   *
   * Замерено на живом аккаунте: 28 записей несут 3213КБ, 4 скилла - 5КБ. То есть 99.8% веса этого ответа
   * это `events`, а нужны они ровно в двух случаях: когда запись ЗАБИРАЮТ в браузер и когда с ней что-то
   * делают. Оба - действия, а не открытие списка.
   *
   * Поэтому запись отдаёт СВОДКУ: сколько событий, в каких окнах, часть ли это длинной сессии, сколько
   * весит. Ровно то, на чём reconcile принимает решения (см. web/src/features/record/reconcile.ts) - и
   * ничего сверх. Сам payload берут по одному, через ?flow=<id>.
   *
   * Скиллы payload ВЕЗУТ: пять килобайт на все, и без него скилл нельзя запустить - а запустить его можно
   * из списка, не открывая ничего.
   *
   * Считается в SQL, а не в JS: тянуть 3МБ из базы, чтобы посчитать длину массива и выбросить, - это та же
   * работа, только на другой стороне провода. */
  const flows = await sql`
    select client_id, source, kind, name, description, origins, created_at, updated_at,
           octet_length(payload::text) as bytes,
           case when kind = 'created' then payload else null end as payload,
           case when jsonb_typeof(payload->'events') = 'array'
                then jsonb_array_length(payload->'events') else 0 end as events,
           payload->'windows' as windows,
           payload->'session' as session,
           payload->'role' as role
    from user_flow
    where user_id = ${who.id} and deleted_at is null
    order by updated_at desc
  `;
  const runs = await sql`
    select client_id, kind, goal, model, flow_id, outcome, summary, error,
           steps, said, extension, started_at, finished_at
    from user_run
    where user_id = ${who.id}
    order by started_at desc nulls last limit ${RUNS_RETURNED}
  `;
  /* Facts about the PERSON, not their work. Small enough to ride along with every read rather than earn a
   * request of its own, and the first of them - whether the introduction has been seen - is needed on the
   * first render of the app, which is exactly when this answer arrives.
   *
   * Wrapped, and the reason is a bug this caused: the table arrived in a migration, the code arrived in a
   * deploy, and for the hours between them this line threw - which failed the WHOLE read. The app then
   * showed no recordings at all on any machine that did not already have them in local storage, and said
   * nothing, because a failed account read is deliberately quiet. A preference is the least important thing
   * in this response and must never be able to take the rest of it down. */
  let prefs = [];
  try {
    prefs = await sql`select key, value from user_pref where user_id = ${who.id}`;
  } catch (_) {
    /* No table yet, or no permission. Absent preferences mean the defaults, which is what a deployment
     * that has never had them should do. */
  }
  return res.status(200).json({
    ok: true,
    you: {
      name: who.name,
      image: who.image,
      prefs: Object.fromEntries(prefs.map((p) => [p.key, p.value])),
    },
    /* `source` says which half made it, and therefore which half can run it. Both are returned to
     * both clients on purpose: being told you have eleven flows and shown four is worse than
     * useless. Each client shows them all and offers Run only on its own. */
    flows: flows.map((f) => ({
      id: f.client_id, source: f.source, kind: f.kind, name: f.name, description: f.description,
      payload: f.payload, origins: f.origins, created: f.created_at, updated: f.updated_at,
      /* ПОЛОЖИТЕЛЬНЫЙ признак, а не отсутствие поля. «payload === undefined» читается и как «не приехал», и
       * как «пустой», и первое же место, которое перепутает их и запушит обратно, сотрёт запись. Здесь
       * сказано прямо: его НЕ ПРИСЛАЛИ, спрашивай отдельно. */
      payloadOmitted: f.payload === null || f.payload === undefined,
      /* То, на чём принимают решения, не открывая payload. */
      summary: {
        events: Number(f.events) || 0,
        bytes: Number(f.bytes) || 0,
        windows: Array.isArray(f.windows) ? f.windows : [],
        session: f.session && typeof f.session === 'object' ? f.session : null,
        role: typeof f.role === 'string' ? f.role : null,
      },
    })),
    runs: runs.map((r) => ({
      id: r.client_id, kind: r.kind, goal: r.goal, model: r.model, flowId: r.flow_id,
      outcome: r.outcome, summary: r.summary, error: r.error, steps: r.steps, said: r.said,
      extension: r.extension, startedAt: r.started_at, finishedAt: r.finished_at,
    })),
  });
}

/** Один payload по клиентскому id. Ничего, кроме него: список уже рассказал, что это за флоу. */
async function onePayload(res, sql, who, id) {
  const clientId = text(id, 80);
  if (!clientId) return fail(res, 400, 'which flow?');
  const rows = await sql`
    select payload from user_flow
    where user_id = ${who.id} and client_id = ${clientId} and deleted_at is null
    limit 1
  `;
  /* 404, а не пустой payload: «нет такой записи» и «запись без содержимого» - разные ответы, и клиент,
   * который получит второй вместо первого, запишет пустоту поверх. */
  if (!rows.length) return fail(res, 404, 'no flow with that id on this account');
  return res.status(200).json({ ok: true, id: clientId, payload: rows[0].payload });
}

/* ----------------------------------------------------------------------- writing */

/* Upsert on (user, client id).
 *
 * The client owns identity here, because a flow is made and renamed on the client. That makes a
 * repeated push idempotent - which matters, because the extension pushes whenever something changes
 * and a retry after a dropped connection must not double anything.
 */
async function push(req, res, sql, who) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const flows = Array.isArray(body.flows) ? body.flows.slice(0, FLOWS_MAX) : [];
  const runs = Array.isArray(body.runs) ? body.runs.slice(0, RUNS_MAX) : [];
  const removed = Array.isArray(body.deleted) ? body.deleted.slice(0, FLOWS_MAX) : [];

  /* Объявлено ЗДЕСЬ, а не ниже у цикла: отброшенный хвост называется раньше, чем разбирается
   * первый флоу, и `problems` должна уже существовать - иначе это ReferenceError в самом обычном push'е,
   * который загрузка модуля не ловит, потому что он внутри функции. */
  const problems = [];

  /* ОТБРОШЕННОЕ НАЗЫВАЕТСЯ. Три среза выше молча теряли остаток, и ответ был 200 ok со счётчиками, равными
   * тому, что уцелело: отправитель не мог отличить «сохранено всё» от «сохранено первые триста».
   *
   * Хуже всего это на `deleted`: расширение чистит свой список удалённых по успешному ответу, так что
   * тихо обрезанный хвост - это удаления, которые не случились и о которых больше никто не вспомнит.
   *
   * `problems` - именно то место, где это должно быть: комментарий ниже говорит, что он существует, чтобы
   * одна плохая запись не теряла остаток push'а. Потерянный хвост - это тот же случай. */
  const tooMany = (had, kept, what, cap) => {
    const total = Array.isArray(had) ? had.length : 0;
    if (total <= kept) return null;
    return `${total - kept} ${what} were not saved — this takes ${cap} at a time. Send the rest in `
      + 'another push.';
  };
  for (const line of [
    tooMany(body.flows, flows.length, 'flows', FLOWS_MAX),
    tooMany(body.runs, runs.length, 'runs', RUNS_MAX),
    tooMany(body.deleted, removed.length, 'deletions', FLOWS_MAX),
  ]) {
    if (line) problems.push(line);
  }

  let savedFlows = 0;
  let savedRuns = 0;

  for (const flow of flows) {
    const clientId = text(flow && flow.id, 80);
    /* Два входа, одно значение. Старые клиенты - и оба агента, и расширение - шлют `payload`; браузер,
     * у которого есть CompressionStream, шлёт `payloadZ`. Принимаются оба, потому что версия приложения
     * и версия агента расходятся по определению, а запись, отказанная за то, что отправитель старый, -
     * это та же потеря часа, только с другой причиной. */
    let payload = flow && flow.payload;
    let encoded = null;
    if (!payload && flow && flow.payloadZ) {
      const opened = inflatePayload(flow.payloadZ);
      if (opened.why) {
        problems.push('"' + (flow.name || clientId) + '": ' + opened.why);
        continue;
      }
      payload = opened.value;
      /* Уже есть текстом - второй раз в строку не сериализуется. */
      encoded = opened.encoded;
    }
    if (!clientId || !payload || typeof payload !== 'object') {
      problems.push('a flow arrived without an id or a payload');
      continue;
    }
    if (encoded === null) encoded = JSON.stringify(payload);
    if (encoded.length > PAYLOAD_MAX_BYTES) {
      problems.push('"' + (flow.name || clientId) + '" is too large to sync (' +
        Math.round(encoded.length / 1024) + 'KB, and the ceiling is '
        + Math.round(PAYLOAD_MAX_BYTES / 1024) + 'KB)');
      continue;
    }
    /* ЗАПИСЬ НЕ ТЕРЯЕТ СОБЫТИЯ ПРИ ОБНОВЛЕНИИ. Инвариант, а не аккуратность на вызывающей стороне.
     *
     * Список больше не везёт `events`, и в приложении есть места, которые берут флоу из списка,
     * разворачивают его payload и пушат обратно: переименование в Skills делает ровно
     * `{ ...flow.payload, name }`. Забыть там дозагрузку - значит записать пустоту поверх часа работы,
     * молча и необратимо. Клиент это делает правильно (payloadOf), но «клиент делает правильно» - это не
     * гарантия, а надежда: клиентов четыре, включая расширение и агентов, и следующий появится завтра.
     *
     * Обратного случая нет. Обрезка шагов (removeSteps) события сохраняет; скилл из записи пишется под
     * своим id (`gs_`/`gd_`), а не поверх неё. Запись, у которой events становятся пустыми, - это всегда
     * ошибка, а не намерение. */
    const incoming = Array.isArray(payload.events) ? payload.events.length : 0;
    if (!incoming) {
      const had = await sql`
        select case when jsonb_typeof(payload->'events') = 'array'
                    then jsonb_array_length(payload->'events') else 0 end as events
        from user_flow
        where user_id = ${who.id} and client_id = ${clientId} and deleted_at is null
        limit 1
      `;
      if (had.length && Number(had[0].events) > 0) {
        problems.push('"' + (flow.name || clientId) + '" arrived with no events, and the account holds '
          + had[0].events + ' — refusing to overwrite a recording with an empty one. Load its payload '
          + 'first (GET /api/sync?flow=' + clientId + ') and send it back whole.');
        continue;
      }
    }
    const kind = flow.kind === 'created' ? 'created' : 'recorded';
    /* Which half made it. Not inferred from the payload: the shapes are similar enough that a guess
     * would sometimes be wrong, and a flow labelled runnable by the wrong half is a broken button. */
    const source = flow.source === 'desktop' ? 'desktop' : 'web';
    const origins = Array.isArray(flow.origins)
      ? flow.origins.filter((o) => typeof o === 'string').slice(0, 12) : [];

    await sql`
      insert into user_flow
        (user_id, client_id, source, kind, name, description, payload, origins, created_at, updated_at)
      values
        (${who.id}, ${clientId}, ${source}, ${kind}, ${text(flow.name, 80) || ''},
         ${text(flow.description, 400) || ''}, ${encoded}, ${origins},
         ${flow.created || null}, now())
      on conflict (user_id, client_id) do update set
        source = excluded.source, kind = excluded.kind, name = excluded.name,
        description = excluded.description, payload = excluded.payload, origins = excluded.origins,
        updated_at = now(), deleted_at = null
    `;
    savedFlows++;
  }

  /* Tombstoned rather than removed, so a delete on one machine propagates instead of the flow
   * reappearing from the next machine that syncs. */
  for (const id of removed) {
    const clientId = text(id, 80);
    if (!clientId) continue;
    await sql`
      update user_flow set deleted_at = now(), updated_at = now()
      where user_id = ${who.id} and client_id = ${clientId} and deleted_at is null
    `;
  }

  for (const run of runs) {
    const clientId = text(run && run.id, 80);
    if (!clientId) { problems.push('a run arrived without an id'); continue; }
    const kind = run.kind === 'replay' ? 'replay' : 'agent';
    const outcome = ['ok', 'failed', 'stopped', 'running'].includes(run.outcome)
      ? run.outcome : 'failed';
    const steps = Array.isArray(run.steps) ? run.steps.slice(0, 400) : [];
    const said = Array.isArray(run.said) ? run.said.slice(0, 200) : [];

    await sql`
      insert into user_run
        (user_id, client_id, kind, goal, model, flow_id, outcome, summary, error,
         steps, said, extension, started_at, finished_at)
      values
        (${who.id}, ${clientId}, ${kind}, ${text(run.goal, 4000)}, ${text(run.model, 60)},
         ${text(run.flowId, 80)}, ${outcome}, ${text(run.summary, 2000)}, ${text(run.error, 2000)},
         ${JSON.stringify(steps)}, ${JSON.stringify(said)}, ${text(run.extension, 20)},
         ${run.startedAt || null}, ${run.finishedAt || null})
      on conflict (user_id, client_id) do update set
        outcome = excluded.outcome, summary = excluded.summary, error = excluded.error,
        steps = excluded.steps, said = excluded.said, finished_at = excluded.finished_at,
        synced_at = now()
    `;
    savedRuns++;
  }

  return res.status(200).json({
    ok: true,
    flows: savedFlows,
    runs: savedRuns,
    deleted: removed.length,
    // Reported rather than thrown: one bad flow should not lose the rest of the push.
    problems,
  });
}

/* The outer net: anything thrown before or around the handler's own try block. */
export default wrap(handler, 'sync');
