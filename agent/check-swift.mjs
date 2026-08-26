/* Swift-агент: сборка и исполнение того, что решает, кого пускать.
 *
 * ПОЧЕМУ ЭТОТ ФАЙЛ ПОЯВИЛСЯ. Рядом год лежит check-csharp.mjs - самодельная проверка C#, которая читает
 * встроенный в PowerShell исходник глазами регулярок, потому что компилятора под рукой нет. Для Swift
 * компилятор ЕСТЬ: `swiftc` приезжает с Xcode, лежит в /usr/bin и проверяет весь файл за полторы секунды.
 * Его никто не звал. За это время в агент дважды уезжали правки, проверенные чтением.
 *
 * ДВЕ ПРОВЕРКИ, И ВТОРАЯ ВАЖНЕЕ ПЕРВОЙ.
 *
 *   1. Весь агент проходит typecheck. Ловит ровно тот класс, на котором один раз уже сломалась установка
 *      под Windows: опечатка в имени, которую человек читает как правильную.
 *
 *   2. Правило допуска ИСПОЛНЯЕТСЯ. До 0.9.7 `--allow-origin` только отражался в заголовок и не отвергал
 *      ничего - то есть любая страница, открытая в Safari или Firefox, могла послать агенту
 *      `action=type text=curl … | sh` и нажать Enter. CORS этого не останавливает: он мешает ПРОЧИТАТЬ
 *      ответ, а не отправить запрос и выполнить его. Правило, которое чинит это, обязано проверяться
 *      исполнением, а не чтением: «выглядит правильно» - это ровно то, чем оно было предыдущий год.
 *
 * ПОЧЕМУ ФУНКЦИЯ ВЫРЕЗАЕТСЯ, А НЕ ЗАПУСКАЕТСЯ АГЕНТ ЦЕЛИКОМ. Настоящий агент при старте читает
 * ~/Library/Application Support/MouseFlow/account.json - файл живого пользователя - и начинает разбирать
 * очередь его аккаунта. Второй экземпляр на тестовом порту забирал бы задания у первого. Поэтому текст
 * функции берётся ИЗ ФАЙЛА (не переписывается сюда) и компилируется отдельно: расходиться нечему, потому
 * что копии нет - есть та же строка, прочитанная с диска.
 *
 * НА WINDOWS ПРОПУСКАЕТСЯ. swiftc там нет, и тест, падающий от отсутствия чужого компилятора, - это тест,
 * который выключат целиком.
 *
 * Запуск: node agent/check-swift.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE = join(ROOT, 'agent/mouseflow-agent.swift');

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const group = (t) => console.log('\n' + t);

/** Есть ли чем компилировать. Отсутствие - не провал, а другая машина. */
function haveSwift() {
  const probe = spawnSync('swiftc', ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}

if (!haveSwift()) {
  console.log('\nswiftc не найден - проверка Swift пропущена (это не macOS, или нет Xcode).');
  console.log('0 passed, 0 failed');
  process.exit(0);
}

const src = readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');

// ------------------------------------------------------------------ 1. весь агент собирается
group('агент проходит проверку типов');
{
  const out = spawnSync('swiftc', ['-typecheck', SOURCE], { encoding: 'utf8' });
  check('swiftc -typecheck без ошибок', out.status === 0,
    (out.stderr || '').split('\n').filter((l) => /error:/.test(l)).slice(0, 6).join(' | '));
}

// ------------------------------------------------------------------ 2. правило допуска, исполнением
/** Кусок исходника от объявления до закрывающей скобки того же уровня. */
function slice(from, opener = '{') {
  const at = src.indexOf(from);
  if (at < 0) return null;
  const start = src.indexOf(opener, at);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  return null;
}

group('правило допуска исполняется, а не читается');
{
  const shipped = src.match(/let SHIPPED_ORIGINS = \[[\s\S]*?\]/);
  const rule = slice('func originAllowed(');
  check('список собственных origin найден в исходнике', !!shipped);
  check('функция допуска найдена в исходнике', !!rule);

  if (shipped && rule) {
    const dir = mkdtempSync(join(tmpdir(), 'mf-swift-'));
    const file = join(dir, 'gate.swift');
    /* Ровно тот текст, что в агенте, плюс минимум вокруг: одна переменная, которую агент берёт из
     * аргументов, и main, печатающий вердикт. Если правило поменяют - поменяется и то, что здесь идёт в
     * компилятор, потому что копии нет. */
    writeFileSync(file, [
      'import Foundation',
      shipped[0],
      'var allowOrigin = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""',
      rule,
      'let asked = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""',
      'print(originAllowed(asked.isEmpty ? nil : asked) ? "allow" : "refuse")',
    ].join('\n\n'));

    const built = join(dir, 'gate');
    const compile = spawnSync('swiftc', ['-O', '-o', built, file], { encoding: 'utf8' });
    check('вырезанное правило компилируется само по себе', compile.status === 0,
      (compile.stderr || '').split('\n').filter((l) => /error:/.test(l)).slice(0, 4).join(' | '));

    if (compile.status === 0) {
      const verdict = (pin, origin) =>
        execFileSync(built, [pin, origin], { encoding: 'utf8' }).trim();

      /* НЕЗАКРЕПЛЁННЫЙ АГЕНТ - тот, что запускается без аргументов, и до 0.9.7 он был открыт всем. */
      group('без аргументов агент отвечает продукту и отказывает остальным');
      check('приложение продукта проходит', verdict('', 'https://mouseflowapp.vercel.app') === 'allow');
      check('и второе развёртывание тоже', verdict('', 'https://mouse-agent.vercel.app') === 'allow');
      check('разработка на localhost проходит', verdict('', 'http://localhost:4400') === 'allow');
      check('и на 127.0.0.1 тоже', verdict('', 'http://127.0.0.1:5173') === 'allow');
      /* Та самая страница из отчёта. */
      check('ЧУЖАЯ СТРАНИЦА ОТКАЗАНА', verdict('', 'https://evil.example') === 'refuse');
      check('и похожая на нашу - тоже',
        verdict('', 'https://mouseflowapp.vercel.app.evil.example') === 'refuse');
      /* Сравнение по префиксу пустило бы это внутрь: хост проверяется целиком, а не началом строки. */
      check('и та, что притворяется localhost',
        verdict('', 'https://localhost.evil.example') === 'refuse');
      check('и поддомен нашего домена, которого мы не выпускали',
        verdict('', 'https://staging.mouseflowapp.vercel.app') === 'refuse');

      group('закреплённый агент отвечает только тому, на кого закреплён');
      const pin = 'https://mouseflowapp.vercel.app';
      check('закреплённый origin проходит', verdict(pin, pin) === 'allow');
      check('а собственный второй origin - уже нет, раз оператор выбрал один',
        verdict(pin, 'https://mouse-agent.vercel.app') === 'refuse');
      check('и localhost тоже нет', verdict(pin, 'http://localhost:4400') === 'refuse');
      check('и чужая страница', verdict(pin, 'https://evil.example') === 'refuse');

      group('звёздочка означает то, что означала, но её надо попросить');
      check('со звёздочкой проходит кто угодно', verdict('*', 'https://evil.example') === 'allow');

      group('запрос без Origin - это не браузер, и он проходит');
      /* curl, mcp/worker.mjs, node fetch. Страница Origin не подделает - его ставит браузер, - а локальный
       * процесс и так может всё: прочитать account.json, нажать клавиши сам. Порог стоит против удалённой
       * страницы, и её он держит. */
      check('без Origin - пропускается', verdict('', '') === 'allow');
      check('и при закреплённом тоже', verdict(pin, '') === 'allow');
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ 3. порог стоит ДО switch
group('порог стоит перед маршрутизацией, а не внутри маршрутов');
{
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('запрос с отказанным origin до route() не доходит',
    /if !originAllowed\(request\.origin\)[\s\S]{0,120}refusedOrigin/.test(code));
  /* Иначе маршрут, добавленный завтра, унаследует не проверку, а её отсутствие. */
  check('и route() вызывается только в else', /\} else \{\s*result = route\(/.test(code));
  check('отказанному не отражается его origin',
    /if let asked = origin, !originAllowed\(asked\) \{ allow = "" \}/.test(code));
  check('DELETE перечислен, иначе «Отсоединить» не работает вовсе',
    /Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS/.test(code));
}

// ------------------------------------------------------------------ 4. набранный текст не читается как имя
group('содержимое поля ввода не становится именем элемента');
{
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('значение читается только у того, во что нельзя писать',
    /depth == 0, valueMayName, !holdsTypedText\(current\)/.test(code));
  check('спрашивается само свойство, а не список ролей',
    /AXUIElementIsAttributeSettable\(element, kAXValueAttribute as CFString, &settable\)/.test(code));
  check('и поле пароля названо отдельно, вторым замком',
    /kAXSubroleAttribute\), sub == "AXSecureTextField"/.test(code));
  /* У сфокусированного элемента вопрос уже решён тем, ЧТО это за элемент: в него сейчас печатают. */
  check('у сфокусированного элемента значение не читается вовсе',
    /nameByClimbing\(focused, valueMayName: false\)/.test(code));
  /* Чужое значение - подпись «Кому» рядом с полем - остаётся, и именно оно делает запрет терпимым. */
  check('но подпись поля по-прежнему читается, иначе поля потеряли бы имена',
    /elementAttr\(current, kAXTitleUIElementAttribute\)/.test(code));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
