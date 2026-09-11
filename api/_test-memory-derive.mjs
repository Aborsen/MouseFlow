/* `derived` из событий, проверенное исполнением — MEMORY-PLAN.md §4.7.1, §5 шаг 3.
 * Run: node api/_test-memory-derive.mjs
 */
import { deriveEntries, DERIVE_VERSION, touchesOf } from './_memory-derive.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const group = (t) => console.log('\n' + t);

const ev = (context) => ({ context });

group('touchesOf: веб-касание однозначно по context.url, нативное - только с названной платформой');
{
  const flow = {
    events: [
      ev({ url: 'https://mail.google.com/mail/u/0?compose=new', window: 'Inbox (3) - Gmail', control: 'Compose' }),
      ev({ app: 'OUTLOOK', window: 'Inbox - Outlook', control: 'Send' }),
      ev({}),
      null,
    ],
  };
  const web = touchesOf(flow);
  check('без platform веб-касание всё равно есть', web.some((t) => t.key === 'web:mail.google.com'));
  check('а нативное - нет, платформа не названа', !web.some((t) => t.key && t.key.startsWith('OUTLOOK')) && web.length === 1, JSON.stringify(web));

  const withWin = touchesOf(flow, { platform: 'win32' });
  check('с platform нативное касание появляется', withWin.some((t) => t.key === 'win32:OUTLOOK'));
  check('и веб остаётся веб-ключом, платформа его не трогает', withWin.some((t) => t.key === 'web:mail.google.com'));
  check('пустой контекст и мусор - молча пропущены, не бросают', withWin.length === 2);

  check('payload.events читается так же, как events', touchesOf({ payload: { events: flow.events } }, { platform: 'win32' }).length === 2);
}

group('deriveEntries: стабильный край заголовка - общий суффикс, а не любой заголовок');
{
  const touches = [
    { key: 'win32:OUTLOOK', title: 'Invoice 41 - Outlook', control: 'Send', near: null, side: null },
    { key: 'win32:OUTLOOK', title: '3 unread - Outlook', control: 'Send', near: null, side: null },
    { key: 'win32:OUTLOOK', title: 'Re: Budget - Outlook', control: 'Reply', near: null, side: null },
  ];
  const [one] = deriveEntries(touches);
  check('ключ верный', one.key === 'win32:OUTLOOK');
  check('запись прошла редакцию', one.ok === true, JSON.stringify(one));
  check('общий суффикс найден, а не тема письма', one.entry.body.includes('" - Outlook"'), one.entry.body);
  check('и тема письма ТУДА не попала', !one.entry.body.includes('Invoice') && !one.entry.body.includes('Budget'), one.entry.body);
  check('самый частый именованный контрол назван со счётом', /"Send" .* 2 presses out of 3 touches/.test(one.entry.body), one.entry.body);
  check('версия формулы проставлена', one.entry.version === DERIVE_VERSION);
  check('provenance - derived, и это не спрашивают', one.entry.provenance === 'derived' && one.entry.state === 'live');

  const single = deriveEntries([{ key: 'win32:Notepad', title: 'Untitled - Notepad', control: null, near: null, side: null }]);
  check('один заголовок ничего не доказывает - края нет', single.length === 0 || !single[0].entry?.body.includes('stable part'));
}

group('landmark у безымянных нажатий (4.1) и координата в заголовке отказывается той же редакцией');
{
  const touches = [
    { key: 'win32:Outlook', title: null, control: null, near: '"Attach"', side: 'right' },
    { key: 'win32:Outlook', title: null, control: null, near: '"Attach"', side: 'right' },
    { key: 'win32:Outlook', title: null, control: null, near: '"Subject"', side: 'below' },
  ];
  const [one] = deriveEntries(touches);
  check('самый частый landmark выбран', one.ok && one.entry.body.includes('near "Attach", right'), JSON.stringify(one));

  const badTitle = [
    { key: 'win32:X', title: 'click 500,600 - X', control: null, near: null, side: null },
    { key: 'win32:X', title: 'do 500,600 - X', control: null, near: null, side: null },
  ];
  const [bad] = deriveEntries(badTitle);
  check('координата в общем крае - отказ той же редакцией, что у writeMemory (4.5), не тихий пропуск', bad.ok === false, JSON.stringify(bad));
}

group('пустой вход - пустой результат, ничего не пишет и не бросает');
{
  check('пусто', deriveEntries([]).length === 0);
  check('null-элементы в списке', deriveEntries([null, undefined, { key: '' }]).length === 0);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
