/* Расширение под Node, против заглушек - потому что иначе его не проверяет ничто.
 *
 * ПОЧЕМУ ЭТОТ ФАЙЛ ПОЯВИЛСЯ. У десктопной половины есть check-swift.mjs (компилятор + исполнение),
 * check-csharp.mjs (заменитель компилятора) и test-contract.mjs (две реализации в шаге). У расширения не
 * было ничего: README описывает проверки под Node со стендом, а файлов в репозитории нет. За это время в
 * него уехали две вещи, каждая из которых тихо врала пользователю - ход без единого вызова инструмента,
 * записанный как успех, и запись, до которой из панели нельзя было добраться.
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ И КАК. Не регулярками по исходнику: background.js импортируется целиком, со
 * стендом вместо chrome, а сообщения идут через НАСТОЯЩИЙ route() - тот самый, который в браузере получает
 * их от панели, вместе с проверкой на аккаунт. То есть проверяется путь, а не наличие функции.
 *
 * Запуск: node extension/check-extension.mjs
 */

import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const group = (title) => console.log('\n' + title);

/* ------------------------------------------------------------------ стенд вместо chrome */

const store = {};
const listeners = {};
const noop = () => {};
const listener = () => ({ addListener: noop });

globalThis.chrome = {
  runtime: {
    id: 'test-extension',
    onMessage: { addListener: (fn) => { listeners.message = fn; } },
    onMessageExternal: listener(),
    onStartup: listener(),
    onInstalled: listener(),
    getURL: (p) => 'chrome-extension://test/' + p,
  },
  storage: {
    local: {
      get: async (keys) => {
        const want = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
        const out = {};
        for (const k of want) if (k in store) out[k] = store[k];
        return out;
      },
      set: async (obj) => { Object.assign(store, obj); },
      remove: async (keys) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k];
      },
    },
  },
  tabs: {
    onActivated: listener(), onUpdated: listener(), onRemoved: listener(),
    query: async () => [], get: async () => ({ id: 1, url: 'https://example.com' }),
    create: async () => ({ id: 2 }), remove: async () => {}, update: async () => ({ id: 1 }),
    sendMessage: async () => ({ ok: true }),
  },
  action: {
    onClicked: listener(),
    setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setPopup: async () => {},
    setTitle: async () => {},
  },
  scripting: { executeScript: async () => [{ result: null }] },
  webNavigation: { onCommitted: listener(), onCompleted: listener() },
  sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
  alarms: { create: noop, onAlarm: listener(), clear: async () => {} },
  windows: { getCurrent: async () => ({ id: 1 }) },
};

/* Сеть по умолчанию отвечает отказом: тест, который случайно ушёл в интернет, - это тест, который однажды
 * станет красным от чужого сбоя. Каждая проверка ставит своё поведение сама. */
let netHandler = async () => { throw new Error('the test made an unexpected network call'); };
globalThis.fetch = (...args) => netHandler(...args);

const reply = (body, ok = true, status = 200) => ({
  ok, status, json: async () => body, text: async () => JSON.stringify(body),
});

const background = await import('./background.js');
void background;

/** Одно сообщение через настоящий route(), как из панели. */
const send = (msg) => new Promise((resolve) => {
  const answered = listeners.message(msg, {}, resolve);
  if (!answered) resolve({ ok: false, error: 'route declined to answer' });
});

const seed = (recordings) => { store.pending = recordings; };
const recording = (id, events, extra = {}) => ({
  id, name: 'Web recording ' + id, created: '2026-08-29T10:00:00.000Z',
  kind: 'web', origins: ['https://example.com'], tabs: 1,
  events: Array.from({ length: events }, (_, i) => ({
    action: i === 0 ? 'focus' : 'click', tab: 0, url: 'https://example.com',
    selector: '#a' + i, at: i * 100,
  })),
  ...extra,
});

/* ------------------------------------------------------------------ проверки */

group('запись, сделанную в панели, можно найти - до этого её нельзя было даже перечислить');
store.syncToken = 'mf_test';
{
  seed([]);
  const empty = await send({ mf: 'record/list' });
  check('пустой список - это список, а не отказ', empty.ok && Array.isArray(empty.recordings)
    && empty.recordings.length === 0, JSON.stringify(empty));

  seed([recording('aaa', 3), recording('bbb', 5)]);
  const list = await send({ mf: 'record/list' });
  check('обе записи в списке', list.ok && list.recordings.length === 2, JSON.stringify(list).slice(0, 90));
  check('новейшая первой - её и ищут после Стоп', list.recordings[0].id === 'bbb',
    list.recordings.map((r) => r.id).join(','));
  check('и у каждой сказано, сколько в ней действий', list.recordings[0].events === 5,
    String(list.recordings[0].events));
  /* СОБЫТИЯ НЕ ЕДУТ. Запись на несколько минут - это мегабайты, а ответ пересекает границу сообщений;
   * список существует, чтобы сказать, ЧТО это, а не чтобы это нести. */
  check('но сами события в списке НЕ едут',
    typeof list.recordings[0].events === 'number' && !Array.isArray(list.recordings[0].events),
    JSON.stringify(list.recordings[0]).slice(0, 120));
}

group('и её можно выбросить - раньше она лежала до очистки хранилища браузера');
{
  seed([recording('aaa', 3), recording('bbb', 5)]);
  const gone = await send({ mf: 'record/forget', id: 'aaa' });
  check('выброшенная - выброшена', gone.ok && gone.left === 1, JSON.stringify(gone));
  check('и выброшена ИМЕННО ТА', store.pending.length === 1 && store.pending[0].id === 'bbb',
    store.pending.map((r) => r.id).join(','));
  const missing = await send({ mf: 'record/forget', id: 'zzz' });
  check('а несуществующая - это отказ, а не тихий успех', !missing.ok, JSON.stringify(missing));
}

