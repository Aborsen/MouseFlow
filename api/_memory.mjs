/* Память о приложениях — MEMORY-PLAN.md §4. Шаг 2 из §5: ключ, запись, порядок провенансов,
 * бюджет/вытеснение, редакция. Чисто, без базы и без экрана.
 *
 * ЗАЧЕМ ЭТО ОТДЕЛЬНЫЙ ЧИСТЫЙ МОДУЛЬ, а не таблица и код рядом с ней. Модуль обязан быть прав, когда никто
 * не смотрит, — как _anchor.mjs. Редакция (4.5) - это единственная граница, которая не пускает запись
 * обратно в то, что уже один раз вычистили из записи: координату, часть URL с запросом, поле пароля,
 * имя длиннее, чем сам рекордер разрешает себе запомнить. Если эта граница живёт внутри маршрута базы,
 * её нельзя проверить исполнением без базы, а значит рано или поздно кто-то её обойдёт, не заметив.
 *
 * ГРАНИЦА 4.2: код хранит факты о платформе, память хранит факты об ОДНОМ приложении. Четыре builtin-
 * строки ниже (4.9) - код, а не память: они здесь только как читаемый список для витрины (лог/ledger),
 * и `fitBlock` их не пускает в блок хода ни при каких обстоятельствах - см. тест "builtin never renders".
 *
 * ЧЕГО ЗДЕСЬ НЕТ: обращения к базе, к экрану, к модели. На входе - то, что попросили запомнить и что уже
 * накопилось; на выходе - решение (можно/нет) и текст блока для хода. Всё.
 */

/** Четыре провенанса, ровно в этом порядке везде, где порядок имеет смысл (4.4). */
export const PROVENANCE = ['derived', 'taught', 'learned', 'builtin'];

/** Кто может это писать, пересчитывается ли оно само и нужно ли согласие (таблица 4.4). */
export const PROVENANCE_RULES = {
  derived: { recomputable: true, approval: false },
  taught: { recomputable: false, approval: false },
  learned: { recomputable: false, approval: true },
  builtin: { recomputable: false, approval: false },
};

/** 4.10: 600 символов на ключ, не больше 6 ключей за ход. */
export const KEY_BUDGET = 600;
export const MAX_KEYS_PER_TURN = 6;

/** 4.5: то же правило, что у рекордера для имени контрола (RecordName, agent 0.13.0) — та же причина. */
export const MAX_NAME_LENGTH = 60;

const KEY_RE = /^(win32|darwin|web):(.+)$/;
/* Не `/`, `?`, `#` и не пробел - ключ `web:` это ORIGIN, а не адрес: без пути, без запроса (4.3). Порт
 * разрешён (`localhost:3000`), потому что это часть origin, а не запроса. */
const WEB_ID_RE = /^[a-z0-9.-]+(:\d+)?$/i;

/**
 * Разобрать ключ памяти. `null`, если он не по форме 4.3 — та же дисциплина, что у readFound: не угадывать.
 * @param {string} key
 * @returns {{platform: 'win32'|'darwin'|'web', id: string}|null}
 */
