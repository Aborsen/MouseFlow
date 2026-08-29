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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