group('и сохранить как навык - вместе с отправкой на аккаунт, потому что экран это обещает');
{
  seed([recording('aaa', 4)]);
  store.skills = [];
  let pushed = null;
  /* Синхронизация - ДВА запроса: сначала push с телом, потом pull без него. Первая версия этой заглушки
   * разбирала init.body в обоих, падала на втором и выглядела как отказ аккаунта - то есть тест сообщал о
   * поломке, которой не было, ровно в той проверке, ради которой писался. */
  netHandler = async (url, init) => {
    if (!String(url).includes('/api/sync')) throw new Error('unexpected ' + url);
    if (init && init.body) pushed = JSON.parse(init.body);
    return reply({ flows: [], runs: [] });
  };
  const kept = await send({ mf: 'record/keep', id: 'aaa', name: 'Weekly report' });
  check('сохранено', kept.ok && !!kept.skill, JSON.stringify(kept).slice(0, 120));
  check('и под тем именем, которое дали', kept.skill.name === 'Weekly report', kept.skill.name);
  check('и оно поехало на аккаунт', kept.synced === true && !!pushed,
    JSON.stringify({ synced: kept.synced, syncError: kept.syncError }));
  check('и в отправленном есть этот навык',
    !!pushed && (pushed.flows || []).some((f) => f.name === 'Weekly report'),
    JSON.stringify(pushed && (pushed.flows || []).map((f) => f.name)));
  /* УЖЕ НЕ PENDING. Список, предлагающий сохранить то, что уже сохранено, приглашает сделать это дважды. */
  check('и запись больше не висит в ожидающих', (store.pending || []).length === 0,
    JSON.stringify(store.pending));
}

group('и то, что уезжает на аккаунт, проштамповано - иначе для MCP этих скиллов не существует');
{
  seed([recording('rrr', 3)]);
  store.skills = [];
  let pushed = null;
  netHandler = async (url, init) => {
    if (!String(url).includes('/api/sync')) throw new Error('unexpected ' + url);
    if (init && init.body) pushed = JSON.parse(init.body);
    return reply({ flows: [], runs: [] });
  };
  await send({ mf: 'record/keep', id: 'rrr', name: 'Stamped' });
  const flow = pushed && (pushed.flows || [])[0];
  check('скилл уехал', !!flow, JSON.stringify(pushed && Object.keys(pushed)));
  /* roleOf в api/_flow-role.mjs читает ИМЕННО payload.role. Без него скилл не назовёт
   * mouseflow_recordings и не запустит mouseflow_run - он для той стороны просто отсутствует. */
  check('и у него есть роль в payload', !!flow && flow.payload && flow.payload.role === 'skill',
    JSON.stringify(flow && flow.payload && flow.payload.role));
  const role = readFileSync(new URL('../api/_flow-role.mjs', import.meta.url), 'utf8');
  const spelling = (role.match(/SKILL_ROLE = '([a-z]+)'/) || [])[1];
  const mine = readFileSync(new URL('./background.js', import.meta.url), 'utf8')
    .match(/const SKILL_ROLE = '([a-z]+)'/);
  check('и написание совпадает с тем, что пишет сервер', !!mine && mine[1] === spelling,
    `${mine && mine[1]} vs ${spelling}`);
}

group('а когда аккаунт недостижим - навык всё равно сохранён, и это сказано отдельно');
{
  seed([recording('ccc', 4)]);
  store.skills = [];
  netHandler = async (url) => {
    if (String(url).includes('/api/sync')) throw new Error('offline');
    throw new Error('unexpected ' + url);
  };

  const kept = await send({ mf: 'record/keep', id: 'ccc' });
  /* САМОЕ ВАЖНОЕ ЗДЕСЬ - что это не отказ. Неудачная отправка не должна выглядеть как потерянная работа:
   * навык лежит в этом браузере, и следующий Sync его увезёт. */
  check('сохранение НЕ провалено из-за сети', kept.ok === true, JSON.stringify(kept).slice(0, 120));
  check('навык действительно лежит на месте', (store.skills || []).length === 1,
    String((store.skills || []).length));
  check('но про аккаунт сказано честно', kept.synced === false && !!kept.syncError,
    JSON.stringify({ synced: kept.synced, err: kept.syncError }));
}

group('и проиграть - через те же две ступени, которыми играется уже сохранённый навык');
{
  /* НЕ запуская настоящий повтор: он двигает указатель и уважает записанные паузы. Проверяются входные
   * ворота - то есть что запись действительно доходит до движка через skillFromRecording и flowFor, а не
   * что движок работает: движок был написан и верен до этой правки, у него не было вызывающего. */
  seed([recording('aaa', 3)]);
  const missing = await send({ mf: 'record/play', id: 'zzz' });
  check('несуществующую играть нечем, и это сказано', !missing.ok
    && /no longer here/.test(String(missing.error)), JSON.stringify(missing));

  seed([{ id: 'empty', name: 'Empty', created: '2026-08-29T10:00:00.000Z', kind: 'web',
    origins: [], tabs: 1, events: [] }]);
  const hollow = await send({ mf: 'record/play', id: 'empty' });
  /* Это сообщение приходит из replayStart - то есть запись прошла весь путь до движка повтора. */
  check('пустая доходит до движка и отвергается ИМ', !hollow.ok
    && /no events/.test(String(hollow.error)), JSON.stringify(hollow));
}

group('без аккаунта эти команды не работают - как и все остальные, кроме перечисленных открытыми');
{
  delete store.syncToken;
  for (const mf of ['record/list', 'record/play', 'record/keep', 'record/forget']) {
    const res = await send({ mf });
    check(mf + ' закрыт стеной, а не выполняется', res.signedOut === true, JSON.stringify(res));
  }
  store.syncToken = 'mf_test';
}

group('ход, не вызвавший ни одного инструмента, - НЕ успех');
{
  /* Исполнением, а не чтением. Это ровно та строка, которая на десктопе стоит наоборот, и цена ошибки
   * здесь больше: ok уезжает в исход прогона, оттуда на аккаунт, и панель предлагает «успешный» прогон
   * как основу для навыка. */
  const { runGoal } = await import('./agent.js');
  netHandler = async (url, init) => {
    if (!init || init.method === 'GET') return reply({ extensionModel: 'claude-opus-5' });
    void url;
    return reply({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'I am not sure which button to press.' }],
    });
  };
  const out = await runGoal({
    goal: 'do a thing', apiKey: null, authToken: 'mf_test',
    execute: async () => ({ ok: true }),
    onEvent: () => {},
    isAborted: () => false,
  });
  check('прогон отчитался НЕуспехом', out.ok === false, JSON.stringify(out).slice(0, 140));
  check('и причиной стало то, что модель написала',
    typeof out.error === 'string' && out.error.includes('not sure which button'), out.error);
}

