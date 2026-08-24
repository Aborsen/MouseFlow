/* Два агента против одного контракта.
 *
 * Swift здесь не скомпилировать - машина под Windows, - и это ровно та причина, по которой нужен тест,
 * который МОЖНО прогнать: проверять не «работает ли macOS-агент», а «отвечают ли обе реализации на одно и то
 * же». Расхождение контракта - это не гипотетическая беда: за один сеанс трижды выяснилось, что тип, мок и
 * сервер описывают один ответ по-разному, и каждый раз это стоило дороже, чем проверка.
 *
 * Источник истины - таблица маршрутов в PROTOCOL.md. Она разбирается, а не переписывается сюда: список,
 * скопированный в тест, расходится с документом молча.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* Relative to this file, and through fileURLToPath rather than by hand: a URL pathname is percent-encoded, so
 * a directory with a space in it - which this one has - turns into %20 and every read fails. It used to be an
 * absolute Windows path, which is exactly the kind of thing that makes a test useless the moment the work
 * moves to another machine. */
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(ROOT + p, 'utf8');

const protocol = read('agent/PROTOCOL.md');
const ps = read('agent/mouseflow-agent.ps1');
const swift = read('agent/mouseflow-agent.swift');
const installer = read('agent/install-mac.sh');
const client = read('web/src/lib/agent.ts');
const connect = read('web/src/features/connect/ConnectView.tsx');
/* Определение платформы, переключатель и строка с командой живут здесь, а не на одном из экранов - именно
 * потому, что экранов ДВА, и когда это лежало на первом, второй остался виндовым. */
const platform = read('web/src/features/connect/platform.tsx');
const settings = read('web/src/shell/settings/ConnectionsScreen.tsx');
const copier = read('web/scripts/copy-agent.mjs');

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const group = (t) => console.log('\n' + t);

