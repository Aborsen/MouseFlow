/* Когда наступит следующий раз - и почему это отдельный модуль с исполняемыми тестами.
 *
 * ВСЯ ФУНКЦИЯ РАСПИСАНИЯ СВОДИТСЯ К ОДНОМУ ЧИСЛУ: next_at. Проверка «пора?» - это сравнение, продвижение
 * после запуска - одна запись. Значит единственное место, где эта функция может врать, - вычисление этого
 * числа, и оно обязано проверяться ВЫЧИСЛЕНИЕМ, а не чтением: «каждый день в 09:00» - утверждение о часовом
 * поясе, переходе на летнее время и границе суток, то есть о трёх вещах, которые человек глазами не
 * проверит.
 *
 * ПОЯС ХРАНИТСЯ, А НЕ УГАДЫВАЕТСЯ. В этом продукте нигде нет часового пояса: браузер знает свой, сервер не
 * знает никакого. «09:00» без пояса молча значит 09:00 UTC - для человека, который просил, это середина
 * ночи. Поэтому зона едет вместе с расписанием (см. db/018), а здесь по ней считается настоящий момент.
 *
 * БЕЗ ЗАВИСИМОСТЕЙ, через Intl. Node 24 приезжает с полным ICU, так что `Intl.DateTimeFormat` с timeZone
 * знает и Europe/Kiev, и его переходы. Тащить сюда tzdata-библиотеку ради двух функций значило бы добавить
 * мегабайты в проект, где зависимостей почти нет, - и вторую таблицу правил, которая расходится с системной.
 *
 * ЧТО ЗДЕСЬ НЕ ПРОИСХОДИТ: ни одного обращения к базе. Модуль чистый нарочно - его вызывают и маршрут
 * приложения, и MCP, и проверка на claim, и тест, и все четыре обязаны получать один ответ.
 */

/** Пределы, названные здесь, чтобы их можно было сравнить рядом. */
/* Пятнадцать минут - минимальный интервал повтора.
 *
 * Не «чтобы не нагружать»: прогон двигает НАСТОЯЩУЮ мышь на чьей-то машине, и повтор чаще четверти часа -
 * это машина, за которой нельзя работать. Плюс целевой скилл платит модели за каждый шаг; «каждые пять
 * минут» это 288 прогонов в сутки, и счёт за них человек увидит позже, чем согласился. */
export const MIN_EVERY_MINUTES = 15;
/** И потолок: раз в тридцать суток. Дальше это не расписание, а напоминание, и его место в календаре. */
export const MAX_EVERY_MINUTES = 60 * 24 * 30;

/* Насколько поздно ещё имеет смысл догонять пропущенное.
 *
 * Машина спала - самый частый исход у любого домашнего расписания, и здесь он обязан быть решением, а не
 * случайностью. Полчаса: «должно было в 09:00, ноутбук открыли в 09:20» - это ровно тот случай, когда
 * человек ждёт, что задача всё-таки выполнится. Открыли в 14:00 - выполнять утреннюю работу задним числом
 * почти всегда хуже, чем не выполнять, поэтому она отмечается пропущенной и ждёт следующего срока. */
export const CATCH_UP_MS = 30 * 60_000;

/** Столько подряд неудач подряд - и расписание встаёт на паузу само. */
export const FAILS_BEFORE_PAUSE = 3;

/* --------------------------------------------------------------------------- пояса */

/* Части местного времени для мгновения UTC. en-CA даёт ISO-подобный порядок, но читаются здесь ЧАСТИ, а не
 * строка: формат локали - не контракт. */
const partsIn = (utcMs, zone) => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const out = {};
  for (const part of fmt.formatToParts(new Date(utcMs))) out[part.type] = part.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    /* «24» вместо «00» приезжает от hour12:false в части реализаций - полночь как конец суток, а не как их
     * начало. Без этой строки полночь съезжала на сутки вперёд. */
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: out.weekday,
  };
};

