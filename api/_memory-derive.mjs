/* `derived` — MEMORY-PLAN.md §4.7.1, §5 шаг 3. Чистая агрегация по событиям записей, без базы, без модели.
 *
 * СТАБИЛЬНЫЙ КРАЙ ЗАГОЛОВКА - НЕ ПРОСТО ЭВРИСТИКА, А ФИЛЬТР СОДЕРЖИМОГО. Заголовок окна часто несёт то,
 * что 4.5 запрещает помнить: тему письма, имя документа. Самый длинный ОБЩИЙ СУФФИКС нескольких разных
 * заголовков одного ключа - это ровно то, что НЕ меняется от письма к письму, то есть часть, которая уже
 * не может быть содержимым. Порог - 6 символов, тот же, что у rung 2 в matchWindow (api/_anchor.mjs) -
 * не совпадение, а та же граница «достаточно, чтобы не быть случайностью».
 *
 * ПОЧЕМУ ПЛАТФОРМА КЛЮЧА НЕ УГАДЫВАЕТСЯ ИЗ ЗАПИСИ. PROTOCOL.md, разбор `mods`: «There is no correct
 * translation without knowing which platform wrote the line, and the body does not say» - то же самое
 * верно и здесь. Запись не несёт win32/darwin нигде в событии, так что нативные (не веб) касания без
 * явно названной платформы ПРОПУСКАЮТСЯ, а не записываются под угаданным ключом - слишком уверенный
 * список контролов под неверным ключом хуже отсутствующего. Веб-касания этой проблемы не имеют: `context.url`
 * называет origin сам.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: чтения `user_flow`, сети. На входе - события уже загруженных записей; на выходе -
 * кандидаты, каждый пропущенный через writeMemory (_memory.mjs), так что редакция (4.5) проверяется
 * ровно там же, где и для taught/learned - один выбор, а не вторая копия правила.
 */

import { webKeyFor, writeMemory } from './_memory.mjs';

/** Версия формулы (4.4: derived несёт версию, и её рост пересчитывает каждую строку заново). */
export const DERIVE_VERSION = 1;

/** Тот же порог, что у rung 2 в matchWindow — api/_anchor.mjs, «shared title edge ≥ 6 chars». */
export const TITLE_EDGE_MIN = 6;

const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Касания одной записи — по одному на событие с контекстом. `platform` называется вызывающим (кто читал
 * запись знает, с какой машины её грузят); без него нативные события пропускаются, веб — нет (см. шапку).
 * @param {{events?: object[]}|{payload: {events?: object[]}}} flow
 * @param {{platform?: 'win32'|'darwin'}} [opts]
 * @returns {{key: string, title: string|null, control: string|null, near: string|null, side: string|null}[]}
 */
export function touchesOf(flow, opts = {}) {
  const events = Array.isArray(flow && flow.events) ? flow.events
    : Array.isArray(flow && flow.payload && flow.payload.events) ? flow.payload.events : [];
  const out = [];
  for (const e of events) {
    const ctx = e && typeof e === 'object' ? e.context : null;
    if (!ctx || typeof ctx !== 'object') continue;
    const control = clean(ctx.control);
    const near = clean(ctx.near);
    const side = clean(ctx.side);
    if (typeof ctx.url === 'string' && ctx.url) {
      const key = webKeyFor(ctx.url);
      if (key) out.push({ key, title: clean(ctx.window), control, near, side });
      continue;
    }
    if (clean(ctx.app) && (opts.platform === 'win32' || opts.platform === 'darwin')) {
      out.push({ key: `${opts.platform}:${clean(ctx.app)}`, title: clean(ctx.window), control, near, side });
    }
  }
  return out;
}

/** Самый длинный общий суффикс нескольких заголовков — `null`, если сравнивать нечего или он короче порога. */
function commonTitleEdge(titles) {
  const distinct = Array.from(new Set((titles || []).filter(Boolean)));
  if (distinct.length < 2) return null;
  let edge = distinct[0];
  for (const t of distinct.slice(1)) {
    let i = 0;
    while (i < edge.length && i < t.length && edge[edge.length - 1 - i] === t[t.length - 1 - i]) i++;
    edge = i ? edge.slice(edge.length - i) : '';
    if (!edge) break;
  }
  /* Не .trim() результата: «` - Outlook`» несёт ведущий пробел не случайно — это разделитель заголовка
   * и приложения, и без него строка «трейлинг "- Outlook"» читается менее понятно (см. пример в 4.4). */
  return edge.trim().length >= TITLE_EDGE_MIN ? edge : null;
}

/** Самый частый ИМЕНОВАННЫЙ контрол: `[имя, число нажатий]`, или `null`. */
function topControl(touches) {
  const counts = new Map();
  for (const t of touches) if (t.control) counts.set(t.control, (counts.get(t.control) || 0) + 1);
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  return sorted[0] || null;
}

/** Самый частый landmark у БЕЗЫМЯННЫХ нажатий (4.1: near/side на #ctx) — `[label, count]`, или `null`. */
function topLandmark(touches) {
  const counts = new Map();
  for (const t of touches) {
    if (t.control || !t.near) continue;
    const label = t.side ? `${t.near}, ${t.side}` : t.near;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  return sorted[0] || null;
}

/**
 * Кандидаты `derived` из уже собранных касаний, по одному на ключ. Каждый проходит через `writeMemory`
 * (та же редакция, что и для остальных провенансов), так что результат — либо готовая запись, либо отказ
 * словами, никогда не тихий пропуск.
 * @param {ReturnType<typeof touchesOf>} touches
 * @param {{version?: number}} [opts]
 * @returns {{key: string, ok: boolean, entry?: object, why?: string, body?: string, seen: number}[]}
 */
export function deriveEntries(touches, { version = DERIVE_VERSION } = {}) {
  const byKey = new Map();
  for (const t of touches || []) {
    if (!t || !t.key) continue;
    if (!byKey.has(t.key)) byKey.set(t.key, []);
    byKey.get(t.key).push(t);
  }
  const out = [];
  for (const [key, list] of byKey) {
    const parts = [];
    const edge = commonTitleEdge(list.map((t) => t.title));
    if (edge) parts.push(`the stable part of the title is the trailing "${edge}"`);
    const control = topControl(list);
    if (control) {
      const [name, count] = control;
      parts.push(`"${name}" — ${count} press${count === 1 ? '' : 'es'} out of ${list.length} touches; the most-named control here`);
    }
    const landmark = topLandmark(list);
    if (landmark) parts.push(`the most common nameless press lands near ${landmark[0]}`);
    if (!parts.length) continue;
    const body = parts.join('; ') + '.';
    const w = writeMemory({ key, provenance: 'derived', body, version });
    out.push(w.ok ? { key, ok: true, entry: w.entry, seen: list.length } : { key, ok: false, why: w.why, body, seen: list.length });
  }
  return out;
}
