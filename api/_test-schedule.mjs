/* Расписания: арифметика, которую человек глазами не проверит.
 *
 * ПОЧЕМУ ЭТО ЕСТЬ ВООБЩЕ. Вся функция сводится к одному числу - next_at, - и всё остальное в ней это
 * сравнение и одна запись. Значит единственное место, где расписание может соврать, - вычисление этого
 * числа, а врёт оно ровно в тех случаях, которые нельзя увидеть чтением: переход на летнее время, полночь,
 * выходные, «должно было в 09:00, а машина спала до обеда».
 *
 * Числа взяты у Украины, потому что там живёт человек, который это заказал: UTC+2 зимой, UTC+3 летом,
 * перевод в последнее воскресенье марта и октября. Проверяется ИСПОЛНЕНИЕМ через Intl - тот же путь, которым
 * считает продукт, - а не таблицей смещений, переписанной сюда руками: вторая таблица разошлась бы с
 * системной, и тест начал бы защищать собственную ошибку.
 *
 * Запуск: node api/_test-schedule.mjs
 */
import {
  CATCH_UP_MS, DEFER_GRACE_MS, FAILS_BEFORE_PAUSE, MAX_EVERY_MINUTES, MIN_EVERY_MINUTES,
  clockOf, clockSaid, decide, deferInstant, firstAt, instantOf, minutesOf, nextAfter, readRule, ruleSaid,
  whenSaid,
} from './_schedule.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const group = (t) => console.log('\n' + t);