export function parseKey(key) {
  const said = String(key == null ? '' : key);
  const m = KEY_RE.exec(said);
  if (!m) return null;
  const [, platform, id] = m;
  if (!id) return null;
  if (platform === 'web' ? !WEB_ID_RE.test(id) : /[\s/?#]/.test(id)) return null;
  return { platform, id };
}

/**
 * Ключ `web:<origin>` из настоящего URL — origin, без пути и без запроса (4.3), той же дисциплины, что
 * `PageUrl`/`Bare` в mouseflow-agent.ps1, но короче: там остаётся путь, здесь — только хозяин страницы.
 * @param {string} url
 * @returns {string|null}
 */
export function webKeyFor(url) {
  const said = String(url == null ? '' : url).trim();
  if (!said) return null;
  let parsed;
  try {
    parsed = new URL(said.includes('://') ? said : `https://${said}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return `web:${parsed.host}`;
}

const COORD_RE = /-?\d{2,5}\s*,\s*-?\d{2,5}/;
const QUERY_RE = /https?:\/\/\S*\?\S*/i;
const SECRET_MARK_RE = /\(password, not read\)/i;
/* Найдено на реальных данных владельца (2026-09-11): "control" одного события оказался не именем
 * контрола, а строкой с адресом почты — accessibility-дерево иногда отдаёт то, что человек ВВЁЛ, за имя.
 * 4.5 предсказывает это дословно: «a learned entry... will carry a customer's name... unless refused
 * explicitly» - и здесь это была не гипотеза. */
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;

/**
 * Причина отказать записи — или `null`, если её можно запомнить (4.5). Проверяет то, что запомнить
 * попросили, а не то, где это в итоге легло: редакция стоит на входе, а не на маршруте базы.
 * @param {{body?: string, name?: string, secret?: boolean}} input
 * @returns {string|null}
 */
export function redactionProblem({ body, name, secret } = {}) {
  if (secret) return 'a password field is never remembered, whatever the text says';
  if (name != null && String(name).length > MAX_NAME_LENGTH) {
    return `the name is ${String(name).length} characters, over the ${MAX_NAME_LENGTH}-character limit the recorder itself uses`;
  }
  if (name != null && EMAIL_RE.test(String(name))) return 'an email address was in the name — that is content, not a control label';
  const text = String(body == null ? '' : body);
  if (SECRET_MARK_RE.test(text)) return 'a password field is never remembered, whatever the text says';
  if (QUERY_RE.test(text)) return 'a URL with a query string was in the text — memory keeps origins only, never a query string';
  if (COORD_RE.test(text)) return 'a coordinate was in the text — memory holds names and rules, never points';
  if (EMAIL_RE.test(text)) return 'an email address was in the text — memory never carries what somebody typed';
  return null;
}

/**
 * Построить запись — или отказать словами (4.5, 4.4). Не пишет никуда: возвращает то, что вызывающий
 * (шаг 5) кладёт в `app_memory`.
 * @param {{key: string, provenance: string, body: string, name?: string, secret?: boolean, version?: number, runId?: string}} input
 * @returns {{ok: true, entry: object}|{ok: false, why: string}}
 */
export function writeMemory({ key, provenance, body, name, secret, version, runId } = {}) {
  if (provenance === 'builtin' || !PROVENANCE.includes(provenance)) {
    return { ok: false, why: `"${provenance}" is not something a caller writes — builtin entries live in code, not in a write` };
  }
  const parsed = parseKey(key);
  if (!parsed) return { ok: false, why: `"${key}" is not a memory key — expected win32:, darwin: or web: (4.3)` };
  if (body == null || String(body) === '') return { ok: false, why: 'nothing to remember — the body is empty' };
  const why = redactionProblem({ body, name, secret });
  if (why) return { ok: false, why };
  return {
    ok: true,
    entry: {
      key,
      provenance,
      body: String(body),
      version: provenance === 'derived' ? (version == null ? 1 : version) : null,
      runId: provenance === 'learned' ? (runId == null ? null : String(runId)) : null,
      state: provenance === 'learned' ? 'pending' : 'live',
    },
  };
}

/** Как одна запись печатается в блок хода — `§ <провенанс> [версия|runId]   <текст>` (4.4). */
function lineFor(e) {
  const tag = e.provenance + (e.version != null ? ` v${e.version}` : '') + (e.runId ? ` ${e.runId}` : '');
  return `§ ${tag}   ${e.body}`;
}

/**
 * Уложить живые записи одного ключа в бюджет (4.10). `taught` не вытесняется никогда; `derived`
 * пересчитывается на чтении и не накапливается, так что и его вытеснять не нужно; вытесняется только
 * `learned`, и самое старое первым. Builtin и `rejected`/`pending` сюда не попадают вовсе — их место не
 * в блоке хода (4.9, 4.4).
 * @param {object[]} entries
 * @param {number} [budget]
 * @returns {{text: string, used: number, evicted: object[]}}
 */
export function fitBlock(entries, budget = KEY_BUDGET) {
  const live = (entries || []).filter((e) => e && e.provenance !== 'builtin' && (e.state == null || e.state === 'live'));
  const taught = live.filter((e) => e.provenance === 'taught');
  const derived = live.filter((e) => e.provenance === 'derived');
  const learned = live
    .filter((e) => e.provenance === 'learned')
    .slice()
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  const evicted = [];
  let kept = [...taught, ...derived, ...learned];
  let text = kept.map(lineFor).join('\n');

  while (text.length > budget && learned.length) {
    const gone = learned.shift();
    kept = kept.filter((e) => e !== gone);
    evicted.push(gone);
    text = kept.map(lineFor).join('\n');
  }
  /* Осталось только taught/derived, и всё равно не влезает - не портить их молча вытеснением, которого
   * 4.4 для них не разрешает; обрезать текст целиком, как `Clip` в ps1, а не одну запись наугад. */
  if (text.length > budget) text = text.slice(0, budget - 1) + '…';

  return { text, used: text.length, evicted };
}

/**
 * Первые четыре строки ledger'а (4.9) — код, показанный как факт, никогда не аргумент записи и никогда
 * не в промпте (`fitBlock` их отбрасывает по `provenance === 'builtin'` выше).
 * @returns {object[]}
 */
export function builtinEntries() {
  return [
    {
      scope: 'platform:win32',
      body: 'A bare right-button release opens a context menu (WM_RBUTTONUP → WM_CONTEXTMENU), so a replay releases only the buttons it held.',
      enforcedIn: 'ReleaseHeldButtons, agent/mouseflow-agent.ps1',
    },
    {
      scope: 'platform:win32',
      body: 'A taskbar button toggles — it minimises a window already in front — so a recorded taskbar press is played as "show that window", by title only.',
      enforcedIn: 'TaskbarSwitch, OnTaskbar, ps1',
    },
    {
      scope: 'platform:win32',
      body: 'A minimised window reports a placeholder rectangle: fit to raise, never to re-anchor by.',
      enforcedIn: 'matchWindow evenMinimized, api/_anchor.mjs',
    },
    {
      scope: 'self',
      body: "MouseFlow is the front window when Record is pressed, so the sampler's first window is us; the replay raises the window the clicks name and never raises itself.",
      enforcedIn: 'whichWindow (api/_anchor.mjs), ourWindow in RecordView.tsx',
    },
  ].map((e) => ({ ...e, provenance: 'builtin' }));
}

/* §5 шаг 4: блок памяти для СЕЙЧАС ОТКРЫТЫХ окон — единственное, что drivers передают в screenMessage
 * (MEMORY-PLAN.md §4.6). ЗА ФЛАГОМ, одним местом на оба драйвера: оба вызывают `memoryForOpen` как обычно,
 * и ни один не пишет свою собственную проверку флага, а значит им и не разойтись, включён он или нет.
 *
 * ВКЛЮЧЁН 2026-09-11, по слову владельца в чате ("включай") - после того, как миграция 023 применена и
 * ledger умеет taught (§5 шаг 5). Пока на аккаунте нет ни одной строки app_memory, это ничего не меняет:
 * memoryForOpen с пустой картой отвечает null, как и раньше. Разница будет видна только когда там что-то
 * появится - `taught` через карточку, или `derived` (когда шаг 3 получит живой путь чтения, а не только
 * разовую пробу). Измерение 4.13 (шаги на успешный прогон, до/после) остаётся открытым и стоит перечитать,
 * когда записей в памяти накопится достаточно, чтобы что-то показать - выключить обратно, если ход стал
 * дороже без такой же выгоды, это одна строка здесь же. */
export const MEMORY_LIVE = true;

/**
 * @param {{process?: string}[]} windows          то же, что уже идёт в openList (api/_brain.mjs)
 * @param {'win32'|'darwin'|null} platform         null — платформа неизвестна (сегодня так у облачного
 *                                                  драйвера: ничего в проводе `?worker=step` её не несёт)
 * @param {Map<string, object[]>} entriesByKey     что уже загружено с account'а, по ключу памяти
 * @param {boolean} [live]                          по умолчанию MEMORY_LIVE; параметр существует только
 *                                                   для того, чтобы тест мог проверить логику под флагом,
 *                                                   не трогая сам переключатель
 * @returns {string|null}
 */
export function memoryForOpen(windows, platform, entriesByKey, live = MEMORY_LIVE) {
  if (!live || !platform || !Array.isArray(windows) || !entriesByKey) return null;
  const keys = [];
  const seen = new Set();
  for (const w of windows) {
    const proc = w && typeof w.process === 'string' ? w.process : null;
    if (!proc) continue;
    const key = `${platform}:${proc}`;
    if (seen.has(key) || !parseKey(key)) continue;
    seen.add(key);
    keys.push(key);
    if (keys.length >= MAX_KEYS_PER_TURN) break;
  }
  const blocks = [];
  for (const key of keys) {
    const fit = fitBlock(entriesByKey.get(key) || [], KEY_BUDGET);
    if (fit.text) blocks.push(`app: ${key}\n${fit.text}`);
  }
  return blocks.length ? blocks.join('\n\n') : null;
}