group('история хода не растёт бесконечно - иначе волна дорожает квадратично');
{
  const { forgetOldPages } = await import('./agent.js');
  const page = 'x'.repeat(3000);
  const result = (id, text) => ({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] });
  const messages = [
    { role: 'user', content: 'do a thing' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read_page', input: {} }] },
    { role: 'user', content: [result('a', page), result('b', 'that element is gone')] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'read_page', input: {} }] },
    { role: 'user', content: [result('c', page)] },
  ];
  forgetOldPages(messages);
  const text = (i, k) => messages[i].content[k].content[0].text;
  check('старый снимок страницы забыт', text(2, 0) === '(earlier page)', text(2, 0).slice(0, 40));
  /* КОРОТКОЕ ОСТАЁТСЯ ЦЕЛИКОМ. Неудача прошлого хода - ровно то, что модель обязана помнить, и стоит она
   * ничего; резать по типу, а не по размеру, стёрло бы и её. */
  check('но короткий ответ - нет, он и есть память о неудаче',
    text(2, 1) === 'that element is gone', text(2, 1));
  check('и последняя страница цела - по ней и принимается решение', text(4, 0).length === 3000,
    String(text(4, 0).length));
  /* Пары tool_use/tool_result нельзя рвать: API отвергает следующий запрос, если у вызова нет ответа. */
  check('и ни один tool_result не исчез',
    messages[2].content.length === 2 && messages[4].content.length === 1,
    messages.map((m) => (Array.isArray(m.content) ? m.content.length : 1)).join(','));
}

group('и цикл действительно её зовёт - проверка самой функции этого не доказывает');
{
  /* ПЕРВАЯ ВЕРСИЯ ЭТОГО НАБОРА ПРОВЕРЯЛА ТОЛЬКО forgetOldPages САМУ ПО СЕБЕ, и удаление её вызова из
   * хода прошло мутацию насквозь: функция работала, звать её перестали. Здесь смотрят на то, что реально
   * уехало во ВТОРОМ запросе - то есть на историю, за которую платят. */
  const { runGoal } = await import('./agent.js');
  const page = 'y'.repeat(3000);
  const bodies = [];
  netHandler = async (url, init) => {
    if (!init || init.method === 'GET') return reply({ extensionModel: 'claude-opus-5' });
    bodies.push(JSON.parse(init.body));
    if (bodies.length >= 3) {
      return reply({ stop_reason: 'end_turn',
        content: [{ type: 'tool_use', id: 'f', name: 'finish', input: { ok: true, summary: 'done' } }] });
    }
    return reply({ stop_reason: 'end_turn',
      content: [{ type: 'tool_use', id: 'r' + bodies.length, name: 'read_page', input: {} }] });
  };
  await runGoal({
    goal: 'look twice', apiKey: null, authToken: 'mf_test',
    execute: async () => ({ ok: true, result: { page } }),
    onEvent: () => {}, isAborted: () => false,
  });
  /* Считаются ЦЕЛЫЕ страницы, а не куски: первая версия делила на десятисимвольный кусок и получала 300
   * там, где страница была одна. Проверка, чья арифметика врёт, зелёной не бывает - она бывает красной по
   * неверной причине, что не лучше. */
  const pages = (body) => JSON.stringify(body.messages).split(page).length - 1;
  const forgotten = (body) => JSON.stringify(body.messages).split('(earlier page)').length - 1;
  check('три хода дошли до модели', bodies.length === 3, String(bodies.length));
  check('во втором запросе страница есть - иначе считать было бы нечего', pages(bodies[1]) === 1,
    String(pages(bodies[1])));
  /* В ТРЕТЬЕМ ЗАПРОСЕ страниц по-прежнему одна, хотя их прочитали две: старая заменена меткой. Без
   * обрезки здесь было бы две, и на двадцать четвёртом ходу - двадцать четыре. */
  check('в третьем - по-прежнему одна, хотя прочитано две', pages(bodies[2]) === 1,
    `${pages(bodies[0])}, ${pages(bodies[1])}, ${pages(bodies[2])}`);
  check('и на месте забытой стоит метка', forgotten(bodies[2]) === 1, String(forgotten(bodies[2])));
}

group('ход выполняется по порядку, и finish больше не съедает то, что было до него');
{
  const { runGoal } = await import('./agent.js');
  const did = [];
  let turn = 0;
  netHandler = async (url, init) => {
    if (!init || init.method === 'GET') return reply({ extensionModel: 'claude-opus-5' });
    turn++;
    /* Клик И finish в одной пачке - модель складывает их вместе постоянно, потому что так дешевле на
     * один ход. Раньше find('finish') срабатывал первым и клик не случался вовсе. */
    return reply({
      stop_reason: 'end_turn',
      content: [
        { type: 'tool_use', id: 't1', name: 'click', input: { ref: 3 } },
        { type: 'tool_use', id: 't2', name: 'finish', input: { ok: true, summary: 'sent' } },
      ],
    });
  };
  const out = await runGoal({
    goal: 'send it', apiKey: null, authToken: 'mf_test',
    execute: async (name, input) => { did.push(name); void input; return { ok: true }; },
    onEvent: () => {}, isAborted: () => false,
  });
  check('клик, стоявший перед finish, выполнен', did.includes('click'), did.join(',') || '(nothing)');
  check('и прогон закончился одним ходом', turn === 1, String(turn));
  check('и отчитался успехом, который заявили', out.ok === true, JSON.stringify(out).slice(0, 90));
}