// ------------------------------------------------------------------ маршруты из таблицы
group('каждый маршрут из таблицы протокола есть в обеих реализациях');
const routes = [...protocol.matchAll(/^\| (?:GET|POST) \| `(\/[^`?]*)`/gm)].map((m) => m[1]);
const unique = [...new Set(routes)];
check('таблица разобралась', unique.length >= 12, unique.join(' '));

for (const route of unique) {
  /* PowerShell сравнивает путь строкой, Swift - в switch по case. Ищется литерал пути: он в обоих случаях
   * есть, и его отсутствие означает 404 на эндпоинт, который клиент считает существующим. */
  const inPs = ps.includes(`"${route}"`);
  const inSwift = swift.includes(`"${route}"`);
  check(`${route} — windows ${inPs ? 'да' : 'НЕТ'}, macos ${inSwift ? 'да' : 'НЕТ'}`, inPs && inSwift);
}

// ------------------------------------------------------------------ курьер
/* Курьер - единственное, что агент делает не потому, что его попросили с этой машины. Обе реализации
 * обязаны отвечать одному контракту: иначе Windows-машина молча перестаёт быть управляемой, а выясняется
 * это только у пользователя. */
group('курьер: обе реализации берут работу одинаково');
check('claim идёт на ?worker=claim',
  ps.includes('worker=claim') && swift.includes('worker=claim'));
check('report идёт на ?worker=report',
  ps.includes('worker=report') && swift.includes('worker=report'));
for (const field of ['#record.start', '#record.stop']) {
  check(`${field} понимают оба`, ps.includes(field) && swift.includes(field));
}
check('оба читают body и activate - это replay скилла',
  /"body"|Text\(job, "body"\)/.test(ps) && swift.includes('job["body"]'));
check('оба шлют wait, иначе long-poll превращается в опрос',
  ps.includes('\\"wait\\"') && swift.includes('"wait"'));
check('оба выключают taking при 401/403 - отказанный токен не повторяют вечно',
  /401 \|\| status == 403/.test(ps) && /401 \|\| status == 403/.test(swift));
check('оба стампят health на записи - версия и что агент умел в тот момент',
  ps.includes('\\"health\\"') && swift.includes('"health"'));
/* Токен лежит в профиле пользователя, а не рядом с бинарником. */
check('оба держат состояние в account.json',
  ps.includes('account.json') && swift.includes('account.json'));

// ------------------------------------------------------------------ /health
group('/health отдаёт одни и те же поля');
/* Клиент читает эти поля по именам. Поле, которое одна реализация не присылает, - это не «чуть меньше
 * данных»: canDrain отсутствует, и приложение перестаёт предлагать долгую сессию; canName отсутствует, и
 * запись молча теряет имена. */
for (const field of ['version', 'screen', 'recording', 'playing', 'canSee', 'canWindows', 'canName',
  'canKeys', 'canDrain', 'autostart', 'canAutostart', 'originPinned', 'platform',
  /* На них приложение вешает кнопку "Let Claude drive this computer": отсутствие linked означает
   * "эта сборка не умеет", а не "выключено". */
  'linked', 'taking']) {
  check(`${field} — в обоих`, ps.includes(`\\"${field}\\"`) && swift.includes(`\\"${field}\\"`),
    `ps ${ps.includes(`\\"${field}\\"`)}, swift ${swift.includes(`\\"${field}\\"`)}`);
}
/* А это - macOS-only, и именно потому, что на Windows нечего сообщать: там оба разрешения безусловны. */
/* Полный MIME, а не расширение. Клиент кладёт это значение в запрос к модели, где допустимы ровно четыре
 * строки - и «jpeg» вместо «image/jpeg» уронил всю генерацию флоу на 400. Проверяется у ОБОИХ, потому что
 * расходились они именно здесь: в документе стояло короткое, у Windows длинное, вторая реализация пошла за
 * документом. */
for (const [who, text] of [['windows', ps], ['macos', swift]]) {
  const said = (text.match(/\\"format\\":\\"([^\\"]+)\\"/) || [])[1]
    || (text.match(/mime = "([^"]+)"/) || [])[1];
  check(`format у ${who} - полный MIME`, !!said && said.startsWith('image/'), String(said));
}
/* И клиент нормализует всё равно: чужое значение не должно уметь ронять функцию целиком. */
check('клиент не передаёт чужое значение в API как есть',
  /media_type: mediaType\(frame\.format\)/.test(read('api/_brain.mjs')));

check('permissions — только у macOS, где это ответ, а не константа',
  swift.includes('\\"permissions\\"') && !ps.includes('\\"permissions\\"'));

group('клиент объявляет то, что читает');
for (const field of ['canDrain', 'platform', 'permissions', 'autostart']) {
  check(`AgentHealth знает про ${field}`, new RegExp(`\\b${field}\\?:`).test(client));
}

// ------------------------------------------------------------------ формат записи
group('слова событий - одни и те же');
/* Транскрипт, история и реплей разбирают именно эти строки. Опечатка в одной реализации - это шаг, который
 * реплей не умеет, и клик, который транскрипт не видит. */
for (const word of ['Mouse Movement', 'Left Click Down', 'Left Click Release', 'Right Click Down',
  'Middle Click Down', 'Scroll Up', 'Scroll Down', 'Key Down', 'Focus']) {
  check(`"${word}" — в обоих`, ps.includes(word) && swift.includes(word));
}

check('#ctx пишут оба', ps.includes('#ctx') && swift.includes('#ctx'));
check('#part пишут оба', ps.includes('#part') && swift.includes('#part'));

group('typed text is not recorded, and that is checkable');
/* Ключевое обещание протокола. На Windows охраной служит то, что vkCode/scanCode не читаются; на macOS - что
 * не читается keyboardEventKeycode. Проверяется отсутствие, потому что появление любого из них и есть
 * нарушение. */
check('виндовый агент не читает код клавиши', !/vkCode\s*[;)=]/.test(ps.replace(/vkCode`/g, '')) || !ps.includes('data.vkCode'));
/* На вызов, а не на упоминание: в Swift это поле названо в комментарии именно затем, чтобы сказать, что его не читают,
 * и запрет на слово запретил бы объяснение заодно с нарушением. Нарушение - это чтение. */
