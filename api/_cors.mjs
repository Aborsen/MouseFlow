/* Кому браузер разрешит прочитать наш ответ. Одно определение на все маршруты.
 *
 * ПОЧЕМУ ОДНО. Семь маршрутов несли по своей копии этих четырёх строк, шесть были одинаковы, а седьмой -
 * api/chats.js - расходился так:
 *
 *     res.setHeader('Access-Control-Allow-Origin', origin);      // любой присланный
 *     res.setHeader('Access-Control-Allow-Credentials', 'true');
 *
 * Вместе это значит: страница на evil.example делает fetch с credentials:'include', браузер прикладывает
 * сессионную куку человека, сервер отражает evil.example и разрешает читать - и страница читает. За этим
 * маршрутом лежат разговоры с ассистентом: полный текст каждого вопроса и каждого ответа. Allow-Methods
 * там же перечисляет DELETE, так что их можно было ещё и стереть.
 *
 * Комментарий у шести соседей объясняет ровно то, чего седьмой не делал: «Not setting Allow-Credentials is
 * what stops a cross-site page spending someone's session». Правило было записано и нарушено в соседнем
 * файле; одинокая копия - это и есть механизм, которым такое случается.
 *
 * НАЙДЕНО ИСПОЛНЕНИЕМ. Аудит читал исходники и это пропустил: чтобы увидеть, нужно было послать запрос с
 * чужим Origin и посмотреть на заголовки ответа. Первый же такой запрос к живому развёртыванию вернул
 * `access-control-allow-origin: https://evil.example` и `allow-credentials: true`.
 *
 * ЧТО ЗДЕСЬ НАМЕРЕННО НЕ ДЕЛАЕТСЯ. Allow-Credentials не ставится нигде. Приложение с API однодоменно, так
 * что CORS к нему не применяется вовсе; расширение присылает токен заголовком, а не кукой. То есть куке
 * незачем ездить кросс-доменно ни в одном настоящем случае - а значит и разрешать это незачем.
 */

/** Собственные адреса продукта. Два, потому что развёртывания два. */
const OURS = new Set([
  'https://mouseflowapp.vercel.app',
  'https://mouse-agent.vercel.app',
]);

/* Куда указывать, когда спросил кто-то посторонний. Значение всё равно ничего не разрешает - оно просто
 * обязано быть одним конкретным адресом, - но называть надо тот, на котором приложение и живёт: раньше
 * здесь стоял mouse-agent, а работает всё на mouseflowapp, и заголовок описывал не то развёртывание. */
const CANONICAL = 'https://mouseflowapp.vercel.app';

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} methods  какие методы этот маршрут действительно принимает
 */
export function cors(req, res, methods = 'GET, POST, OPTIONS') {
  const origin = String((req.headers && req.headers.origin) || '');
  /* Расширение отражается: его origin - chrome-extension://<id>, он у каждой установки свой, и
   * перечислить их нельзя.
   *
   * Проверка та же, что стояла в шести копиях до этого файла, буква в букву. Напрашивалось ужесточить её
   * до «ровно 32 строчные буквы» - настоящий id расширения выглядит так, - но это изменение поведения,
   * проверить которое можно только установленным расширением, а выигрыша нет: отражение само по себе
   * ничего не разрешает, пока Allow-Credentials не стоит нигде. Менять то, что нельзя проверить, ради
   * аккуратности - это ровно тот обмен, который здесь не делают. */
  const allow = /^chrome-extension:\/\//.test(origin) || OURS.has(origin)
    ? origin
    : CANONICAL;
  res.setHeader('Access-Control-Allow-Origin', allow);
  /* Ответ зависит от Origin - без этого кэш отдал бы одному origin ответ, приготовленный для другого. */
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}
