/* Память о приложениях, проверенная исполнением — MEMORY-PLAN.md §4, §5 шаг 2.
 *
 * Тот же принцип, что у _test-expect.mjs и _test-schedule.mjs: единственное место, где эта функция может
 * соврать, - редакция (4.5) и вытеснение (4.10), и оба обязаны проверяться вычислением, а не чтением.
 *
 * Run: node api/_test-memory.mjs
 */
import { builtinEntries, fitBlock, KEY_BUDGET, MAX_NAME_LENGTH, parseKey, PROVENANCE, redactionProblem, webKeyFor, writeMemory } from './_memory.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const group = (t) => console.log('\n' + t);

group('ключ разбирается по форме 4.3, а не угадывается');
{
  check('win32:process', JSON.stringify(parseKey('win32:WindowsTerminal')) === JSON.stringify({ platform: 'win32', id: 'WindowsTerminal' }));
  check('darwin:bundle id', JSON.stringify(parseKey('darwin:com.apple.mail')) === JSON.stringify({ platform: 'darwin', id: 'com.apple.mail' }));
  check('web:origin', JSON.stringify(parseKey('web:outlook.office.com')) === JSON.stringify({ platform: 'web', id: 'outlook.office.com' }));
  check('web с портом - это ещё origin', parseKey('web:localhost:3000') && parseKey('web:localhost:3000').id === 'localhost:3000');
  check('неизвестная платформа - null', parseKey('android:Gmail') === null);
  check('без платформы вовсе - null', parseKey('WindowsTerminal') === null);
  check('пусто - null, не бросает', parseKey('') === null && parseKey(null) === null && parseKey(undefined) === null);
  check('web с путём - null: origin, а не адрес', parseKey('web:outlook.office.com/mail') === null);
  check('web с запросом - null', parseKey('web:outlook.office.com?x=1') === null);
  check('win32 с пробелом - null', parseKey('win32:two words') === null);
}

group('web-ключ из настоящего URL - origin, без пути и без запроса');
{
  check('путь и запрос отрезаны', webKeyFor('https://outlook.office.com/mail/inbox?x=1') === 'web:outlook.office.com');
  check('схема не обязательна на входе', webKeyFor('mail.google.com/mail/u/0') === 'web:mail.google.com');
  check('порт сохраняется - он часть origin', webKeyFor('http://localhost:3000/app') === 'web:localhost:3000');
  check('не http(s) - null', webKeyFor('ftp://files.example.com') === null);
  check('мусор - null, не бросает', webKeyFor('not a url at all ??') === null);
  check('пусто - null', webKeyFor('') === null && webKeyFor(null) === null);
}

group('редакция (4.5): что нельзя запомнить, ни при каких обстоятельствах');
{
  check('координата в тексте', redactionProblem({ body: 'Click 1814,246 to send' }) != null);
  check('и это её причина, а не общая', /coordinate/.test(redactionProblem({ body: 'Click 1814,246 to send' })));
  check('обычные числа через запятую - не координата (короткие)', redactionProblem({ body: 'kept 3 of 12, all fine' }) === null);
  check('имя длиннее 60 символов', redactionProblem({ name: 'x'.repeat(61), body: 'ok' }) != null);
  check('а 60 - ещё можно, ровно как у RecordName', redactionProblem({ name: 'x'.repeat(MAX_NAME_LENGTH), body: 'ok' }) === null);
  check('URL с запросом в тексте', redactionProblem({ body: 'the page is https://mail.google.com/mail/u/0?compose=new' }) != null);
  check('а без запроса - можно', redactionProblem({ body: 'the page is https://mail.google.com/mail/u/0' }) === null);
  check('поле пароля - флагом', redactionProblem({ body: 'the password field', secret: true }) != null);
  check('поле пароля - и по тексту агента, дословно', redactionProblem({ body: '"Password" at 10,10 = (password, not read)' }) != null);
  check('обычный текст без имён - можно', redactionProblem({ body: 'the send button sits just right of "Attach"' }) === null);
}

