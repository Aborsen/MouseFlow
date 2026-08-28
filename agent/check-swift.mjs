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

// ------------------------------------------------------------------ 5. правила 0.16.0, исполнением
/* Эти пять кусков - чистая логика, и потому единственный способ проверить их честно - выполнить.
 *
 * Регулярка над исходником говорит «функция похожа на правильную»; она пропустила бы перевёрнутый знак,
 * порог не с той стороны сравнения и обрезку, которая режет предложения вместе с адресами. Всё это уже
 * происходило в этом файле - см. историю про min(30, …), поданное как успех. Вырезается ТОТ ЖЕ текст, что в
 * агенте, копии нет. */
group('заголовок-адрес: обрезка исполняется, а не читается');
{
  const bare = slice('static func bareTitle(');
  check('функция найдена в исходнике', !!bare);
  if (bare) {
    const dir = mkdtempSync(join(tmpdir(), 'mf-title-'));
    const file = join(dir, 'title.swift');
    writeFileSync(file, [
      'import Foundation',
      bare.replace('static func', 'func'),
      'let asked = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""',
      'print(bareTitle(asked) ?? "<kept>")',
    ].join('\n\n'));
    const built = join(dir, 'title');
    const compile = spawnSync('swiftc', ['-O', '-o', built, file], { encoding: 'utf8' });
    check('вырезанная обрезка компилируется сама по себе', compile.status === 0,
      (compile.stderr || '').split('\n').filter((l) => /error:/.test(l)).slice(0, 4).join(' | '));
    if (compile.status === 0) {
      const cut = (title) => execFileSync(built, [title], { encoding: 'utf8' }).trim();
      /* Та самая строка из настоящей записи: `state` - одноразовый токен входа. */
      check('токен входа из настоящей записи срезается',
        cut('auth.doubleword.ai/u/login?state=hKFo2SAwOWZhZDMzYQ') === 'auth.doubleword.ai/u/login');
      check('и со схемой тоже, схема при этом сохраняется',
        cut('https://auth.doubleword.ai/u/login?state=hKFo2SAw') === 'https://auth.doubleword.ai/u/login');
      check('схема не дописывается там, где её не было',
        cut('example.com/a?b=c') === 'example.com/a');
      /* ГЛАВНОЕ, ЧТО НЕЛЬЗЯ СЛОМАТЬ: обычный заголовок с вопросительным знаком остаётся целым. */
      /* Пробел - первый замок, и он не единственный: URLComponents не принимает строку с пробелом вовсе,
       * так что снятие этой проверки заголовок всё равно не испортит. Она остаётся ровно потому, что
       * повторяет правило Windows-агента, а расхождение правил здесь стоило бы обеим сторонам. */
      check('предложение с вопросительным знаком не трогается',
        cut('What is a good name? - Google Search') === '<kept>');
      check('и заголовок без вопроса тоже', cut('Inbox - Gmail') === '<kept>');
      /* Хост без точки - это не адрес, а слово: «TODO?» из заголовка редактора. */
      check('слово без точки в хосте не считается адресом', cut('TODO?next') === '<kept>');
      check('и не-веб схема не считается тоже', cut('file:///x?y=1') === '<kept>');
      /* file: отбивается ещё и отсутствием хоста, так что проверка схемы сама по себе видна только на
       * схеме, у которой хост есть. Без неё этот заголовок был бы обрезан - то есть правило «только веб»
       * молча перестало бы существовать. */
      check('и схема с хостом, но не веб - тоже',
        cut('ftp://files.example.com/x?y=1') === '<kept>');
      /* Без вопросительного знака резать нечего, и это первая же проверка в функции: заголовок-адрес без
       * строки запроса обязан доехать до записи ровно таким, каким был. */
      check('адрес без строки запроса не трогается', cut('example.com/page') === '<kept>');
      /* Путь `/` не превращается в хвост: origin остаётся origin. */
      check('корневой путь не оставляет косой черты', cut('example.com/?q=1') === 'example.com');
      check('порт сохраняется, если он не по умолчанию',
        cut('http://dev.local:4400/app?token=abc') === 'http://dev.local:4400/app');
      /* И то же ограничение, что у Windows: хост без точки не считается адресом, так что заголовок с
       * localhost остаётся целым вместе со своей строкой запроса. Названо тестом, а не оставлено на
       * обнаружение - обе реализации ведут себя так, и разойтись им нельзя. */
      check('localhost не считается адресом - ровно как на Windows',
        cut('http://localhost:4400/app?token=abc') === '<kept>');
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

group('подпись против содержимого: порог исполняется');
{
  const ev = slice('final class Ev {');
  const clipper = slice('func clip(');
  const rule = slice('static func recordName(');
  const max = src.match(/static let NAME_MAX = \d+/);
  check('класс события, обрезка, правило и порог найдены', !!(ev && clipper && rule && max));
  if (ev && clipper && rule && max) {
    const dir = mkdtempSync(join(tmpdir(), 'mf-name-'));
    const file = join(dir, 'name.swift');
    writeFileSync(file, [
      'import Foundation',
      clipper,
      ev,
      max[0].replace('static let', 'let'),
      rule.replace('static func', 'func'),
      'let asked = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""',
      'let e = Ev()',
      'recordName(e, name: asked, type: "button")',
      'print("\\(e.control ?? "<dropped>")|\\(e.nameLength)")',
    ].join('\n\n'));
    const built = join(dir, 'name');
    const compile = spawnSync('swiftc', ['-O', '-o', built, file], { encoding: 'utf8' });
    check('вырезанное правило компилируется само по себе', compile.status === 0,
      (compile.stderr || '').split('\n').filter((l) => /error:/.test(l)).slice(0, 4).join(' | '));
    if (compile.status === 0) {
      const kept = (name) => execFileSync(built, [name], { encoding: 'utf8' }).trim();
      /* Самое длинное имя на НАЖИМАЕМОМ элементе в замере - 43 символа. Подписи проходят целиком. */
      check('обычная подпись остаётся', kept('Отправить') === 'Отправить|0');
      check('и подпись в 60 символов - тоже', kept('x'.repeat(60)) === `${'x'.repeat(60)}|0`);
      /* 61 - первый, который уходит. Проверяется граница, а не «что-то длинное». */
      check('шестьдесят один символ уже не пишется',
        kept('x'.repeat(61)) === '<dropped>|61');
      /* Именно эта форма и утекала: имя элемента-сообщения ЕСТЬ сообщение. */
      check('сообщение вместо подписи выбрасывается, а длина остаётся',
        kept('Привет, я посмотрел твой документ и оставил там пару комментариев про сроки')
          === '<dropped>|75');
      /* Кириллица считается символами, а не байтами: иначе порог для русского был бы вдвое ниже. */
      check('длина считается символами, а не байтами', kept('я'.repeat(50)) === `${'я'.repeat(50)}|0`);
      check('пустое имя не даёт ни имени, ни длины', kept('') === '<dropped>|0');
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

group('знак горизонтального колеса согласован между записью и впрыском');
{
  const sideways = slice('enum Sideways {');
  check('константа знака найдена', !!sideways);
  if (sideways) {
    const dir = mkdtempSync(join(tmpdir(), 'mf-side-'));
    const file = join(dir, 'side.swift');
    writeFileSync(file, [
      'import Foundation',
      sideways,
      /* Круг замыкается: то, что впрыснули как «вправо», обязано прочитаться как "Scroll Right". Именно
       * эта пара и разъезжается, когда знак правят в одном месте из двух. */
      'for right in [true, false] {',
      '  let injected = Sideways.wheel2(right: right)',
      '  let readBack = Sideways.name(delta: Int64(injected))',
      '  print("\\(right ? "right" : "left")->\\(injected)->\\(readBack)")',
      '}',
    ].join('\n\n'));
    const built = join(dir, 'side');
    const compile = spawnSync('swiftc', ['-O', '-o', built, file], { encoding: 'utf8' });
    check('вырезанная константа компилируется сама по себе', compile.status === 0,
      (compile.stderr || '').split('\n').filter((l) => /error:/.test(l)).slice(0, 4).join(' | '));
    if (compile.status === 0) {
      const lines = execFileSync(built, [], { encoding: 'utf8' }).trim().split('\n');
      check('впрыснутое «вправо» читается как Scroll Right',
        /^right->-?\d+->Scroll Right$/.test(lines[0]), lines[0]);
      check('и «влево» - как Scroll Left', /^left->-?\d+->Scroll Left$/.test(lines[1]), lines[1]);
      /* Ноль - не сторона, и обе стороны обязаны быть РАЗНЫМИ: одна константа, использованная дважды с
       * одним знаком, прошла бы обе проверки выше поодиночке. */
      const signs = lines.map((l) => Number(l.split('->')[1]));
      check('и это два разных знака, а не один', signs[0] !== 0 && signs[1] !== 0 && signs[0] !== signs[1],
        signs.join(' '));
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

group('перевод в пиксели скриншота исполняется');
{
  const geo = slice('enum Geometry {');
  check('преобразование найдено', !!geo);
  if (geo) {
    const dir = mkdtempSync(join(tmpdir(), 'mf-geo-'));
    const file = join(dir, 'geo.swift');
    writeFileSync(file, [
      'import Foundation',
      geo,
      'Geometry.read(["scale": "0.5", "ox": "100", "oy": "50"])',
      'print("\\(Geometry.shotX(1574)),\\(Geometry.shotY(278)),\\(Geometry.shotSize(64))")',
      'Geometry.read([:])',
      'print("\\(Geometry.shotX(1574)),\\(Geometry.shotY(278)),\\(Geometry.shotSize(64))")',
      'Geometry.read(["scale": "0", "ox": "x", "oy": ""])',
      'print("\\(Geometry.shotX(10)),\\(Geometry.shotY(10)),\\(Geometry.shotSize(10))")',
    ].join('\n\n'));
    const built = join(dir, 'geo');
    const compile = spawnSync('swiftc', ['-O', '-o', built, file], { encoding: 'utf8' });
    check('вырезанное преобразование компилируется само по себе', compile.status === 0,
      (compile.stderr || '').split('\n').filter((l) => /error:/.test(l)).slice(0, 4).join(' | '));
    if (compile.status === 0) {
      const out = execFileSync(built, [], { encoding: 'utf8' }).trim().split('\n');
      /* Числа сняты с живого прогона агента: значок на рабочем столе в 1574,278 64x64 при scale 0.5 и
       * начале 100,50 отвечает 737,114 32x32. */
      check('масштаб и начало применяются оба', out[0] === '737,114,32', out[0]);
      /* Отсутствие полей - это «экранные пиксели», как было до 0.14.0, а не ноль и не отказ. */
      check('без полей ничего не меняется', out[1] === '1574,278,64', out[1]);
      /* Ноль в масштабе схлопнул бы весь экран в точку. */
      check('мусор в полях не ломает арифметику', out[2] === '10,10,10', out[2]);
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

group('охрана собственного окна не запирает рабочий стол');
{
  const own = slice('enum Own {');
  check('охрана найдена', !!own);
  if (own) {
    const dir = mkdtempSync(join(tmpdir(), 'mf-own-'));
    const file = join(dir, 'own.swift');
    writeFileSync(file, [
      'import Foundation',
      'import AppKit',
      own,
      'let mine = Own.pids()',
      'print("self=\\(mine.contains(getpid()))")',
      'print("init=\\(mine.contains(1))")',
      /* Finder и Dock владеют рабочим столом и панелью - если охрана поднялась до них, запрещённым
       * оказывается ВЕСЬ экран. На Windows тот же лишний шаг упёрся бы в explorer. */
      'let shell = NSWorkspace.shared.runningApplications',
      '  .filter { ["com.apple.finder", "com.apple.dock"].contains($0.bundleIdentifier ?? "") }',
      '  .map { $0.processIdentifier }',
      'print("shell=\\(shell.contains { mine.contains($0) })")',
      'print("count=\\(mine.count)")',
    ].join('\n\n'));
    const built = join(dir, 'own');
    const compile = spawnSync('swiftc', ['-O', '-o', built, file], { encoding: 'utf8' });
    check('вырезанная охрана компилируется сама по себе', compile.status === 0,
      (compile.stderr || '').split('\n').filter((l) => /error:/.test(l)).slice(0, 4).join(' | '));
    if (compile.status === 0) {
      const said = Object.fromEntries(execFileSync(built, [], { encoding: 'utf8' })
        .trim().split('\n').map((l) => l.split('=')));
      check('собственный процесс защищён всегда', said.self === 'true');
      /* launchd - это всё, и подъём обязан на нём остановиться. Замка здесь два независимых - условие
       * `walker > 1` и список notAHost, - поэтому одиночная правка любого из них эту проверку не уронит.
       * Она держит СВОЙСТВО, а не строку: если однажды не станет обоих, здесь будет видно. */
      check('launchd НЕ защищён', said.init === 'false');
      check('Finder и Dock НЕ защищены', said.shell === 'false');
      /* Ограничено сверху: подъём на шесть уровней с остановкой на первом окне не может собрать пол-машины. */
      check('и список остаётся коротким', Number(said.count) >= 1 && Number(said.count) <= 7, said.count);
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ 6. аккорд не оставляет модификатор
/* САМАЯ ДОРОГАЯ ОШИБКА ИЗ ВСЕХ, ЧТО ЗДЕСЬ БЫЛИ, и найдена она замером, а не чтением.
 *
 * После одного `action=key key=a ctrl=1` Command оставался зажатым ДЛЯ ВСЕЙ МАШИНЫ, и каждое следующее
 * событие агента его наследовало. Снято тапом с живой машины, по событиям с меткой агента:
 *
 *   keyDown   mods=Cmd  text=""     <- сам аккорд, как и просили
 *   mouseDown mods=Cmd              <- клик стал Cmd-кликом
 *   scroll    mods=Cmd              <- прокрутка стала зумом
 *   keyDown   mods=Cmd  text="z"    <- набор буквы стал Cmd+Z, то есть отменой
 *
 * То есть набор «mouse test4» после Cmd+S уходил как Cmd+M, Cmd+O, Cmd+U, Cmd+S, Cmd+E, Cmd+T: ни один
 * символ не попадал в поле, macOS пищала, и модель писала «the typing didn't land» - и была права.
 *
 * ПОЧЕМУ ЭТО ИСПОЛНЯЕМЫЙ ТЕСТ, А НЕ РЕГУЛЯРКА. Правило состоит в том, что ПОСЛЕДНИЙ шаг аккорда несёт
 * пустые флаги; регулярка на «есть цикл по MODIFIER_KEYS» прошла бы и на коде, который снимает флаги не в
 * ту сторону. А проверить это нажатием клавиш на живой машине нельзя - такой тест никто не станет держать
 * в наборе. Поэтому порядок событий вынесен в чистую функцию, и здесь выполняется ОНА, не тронув ничего. */
group('аккорд отпускает модификатор, и это выполняется');
{
  const keys = src.match(/let MODIFIER_KEYS: \[\(flag: CGEventFlags, left: CGKeyCode, right: CGKeyCode\)\] = \[[\s\S]*?\]/);
  const chord = slice('func chordSteps(');
  const release = slice('func releaseSteps(');
  check('таблица модификаторов и обе функции найдены', !!(keys && chord && release));

  if (keys && chord && release) {
    const dir = mkdtempSync(join(tmpdir(), 'mf-chord-'));
    const file = join(dir, 'chord.swift');
    writeFileSync(file, [
      'import CoreGraphics',
      'import Foundation',
      keys[0],
      chord,
      release,
      'func show(_ steps: [(code: CGKeyCode, down: Bool, flags: CGEventFlags)]) -> String {',
      '  steps.map { s in',
      '    var m: [String] = []',
      '    if s.flags.contains(.maskCommand) { m.append("Cmd") }',
      '    if s.flags.contains(.maskShift) { m.append("Shift") }',
      '    if s.flags.contains(.maskAlternate) { m.append("Alt") }',
      '    if s.flags.contains(.maskControl) { m.append("Ctrl") }',
      '    return "\\(s.code)\\(s.down ? "v" : "^")[\\(m.isEmpty ? "-" : m.joined(separator: "+"))]"',
      '  }.joined(separator: " ")',
      '}',
      'let what = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""',
      'switch what {',
      'case "plain":    print(show(chordSteps([], key: 9)))',
      'case "cmd":      print(show(chordSteps(.maskCommand, key: 9)))',
      'case "cmdshift": print(show(chordSteps([.maskCommand, .maskShift], key: 9)))',
      'case "release":  print(show(releaseSteps(.maskCommand)))',
      'case "nothing":  print(show(releaseSteps([])))',
      'default: print("?")',
      '}',
    ].join('\n\n'));

    const built = join(dir, 'chord');
    const compile = spawnSync('swiftc', ['-O', '-o', built, file], { encoding: 'utf8' });
    check('вырезанное правило компилируется само по себе', compile.status === 0,
      (compile.stderr || '').split('\n').filter((l) => /error:/.test(l)).slice(0, 4).join(' | '));

    if (compile.status === 0) {
      const steps = (what) => execFileSync(built, [what], { encoding: 'utf8' }).trim();

      /* Без модификаторов аккорда нет: ровно нажатие и отпускание, и оба без флагов. */
      check('без модификаторов - два события и ни одного флага',
        steps('plain') === '9v[-] 9^[-]', steps('plain'));

      /* Command НАЖИМАЕТСЯ левой клавишей и ОТПУСКАЕТСЯ ОБЕИМИ: 55 - kVK_Command, 54 - правая. Флаг у них
       * общий, различить по состоянию нельзя, и отпустить надо ту, которую человек мог держать. */
      check('Command нажимается своей клавишей и отпускается с обеих сторон',
        steps('cmd') === '55v[Cmd] 9v[Cmd] 9^[Cmd] 54^[-] 55^[-]', steps('cmd'));

      /* ВОТ ЭТО И ЕСТЬ ВСЯ ПОЧИНКА: последний шаг с пустыми флагами. Без него Command остаётся зажатым
       * для всей машины - включая собственный ввод человека, - и следующий набор уходит аккордами. */
      check('и ПОСЛЕДНИЙ шаг несёт пустые флаги',
        /\[-\]$/.test(steps('cmd')), steps('cmd'));

      /* Два модификатора снимаются по одному флагу за раз, в обратном порядке: приложение, читающее
       * flagsChanged, должно видеть то же, что от настоящей клавиатуры. */
      check('два модификатора снимаются по одному, в обратном порядке',
        steps('cmdshift')
          === '55v[Cmd+Shift] 56v[Cmd+Shift] 9v[Cmd+Shift] 9^[Cmd+Shift] 60^[Cmd] 56^[Cmd] 54^[-] 55^[-]',
        steps('cmdshift'));

      /* Отпускание уже зажатого - без единого нажатия: набор обязан быть набором, что бы ни залипло
       * раньше, включая прошлую сборку агента и чужое приложение. */
      check('зажатое отпускается, ничего не нажимая, и с обеих сторон',
        steps('release') === '54^[-] 55^[-]', steps('release'));
      check('а когда ничего не зажато - не шлётся ничего', steps('nothing') === '', `"${steps('nothing')}"`);
    }
    rmSync(dir, { recursive: true, force: true });
  }
}


group('рамка «этой машиной управляют»: когда горит, и чем не задевает агента');
{
  const rule = slice('func frameShows(');
  check('правило показа найдено', !!rule);
  if (rule) {
    const dir = mkdtempSync(join(tmpdir(), 'mf-frame-'));
    const file = join(dir, 'frame.swift');
    writeFileSync(file, [
      'import Foundation',
      rule,
      'let now = Date(timeIntervalSince1970: 1_000_000)',
      'let past = now.addingTimeInterval(-1)',
      'let soon = now.addingTimeInterval(5)',
      'func say(_ tag: String, _ v: Bool) { print("\\(tag)=\\(v)") }',
      'say("idle", frameShows(drivers: [], leaseUntil: past, now: now))',
      'say("lease", frameShows(drivers: [], leaseUntil: soon, now: now))',
      'say("expired", frameShows(drivers: [], leaseUntil: past, now: now))',
      'say("goal", frameShows(drivers: ["goal"], leaseUntil: past, now: now))',
      'say("goalExpired", frameShows(drivers: ["goal"], leaseUntil: past, now: now))',
      /* Два ведущих сразу: курьерский прогон и повтор. Снятие ОДНОГО не гасит рамку - иначе прогон,
       * закончившийся раньше повтора, погасил бы предупреждение о ещё идущем повторе. */
      'var two: Set<String> = ["goal", "replay"]',
      'two.remove("goal")',
      'say("oneLeft", frameShows(drivers: two, leaseUntil: past, now: now))',
      'two.remove("replay")',
      'say("bothGone", frameShows(drivers: two, leaseUntil: past, now: now))',
      /* Множество, а не счётчик: снять одно и то же имя дважды безопасно. У счётчика это ушло бы в -1 и
       * рамка не зажглась бы больше НИКОГДА - самый тихий из возможных отказов. */
      'var twice: Set<String> = ["goal"]',
      'twice.remove("goal"); twice.remove("goal"); twice.insert("goal")',
      'say("removedTwiceStillLights", frameShows(drivers: twice, leaseUntil: past, now: now))',
    ].join('\n\n'));
    const built = join(dir, 'frame');
    const compile = spawnSync('swiftc', ['-O', '-o', built, file], { encoding: 'utf8' });
    check('вырезанное правило компилируется само по себе', compile.status === 0,
      (compile.stderr || '').split('\n').filter((l) => /error:/.test(l)).slice(0, 4).join(' | '));
    if (compile.status === 0) {
      const out = Object.fromEntries(
        execFileSync(built, [], { encoding: 'utf8' }).trim().split('\n').map((l) => l.split('=')),
      );
      const on = (k) => out[k] === 'true';
      check('никто не ведёт - рамки нет', !on('idle'), out.idle);
      check('живая аренда одиночного действия - горит', on('lease'), out.lease);
      /* ГАСНЕТ. Индикатор «вами управляют», оставшийся гореть после конца, врёт ровно в ту сторону, в
       * которую индикатору врать нельзя, и заметить это можно только выполнив правило. */
      check('истёкшая аренда - гаснет', !on('expired'), out.expired);
      check('прогон по цели держит её сам, без аренды', on('goal'), out.goal);
      check('и держит даже когда аренда давно истекла', on('goalExpired'), out.goalExpired);
      check('пока остаётся хоть один ведущий - горит', on('oneLeft'), out.oneLeft);
      check('ушли оба - гаснет', !on('bothGone'), out.bothGone);
      check('снятое дважды имя не ломает рамку навсегда', on('removedTwiceStillLights'),
        out.removedTwiceStillLights);
    }
    rmSync(dir, { recursive: true, force: true });
  }

  /* СТРУКТУРНЫЕ проверки: это не правило, а четыре способа сломать агента собственным окном, и каждый
   * закрыт одной строкой, которую легко потерять при правке. Выполнить их здесь нельзя - нужен экран, -
   * но замерены они на живой машине (см. комментарий у ScreenFrame). */
  const frameWindow = slice('final class ScreenFrame {');
  check('класс рамки найден', !!frameWindow);
  if (frameWindow) {
    const bare = frameWindow.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    check('окно сквозное для мыши - иначе оно съест каждый клик на экране',
      /ignoresMouseEvents\s*=\s*true/.test(bare));
    check('и не попадает в чужой захват экрана', /sharingType\s*=\s*\.none/.test(bare));
    check('и поднимается, никого не активируя', /orderFrontRegardless\(\)/.test(bare)
      && !/makeKeyAndOrderFront/.test(bare));
    check('и живёт выше полноэкранных окон, на всех рабочих столах',
      /CGShieldingWindowLevel\(\)/.test(bare) && /\.canJoinAllSpaces/.test(bare)
      && /\.fullScreenAuxiliary/.test(bare));
  }

  /* И ГЛАВНОЕ: у обоих путей с точными границами конец обязан быть на ВСЕХ выходах. drive() выходит из
   * восьми мест, run() - из десятка; парный вызов в конце тела покрывал бы один из них. */
  const drive = slice('private static func drive(');
  const replay = slice('private func run(steps:');
  check('прогон по цели снимает рамку через defer, а не в конце тела',
    !!drive && /Acting\.begin\(\.goal\)/.test(drive) && /defer\s*\{\s*Acting\.end\(\.goal\)\s*\}/.test(drive));
  check('повтор - тоже, и в том же defer, что отпускает кнопки мыши',
    !!replay && /Acting\.begin\(\.replay\)/.test(replay)
    && /defer\s*\{[\s\S]*?releaseEverything\(\)[\s\S]*?Acting\.end\(\.replay\)[\s\S]*?\}/.test(replay));

  /* Снимок агента не должен содержать его собственную рамку - второй замок к sharingType. */
  const grab = slice('private static func grab(');
  check('свои окна вычитаются из снимка экрана',
    !!grab && /excludingWindows:\s*ours/.test(grab.replace(/\/\*[\s\S]*?\*\//g, '')));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
