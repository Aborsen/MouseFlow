/* Вердикт проверки в браузере - вычислением, без браузера.
 *
 * ЗДЕСЬ ДВЕ ВАЖНЫЕ ПРОВЕРКИ, и остальные вокруг них:
 *
 *   «НЕ УДАЛОСЬ ПРОВЕРИТЬ» - ЭТО НЕ «НЕ СОШЛОСЬ». Страница, которая не ответила; пять элементов с одним
 *   именем; поле пароля, которое не читается никогда; поле, в котором нечего читать. Слить любое из них с
 *   провалом значит однажды показать красный отчёт про исправный продукт - или, что хуже, зелёный про
 *   сломанный, если слить в другую сторону.
 *
 *   ПРОВЕРКА, В КОТОРОЙ НЕТ СМЫСЛА, ОТВЕРГАЕТСЯ ДО СТРАНИЦЫ. `count_is` без числа и `text_is` без текста -
 *   это ошибки в утверждении, а не факты о продукте, и записанные как «не сошлось» они выглядели бы
 *   найденным дефектом.
 *
 * Run: node extension/test-checks.mjs
 */
import {
  DOM_CHECKS, checkSaid, checksOf, judgeDom, kindOf, saidOf, whyNotCheckable,
} from './checks.js';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const group = (t) => console.log('\n' + t);

const verdict = (want, facts) => judgeDom(want, facts);
const why = 'it proves something';

group('«не удалось проверить» - отдельный исход, и он не красится как провал');
{
  check('страница не ответила',
    verdict({ check: 'present', name: 'Send', why }, { error: 'the page did not answer' }).pass === null);
  check('и в доказательстве сказано, почему',
    verdict({ check: 'present', name: 'Send', why }, { error: 'the page did not answer' })
      .evidence.includes('could not check'));
  check('пять одноимённых - утверждение было бы про случайный из них',
    verdict({ check: 'text_is', name: 'Name', text: 'Ann', why }, { count: 5 }).pass === null,
    JSON.stringify(verdict({ check: 'text_is', name: 'Name', text: 'Ann', why }, { count: 5 })));
  check('и это сказано числом', /5 things are called/.test(
    verdict({ check: 'text_is', name: 'Name', text: 'Ann', why }, { count: 5 }).evidence));
  check('поле пароля не читается никогда',
    verdict({ check: 'text_is', name: 'Password', text: 'hunter2', why },
      { count: 1, secret: true }).pass === null);
  check('и это сказано словом «password»', /password field/.test(
    verdict({ check: 'text_is', name: 'Password', text: 'x', why }, { count: 1, secret: true }).evidence));
  check('в поле нечего читать - это не «не совпало»',
    verdict({ check: 'text_contains', name: 'Subject', text: 'invoice', why },
      { count: 1, value: '', text: '' }).pass === null);
  check('нет элемента - у text_is это невозможный вопрос, а не ложь',
    verdict({ check: 'text_is', name: 'Subject', text: 'x', why }, { count: 0 }).pass === null);
  check('«не сказано, можно ли этим пользоваться» - тоже не провал',
    verdict({ check: 'enabled', name: 'Send', why }, { count: 1 }).pass === null);
}

group('а провал - это провал, и доказательство называет, что нашлось вместо');
{
  const one = verdict({ check: 'present', name: 'Saved', why }, { count: 0 });
  check('present без совпадений - честный провал', one.pass === false, JSON.stringify(one));
  check('и уровень доказательства - dom', one.how === 'dom');
  const two = verdict({ check: 'text_is', name: 'Subject', text: 'Re: invoice', why },
    { count: 1, value: 'Re: invoce' });
  check('text_is с другим значением', two.pass === false);
  check('и в доказательстве видно, что там на самом деле', two.evidence.includes('Re: invoce'), two.evidence);
  check('absent, когда оно есть', verdict({ check: 'absent', name: 'Error', why }, { count: 1 }).pass === false);
  check('disabled, когда включено',
    verdict({ check: 'disabled', name: 'Send', why }, { count: 1, disabled: false }).pass === false);
}

group('и зачёт - зачёт');
{
  check('present', verdict({ check: 'present', name: 'Send', why }, { count: 1, role: 'button', name: 'Send' }).pass === true);
  check('absent', verdict({ check: 'absent', name: 'Error', why }, { count: 0 }).pass === true);
  check('enabled', verdict({ check: 'enabled', name: 'Send', why }, { count: 1, disabled: false }).pass === true);
  check('disabled', verdict({ check: 'disabled', name: 'Send', why }, { count: 1, disabled: true }).pass === true);
  check('text_contains по значению поля',
    verdict({ check: 'text_contains', name: 'Subject', text: 'invoice', why },
      { count: 1, value: 'Re: invoice 41' }).pass === true);
  check('text_contains по тексту элемента, когда значения нет',
    verdict({ check: 'text_contains', name: 'Welcome back', text: 'Ann', why },
      { count: 1, text: 'Welcome back, Ann' }).pass === true);
  /* present ЕДИНСТВЕННЫЙ, кому несколько совпадений не мешают: «оно на странице» верно и при пяти. */
  check('present при нескольких совпадениях - всё равно зачёт, и число названо',
    verdict({ check: 'present', name: 'Delete', why }, { count: 3, role: 'button' }).pass === true
      && /3 of them/.test(verdict({ check: 'present', name: 'Delete', why }, { count: 3 }).evidence));
}