group('отказ действия обрывает остаток хода - и объясняется каждому оборванному');
{
  const { runGoal } = await import('./agent.js');
  const did = [];
  let sent = null;
  netHandler = async (url, init) => {
    if (!init || init.method === 'GET') return reply({ extensionModel: 'claude-opus-5' });
    const body = JSON.parse(init.body);
    const last = body.messages[body.messages.length - 1];
    if (Array.isArray(last.content) && last.content.some((p) => p.type === 'tool_result')) {
      sent = last.content;
      return reply({
        stop_reason: 'end_turn',
        content: [{ type: 'tool_use', id: 'z', name: 'finish', input: { ok: false, summary: 'gave up' } }],
      });
    }
    return reply({
      stop_reason: 'end_turn',
      content: [
        { type: 'tool_use', id: 'a1', name: 'click', input: { ref: 1 } },
        { type: 'tool_use', id: 'a2', name: 'type_text', input: { ref: 2, text: 'x' } },
        { type: 'tool_use', id: 'a3', name: 'press_key', input: { key: 'Enter' } },
      ],
    });
  };
  await runGoal({
    goal: 'try it', apiKey: null, authToken: 'mf_test',
    execute: async (name) => { did.push(name); return name === 'click' ? { ok: false, error: 'no such element' } : { ok: true }; },
    onEvent: () => {}, isAborted: () => false,
  });
  check('после отказа остальное НЕ выполнялось', did.join(',') === 'click', did.join(',') || '(nothing)');
  check('но ответ есть у каждого вызова - иначе API отвергнет следующий запрос',
    !!sent && sent.filter((p) => p.type === 'tool_result').length === 3,
    String(sent && sent.length));
  /* Подробность собирается защищённо. Первая версия читала sent[1].content[0].text прямо, и когда
   * предыдущая проверка краснела - то есть ровно тогда, когда подробность и нужна, - тест ПАДАЛ на ней,
   * унося с собой все следующие группы. Тест, который валится вместо того чтобы покраснеть, прячет
   * больше, чем показывает. */
  const said = (list, i) => {
    const part = Array.isArray(list) ? list[i] : null;
    const block = part && Array.isArray(part.content) ? part.content[0] : null;
    return (block && block.text) || '(nothing)';
  };
  check('и оборванным сказано, почему их не выполнили',
    Array.isArray(sent) && sent.length > 1
      && sent.slice(1).every((p) => /not carried out/.test(said([p], 0))),
    said(sent, 1).slice(0, 80));
}

group('Стоп во время хода модели останавливает ход модели, а не только следующий');
{
  const { runGoal } = await import('./agent.js');
  let stopped = false;
  netHandler = (url, init) => {
    if (!init || init.method === 'GET') return Promise.resolve(reply({ extensionModel: 'claude-opus-5' }));
    /* Запрос, который не отвечает никогда - ровно то, во что упирался Стоп до этой правки. Отменяется
     * ТОЛЬКО через signal, поэтому если сигнал не доехал до fetch, тест повиснет и это увидят. */
    return new Promise((resolve, reject) => {
      if (!init.signal) return reject(new Error('no abort signal reached fetch'));
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      void resolve;
    });
  };
  setTimeout(() => { stopped = true; }, 400);
  const out = await runGoal({
    goal: 'wait forever', apiKey: null, authToken: 'mf_test',
    execute: async () => ({ ok: true }), onEvent: () => {}, isAborted: () => stopped,
  });
  check('прогон закончился, а не завис', !!out, JSON.stringify(out).slice(0, 80));
  /* Остановка - решение человека, а не поломка, и это РАЗНЫЕ исходы. Признак 'stopped' - тот самый, по
   * которому background.js отличает остановленный прогон от провалившегося, когда пишет его на аккаунт;
   * произвольный текст ошибки уехал бы туда как 'failed'. */
  check('и записан как остановленный, а не как провалившийся',
    out.ok === false && out.error === 'stopped', JSON.stringify(out).slice(0, 90));
}

group('и три реализации согласны, сколько ждать модель');
{
  const ext = readFileSync(new URL('./agent.js', import.meta.url), 'utf8');
  const desk = readFileSync(new URL('../web/src/lib/desktop-engine.ts', import.meta.url), 'utf8');
  const num = (text) => (text.match(/MODEL_TIMEOUT_MS = (\d+)/) || [])[1];
  /* Держится в шаге тем же способом, каким agent/test-contract.mjs держит два агента: код у них общим
   * быть не может - сервис-воркер нарочно не собирается сборщиком, - поэтому в шаге держит проверка. */
  check('таймаут ожидания модели одинаков у расширения и у десктопного драйвера',
    !!num(ext) && num(ext) === num(desk), `${num(ext)} vs ${num(desk)}`);
}

group('«страница не изменилась» - без пикселей, по тому, что действие и так приносит назад');
{
  const { pageMark } = await import('./agent.js');
  const page = (over) => Object.assign({
    url: 'https://example.com/a', title: 'A', dialog: null, shown: 2, total: 9,
    elements: [
      { ref: 0, tag: 'input', role: 'textbox', name: 'Search', value: '' },
      { ref: 1, tag: 'button', role: 'button', name: 'Go' },
    ],
  }, over);
  check('одна и та же страница даёт один и тот же отпечаток',
    pageMark(page()) === pageMark(page()), 'differs');
  check('другой адрес - другой отпечаток',
    pageMark(page()) !== pageMark(page({ url: 'https://example.com/b' })), 'same');
  /* НАБРАННЫЙ ТЕКСТ - ТОЖЕ ИЗМЕНЕНИЕ, и его не видно ни в адресе, ни в счётчиках. Без значения поля
   * ход «кликнуть в поле, напечатать адрес» считался бы неподвижным. */
  const typed = page();
  typed.elements = [Object.assign({}, typed.elements[0], { value: 'cats' }), typed.elements[1]];
  check('напечатанное в поле меняет отпечаток', pageMark(page()) !== pageMark(typed), 'same');
  check('открывшийся диалог тоже',
    pageMark(page()) !== pageMark(page({ dialog: 'Confirm' })), 'same');
  /* Действие возвращает страницу вложенной в .page, read_page - напрямую. Оба обязаны читаться. */
  check('снимок действия и снимок read_page дают одно и то же',
    pageMark({ done: true, page: page() }) === pageMark(page()), 'differ');
  /* NULL - это «не смог определить», а не «не изменилось». */
  check('результат без страницы - это null, а не пустой отпечаток',
    pageMark({ ok: true }) === null && pageMark(null) === null, String(pageMark({ ok: true })));
}