/** Смещение зоны в миллисекундах для этого мгновения: local - utc. */
const offsetAt = (utcMs, zone) => {
  const p = partsIn(utcMs, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (Math.floor(utcMs / 1000) * 1000);
};

/**
 * Мгновение UTC, у которого местное время в этой зоне - ровно указанная стенка.
 *
 * ДВА ПРОХОДА, И ВТОРОЙ - НЕ ПЕДАНТИЗМ. Смещение зависит от момента, а момент - от смещения: в сутки
 * перехода на летнее время первая догадка берёт вчерашнее смещение и промахивается на час. Второй проход
 * считает смещение уже в найденной точке. Третьего не нужно: смещения меняются на величины, много большие
 * ошибки второго прохода.
 *
 * Час, которого не существует (02:30 в ночь перевода вперёд), даёт момент сразу за переходом - это ближайшее
 * настоящее время к тому, что просили, и лучше отказа: расписание, которое раз в год не сработало из-за
 * астрономии, читается как поломка.
 */
export function instantOf({ year, month, day, minutes }, zone) {
  const wall = Date.UTC(year, month - 1, day, 0, 0, 0) + minutes * 60_000;
  let guess = wall - offsetAt(wall, zone);
  guess = wall - offsetAt(guess, zone);
  return guess;
}

/** Местные сутки этого мгновения плюс `add` дней. */
const dayIn = (utcMs, zone, add = 0) => {
  const p = partsIn(utcMs, zone);
  const at = Date.UTC(p.year, p.month - 1, p.day) + add * 86_400_000;
  const d = new Date(at);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
};

/** Будний ли этот местный день. Считается ПО ЗОНЕ расписания: пятница в Киеве - суббота в Окленде. */
const isWeekday = (utcMs, zone) => {
  const w = partsIn(utcMs, zone).weekday;
  return w !== 'Sat' && w !== 'Sun';
};

/* --------------------------------------------------------------------------- правило */

/**
 * Разобрать правило или сказать, что с ним не так. Ничего не бросает: отказ - это строка для человека и
 * для модели, а не исключение.
 *
 * @returns {{rule: object} | {why: string}}
 */
export function readRule(said) {
  const it = said && typeof said === 'object' ? said : {};
  const zone = String(it.zone || 'UTC').trim() || 'UTC';
  /* Зона проверяется ИСПОЛНЕНИЕМ - Intl бросает на неизвестной. Принять «Europe/Kyv» и считать по UTC
   * значило бы построить расписание, которое сработает не тогда, когда обещало. */
  try { partsIn(Date.now(), zone); } catch (_) {
    return { why: `"${zone}" is not a time zone this system knows. Pass an IANA name like "Europe/Kiev".` };
  }

  if (it.once) {
    const at = Date.parse(it.once);
    if (!Number.isFinite(at)) {
      return { why: `"${it.once}" is not a date I can read. Pass an ISO instant like "2026-09-03T09:00:00Z", `
        + 'or use `at` with `days` for something that repeats.' };
    }
    return { rule: { kind: 'once', zone, nextAt: at } };
  }

  if (it.every != null) {
    const minutes = minutesOf(it.every);
    if (minutes == null) {
      return { why: `"${it.every}" is not an interval I can read. Try "30m", "1h", "6h" or "1d".` };
    }
    if (minutes < MIN_EVERY_MINUTES) {
      return { why: `Every ${minutes} minutes is too often: the floor is ${MIN_EVERY_MINUTES} minutes. A run `
        + 'drives the real mouse on that machine, so anything faster is a machine nobody can work at.' };
    }
    if (minutes > MAX_EVERY_MINUTES) {
      return { why: 'Longer than thirty days is a reminder rather than a schedule. Use `at` with `days`.' };
    }
    return { rule: { kind: 'every', zone, everyMinutes: minutes } };
  }

  if (it.at != null) {
    const minutes = clockOf(it.at);
    if (minutes == null) {
      return { why: `"${it.at}" is not a time of day I can read. Pass "09:00" or "17:30".` };
    }
    const days = String(it.days || 'all');
    if (days !== 'all' && days !== 'weekdays') {
      return { why: `"${days}" is not a set of days I know. Pass "all" or "weekdays".` };
    }
    return { rule: { kind: 'daily', zone, atMinutes: minutes, days } };
  }

  return { why: 'When should it run? Pass `every` ("1h"), or `at` ("09:00") with optional `days`, or `once` '
    + 'with an ISO instant.' };
}

/** «30m» / «90` / «1h» / «2d» в минуты, или null. */
export function minutesOf(said) {
  const text = String(said).trim().toLowerCase();
  const m = text.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] || 'm';
  if (unit.startsWith('h')) return n * 60;
  if (unit.startsWith('d')) return n * 1440;
  return n;
}