group('три вида, которых нет на десктопе: адрес и точное число');
{
  check('url_is', verdict({ check: 'url_is', text: 'https://a/b', why }, { url: 'https://a/b' }).pass === true);
  check('url_is мимо', verdict({ check: 'url_is', text: 'https://a/b', why }, { url: 'https://a/c' }).pass === false);
  check('url_contains', verdict({ check: 'url_contains', text: '/dashboard', why },
    { url: 'https://app.example.com/dashboard?tab=1' }).pass === true);
  check('и адрес в доказательстве целиком', verdict({ check: 'url_contains', text: '/x', why },
    { url: 'https://app.example.com/dashboard' }).evidence.includes('app.example.com'));
  check('вкладка не сказала адрес - не удалось проверить',
    verdict({ check: 'url_is', text: 'https://a', why }, {}).pass === null);
  check('count_is', verdict({ check: 'count_is', name: 'row', text: '3', why }, { count: 3 }).pass === true);
  check('count_is мимо, и в доказательстве оба числа',
    verdict({ check: 'count_is', name: 'row', text: '3', why }, { count: 2 }).pass === false
      && /2 things[\s\S]*not 3/.test(verdict({ check: 'count_is', name: 'row', text: '3', why }, { count: 2 }).evidence));
  check('count_is с нечислом - это ошибка утверждения, а не факт',
    verdict({ check: 'count_is', name: 'row', text: 'many', why }, { count: 2 }).pass === null);
}

group('утверждение без смысла отвергается ДО страницы');
{
  check('незнакомый вид перечисляет известные',
    (whyNotCheckable({ check: 'looks_right', name: 'x', why }) || '').includes('url_contains'));
  check('без имени', (whyNotCheckable({ check: 'present', why }) || '').includes('needs the name'));
  check('text_is без текста', (whyNotCheckable({ check: 'text_is', name: 'x' }) || '').includes('needs `text`'));
  check('count_is просит число прямо',
    (whyNotCheckable({ check: 'count_is', name: 'x' }) || '').includes('as a number'));
  check('а url_is имени не требует', whyNotCheckable({ check: 'url_is', text: 'https://a' }) === null);
  check('годное - null', whyNotCheckable({ check: 'present', name: 'Send', why }) === null);
  check('и таких видов девять', DOM_CHECKS.length === 9, String(DOM_CHECKS.length));
  check('шесть из них - те же, что на десктопе',
    ['present', 'absent', 'enabled', 'disabled'].every((one) => DOM_CHECKS.includes(one)));
}

group('что читает модель');
{
  const said = checkSaid({ check: 'present', name: 'Send', why: 'the mail can be sent' },
    { pass: false, how: 'dom', evidence: 'nothing visible on the page is called "Send"' });
  check('FAIL первым словом', said.startsWith('FAIL'), said);
  check('и сказано, что прогон на этом не кончается', /does not end the run/.test(said));
  check('уровень доказательства назван', /tier dom/.test(said));
  check('«что это доказывает» - словами человека', /the mail can be sent/.test(said));
  const cannot = checkSaid({ check: 'present', name: 'Send', why: 'x' },
    { pass: null, how: 'dom', evidence: 'could not check: the page did not answer' });
  check('CANNOT CHECK называется не провалом', /Not a failure/.test(cannot), cannot);
}

group('сводка прогона - одна на обе формы шага');
{
  const desktop = [{ tool: 'expect', outcome: { pass: true, how: 'tree' } },
    { tool: 'expect', outcome: { pass: false, how: 'tree' } }, { tool: 'click' }];
  const web = [{ name: 'expect', outcome: { pass: true, how: 'dom' } },
    { name: 'expect', outcome: { pass: null, how: 'dom' } }, { name: 'click' }];
  check('десктопные шаги (tool)', JSON.stringify(checksOf(desktop))
    === JSON.stringify({ passed: 1, failed: 1, unchecked: 0, tiers: { tree: 2 } }),
  JSON.stringify(checksOf(desktop)));
  check('шаги расширения (name)', JSON.stringify(checksOf(web))
    === JSON.stringify({ passed: 1, failed: 0, unchecked: 1, tiers: { dom: 2 } }),
  JSON.stringify(checksOf(web)));
  check('прогон без проверок - null, а не нули', checksOf([{ name: 'click' }]) === null);
  check('и мусор ничего не ломает', checksOf(null) === null && checksOf('нет') === null);
}

group('вид кадра по тому, что ход доказал');
{
  check('провал в ходу - кадр провала', kindOf([{ pass: true }, { pass: false }]) === 'failure');
  check('«не удалось» - не провал, но кадр всё равно нужен',
    kindOf([{ pass: null }]) === 'check');
  check('всё сошлось', kindOf([{ pass: true }]) === 'check');
  check('без вердиктов', kindOf([]) === 'check' && kindOf(null) === 'check');
  check('слова к кадру называют исход каждой проверки',
    saidOf([{ pass: false, evidence: 'not there' }]) === 'FAIL: not there');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