group('и застрявший прогон останавливается сам - шесть решений подряд без изменений');
{
  const { runGoal } = await import('./agent.js');
  const frozen = { url: 'https://example.com', title: 'A', dialog: null, shown: 1, total: 1,
    elements: [{ ref: 0, tag: 'button', role: 'button', name: 'Go' }] };
  let turns = 0;
  let warned = 0;
  netHandler = async (url, init) => {
    if (!init || init.method === 'GET') return reply({ extensionModel: 'claude-opus-5' });
    const body = JSON.parse(init.body);
    warned = JSON.stringify(body.messages).split('Nothing on the page has changed').length - 1;
    turns++;
    return reply({ stop_reason: 'end_turn',
      content: [{ type: 'tool_use', id: 't' + turns, name: 'click', input: { ref: 0 } }] });
  };
  const out = await runGoal({
    goal: 'press it', apiKey: null, authToken: 'mf_test',
    execute: async () => ({ ok: true, result: { done: true, page: frozen } }),
    onEvent: () => {}, isAborted: () => false,
  });
  check('прогон остановился сам, а не выгреб все 24 хода волны', turns < 12, String(turns));
  check('и отчитался неуспехом с причиной', out.ok === false
    && /Nothing on the page has changed/.test(String(out.error)), String(out.error).slice(0, 70));
  /* ПРЕДУПРЕЖДЕНИЕ РАНЬШЕ СТЕНЫ: на третьем модель ещё может выпутаться сама. */
  check('и предупреждение дошло до модели до остановки', warned > 0, String(warned));
}

group('а прогон, в котором страница меняется, не трогается');
{
  const { runGoal } = await import('./agent.js');
  let turns = 0;
  netHandler = async (url, init) => {
    if (!init || init.method === 'GET') return reply({ extensionModel: 'claude-opus-5' });
    turns++;
    if (turns > 8) {
      return reply({ stop_reason: 'end_turn',
        content: [{ type: 'tool_use', id: 'f', name: 'finish', input: { ok: true, summary: 'done' } }] });
    }
    return reply({ stop_reason: 'end_turn',
      content: [{ type: 'tool_use', id: 't' + turns, name: 'click', input: { ref: 0 } }] });
  };
  const out = await runGoal({
    goal: 'keep going', apiKey: null, authToken: 'mf_test',
    execute: async () => ({ ok: true, result: { page: {
      url: 'https://example.com/' + turns, title: 'T' + turns, dialog: null, shown: 1, total: 1,
      elements: [{ ref: 0, tag: 'button', role: 'button', name: 'Go' }] } } }),
    onEvent: () => {}, isAborted: () => false,
  });
  check('девять ходов подряд прошли без остановки', turns === 9, String(turns));
  check('и прогон закончился по finish, а не по неподвижности', out.ok === true,
    JSON.stringify(out).slice(0, 80));
}

group('а ход, про который нечем судить, счёт неподвижности не трогает');
{
  /* ВАЖНАЯ ПОЛОВИНА ПРАВИЛА. Действие, которое не возвращает страницу, - это «не смог определить», а не
   * «не изменилось»; считай его вторым, и живой прогон, чьи действия просто молчат, останавливался бы
   * сам собой через шесть ходов. Проверяется тем, что таких ходов делается БОЛЬШЕ шести. */
  const { runGoal } = await import('./agent.js');
  let turns = 0;
  netHandler = async (url, init) => {
    if (!init || init.method === 'GET') return reply({ extensionModel: 'claude-opus-5' });
    turns++;
    if (turns > 10) {
      return reply({ stop_reason: 'end_turn',
        content: [{ type: 'tool_use', id: 'f', name: 'finish', input: { ok: true, summary: 'done' } }] });
    }
    return reply({ stop_reason: 'end_turn',
      content: [{ type: 'tool_use', id: 't' + turns, name: 'press_key', input: { key: 'Tab' } }] });
  };
  const out = await runGoal({
    goal: 'press keys', apiKey: null, authToken: 'mf_test',
    /* Ни страницы, ни .page - ровно то, что возвращает действие, которому нечего показать. */
    execute: async () => ({ ok: true }),
    onEvent: () => {}, isAborted: () => false,
  });
  check('одиннадцать молчащих ходов не остановлены правилом неподвижности', turns === 11, String(turns));
  check('и прогон закончился по finish', out.ok === true, JSON.stringify(out).slice(0, 80));
}

group('пачка ограничена - и после действия, за которым нельзя ничего, остаток отбрасывается');
{
  const { runGoal, notBatched } = await import('./agent.js');
  check('первое разрешено всегда', notBatched([], 'click') === null, String(notBatched([], 'click')));
  check('седьмое - нет', /as much as one turn carries/.test(String(notBatched(
    ['click', 'type_text', 'press_key', 'click', 'type_text', 'press_key'], 'click'))), 'allowed');
  check('и ничто не следует за wait', /came after wait/.test(String(notBatched(['wait'], 'click'))),
    String(notBatched(['wait'], 'click')));
  check('ни за navigate', /came after navigate/.test(String(notBatched(['navigate'], 'click'))), 'allowed');
  /* ПРОКРУТКА - НЕ ТЕРМИНАЛ, и это отличие поверхности: ссылки указывают на элементы, а не на точки. */
  check('но прокрутка терминалом НЕ является - ссылки её переживают',
    notBatched(['scroll'], 'click') === null, String(notBatched(['scroll'], 'click')));

  const did = [];
  let sent = null;
  netHandler = async (url, init) => {
    if (!init || init.method === 'GET') return reply({ extensionModel: 'claude-opus-5' });
    const body = JSON.parse(init.body);
    const last = body.messages[body.messages.length - 1];
    if (Array.isArray(last.content) && last.content.some((p) => p.type === 'tool_result')) {
      sent = last.content;
      return reply({ stop_reason: 'end_turn',
        content: [{ type: 'tool_use', id: 'f', name: 'finish', input: { ok: true, summary: 'done' } }] });
    }
    return reply({ stop_reason: 'end_turn',
      content: Array.from({ length: 8 }, (_, i) => ({
        type: 'tool_use', id: 'b' + i, name: 'press_key', input: { key: 'Tab' } })) });
  };
  await runGoal({
    goal: 'tab a lot', apiKey: null, authToken: 'mf_test',
    execute: async (name) => { did.push(name); return { ok: true }; },
    onEvent: () => {}, isAborted: () => false,
  });
  check('из восьми действий выполнены шесть', did.length === 6, String(did.length));
  check('и все восемь получили ответ', !!sent && sent.length === 8, String(sent && sent.length));
}