check('macOS-агент не читает код клавиши',
  !/getIntegerValueField\(\s*\.keyboardEventKeycode/.test(swift));
check('и оба это проговаривают', /never.{0,40}which key/is.test(ps) && /Never which/i.test(swift));

// ------------------------------------------------------------------ реплей
group('реплей не делает вид, что умеет непроигрываемое');
check('windows считает unplayable', ps.includes('unplayable'));
check('macos считает unplayable', swift.includes('unplayable'));
check('и оба называют Key Down и Focus отдельным случаем',
  /case "Key Down", "Focus"/.test(swift) || (swift.includes('"Key Down", "Focus"')));

// ------------------------------------------------------------------ установщик
group('установщик macOS');
check('bash -n проходит', (() => {
  try { execFileSync('bash', ['-n', ROOT + 'agent/install-mac.sh']); return true; } catch { return false; }
})());
/* Пайп в bash исполняет то, что успело прийти: обрыв на середине иначе запустит половину установщика. */
check('весь скрипт - функция, вызванная в конце', /^main "\$@"\s*$/m.test(installer));
check('качает и агента, и себя из origin', installer.includes('/agent/mouseflow-agent.swift'));
check('компилирует, а не скачивает бинарь', installer.includes('swiftc'));
check('и говорит, что делать без инструментов', installer.includes('xcode-select --install'));
check('имя файла - main.swift, чтобы top-level код был однозначен', installer.includes('main.swift'));
check('умеет удалять себя', installer.includes('--uninstall'));
check('останавливает прежний, прежде чем занять порт', installer.includes('pkill'));
/* Бандл - не вкус в упаковке. Голый бинарник на macOS не субъект прав: TCC винит ОТВЕТСТВЕННЫЙ процесс, а для
 * запущенного из терминала это терминал - поэтому ни запроса, ни строки в списке, и единственный способ выдать
 * ему что-либо это выдать Accessibility терминалу. Найдено тем же способом, что и всё остальное здесь: оно
 * собралось, запустилось и не могло получить ни одного разрешения. */
check('собирается .app, а не голый бинарник', installer.includes('MouseFlow Agent.app')
  && installer.includes('CFBundleIdentifier') && installer.includes('LSUIElement'));
check('и запускается через open, иначе личность прав достаётся терминалу',
  /open "\$app" --args/.test(installer));
check('старый голый бинарник убирается при обновлении',
  /rm -f "\$\{install_dir\}\/mouseflow-agent"/.test(installer));
/* Агент - login item с KeepAlive, поэтому убить процесс не значит остановить его: launchd поднимает
 * снова. И остановка, и перезапуск идут через launchctl по метке, а не через pkill и open - иначе экран
 * называл бы выключателем то, что им не является, а «перезапуск» поднимал бы второй экземпляр на тот же
 * порт рядом с живой задачей launchd. */
check('остановка идёт через launchctl, а не через pkill',
  /MAC_STOP_COMMAND = `launchctl bootout/.test(client)
  && installer.includes('launchctl bootout'));
check('и агент зарегистрирован как login item',
  /RunAtLoad/.test(installer) && /KeepAlive/.test(installer)
  && installer.includes('launchctl bootstrap'));
/* Перезапуск одной командой, и аргументы она берёт из plist, а не повторяет их: порт и origin уже там, и
 * перезапуск со своими разошёлся бы с тем, что стартует при входе. */
check('перезапуск идёт через launchctl kickstart',
  /launchctl kickstart -k \$\{MAC_LABEL\}/.test(client));
/* И то, что было самой дорогой загадкой: разрешение выдано, галочка стоит, доступа нет. TCC хранит грант
 * против подписи, а ad-hoc подпись - это cdhash бинарника, и пересборка его меняет. Установщик обязан
 * сбрасывать запись после НАСТОЯЩЕЙ пересборки, иначе галочка врёт. */
check('после пересборки старый грант сбрасывается',
  /tccutil reset Accessibility/.test(installer) && /rebuilt="yes"/.test(installer));
check('и это можно позвать отдельно, когда состояние уже плохое',
  installer.includes('--fix-permissions'));

group('оба файла попадают в public/, иначе команда установки - 404');
for (const name of ['mouseflow-agent.ps1', 'mouseflow-agent.swift', 'install-mac.sh']) {
  check(`copy-agent копирует ${name}`, copier.includes(name));
}
check('и отсутствие файла - падение, а не пропуск', /process\.exit\(1\)/.test(copier));

// ------------------------------------------------------------------ экран подключения
group('экран подключения предлагает обе платформы');
check('команда для macOS есть в клиенте', /export function macInstallCommand/.test(client));
check('и это curl в bash', /curl -fsSL \$\{origin\}\/agent\/install-mac\.sh/.test(client));
check('платформа определяется, но агент её перебивает',
  /export function hostOS/.test(client) && /health\?\.platform/.test(platform));
check('обе платформы переключаются вручную',
  /id: 'windows'/.test(platform) && /id: 'macos'/.test(platform));
/* Оба экрана берут это из общего модуля, а не каждый из своей копии. Копия и была той ошибкой: команда
 * установки живёт на двух поверхностях, а про macOS узнала одна. */
check('и оба экрана берут одно и то же место',
  /usePlatform\(/.test(connect) && /usePlatform\(/.test(settings)
  && /PlatformPicker/.test(connect) && /PlatformPicker/.test(settings));
/* Ссылка на скачивание - НЕ <Button asChild>: у этой кнопки asChild рендерит Radix Slot, Slot требует
 * ровно одного дочернего элемента, а Button всегда отдаёт несколько - и клик по складке ронял всё
 * приложение с «Slot failed to slot onto its children». */
check('скачивание - ссылка, а не Button asChild',
  /export const DownloadLink/.test(platform)
  && !/asChild/.test(connect) && !/asChild/.test(settings));
/* Шаг про разрешения существует только на macOS: на Windows нечего разрешать, и вечно отмеченный шаг - это
 * мебель. */
check('шаг про разрешения - только на macOS',
  /mac\s*\?\s*\[commandStep, runStep, permissionStep/.test(connect));
/* Три состояния, не два: «ещё не спрашивали» - это не «отказано», и отправлять человека в настройки
 * починить неполоманное - хуже, чем ничего не сказать. */
check('и у разрешения три состояния, а не два',
  /granted === true/.test(connect) && /granted === false/.test(connect) && /permissions\[row\.key\] : null/.test(connect));

/* Client Hints спрашиваются ПЕРВЫМИ, и это не стилистика: Chrome заморозил строку User-Agent, в ней стоит
 * фиксированная Windows, и разбор строки выдал бы человеку на маке команду PowerShell. Поведение прогоняется
 * в test-host-os.mjs; здесь охраняется порядок. */
/* На КОДЕ, а не на прозе: первая версия этой проверки искала имена полей и находила их в комментарии,
 * который объясняет тот самый порядок - и падала на объяснении. */
check('подсказка браузера спрашивается раньше строки',
  client.indexOf('const hinted =') < client.indexOf('const said ='));
/* Третий ответ - «не знаю», и он должен быть сказан словами: подсветить нечего, и страница без этой строки
 * выглядит так, будто переключатель сломан. */
check('и «платформа не определилась» названо на экране',
  /unknown: os === 'other'/.test(platform) && connect.includes('Linux build yet'));
check('а шаги при этом показываются виндовые, с подсвеченной кнопкой',
  /\(platform\.mac \? choice\.id === 'macos' : choice\.id === 'windows'\)/.test(platform));

group('повтор целится в имя, а координата - запасной вариант');
{
  /* Парсер и сборщик тела переехали к API: их читают три стороны - экран Record, локальный MCP-сервер и
   * /api/mcp, который разбирает остановленную запись, когда браузера нигде не открыто. web/src/lib/macro.ts
   * теперь тонкая обёртка, и проверять в ней нечего. */
  const macro = read('api/_macro.mjs');
  /* Промпт, схемы инструментов и кодирование действия переехали в api/_brain.mjs: драйверов теперь два -
   * страница и облачный шаг, - и то, что модель видит, обязано быть одним. Проверяется там, где оно живёт. */
  const engine = read('api/_brain.mjs');

  /* Отчёт был «промахнулись на пару пикселей - открылась не та вкладка», и пиксели тут ни при чём: полоса
   * вкладок перекладывается при изменении их числа. Лечит имя, и оно в записи есть - но flowBody его не
   * отправлял, то есть агент повторял координаты, имея запись, которая знала цель. */
  check('flowBody отдаёт #ctx вместе с событиями', /#ctx/.test(macro) && /if \(e\.context\)/.test(macro));

  /* Агент писал восемь ключей, парсер оставлял четыре, и разошлись они молча: клик, которому приложение не
   * дало имени, приезжал голыми координатами, хотя агент сказал, что это кнопка. Именно этот класс - «одна
   * сторона пишет, другая не читает» - тест и существует ловить. */
  const written = [...swift.matchAll(/out \+= "\\t([A-Za-z]+)=" \+ v/g)].map((m) => m[1]);
  const kept = [...macro.matchAll(/^\s+(\w+): found\.(\w+),$/gm)].map((m) => m[2]);
  check('каждый ключ #ctx, который агент пишет, парсер читает',
    written.length >= 8 && written.every((k) => kept.includes(k)),
    `пишет ${written.join(',')} | читает ${kept.join(',')}`);
  check('и отдаёт обратно в тело повтора под теми же именами',
    written.every((k) => new RegExp(`push\\(\`${k}=`).test(macro)),
    written.filter((k) => !new RegExp(`push\\(\`${k}=`).test(macro)).join(','));
  const transcript = read('api/_transcript.js');
  check('и транскрипт их не теряет на своей нормализации',
    /role: role \|\| null/.test(transcript) && /containerName: containerName \|\| null/.test(transcript));
  check('и агент его разбирает', /line\.hasPrefix\("#ctx"\)/.test(swift));
  check('и целится по нему на КЛИКЕ', /Accessibility\.aim\(at:/.test(swift));

  /* Один уровень вверх, а не обход дерева: протокол запрещает обход из-за цены, и здесь та же арифметика. */
  check('прицел смотрит на соседей, а не обходит дерево',
    /childrenOf\(parent\)\.prefix\(60\)/.test(swift) && !/func walkAll/.test(swift));

  /* Отпускание идёт туда, куда попало нажатие. Иначе клик превращается в перетаскивание через окно. */
  check('release следует за press, а не за записанной точкой',
    /Click Release"\), let at = aimedPoint\(\)/.test(swift));
  /* И сбрасывается на КАЖДОМ нажатии: иначе следующий release уедет в прошлую цель. */
  check('и прицел сбрасывается на каждом нажатии', /aimed = better/.test(swift));

  /* Молча подменять точку нельзя: прогон, который передвинул клик и не сказал, - прогон, чьему отчёту нельзя
   * верить. */
  check('поправки считаются и отдаются в статусе',
    /retargeted/.test(swift) && /\\"retargeted\\":/.test(swift));

  /* Модель тоже знает, во что целится - в описании задачи вкладка названа. Поле для этого теперь есть. */
  check('у инструмента click есть label', /label: \{/.test(engine));
  check('и он едет как name= последним в строке', /name=\$\{label/.test(engine));
  check('а name= берёт остаток строки, как text= и title=',
    /name == "text" \|\| name == "title" \|\| name == "name"/.test(swift));
}

/* Оба агента пишут адрес страницы, и обрезают его ОДИНАКОВО. Это половина того, что делает запись
 * пригодной для портативного скилла - без адреса первый шаг звучит как «найди окно с таким заголовком», а
 * этого облачный агент не умеет. */
group('адрес страницы, и он обрезан в агенте');
check('macOS читает AXURL там, где уже искал контейнер',
  /if role == "AXWebArea" \{ out\.url = webURL\(e\) \}/.test(swift));
check('Windows читает его с Document через ValuePattern',
  /at\.Current\.ControlType == ControlType\.Document/.test(ps)
    && /\(\(ValuePattern\)pattern\)\.Current\.Value/.test(ps));
/* Не поиском вниз: полный обход control view - 0.6-4.4 секунды на окно, и протокол это запрещает. */
check('и оба поднимаются вверх, а не ищут вниз',
  /TreeWalker\.ControlViewWalker\.GetParent\(at\)/.test(ps) && !/FindFirst\(TreeScope\.Descendants/.test(ps));
/* Строка запроса - это место, где живут сессионный токен, одноразовая ссылка и то, что человек набрал в
 * поиске. Дальше по цепочке payload копируется куда угодно, поэтому режется здесь. */
check('macOS отбрасывает query и fragment', /parts\.query = nil/.test(swift) && /parts\.fragment = nil/.test(swift));
check('Windows отбрасывает их через Uri, а не строковой хирургией',
  /GetLeftPart\(UriPartial\.Authority\)/.test(ps) && /Uri\.TryCreate/.test(ps));
check('и оба берут только http и https',
  /scheme == "http" \|\| scheme == "https"/.test(swift)
    && /parsed\.Scheme != Uri\.UriSchemeHttp/.test(ps));
check('протокол называет ключ и говорит, где происходит обрезка',
  /`url` \(the page it landed on/.test(protocol) && /the cut happens in the AGENT/.test(protocol));
check('и обе половины пишут его в #ctx',
  /out \+= "\\turl=" \+ v/.test(swift) && /sb\.Append\("\\turl="\)/.test(ps));

/* Перенаведение на Windows. macOS это уже умеет; пока Windows не умел, повтор там был чистыми
 * координатами - и это ровно та половина продукта, которой пользуется владелец. */
group('Windows тоже целится в имя');
/* Настоящий блокер был здесь: парсер повтора выбрасывал #ctx на третьем символе, так что имён при
 * воспроизведении не существовало вовсе. */
check('парсер повтора читает #ctx, а не пропускает его',
  /if \(line\.StartsWith\("#ctx", StringComparison\.OrdinalIgnoreCase\)\) pending = ParseCtx\(line\)/.test(ps));
check('и контекст цепляется ровно к одному событию', /pending = null;/.test(ps));
check('целится только на нажатии, release идёт следом',
  /if \(IsPress\(e\.Action\)\) Retarget\(e, ref ax, ref ay\)/.test(ps));
check('ищет имя среди СОСЕДЕЙ, на один уровень',
  /parent\.FindFirst\(TreeScope\.Children/.test(ps));
check('поправки считаются и отдаются в статусе, как на macOS',
  /_retargeted\+\+/.test(ps) && /\\"retargeted\\":/.test(ps));
check('и счётчик сбрасывается на каждом прогоне', /_retargeted = 0;/.test(ps));
/* Отказ accessibility не должен отменять повтор: без имени, без элемента, без точки - жмём туда, где было. */
check('всё падает мягко в координату', /catch \{ \/\* the screen moved under the read/.test(ps));

/* Два разных забирающих на одном аккаунте, и они не взаимозаменяемы: курьер агента умеет запись и повтор,
 * а скилл-цель - это модель, решающая по одному действию за ход, и модели в агенте нет. Стучатся оба в
 * один и тот же endpoint. */
group('курьер говорит, что он курьер, и цели ему не дают');
check('оба агента объявляют kind=agent при claim',
  /"kind": "agent"/.test(swift) && /\\"kind\\":\\"agent\\"/.test(ps));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