const KIEV = 'Europe/Kiev';
const iso = (ms) => new Date(ms).toISOString();
const local = (ms, zone = KIEV) => new Intl.DateTimeFormat('en-CA', {
  timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(ms));

/* ------------------------------------------------------------------ пояс и переход */

group('«каждый день в 09:00» значит девять утра там, где человек живёт');

const daily = readRule({ at: '09:00', zone: KIEV }).rule;

const winter = nextAfter(daily, Date.parse('2026-01-15T12:00:00Z'));
check('зимой это 07:00 UTC - Киев на UTC+2', iso(winter) === '2026-01-16T07:00:00.000Z', iso(winter));
const summer = nextAfter(daily, Date.parse('2026-07-15T12:00:00Z'));
check('летом 06:00 UTC - на UTC+3, и это ДРУГОЕ число UTC для того же «девяти»',
  iso(summer) === '2026-07-16T06:00:00.000Z', iso(summer));
check('но местное время в обоих случаях ровно 09:00',
  local(winter) === '09:00' && local(summer) === '09:00', `${local(winter)} / ${local(summer)}`);

/* Ночь перевода вперёд, и здесь тест сначала ошибся сам - стоит записать. Я взял 02:30 как «несуществующий
 * час», рассуждая по аналогии с зонами, где переводят в два. В Киеве переводят в ТРИ: измерено - 00:59Z даёт
 * местное 02:59, а 01:00Z сразу 04:00, - то есть не существует 03:xx. Проверка, написанная по рассуждению, а
 * не по замеру, ловила бы правильный код. */
const jumpNight = Date.parse('2026-03-28T22:00:00Z');
const halfPastTwo = readRule({ at: '02:30', zone: KIEV }).rule;
const real = nextAfter(halfPastTwo, jumpNight);
check('02:30 в ту ночь существует - и остаётся 02:30',
  local(real) === '02:30', `${iso(real)} local ${local(real)}`);
const halfPastThreeSpring = readRule({ at: '03:30', zone: KIEV }).rule;
const ghost = nextAfter(halfPastThreeSpring, jumpNight);
check('а 03:30, которого в ту ночь нет вовсе, даёт момент сразу за переходом, а не отказ',
  ghost > jumpNight && local(ghost) === '04:30', `${iso(ghost)} local ${local(ghost)}`);
/* Ночь перевода назад: 25 октября 2026, 03:00 повторяется. Расписание обязано сработать один раз. */
const backNight = Date.parse('2026-10-24T22:00:00Z');
const halfPastThree = readRule({ at: '03:30', zone: KIEV }).rule;
const twice = nextAfter(halfPastThree, backNight);
const after = nextAfter(halfPastThree, twice);
check('в ночь перевода назад повтор не срабатывает дважды за одни сутки',
  after - twice > 20 * 3_600_000, `${iso(twice)} → ${iso(after)}`);

/* Полночь ловила «24» вместо «00» в части реализаций Intl и уезжала на сутки вперёд. */
const midnight = readRule({ at: '00:00', zone: KIEV }).rule;
const atMidnight = nextAfter(midnight, Date.parse('2026-02-10T21:00:00Z'));
check('полночь - это начало суток, а не их конец',
  local(atMidnight) === '00:00' && atMidnight - Date.parse('2026-02-10T21:00:00Z') < 86_400_000,
  `${iso(atMidnight)} local ${local(atMidnight)}`);

check('instantOf находит момент по местной стенке',
  local(instantOf({ year: 2026, month: 6, day: 1, minutes: 17 * 60 + 30 }, KIEV)) === '17:30');

/* ------------------------------------------------------------------ будни */

group('«по будням» считается по зоне расписания, а не по зоне сервера');

const weekdays = readRule({ at: '09:00', days: 'weekdays', zone: KIEV }).rule;
/* Пятница 2026-09-04, 12:00 по Киеву: следующий будний - понедельник 7-го. */
const fridayNoon = Date.parse('2026-09-04T09:00:00Z');
const monday = nextAfter(weekdays, fridayNoon);
check('после пятницы идёт понедельник, а не суббота',
  iso(monday).startsWith('2026-09-07'), iso(monday));
check('и это по-прежнему девять утра на месте', local(monday) === '09:00', local(monday));
check('а «every day» субботу не пропускает',
  iso(nextAfter(daily, fridayNoon)).startsWith('2026-09-05'), iso(nextAfter(daily, fridayNoon)));

/* ------------------------------------------------------------------ интервалы и разбор */

group('интервал читается словами человека, а cron-строкой не читается вовсе');

check('«1h» это шестьдесят минут', minutesOf('1h') === 60);
check('«30m» и «30» - одно и то же', minutesOf('30m') === 30 && minutesOf('30') === 30);
check('«2d» это двое суток', minutesOf('2d') === 2880);
check('а «0 * * * *» не читается - и не должен', minutesOf('0 * * * *') === null);
check('«09:00» это 540 минут от полуночи', clockOf('09:00') === 540 && clockOf('9:00') === 540);
check('«25:00» не время', clockOf('25:00') === null && clockOf('09:70') === null);

const tooOften = readRule({ every: '5m' });
check('чаще пятнадцати минут - отказ, и он называет причину',
  !!tooOften.why && /real mouse/.test(tooOften.why), tooOften.why);
check('пятнадцать минут - можно', readRule({ every: '15m' }).rule?.everyMinutes === MIN_EVERY_MINUTES);
check('дольше тридцати суток - это уже не расписание',
  !!readRule({ every: `${MAX_EVERY_MINUTES + 1}` }).why);
const badZone = readRule({ at: '09:00', zone: 'Europe/Kyv' });
check('несуществующая зона отвергается, а не считается как UTC',
  !!badZone.why && /time zone/.test(badZone.why), badZone.why);
check('и пустое правило спрашивает, а не додумывает', !!readRule({}).why);

const once = readRule({ once: '2026-09-03T09:00:00Z' });
check('разовое берёт названный момент как есть',
  once.rule.kind === 'once' && once.rule.nextAt === Date.parse('2026-09-03T09:00:00Z'));
check('и у разового нет следующего раза - это конец, а не ошибка',
  nextAfter(once.rule, once.rule.nextAt) === null);
check('firstAt у разового - сам момент, у повтора - ближайший по правилу',
  firstAt(once.rule, Date.now()) === once.rule.nextAt
    && firstAt(daily, Date.parse('2026-01-15T12:00:00Z')) === winter);

/* ------------------------------------------------------------------ такт */

group('что делать с подошедшим - решается арифметикой, а не настроением');

const every2h = readRule({ every: '2h', zone: KIEV }).rule;
const due = Date.parse('2026-09-02T09:00:00Z');

const onTime = decide({ rule: every2h, dueMs: due, nowMs: due + 2_000, busy: false });
check('вовремя - запускать', onTime.do === 'run' && /on time/.test(onTime.why));
check('и следующий раз считается ОТ СРОКА, а не от сейчас - иначе расписание уползает',
  onTime.nextAt === due + 120 * 60_000, iso(onTime.nextAt));

const late = decide({ rule: every2h, dueMs: due, nowMs: due + 10 * 60_000, busy: false });
check('опоздание в десять минут - всё ещё запуск, и опоздание названо',
  late.do === 'run' && /10 minutes late/.test(late.why), late.why);

const slept = decide({ rule: every2h, dueMs: due, nowMs: due + CATCH_UP_MS + 60_000, busy: false });
check('машина спала дольше получаса - пропуск, а не запуск задним числом', slept.do === 'miss');
check('и пропуск говорит, на сколько опоздали', /missed by 31 minutes/.test(slept.why), slept.why);
check('а следующий срок уже в будущем - расписание не догоняет пачкой',
  slept.nextAt > due + CATCH_UP_MS + 60_000, iso(slept.nextAt));

const busy = decide({ rule: every2h, dueMs: due, nowMs: due + 1_000, busy: true });
check('одна мышь: занято - такт уступается', busy.do === 'skip' && /one mouse|busy/.test(busy.why), busy.why);
const busyOnce = decide({ rule: once.rule, dueMs: due, nowMs: due + 1_000, busy: true });
check('но РАЗОВОЕ при занятой машине ждёт своего часа, а не теряется',
  busyOnce.do === 'skip' && busyOnce.nextAt === due);

const missedOnce = decide({ rule: once.rule, dueMs: due, nowMs: due + CATCH_UP_MS + 1, busy: false });
check('разовое, чей час прошёл при спящей машине, встаёт на паузу с причиной',
  missedOnce.do === 'miss' && missedOnce.nextAt === null && !!missedOnce.pause, missedOnce.pause);

/* Продвижение обязано быть СТРОГО в будущее относительно срока: иначе один и тот же момент подойдёт снова
 * на следующем такте через три секунды, и «каждые два часа» станет «каждые три секунды». */
let cursor = due;
let jumps = 0;
for (let i = 0; i < 5; i++) {
  const out = decide({ rule: every2h, dueMs: cursor, nowMs: cursor + 1_000, busy: false });
  if (out.nextAt > cursor) jumps++;
  cursor = out.nextAt;
}
check('пять срабатываний подряд двигают срок вперёд каждый раз', jumps === 5);
check('и за пять раз это ровно десять часов', cursor === due + 10 * 3_600_000, iso(cursor));

/* ------------------------------------------------------------------ как это читается */

group('и то, что человек прочитает, - тоже проверяемо');

check('интервал словами', ruleSaid(every2h) === 'every 2 hours' && ruleSaid(readRule({ every: '1d' }).rule) === 'every 1 day');
check('время суток словами, с зоной - без неё «09:00» ничего не значит',
  ruleSaid(daily) === 'every day at 09:00 Europe/Kiev');
check('будни называются буднями', ruleSaid(weekdays).startsWith('weekdays at 09:00'));
check('момент печатается местным временем расписания, с днём недели',
  whenSaid(winter, KIEV) === 'Fri 2026-01-16 09:00 (Europe/Kiev)', whenSaid(winter, KIEV));
check('и «больше никогда» - это тоже ответ', whenSaid(null, KIEV) === 'never again');
check('порог неудач назван числом, а не спрятан', FAILS_BEFORE_PAUSE === 3);

/* ---------------------------------------------------------------- цель, назвавшая время
 *
 * Прогон, получивший «в 19:41 открой ChatGPT и напиши Continue», строил таймер из PowerShell: у него не было
 * ни часов, ни слова «позже». Здесь проверяется слово - и то, что «уже наступило» не становится расписанием
 * на секунду вперёд. */
group('цель, назвавшая время впереди, откладывается на этот момент - а не ждёт его таймером');
{
  const now = Date.UTC(2026, 8, 8, 16, 13, 7);   // 19:13:07 в Киеве, лето
  const later = deferInstant({ at: '19:41', zone: KIEV, nowMs: now });
  check('«19:41» сегодня в Киеве - это 16:41Z сегодня', iso(later.atMs) === '2026-09-08T16:41:00.000Z', iso(later.atMs));
  check('часы для модели - местные, с секундами, днём и зоной',
    clockSaid(now, KIEV) === '19:13:07 on Tue 2026-09-08 (Europe/Kiev)', clockSaid(now, KIEV));

  const sameMinute = deferInstant({ at: '19:13', zone: KIEV, nowMs: now });
  check('время, которое сейчас, - не «потом»: отказ с часами, а не расписание на секунду вперёд',
    sameMinute.now === true && /is now - it is 19:13:07/.test(sameMinute.why), sameMinute.why);
  const justPassed = deferInstant({ at: '19:00', zone: KIEV, nowMs: now });
  check('время, прошедшее тринадцать минут назад, - ещё «сейчас»: просивший «в 19:00» ждёт письма, а не завтра',
    justPassed.now === true);
  check('и окно этой поблажки - то же, что у догона расписания', DEFER_GRACE_MS === CATCH_UP_MS);

  const morning = deferInstant({ at: '09:00', zone: KIEV, nowMs: now });
  check('время, прошедшее давно, значит завтра', iso(morning.atMs) === '2026-09-09T06:00:00.000Z', iso(morning.atMs));
  const instant = deferInstant({ at: '2026-09-08T16:20:00Z', zone: KIEV, nowMs: now });
  check('ISO-мгновение берётся как есть', instant.atMs === Date.parse('2026-09-08T16:20:00Z'));
  const within = deferInstant({ at: '2026-09-08T16:13:40Z', zone: KIEV, nowMs: now });
  check('мгновение в пределах минуты - тоже «сейчас»', within.now === true);

  check('нечитаемое время - отказ словами, а не NaN',
    /is not a time I can read/.test(deferInstant({ at: 'soon', zone: KIEV, nowMs: now }).why));
  check('пустое - вопрос «когда?»', /when\?/.test(deferInstant({ at: '', zone: KIEV, nowMs: now }).why));
  check('неизвестная зона - отказ, а не UTC молча',
    /not a time zone/.test(deferInstant({ at: '19:41', zone: 'Mars/Olympus', nowMs: now }).why));
  check('дальше тридцати суток - напоминание, а не прогон',
    /thirty days/.test(deferInstant({ at: '2026-11-01T10:00:00Z', zone: KIEV, nowMs: now }).why));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