group('и три реализации согласны, когда сдаваться и сколько нести за ход');
{
  const ext = readFileSync(new URL('./agent.js', import.meta.url), 'utf8');
  const brain = readFileSync(new URL('../api/_brain.mjs', import.meta.url), 'utf8');
  const num = (text, name) => (text.match(new RegExp(name + ' = (\\d+)')) || [])[1];
  for (const name of ['STILL_WARN', 'STILL_GIVE_UP', 'BATCH_MAX']) {
    check(name + ' одинаков у расширения и у общего мозга',
      !!num(ext, name) && num(ext, name) === num(brain, name),
      `${num(ext, name)} vs ${num(brain, name)}`);
  }
}

group('дешёвый словарь: наведение, перезагрузка, заметка и клик, у которого есть кнопка');
{
  const { runGoal, notBatched } = await import('./agent.js');
  const src = readFileSync(new URL('./agent.js', import.meta.url), 'utf8');
  for (const t of ['hover', 'refresh', 'note']) {
    check(`модель может попросить ${t}`, new RegExp(`name: '${t}'`).test(src), 'missing');
  }
  check('и у click появились кнопка и двойной',
    /enum: \['left', 'right', 'middle'\]/.test(src) && /double: \{ type: 'boolean'/.test(src), 'missing');
  /* Наведение делается ИМЕННО ПОТОМУ, что страница сейчас изменится - значит за ним в том же ходу
   * ничего идти не может, как и за перезагрузкой. */
  check('за наведением в том же ходу ничего не идёт',
    /came after hover/.test(String(notBatched(['hover'], 'click'))), String(notBatched(['hover'], 'click')));
  check('и за перезагрузкой тоже',
    /came after refresh/.test(String(notBatched(['refresh'], 'click'))), 'allowed');

  /* ЗАМЕТКА - НЕ ДЕЙСТВИЕ. Она не идёт в правило пачки, не обрывает ход и не тратит его: прогон
   * «посмотри пять объявлений и назови цены» иначе платил бы за каждую цену целым ходом. */
  const did = [];
  const noted = [];
  let turn = 0;
  netHandler = async (url, init) => {
    if (!init || init.method === 'GET') return reply({ extensionModel: 'claude-opus-5' });
    turn++;
    if (turn > 1) {
      return reply({ stop_reason: 'end_turn',
        content: [{ type: 'tool_use', id: 'f', name: 'finish', input: { ok: true, summary: 'done' } }] });
    }
    /* Восемь заметок и шесть нажатий в одном ходу: если бы заметки считались, до шестого нажатия
     * дело бы не дошло. */
    return reply({ stop_reason: 'end_turn', content: [
      ...Array.from({ length: 8 }, (_, i) => ({
        type: 'tool_use', id: 'n' + i, name: 'note', input: { text: 'price ' + i } })),
      ...Array.from({ length: 6 }, (_, i) => ({
        type: 'tool_use', id: 'k' + i, name: 'press_key', input: { key: 'Tab' } })),
    ] });
  };
  const out = await runGoal({
    goal: 'read the prices', apiKey: null, authToken: 'mf_test',
    execute: async (name) => { did.push(name); return { ok: true }; },
    onEvent: (e) => { if (e.type === 'note') noted.push(e.text); }, isAborted: () => false,
  });
  check('восемь заметок записаны', noted.length === 8, noted.join('|').slice(0, 60));
  check('и ни одна не дошла до страницы', !did.includes('note'), did.join(','));
  check('и все шесть нажатий всё равно выполнены - заметки потолок не съели',
    did.length === 6, String(did.length));
  check('и заметки лежат в шагах прогона, а не только в итоговом предложении',
    (out.steps || []).filter((st) => st.name === 'note').length === 8,
    String((out.steps || []).filter((st) => st.name === 'note').length));
}

group('модификаторы клика: записываются, читаются обратно и пишутся так же, как на десктопе');
{
  /* content.js - это IIFE поверх DOM, целиком его в Node не поднять. Поэтому две чистые функции
   * ВЫРЕЗАЮТСЯ из файла и ИСПОЛНЯЮТСЯ - тот же приём, которым agent/check-swift.mjs проверяет правила
   * свифтового агента. Расходиться нечему: это та же строка, прочитанная с диска. */
  const src = readFileSync(new URL('./content.js', import.meta.url), 'utf8');
  const cut = (name) => {
    const at = src.indexOf('function ' + name + '(');
    let depth = 0;
    for (let i = src.indexOf('{', at); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
    }
    return '';
  };
  const body = cut('modsOf') + '\n' + cut('modKeys');
  check('обе функции вырезаны', /function modsOf/.test(body) && /function modKeys/.test(body),
    String(body.length));
  // eslint-disable-next-line no-new-func
  const { modsOf, modKeys } = new Function(body + '; return { modsOf, modKeys };')();

  check('без модификаторов поля нет вовсе - старые записи не меняются',
    modsOf({}) === undefined, String(modsOf({})));
  check('Shift-клик записан', modsOf({ shiftKey: true }) === 'Shift', String(modsOf({ shiftKey: true })));
  /* ТОТ ЖЕ ПОРЯДОК, что у chordName в агентах: человек, читающий запись с Mac и запись из браузера, не
   * должен встречать два написания одного жеста. */
  const all = modsOf({ metaKey: true, ctrlKey: true, altKey: true, shiftKey: true });
  check('четыре сразу - в порядке Cmd, Ctrl, Alt, Shift', all === 'Cmd+Ctrl+Alt+Shift', String(all));
  const swift = readFileSync(new URL('../agent/mouseflow-agent.swift', import.meta.url), 'utf8');
  const chord = swift.slice(swift.indexOf('func chordName('));
  const order = (chord.slice(0, 400).match(/parts\.append\("(\w+)"\)/g) || [])
    .map((m) => m.replace(/.*"(\w+)".*/, '$1')).join('+');
  check('и этот порядок взят у агента, а не придуман', all === order, `${all} vs ${order}`);

  /* Круг замыкается: то, что записали, обязано прочитаться обратно теми же четырьмя булевыми. */
  const back = modKeys(modsOf({ metaKey: true, shiftKey: true }));
  check('записанное читается обратно', back.metaKey && back.shiftKey && !back.altKey && !back.ctrlKey,
    JSON.stringify(back));
  check('и мусор не ломает повтор, а просто не совпадает',
    Object.values(modKeys('Meta+Windows')).every((v) => v === false), JSON.stringify(modKeys('Meta+Windows')));

  /* Структурно: чистые функции могут быть верны и не быть позваны. */
  check('запись клика несёт mods', /action: isDouble \? 'dblclick' : 'click',\s*\n\s*button: ev\.button,\s*\n\s*mods: modsOf\(ev\),/.test(src), 'not wired');
  check('и повтор их применяет', /const mods = modKeys\(ev\.mods\);/.test(src)
    && /Object\.assign\(\{ button \}, mods\)/.test(src), 'not applied');
}

group('чекпоинты: цикл встаёт и ждёт человека');
{
  const { runGoal, toolsFor } = await import('./agent.js');
  const has = (list) => list.some((t) => t.name === 'reached_checkpoint');
  /* Модель, которой дали способ остановиться там, где остановку никто не обрабатывает, будет стоять
   * там вечно. То же правило, что у toolsFor в api/_brain.mjs. */
  check('без шлюза инструмент НЕ предлагается', !has(toolsFor(false)), 'offered');
  check('со шлюзом - предлагается', has(toolsFor(true)), 'missing');

  const plan = [{ title: 'Draft ready', detail: 'the reply is written' },
    { title: 'Sent', detail: 'it has gone' }];
  const asked = [];
  const did = [];
  let sentTools = null;
  let turn = 0;
  netHandler = async (url, init) => {
    if (!init || init.method === 'GET') return reply({ extensionModel: 'claude-opus-5' });
    const body = JSON.parse(init.body);
    sentTools = body.tools.map((t) => t.name);
    turn++;
    if (turn === 1) {
      /* Чекпоинт и клик в одной пачке: клик обязан НЕ случиться - человек смотрел на страницу сколько
       * хотел, и всё, что за объявлением, целилось по снимку, которого он уже не видит. */
      return reply({ stop_reason: 'end_turn', content: [
        { type: 'tool_use', id: 'c1', name: 'reached_checkpoint', input: { n: 1, said: 'draft is written' } },
        { type: 'tool_use', id: 'x1', name: 'click', input: { ref: 3 } },
      ] });
    }
    return reply({ stop_reason: 'end_turn',
      content: [{ type: 'tool_use', id: 'f', name: 'finish', input: { ok: true, summary: 'sent' } }] });
  };
  const out = await runGoal({
    goal: 'reply to Ann', apiKey: null, authToken: 'mf_test', plan,
    gate: async (at) => { asked.push(at); return 'go'; },
    execute: async (name) => { did.push(name); return { ok: true }; },
    onEvent: () => {}, isAborted: () => false,
  });
  check('человека спросили ровно один раз', asked.length === 1, String(asked.length));
  check('и назвали ему чекпоинт словами из плана',
    asked[0] && asked[0].n === 1 && asked[0].title === 'Draft ready'
      && asked[0].said === 'draft is written', JSON.stringify(asked[0]));
  check('клик, стоявший за объявлением, НЕ случился', !did.includes('click'), did.join(',') || '(none)');
  check('а после «продолжить» прогон дошёл до конца', out.ok === true, JSON.stringify(out).slice(0, 80));
  check('и инструмент чекпоинта уезжал модели', !!sentTools && sentTools.includes('reached_checkpoint'),
    String(sentTools && sentTools.length));
}

group('а «остановись здесь» - это решение, а не ошибка');
{
  const { runGoal } = await import('./agent.js');
  let turn = 0;
  netHandler = async (url, init) => {
    if (!init || init.method === 'GET') return reply({ extensionModel: 'claude-opus-5' });
    turn++;
    return reply({ stop_reason: 'end_turn', content: [{ type: 'tool_use', id: 'c', name: 'reached_checkpoint',
      input: { n: 2, said: 'about to send it' } }] });
  };
  const out = await runGoal({
    goal: 'send it', apiKey: null, authToken: 'mf_test',
    plan: [{ title: 'Draft ready', detail: '' }, { title: 'About to send', detail: '' }],
    gate: async () => 'stop',
    execute: async () => ({ ok: true }), onEvent: () => {}, isAborted: () => false,
  });
  check('прогон остановился на первом же объявлении', turn === 1, String(turn));
  /* Одним словом «stopped» выбросило бы единственное, что здесь стоит знать: ГДЕ остановились и что
   * прогон об этом сказал. */
  check('и назвал место и слова, а не просто «остановлено»',
    out.ok === false && /Stopped at checkpoint 2 — About to send/.test(String(out.error))
      && /about to send it/.test(String(out.error)), String(out.error).slice(0, 90));
}

group('и без плана прогон идёт как раньше');
{
  const { runGoal } = await import('./agent.js');
  let sentTools = null;
  netHandler = async (url, init) => {
    if (!init || init.method === 'GET') return reply({ extensionModel: 'claude-opus-5' });
    sentTools = JSON.parse(init.body).tools.map((t) => t.name);
    return reply({ stop_reason: 'end_turn',
      content: [{ type: 'tool_use', id: 'f', name: 'finish', input: { ok: true, summary: 'done' } }] });
  };
  await runGoal({
    goal: 'just do it', apiKey: null, authToken: 'mf_test',
    execute: async () => ({ ok: true }), onEvent: () => {}, isAborted: () => false,
  });
  check('инструмента чекпоинта модели не показали',
    !!sentTools && !sentTools.includes('reached_checkpoint'), String(sentTools));
}

group('и ответ, которого никто не ждёт, - отказ, а не тихое ничего');
{
  const res = await send({ mf: 'agent/answer', answer: 'go' });
  check('отвечать нечему - и это сказано', !res.ok && /nothing is waiting/.test(String(res.error)),
    JSON.stringify(res));
}

group('знак «этой вкладкой управляют» - в странице, и не мешает ни человеку, ни модели');
{
  /* content.js DOM-зависим целиком, поэтому две функции вырезаются и исполняются против крошечной
   * заглушки - тот же приём, что с модификаторами. */
  const src = readFileSync(new URL('./content.js', import.meta.url), 'utf8');
  const cut = (name) => {
    const at = src.indexOf('function ' + name + '(');
    let depth = 0;
    for (let i = src.indexOf('{', at); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
    }
    return '';
  };
  const node = () => {
    const el = {
      attrs: {}, style: {}, kids: [], shadow: null, textContent: '', isConnected: false,
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(c) { this.kids.push(c); c.isConnected = true; return c; },
      attachShadow(opts) { this.shadow = { mode: opts.mode, kids: [], appendChild(c) { this.kids.push(c); } };
        return this.shadow; },
      remove() { this.isConnected = false; },
    };
    return el;
  };
  const body = node();
  const harness = `
    const SIGN_LIME = '#bdff7a';
    let IS_TOP = true;
    let sign = null;
    const document = { createElement: () => makeNode(), body };
    ${cut('showSign')}
    ${cut('hideSign')}
    return { showSign, hideSign, setTop: (v) => { IS_TOP = v; }, current: () => sign };
  `;
  // eslint-disable-next-line no-new-func
  // eslint-disable-next-line no-new-func
  const api = new Function('makeNode', 'body', harness)(node, body);

  api.showSign('MouseFlow is working in this tab');
  const host = body.kids[0];
  check('знак поставлен', !!host, 'nothing appended');
  /* СКВОЗНОЙ. Без этого он съедал бы каждый клик на странице - и человека, и агента. */
  check('и он сквозной для мыши', host.style.pointerEvents === 'none', String(host.style.pointerEvents));
  check('и помечен как наш, чтобы старую сборку было чем вымести',
    host.attrs['data-mouseflow'] === 'driving', String(host.attrs['data-mouseflow']));
  check('и спрятан от читалок - это состояние окна, а не часть страницы',
    host.attrs['aria-hidden'] === 'true', String(host.attrs['aria-hidden']));
  /* ЗАКРЫТАЯ ТЕНЬ - вот чем слова знака не попадают в document.body.innerText, который модель читает
   * как образец текста страницы. Открытая тень их бы туда тоже не пустила, но закрытая заодно
   * закрывает их и от скриптов самой страницы. */
  check('и живёт в ЗАКРЫТОМ теневом корне, а не в самой странице',
    host.shadow && host.shadow.mode === 'closed', JSON.stringify(host.shadow && host.shadow.mode));
  /* Через защищённый доступ: мутация, кладущая знак прямо в страницу, оставляет shadow пустым, и
   * прямое обращение уронило бы тест вместо того, чтобы покрасить его. */
  const inShadow = (i) => (host.shadow && host.shadow.kids[i]) || null;
  check('и в тени лежат рамка и подпись', !!host.shadow && host.shadow.kids.length === 2,
    String(host.shadow && host.shadow.kids.length));
  check('и подпись говорит, что происходит',
    !!inShadow(1) && inShadow(1).textContent === 'MouseFlow is working in this tab',
    String(inShadow(1) && inShadow(1).textContent));

  /* Второй вызов НЕ городит второй знак: агент действует много раз подряд в одной вкладке. */
  api.showSign('MouseFlow is replaying a recording here');
  check('второй вызов не ставит второй знак', body.kids.length === 1, String(body.kids.length));
  check('а только меняет подпись',
    !!inShadow(1) && inShadow(1).textContent === 'MouseFlow is replaying a recording here',
    String(inShadow(1) && inShadow(1).textContent));

  api.hideSign();
  check('и снимается', !host.isConnected, 'still connected');

  /* ТОЛЬКО ВЕРХНИЙ КАДР: иначе страница из четырёх iframe получила бы четыре рамки. */
  const body2 = node();
  const api2 = new Function('makeNode', 'body', harness)(node, body2);
  api2.setTop(false);
  api2.showSign('x');
  check('во вложенном кадре знака нет', body2.kids.length === 0, String(body2.kids.length));
}

group('и он переезжает за агентом по вкладкам, не оставляя следов позади');
{
  const bg = readFileSync(new URL('./background.js', import.meta.url), 'utf8');
  const cut = (name) => {
    const at = bg.indexOf('function ' + name + '(');
    let depth = 0;
    for (let i = bg.indexOf('{', at); i < bg.length; i++) {
      if (bg[i] === '{') depth++;
      else if (bg[i] === '}' && --depth === 0) return bg.slice(at, i + 1);
    }
    return '';
  };
  const sent = [];
  const stub = { tabs: { sendMessage: (id, m) => { sent.push([id, m.mf]); return Promise.resolve(); } } };
  // eslint-disable-next-line no-new-func
  const api = new Function('chrome', `
    let signedTab = null;
    ${cut('signOn')}
    ${cut('signsOff')}
    return { signOn, signsOff, where: () => signedTab };
  `)(stub);

  api.signOn(1, 'working');
  check('знак поставлен на рабочую вкладку', api.where() === 1, String(api.where()));
  /* Повторный вызов на ту же вкладку молчит: агент действует много раз подряд в одной, и сообщение на
   * каждое действие было бы платой ни за что. */
  sent.length = 0;
  api.signOn(1, 'working');
  check('и на ту же вкладку второй раз ничего не шлётся', sent.length === 0, JSON.stringify(sent));
  /* СО СТАРОЙ СНИМАЕТСЯ СРАЗУ. Иначе оставленная позади страница продолжала бы утверждать, что ею
   * управляют, - а ею уже нет. */
  api.signOn(2, 'working');
  check('переехал на новую', api.where() === 2, String(api.where()));
  check('и со старой снят', sent.some(([id, mf]) => id === 1 && mf === 'sign/off'), JSON.stringify(sent));

  sent.length = 0;
  api.signsOff([1, 2, 3, null, 2]);
  check('в конце снимается со ВСЕХ, по разу на вкладку',
    sent.filter(([, mf]) => mf === 'sign/off').length === 3, JSON.stringify(sent));
  check('и больше ни одна вкладка не помечена', api.where() === null, String(api.where()));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
