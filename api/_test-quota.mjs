/* Правило отступления при переполнении диска - ИСПОЛНЕНИЕМ.
 *
 * Проверяется здесь ровно одно свойство, и оно того стоит: запись, у которой нет второй копии на аккаунте,
 * НЕ отдаёт свои события ни при каких обстоятельствах. Всё остальное в этом правиле - про место на диске;
 * это - про то, потеряет ли человек свою работу.
 *
 * Регулярка над исходником прошла бы и на коде, отсортированном не в ту сторону, и на коде, где фильтр по
 * `syncedAt` стоит после `slice`. Поэтому - выполнение.
 *
 * Запуск: node api/_test-quota.mjs
 */
import { freeingOrder, heldElsewhere } from './_quota.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const group = (t) => console.log('\n' + t);

const events = (n) => Array.from({ length: n }, (_, i) => ({ x: i, y: i, action: 'Mouse Movement', delayMs: 1 }));
const synced = (id, n) => ({ id, name: id, syncedAt: '2026-08-28T00:00:00.000Z', events: events(n) });
const local = (id, n) => ({ id, name: id, events: events(n) });

group('что отдаёт события, и в каком порядке');
check('самая большая первой',
  JSON.stringify(freeingOrder([synced('small', 10), synced('big', 900), synced('mid', 100)]))
    === JSON.stringify(['big', 'mid', 'small']));
check('пустая запись не в очереди - отдавать нечего',
  JSON.stringify(freeingOrder([synced('has', 5), { id: 'empty', syncedAt: 'x', events: [] }]))
    === JSON.stringify(['has']));
/* Порядок при равенстве фиксирован, иначе тест иногда проходит - а это хуже, чем не иметь его. */
check('одинаковые по размеру идут в устойчивом порядке',
  JSON.stringify(freeingOrder([synced('b', 50), synced('a', 50)])) === JSON.stringify(['a', 'b']));

group('ТО, ЧЕГО НЕТ НА АККАУНТЕ, НЕ ОТДАЁТ НИЧЕГО');
/* Единственная копия. Выложить её события значит их потерять - то есть сделать ровно то, ради чего всё это
 * и написано. Она может быть какой угодно большой: размер здесь не аргумент. */
check('запись без штампа не попадает в очередь никогда',
  JSON.stringify(freeingOrder([local('mine', 99999), synced('theirs', 1)]))
    === JSON.stringify(['theirs']));
check('и даже когда она единственная - очередь пуста, а не «ну ладно»',
  JSON.stringify(freeingOrder([local('only', 99999)])) === JSON.stringify([]));
check('пустой штамп - это отсутствие штампа',
  JSON.stringify(freeingOrder([{ id: 'x', syncedAt: '', events: events(10) }])) === JSON.stringify([]));
check('и heldElsewhere отвечает то же самое',
  heldElsewhere(synced('a', 1)) === true && heldElsewhere(local('b', 1)) === false
    && heldElsewhere(null) === false);

group('мусор на входе не роняет и не выдумывает');
check('не массив - пустая очередь', JSON.stringify(freeingOrder(null)) === JSON.stringify([]));
check('дыры в списке пропускаются',
  JSON.stringify(freeingOrder([null, undefined, synced('ok', 3)])) === JSON.stringify(['ok']));
check('запись без событий вовсе не роняет',
  JSON.stringify(freeingOrder([{ id: 'no-events', syncedAt: 'x' }])) === JSON.stringify([]));
check('и запись без id тоже',
  JSON.stringify(freeingOrder([{ syncedAt: 'x', events: events(5) }])) === JSON.stringify([]));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