/** «09:00» / «9:00» / «17.30» в минуты от полуночи, или null. */
export function clockOf(said) {
  const m = String(said).trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/* --------------------------------------------------------------------------- следующий раз */

/**
 * Когда это должно сработать в следующий раз ПОСЛЕ `fromMs`. Строго после: иначе продвижение после запуска
 * вернуло бы тот же момент и расписание сработало бы дважды за одну секунду.
 *
 * Для 'once' возвращается null: у него нет следующего раза, и это не ошибка, а конец.
 */
export function nextAfter(rule, fromMs) {
  if (rule.kind === 'once') return null;
  if (rule.kind === 'every') return fromMs + rule.everyMinutes * 60_000;

  /* daily: ближайшие сутки, у которых местная стенка позже fromMs и день подходит по `days`. Перебор, а не
   * арифметика: суток в году мало, а переход на летнее время делает «плюс 86 400 000» неверным. */
  for (let add = 0; add <= 8; add++) {
    const day = dayIn(fromMs, rule.zone, add);
    const at = instantOf({ ...day, minutes: rule.atMinutes }, rule.zone);
    if (at <= fromMs) continue;
    if (rule.days === 'weekdays' && !isWeekday(at, rule.zone)) continue;
    return at;
  }
  /* Недостижимо при days из двух значений; возвращать «через сутки» молча было бы хуже, чем сказать. */
  return null;
}

/** Первый раз для нового расписания: для 'once' - названный момент, иначе ближайший по правилу. */
export function firstAt(rule, nowMs) {
  if (rule.kind === 'once') return rule.nextAt;
  return nextAfter(rule, nowMs);
}

/* --------------------------------------------------------------------------- решение на такте */

/**
 * ЧТО ДЕЛАТЬ С ПОДОШЕДШИМ РАСПИСАНИЕМ. Чистая функция, потому что решение здесь важнее записи в базу:
 * «пропустить», «догнать» и «запустить» различаются на минуты, и различие обязано быть проверяемым.
 *
 * @returns {{ do: 'run'|'skip'|'miss', why: string, nextAt: number|null, pause?: string }}
 */
export function decide({ rule, dueMs, nowMs, busy }) {
  const late = nowMs - dueMs;

  /* ОДНА МЫШЬ - и это не оптимизация, а то же правило, что у ручного запуска: пока машина занята, второй
   * прогон не ставится в очередь. Разовое ждёт своего часа - его момент ещё не прошёл безвозвратно; повтор
   * уступает такт, потому что следующий будет всё равно. */
  if (busy) {
    return rule.kind === 'once'
      ? { do: 'skip', why: 'the machine was busy with another run; this waits', nextAt: dueMs }
      : { do: 'skip', why: 'the machine was busy with another run; this tick was skipped',
        nextAt: nextAfter(rule, nowMs) };
  }

  /* ОПОЗДАЛИ БОЛЬШЕ, ЧЕМ ИМЕЕТ СМЫСЛ ДОГОНЯТЬ. Самый частый случай: машина спала. Выполнять утреннюю
   * работу в обед почти всегда хуже, чем не выполнять, - и молчать об этом нельзя, поэтому это отдельный
   * исход со своим счётчиком, а не тихое продвижение. */
  if (late > CATCH_UP_MS) {
    const missed = Math.round(late / 60_000);
    if (rule.kind === 'once') {
      return {
        do: 'miss',
        why: `it was due ${missed} minutes ago and the machine was not taking work then, which is too late `
          + 'to run it now',
        nextAt: null,
        pause: 'the one time it was set for passed while nothing was listening',
      };
    }
    return {
      do: 'miss',
      why: `missed by ${missed} minutes - nothing was listening when it was due`,
      nextAt: nextAfter(rule, nowMs),
    };
  }

  return {
    do: 'run',
    why: late > 60_000 ? `started ${Math.round(late / 60_000)} minutes late` : 'started on time',
    nextAt: rule.kind === 'once' ? null : nextAfter(rule, dueMs),
  };
}

/* --------------------------------------------------------------------- цель, назвавшая время

/* НАСКОЛЬКО ДАВНО НАЗВАННОЕ ВРЕМЯ ЕЩЁ ЗНАЧИТ «СЕЙЧАС». То же окно, что у догона пропущенного расписания, и по
 * той же причине: «в 19:41 отправь» в 19:50 - это ещё та самая просьба, в 14:00 следующего дня - уже нет. */
export const DEFER_GRACE_MS = CATCH_UP_MS;

/* А ВПЕРЁД - СЕКУНДЫ. Здесь стояла минута, и «в 19:54», сказанное в 19:53:29, было исполнено сразу: на
 * тридцать одну секунду раньше и без очереди. Время, которое ещё не наступило, - это «потом», сколько бы до
 * него ни оставалось; десять секунд - только запас на то, что часы драйвера и часы базы, по которым
 * расписание сработало, не одни и те же. */
export const DEFER_NOW_MS = 10_000;

/**
 * Момент, на который цель просит отложить работу, - или отказ, если откладывать нечего.
 *
 * ЗАЧЕМ ЭТО ЗДЕСЬ, А НЕ В ЦИКЛЕ РЕШЕНИЙ. Прогон, получивший «в 19:41 открой ChatGPT и напиши Continue», не
 * имеет ни часов, ни понятия «позже»: единственное ожидание в его словаре - `wait` до двух минут, «пока
 * экран не успокоится». Он честно строит таймер из того, что видит на экране, - PowerShell и цикл с
 * Get-Date, - и дёргает компьютер каждые четыреста миллисекунд до назначенного часа. Правильный ответ на
 * «сделай в 19:41» - не ждать, а стать разовым расписанием на 19:41 и отпустить мышь; это оно и считает.
 *
 * `at` - «HH:MM» в зоне человека или ISO-мгновение. Время суток без даты значит ближайшее: сегодня, если
 * оно впереди, иначе завтра. Время, которое уже наступило или наступит в пределах минуты, - это не «потом»,
 * это «сейчас», и вызывающий получает `now: true`, чтобы продолжить работу, а не ставить расписание на
 * секунду вперёд. Время, прошедшее не дальше DEFER_GRACE_MS, - тоже «сейчас»: человек, сказавший «в 19:41»
 * в 19:45, ждёт письма, а не следующего дня.
 *
 * @returns {{atMs: number} | {now: true, why: string} | {why: string}}
 */
export function deferInstant({ at, zone, nowMs = Date.now() }) {
  const said = String(at == null ? '' : at).trim();
  if (!said) return { why: 'when? pass `at` as "HH:MM" in the user\'s zone, or an ISO instant' };
  const tz = String(zone || 'UTC');
  try { partsIn(nowMs, tz); } catch (_) {
    return { why: `"${tz}" is not a time zone this system knows` };
  }

  let atMs;
  const clock = clockOf(said);
  if (clock != null) {
    const today = instantOf({ ...dayIn(nowMs, tz), minutes: clock }, tz);
    /* Сегодня, если впереди; если оно только что прошло - «сейчас» (см. ниже); иначе завтра. */
    atMs = today >= nowMs - DEFER_GRACE_MS ? today : instantOf({ ...dayIn(nowMs, tz, 1), minutes: clock }, tz);
  } else {
    atMs = Date.parse(said);
    if (!Number.isFinite(atMs)) {
      return { why: `"${said}" is not a time I can read. Pass "HH:MM" like "19:41", or an ISO instant.` };
    }
  }

  if (atMs <= nowMs + DEFER_NOW_MS) {
    return {
      now: true,
      why: `${whenSaid(atMs, tz)} is now - it is ${clockSaid(nowMs, tz)}. Do not wait for it; carry out `
        + 'the rest of the goal.',
    };
  }
  if (atMs > nowMs + MAX_EVERY_MINUTES * 60_000) {
    return { why: 'That is more than thirty days away, which is a reminder rather than a run. Say so and finish.' };
  }
  return { atMs };
}

/** Который час, словами для модели: «19:13:07 on Tue 2026-09-08 (Europe/Kiev)». */
export function clockSaid(utcMs, zone) {
  const p = partsIn(utcMs, zone);
  const hh = String(p.hour).padStart(2, '0');
  const mm = String(p.minute).padStart(2, '0');
  const ss = String(p.second).padStart(2, '0');
  return `${hh}:${mm}:${ss} on ${p.weekday} ${p.year}-${String(p.month).padStart(2, '0')}-`
    + `${String(p.day).padStart(2, '0')} (${zone})`;
}

/* --------------------------------------------------------------------------- как это читается */

/** Правило словами - для списка, для ответа модели и для строки в интерфейсе. */
export function ruleSaid(rule) {
  if (rule.kind === 'once') return `once, at ${new Date(rule.nextAt).toISOString()}`;
  if (rule.kind === 'every') {
    const m = rule.everyMinutes;
    if (m % 1440 === 0) return `every ${m / 1440} day${m === 1440 ? '' : 's'}`;
    if (m % 60 === 0) return `every ${m / 60} hour${m === 60 ? '' : 's'}`;
    return `every ${m} minutes`;
  }
  const hh = String(Math.floor(rule.atMinutes / 60)).padStart(2, '0');
  const mm = String(rule.atMinutes % 60).padStart(2, '0');
  return `${rule.days === 'weekdays' ? 'weekdays' : 'every day'} at ${hh}:${mm} ${rule.zone}`;
}

/** Момент местным временем расписания - «Wed 09:00 (Europe/Kiev)». */
export function whenSaid(utcMs, zone) {
  if (utcMs == null) return 'never again';
  const p = partsIn(utcMs, zone);
  const two = (n) => String(n).padStart(2, '0');
  return `${p.weekday} ${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)} (${zone})`;
}

/** Строка расписания в правило - обратно из того, что лежит в базе. */
export const ruleOf = (row) => ({
  kind: row.kind,
  zone: row.zone || 'UTC',
  everyMinutes: row.every_minutes ?? undefined,
  atMinutes: row.at_minutes ?? undefined,
  days: row.days || 'all',
  nextAt: row.next_at ? new Date(row.next_at).getTime() : null,
});
