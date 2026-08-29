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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