group('writeMemory: ключ и редакция проверяются вместе, отказ - словами');
{
  const ok = writeMemory({ key: 'web:outlook.office.com', provenance: 'taught', body: 'the stable part of the title is " - Outlook"' });
  check('запись строится', ok.ok === true, JSON.stringify(ok));
  check('provenance сохранён', ok.ok && ok.entry.provenance === 'taught');
  check('taught живёт сразу', ok.ok && ok.entry.state === 'live');

  const learned = writeMemory({ key: 'win32:Outlook', provenance: 'learned', body: 'the compose window appears after ~1.5s', runId: 'r8kd2' });
  check('learned ждёт согласия (4.4, 4.7)', learned.ok && learned.entry.state === 'pending', JSON.stringify(learned));

  const derived = writeMemory({ key: 'win32:Outlook', provenance: 'derived', body: '"Reading Pane" is the most-named control here', version: 3 });
  check('derived несёт версию формулы', derived.ok && derived.entry.version === 3);

  check('builtin - не то, что пишет вызывающий', writeMemory({ key: 'win32:Outlook', provenance: 'builtin', body: 'x' }).ok === false);
  check('неизвестный provenance - отказ', writeMemory({ key: 'win32:Outlook', provenance: 'guessed', body: 'x' }).ok === false);
  check('плохой ключ - отказ словами про 4.3', /4\.3/.test(writeMemory({ key: 'nope', provenance: 'taught', body: 'x' }).why || ''));
  check('пустое тело - отказ', writeMemory({ key: 'win32:Outlook', provenance: 'taught', body: '' }).ok === false);
  check('координата в теле - отказ и здесь, не только в redactionProblem', writeMemory({ key: 'win32:Outlook', provenance: 'taught', body: 'click 500,600' }).ok === false);
}

group('бюджет и вытеснение (4.10): learned уходит первым, самое старое; taught не уходит');
{
  const taught = { provenance: 'taught', body: 'x'.repeat(100), createdAt: '2026-08-01' };
  const derived = { provenance: 'derived', body: 'y'.repeat(100), version: 1, createdAt: '2026-08-02' };
  const oldLearned = { provenance: 'learned', body: 'z'.repeat(80), runId: 'r1', createdAt: '2026-08-03', state: 'live' };
  const newLearned = { provenance: 'learned', body: 'w'.repeat(80), runId: 'r2', createdAt: '2026-09-10', state: 'live' };

  const fit = fitBlock([newLearned, taught, oldLearned, derived], KEY_BUDGET);
  check('в бюджет - ничего не вытеснено', fit.evicted.length === 0 && fit.used <= KEY_BUDGET, JSON.stringify({ used: fit.used, evicted: fit.evicted.length }));
  check('taught в тексте', fit.text.includes('§ taught'));
  check('derived несёт версию в строке', fit.text.includes('§ derived v1'));
  check('learned несёт runId в строке', fit.text.includes('§ learned r1') && fit.text.includes('§ learned r2'));

  const tight = fitBlock([newLearned, taught, oldLearned, derived], 350);
  check('за пределом бюджета что-то вытеснено', tight.evicted.length > 0, JSON.stringify(tight.evicted.map((e) => e.runId)));
  check('и это learned, а не taught/derived', tight.evicted.every((e) => e.provenance === 'learned'));
  check('и самое старое первым', tight.evicted[0].runId === 'r1');
  check('taught остался, каким бы тесным бюджет ни был', tight.text.includes('§ taught'));

  const onlyOldTaught = fitBlock([{ provenance: 'taught', body: 'a'.repeat(5000), createdAt: '2026-01-01' }], KEY_BUDGET);
  check('если и без learned не влезает - taught обрезается, а не выбрасывается', onlyOldTaught.text.endsWith('…') && onlyOldTaught.text.length <= KEY_BUDGET);

  check('provenance порядок фиксирован', PROVENANCE.join(',') === 'derived,taught,learned,builtin');
}

group('builtin (4.9): в ledger виден, в блок хода - никогда');
{
  const b = builtinEntries();
  check('четыре строки', b.length === 4, String(b.length));
  check('у каждой свой scope, не app-ключ', b.every((e) => e.scope === 'platform:win32' || e.scope === 'self'));
  check('у каждой provenance builtin', b.every((e) => e.provenance === 'builtin'));

  const fit = fitBlock(b, KEY_BUDGET);
  check('fitBlock их не показывает вовсе', fit.text === '' && fit.used === 0, JSON.stringify(fit));

  const mixed = fitBlock([...b, { provenance: 'taught', body: 'a real fact', createdAt: '2026-09-01' }], KEY_BUDGET);
  check('и не среди настоящих записей тоже', !mixed.text.includes('WM_RBUTTONUP') && mixed.text.includes('a real fact'));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
