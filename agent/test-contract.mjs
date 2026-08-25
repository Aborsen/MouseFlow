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
/* CRLF folded to LF. The checks below match multi-line shapes with a newline in the pattern, and a Windows
   checkout stores these files with a carriage return before it - so without this they fail on the one
   platform the Windows agent runs on, while the source they describe is perfectly correct. See
   mcp/test-mcp.mjs, which lost three checks to exactly this. */
const read = (p) => readFileSync(ROOT + p, 'utf8').replace(/\r\n/g, '\n');

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
/* Виндовый агент код клавиши ТОЖЕ читает, и проверка симметрична macOS: не отсутствие механизма, а само
 * свойство. Отдельная ловушка здесь своя, платформенная - AltGr. На многих раскладках это Ctrl+Alt, и он
 * складывает символы: поляк, украинец и венгр набирают текст аккордом, который наивная проверка сочтёт
 * командой и прочитает. Поэтому командой считается Ctrl БЕЗ Alt, либо клавиша Windows. */
check('windows: именуются только клавиши, которые ничего не пишут',
  /static string NamedKey\(int vk\)/.test(ps)
  && !/case 0x4[1-9A-F]: name = "[A-Z]"/.test(ps));
check('windows: буква читается только под командным аккордом',
  /if \(!commanded\) return null;/.test(ps)
  && /vk >= 0x41 && vk <= 0x5A/.test(ps));
check('windows: AltGr не считается командой, иначе он прочитает набранный текст',
  /bool commanded = \(ctrl && !alt\) \|\| win;/.test(ps));
check('windows: всё, что может написать символ, остаётся анонимным',
  /if \(named != null\) CaptureNamedKey\(named\); else CaptureKey\(\);/.test(ps));
/* macOS-агент КОД КЛАВИШИ ЧИТАЕТ - и это изменение, сделанное сознательно, поэтому проверка здесь другая.
 *
 * Раньше проверялось отсутствие механизма: `keyboardEventKeycode` не встречается - значит ничего не прочитано.
 * Это было просто, но защищало не то. Обещание протокола - не «код не читается», а «клавиша, которая может
 * что-то написать, никогда не называется». Пока код не читался вовсе, запись не могла знать, что работа
 * закончилась нажатием Send, и скил из неё молча не доделывал последний шаг - человек узнавал об этом на
 * живой машине.
 *
 * Поэтому теперь проверяется само СВОЙСТВО, четырьмя частями, и каждая из них - место, где его можно
 * потерять:
 *   1. в списке именованных клавиш нет ни букв, ни цифр;
 *   2. буквы читаются ТОЛЬКО под Command или Control - не под Shift и не под Option, потому что Shift+буква
 *      это заглавная буква, а ⌥+буква на многих раскладках складывается в символ;
 *   3. всё остальное по-прежнему уходит в анонимный captureKey();
 *   4. и оба агента продолжают это проговаривать словами.
 */
check('macOS: именуются только клавиши, которые ничего не пишут',
  /let NAMED_KEYS: \[Int64: String\] = \[([\s\S]*?)\]/.test(swift)
  && !/"[A-Za-z0-9]"\s*[,\]]/.test(swift.match(/let NAMED_KEYS: \[Int64: String\] = \[([\s\S]*?)\]/)[1]));
check('macOS: буква читается только под Command или Control',
  /let commanded = flags\.contains\(\.maskCommand\) \|\| flags\.contains\(\.maskControl\)/.test(swift)
  && /else if commanded, let letter = commandLetter\(event\)/.test(swift)
  && !/maskShift[\s\S]{0,60}commandLetter/.test(swift));
check('macOS: всё, что может написать символ, остаётся анонимным',
  /\} else \{\s*\n\s*Recorder\.shared\.captureKey\(\)/.test(swift));
check('и оба это проговаривают', /never.{0,40}which key/is.test(ps) && /Never which/i.test(swift));

// ------------------------------------------------------------------ реплей
/* Названная клавиша проигрывается, а анонимная - нет, и порядок веток здесь и есть защита.
 *
 * "Key Down" - это старое анонимное событие набора. Разобранное наивно, оно читается как клавиша по имени
 * "Down", и реплей человека, набиравшего текст, нажал бы стрелку вниз по разу на каждую нажатую клавишу.
 * Ветка с этим именем стоит РАНЬШЕ общей, и в общей стоит ещё и явная проверка. */
group('названные клавиши проигрываются, анонимный набор - нет');
check('старое анонимное событие ловится раньше общей ветки',
  swift.indexOf('case "Key Down", "Focus":') < swift.indexOf('event.action.hasPrefix("Key ")'));
check('и в общей ветке оно исключено ещё раз, явно',
  /event\.action\.hasPrefix\("Key "\), event\.action != "Key Down"/.test(swift));
check('названная клавиша уходит в тот же Input.key, что и /do',
  /Input\.key\(name, ctrl: mods\.contains\("ctrl"\)/.test(swift));
check('на windows та же ловушка исключена так же',
  ps.indexOf('case "Key Down":') < ps.indexOf('e.Action.StartsWith("Key ")')
  && /e\.Action\.StartsWith\("Key "\) && e\.Action != "Key Down"/.test(ps));
check('и windows играет её через тот же PressKey, что и /do',
  /PressKey\(name, wantCtrl, wantShift, wantAlt\)/.test(ps));

/* Запись знала, когда работа перешла в другое ПРИЛОЖЕНИЕ, и никогда - когда то же самое сменило то, что
 * показывает. Браузер, уходящий со страницы на страницу, не оставлял следа: транскрипт мог сказать, на
 * какую ссылку нажали, и не мог сказать, куда она привела.
 *
 * Действие осталось прежним - "Focus" - намеренно: ниже по течению оно открывает сегмент и не создаёт шага,
 * что навигации ровно и нужно, а новое значение приехало бы к старым читателям как «не то действие, которое
 * этот агент записывает». Расширился СМЫСЛ, и обе стороны обязаны расширить его одинаково. */
group('смена заголовка окна - тоже перемещение работы');
for (const [name, text] of [['windows', ps], ['macOS', swift]]) {
  check(`${name}: заголовок читается по часам, а не на каждом тике`,
    /400/.test(text) && /(TitleLookMs|TITLE_LOOK_MS)/.test(text));
  check(`${name}: новый заголовок должен устояться, иначе «Loading…» станет местом`,
    /(TitleSettleMs|TITLE_SETTLE_MS)/.test(text) && /700/.test(text));
  check(`${name}: смена приложения при этом не откладывается`,
    /moved/.test(text));
}

/* У `do` нет возвращаемого значения и никогда не было, поэтому единственным свидетельством оставался
 * следующий скриншот. Прогон потратил минуту на десять действий, ни одно из которых не дошло. Отпечаток
 * экрана по обе стороны действия стоит тридцать миллисекунд - и это ФАКТ, а слова складываются на деплое,
 * иначе два агента научат модель двум разным привычкам. */
group('действие отвечает, шевельнулся ли экран');
for (const [name, text] of [['windows', ps], ['macOS', swift]]) {
  check(`${name}: отпечаток снимается до и после`, /\bmoved\b/i.test(text));
  /* В пределах самого места, а не по всему файлу: первое "350" в этих агентах встречается задолго до
   * действия, и сравнение индексов по всему тексту проходило бы всегда. */
  const emit = text.indexOf('\\"moved\\":');
  check(`${name}: сравнение ПОСЛЕ паузы, иначе всё выглядит неподвижным`,
    emit > 0 && /350/.test(text.slice(Math.max(0, emit - 900), emit)));
  check(`${name}: отдаётся фактом, а не фразой`,
    /\\"moved\\":/.test(text) && !/screen looks exactly/.test(text));
  check(`${name}: «не смог посмотреть» это не «не двигалось»`, /null/.test(text));
}

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

/* ------------------------------------------------------------------- история созданных прогонов */

/* «Создали - вышли - и он пропал»: лента Create жила в памяти компонента, и уход на соседний экран стирал
 * всё - включая единственную кнопку «сделать скилл» у удачного прогона.
 *
 * Проверяется здесь ровно одно, и это то, из-за чего история год выглядела невозможной: данные УЖЕ ехали
 * в браузер и молча выбрасывались типом. Ни новой таблицы, ни нового маршрута, ни второй копии - иначе
 * возражение из шапки CreateView («две записи, которые могут разойтись») стало бы правдой. */
group('история читает ту запись, которая уже есть, а не заводит вторую');
{
  const api = read('web/src/lib/api.ts');
  const sync = read('api/sync.js');
  const earlier = read('web/src/features/create/Earlier.tsx');
  const create = read('web/src/features/create/CreateView.tsx');

  check('сервер отдаёт шаги и слова прогона', /steps: r\.steps, said: r\.said/.test(sync));
  check('и клиент их наконец объявляет, а не выбрасывает типом',
    /steps\?: unknown\[\];/.test(api) && /said\?: unknown\[\];/.test(api));
  /* Ни fetch, ни useEffect, ни своего кэша: всё приезжает через useAccount, который уже это держит. */
  check('история не делает своего запроса', !/fetch\(|useEffect/.test(earlier));
  check('а берёт прогоны с аккаунта', /runs=\{runs\}/.test(create) && /const \{ reload, flows, runs \} = useAccount\(\)/.test(create));

  /* Повтор записи - не реплика: у него нет цели, а лента читается как разговор. */
  check('повторы записей в ленту не попадают',
    /r\.kind === 'agent' && !!r\.goal/.test(earlier));
  /* После удачного прогона страница перечитывает аккаунт - и без этого он оказался бы в ленте дважды. */
  check('и прогон этой сессии не показывается вторым разом как своя же история',
    /hide=\{new Set\(turns\.map/.test(create) && /!hide\.has\(r\.id\)/.test(earlier));

  /* Скилл собирается с agent: 'desktop' из шагов вида {tool, input}. У расширения форма другая, и
   * предложить из неё десктопный скилл значило бы собрать то, что не запустится. */
  /* Комментарии сняты, и в этом весь смысл проверки: файл ОБЪЯСНЯЕТ, почему не различает по
   * `extension === null`, так что искать эту строку в исходнике целиком - значит найти собственное
   * объяснение и посчитать его нарушением. */
  const earlierCode = earlier.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('«сделать скилл» предлагается по ФОРМЕ шагов, а не по отсутствию поля',
    /typeof \(s as Step\)\.tool === 'string'/.test(earlierCode) && !/extension === null/.test(earlierCode));
  check('и только с прогона, который дошёл до конца',
    /run\.outcome === 'ok' && steps\.length > 0/.test(earlier));
  /* Окна спрашиваются у машины в момент, когда прогон кончился. Неделю спустя их не восстановить, а
   * выдуманные origins - это скилл, который врёт, где он применим. */
  check('окна не выдумываются, а остаются пустыми', /windows: \[\],/.test(earlier));

  /* user_run.said существует с самого начала и на этом пути не заполнялся - api/insights.js вынужден
   * объяснять, что пустая колонка не значит «прогон молчал». */
  check('и слова прогона наконец записываются',
    /if \(event\.type === 'text' && event\.text\) commentary\.push/.test(create)
      && /said: commentary\.slice\(0, 200\)/.test(create));

  /* Одно действие - одна строка, на обе стороны. Иначе «click at 220,540» живьём и «click» в истории
   * разошлись бы молча. */
  check('шаг описывается одной функцией на живой фид и на историю',
    /export function describe\(did: Did\)/.test(read('web/src/features/create/describe.ts'))
      && /from '\.\/describe'/.test(create) && /from '\.\/describe'/.test(earlier));
}

/* --------------------------------------------------------------- пачка действий за один ход */

/* Ход стоил снимок и решение, а нёс одно действие: «кликнуть в поле, напечатать адрес, нажать Tab» - три
 * картинки и три решения там, где решается одно. Оба драйвера всегда умели выполнить несколько действий за
 * ход; запрещал это промпт. Разрешив, нужно было провести границу - и она в КОДЕ, потому что промпт говорит
 * модели, что делать, а код решает, что произойдёт.
 *
 * Проверяется здесь, а не только в api/test-step.mjs, потому что драйверов два: правило, применённое одним
 * и забытое другим, - это ровно тот класс расхождения, ради которого существует и _brain.mjs, и этот файл. */
group('пачку режет одно правило, и его читают оба драйвера');
{
  const brain = read('api/_brain.mjs');
  const cloud = read('api/_step.mjs');
  const local = read('web/src/lib/desktop-engine.ts');

  check('правило живёт в мозге, а не в драйвере',
    /export function sameTurn\(/.test(brain) && /export function notBatched\(/.test(brain));
  /* Первое действие целилось в картинку, которую модель видела. Всё, что за ним, - в картинку, которой уже
   * нет: клик и прокрутка берут координату оттуда, поэтому в пачку они не идут. */
  check('в пачку идут только клавиатурные действия и ожидание',
    /const BATCHABLE = new Set\(\['type_text', 'press_key', 'wait'\]\)/.test(brain));
  check('а после ожидания и активации окна - ничего',
    /const TERMINAL = new Set\(\['wait', 'activate_window'\]\)/.test(brain));
  check('и у пачки есть потолок', /export const BATCH_MAX = \d+;/.test(brain));
  /* Потолок стоит в двух местах - в правиле и в промпте, - и это ровно тот случай, когда вторая копия
   * расходится с первой молча. Поэтому промпт его подставляет, а не печатает. */
  check('и промпт называет ТОТ ЖЕ потолок, подстановкой, а не второй копией числа',
    /Up to \$\{BATCH_MAX\} actions in a turn/.test(brain));

  check('облачный драйвер спрашивает правило', /sameTurn\(ran, use\.name \|\| ''\)/.test(cloud));
  check('и локальный спрашивает то же самое', /sameTurn\(ran, use\.name \?\? ''\)/.test(local));
  /* Отрезано, а не отфильтровано: печатать после отказанного клика значит печатать не туда. */
  check('оба режут ход целиком, а не пропускают отказ',
    /cut = true;/.test(cloud) && /cut = true;/.test(local)
      && /cut \|\| !sameTurn/.test(cloud) && /cut \|\| !sameTurn/.test(local));
  check('и оба отвечают на каждый отказанный вызов, потому что API требует результат на каждый',
    /content: cut \? AFTER_CUT : notBatched/.test(cloud)
      && /content: cut \? AFTER_CUT : notBatched/.test(local));
  /* Ложный зелёный не виден и не оспорим - см. блок про turn-that-called-nothing в обоих драйверах. */
  check('успех, обоснованный тем, чего не было, не засчитывается ни там, ни там',
    /if \(use\.name === 'finish'\)[\s\S]{0,700}?if \(cut\) \{[\s\S]{0,200}?AFTER_CUT/.test(cloud)
      && /if \(use\.name === 'finish'\)[\s\S]{0,500}?if \(cut\) \{[\s\S]{0,200}?AFTER_CUT/.test(local));

  /* СЧЁТ БУКСОВАНИЯ ПЕРЕЕХАЛ С ДЕЙСТВИЙ НА ХОДЫ, и это часть той же правки, а не отдельная.
   *
   * До пачек это было одно и то же число. Стало разным - и по действиям ход «кликнуть, Tab, Tab, Tab»
   * насчитал бы три неподвижных из шести, потому что отпечаток 64x36 рамку фокуса не замечает. То есть
   * пачки, поставленные без этой правки, убивали бы работающий прогон вдвое быстрее человека. */
  check('буксование считается ходами, а не нажатиями, в обоих драйверах',
    /if \(judged\) loop\.still = stirred \? 0 : loop\.still \+ 1;/.test(cloud)
      && /still = stirred \? 0 : still \+ 1;/.test(local));
  check('и ход, в котором сдвинулось хоть одно действие, не считается неподвижным',
    /stirred = true/.test(cloud) && /stirred = true/.test(local));
  check('а ход, про который агент не смог сказать, счёт не трогает вовсе',
    /if \(judged\)/.test(cloud) && /if \(judged\)/.test(local)
      && /if \(before && after\) \{/.test(local));
  check('и слова говорят про ходы, а не про нажатия',
    /turns in a row now with nothing changing on screen/.test(brain)
      && /through \$\{streak\} decisions in a row/.test(brain));

  /* И модель об этом ЗНАЕТ заранее, а не узнаёт из отказов: отказ стоит ход. */
  check('промпт объясняет правило раньше, чем оно применится',
    /ONE thing aimed at the screen per turn/.test(brain)
      && /in the SAME turn, add the typing and key presses/.test(brain));
  check('и больше не говорит «одно действие за ход»', !/One action per turn/.test(brain));
  /* Чего код знать не может: Enter отправляет письмо и Enter ищет в Google - по нажатию их не различить.
   * Значит «одностороннее - отдельным ходом» остаётся правилом промпта, и сказано это там прямо. */
  check('а необратимое остаётся правилом промпта, потому что по нажатию его не опознать',
    /Do not put a one-way action in a batch/.test(brain));
}

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

/* Скилл-цель раньше требовала отдельного процесса на машине - воркера, - и вся его квалификация была в том,
 * что он дотягивался до 127.0.0.1. Теперь решает деплой, а агент - руки. Две реализации рук должны вести
 * себя одинаково, иначе один и тот же скилл на Mac и на PC - это два разных скилла. */
group('агент сам доводит цель, по одному ходу за запрос');
check('оба объявляют, что умеют шагать - иначе цель им не дадут',
  /"steps": true/.test(swift) && /\\"steps\\":true/.test(ps));
check('оба ходят в один и тот же endpoint',
  /worker=step/.test(swift) && /worker=step/.test(ps));
/* Обёртка с одной стороны и массив с другой не видны ниоткуда, пока модели не скажут, что ничего не
 * открыто. */
check('оба шлют МАССИВ окон, а не обёртку',
  /\\"windows\\":\[\\\(windows\)\]/.test(swift) && /Append\(Agent\.WindowsArray\(\)\)/.test(ps));
check('оба умеют уменьшить картинку по просьбе и не считают это шагом',
  /raw\["shrink"\] as\? Int/.test(swift) && /Json\.Int\(raw, "shrink", 0\)/.test(ps)
    && /results = \[\]/.test(swift) && /results = "";/.test(ps));
/* Деплой закрывает работу сам на том шаге, который её закончил. Отчёт поверх - это затирание того, что
 * прогон сказал о себе. */
check('оба молча останавливаются на done и НЕ отчитываются поверх',
  /if raw\["done"\] as\? Bool == true \{ return \}/.test(swift)
    && /if \(Json\.Truth\(raw, "done", false\)\) return;/.test(ps));
check('но оба отчитываются, если сдались на полпути',
  /report\(link, id: id, done: Done\(ok: false/.test(swift)
    && /Report\(root, token, id, false/.test(ps));
/* Формулировку про ожидание читает модель, и она обязана быть одной. Поэтому едут числа. */
check('ожидание отвечает числами, а не фразой',
  /\\"quiet\\":\\\(jsonBool\(outcome\.quiet\)\)/.test(swift) && /\\"quiet\\":" \+ \(quiet \? "true"/.test(ps));
check('и обе реализации ждут по одним и тем же числам',
  /settlePollMs = 1500/.test(swift) && /SettlePollMs = 1500/.test(ps)
    && /settleQuietFrames = 2/.test(swift) && /SettleQuietFrames = 2/.test(ps));
check('и одинаково решают, что экран шевельнулся',
  /Double\(sum\) \/ Double\(a\.count\) > 3/.test(swift) && /\(double\)sum \/ a\.Length > 3/.test(ps));
check('оба дают экрану те же 350мс среагировать',
  /forTimeInterval: 0\.35/.test(swift) && /Thread\.Sleep\(350\)/.test(ps));
/* Мышь одна. Повтор, запущенный из приложения посреди прогона, дрался бы с ним за курсор. */
/* Прогон идёт минутами, и деплой может смениться под ним - это несколько секунд 5xx. Терять из-за них
 * наполовину сделанную работу дороже, чем один лишний запрос. 4xx не повторяется: отозванный токен скажет
 * то же самое второй раз. */
check('оба повторяют шаг ровно один раз - и только на 5xx или обрыве',
  /attempt == 0 && \(status == 0 \|\| status >= 500\)/.test(swift)
    && /attempt == 0 && \(status == 0 \|\| status >= 500\)/.test(ps));
const version = (text, re) => (text.match(re) || [])[1];
const swiftVersion = version(swift, /let VERSION = "([\d.]+)"/);
check('и обе версии совпадают',
  swiftVersion && swiftVersion === version(ps, /public const string Version = "([\d.]+)";/),
  `${swiftVersion} vs ${version(ps, /public const string Version = "([\d.]+)";/)}`);
/* Приложение зовёт обновиться до той сборки, которой уже не нужен воркер рядом. Разъезд этих двух чисел -
 * это либо «обнови до того, чего нет», либо молчание о том, что установочный шаг больше не нужен. */
check('и приложение просит ровно её',
  new RegExp(`AGENT_WANTS = '${swiftVersion.replace(/\./g, '\\.')}'`).test(read('web/src/lib/agent.ts')));

/* Отмена приходит, пока агент СТОИТ в ожидании - до двух минут. Оба спрашивают у очереди, не отменили ли. */
check('оба замечают отмену внутри долгого ожидания',
  /worker=state&id=/.test(swift) && /worker=state&id=/.test(ps));
check('и спрашивают не на каждом взгляде на экран, а на каждом третьем',
  /stopEveryPolls = 3/.test(swift) && /StopEveryPolls = 3/.test(ps));
check('молчание в ответ не считается отменой',
  /return false {20}\/\/ no answer is not an answer/.test(swift)
    && /catch \{ return false; \} {3}\/\/ no answer is not an answer/.test(ps));
check('оба уступают, если на машине уже что-то воспроизводится',
  /if Replayer\.shared\.isPlaying \{/.test(swift) && /if \(Agent\.IsPlaying\)/.test(ps));

/* Оба агента падают там, где никто не смотрит: один под launchd, другой в окне на чужом компьютере. До
 * сих пор единственным следом была строка в логе. Проверяется у обоих и одинаково - расходятся они именно
 * в таких местах: одна сторона шлёт, вторая молчит, и это не видно ниоткуда. */
group('агент умеет сказать, что упал');
check('оба шлют краш через аккаунт',
  /worker=crash/.test(swift) && /worker=crash/.test(ps));
/* Ключевое: DSN не лежит внутри программы, которую скачивает пользователь. Дозвон и так идёт с токеном. */
const looksLikeDsn = (text) => /sentry_key=|ingest\.[a-z.]*sentry|https:\/\/[0-9a-f]{16,}@/i.test(text);
check('и ни один не носит в себе DSN Sentry',
  !looksLikeDsn(swift) && !looksLikeDsn(ps));
check('оба говорят, какая они платформа и какая сборка',
  /"platform": "macos"/.test(swift) && /\\"platform\\":\\"windows\\"/.test(ps)
    && /"version": VERSION/.test(swift) && /Agent\.JsonText\(Agent\.Version\)/.test(ps));
/* Хук, который не встал, не встаёт КАЖДЫЙ раз. Репортер, повторяющий это каждый раз, - выключенный
 * репортер. */
check('оба докладывают один и тот же сбой один раз за процесс',
  /told\.insert\(key\)\.inserted/.test(swift) && /Told\.ContainsKey\(key\)/.test(ps));
check('оба молчат, пока машина не привязана к аккаунту',
  /guard let link = Account\.link/.test(swift) && /if \(string\.IsNullOrEmpty\(token\)/.test(ps));
/* Курьер ждёт 90 секунд, потому что он лонг-поллит. Отчёт о падении с таким таймаутом - вторая авария. */
check('и ни один не держит поток минуту с лишним ради отчёта',
  /req\.timeoutInterval = 10/.test(swift) && /req\.Timeout = 10000/.test(ps));
/* Единственный способ проверить трубу на машине, где она обязана работать: настоящую аварию по заказу не
 * устроить, а «мы бы узнали» - это ровно то допущение, из-за которого молчащий репортер живёт месяцами. */
check('у обоих есть способ проверить трубу нарочно',
  /case "\/crash-test"/.test(swift) && /path == "\/crash-test"/.test(ps));
check('и он отказывается, когда докладывать некуда',
  /nowhere to report a crash to/.test(swift) && /nowhere to report a crash to/.test(ps));
/* «Отправлено» значит «отдано сокету». Вопрос теста ровно один: дошло ли. Ответ деплоя несёт `reported`,
 * и он true только если событие взял сам Sentry. */
check('и проверка ждёт ответа, а не рапортует об отправке',
  /raw\["reported"\] as\? Bool == true/.test(swift) && /Json\.Truth\(Json\.Parse\(answer\), "reported"/.test(ps));
/* Хук - главная причина, по которой этот репортер существует: без него запись не пишет ничего. */
check('оба докладывают о невставшем хуке ввода',
  /at: "installTap"/.test(swift) && /"hook\.mouse"/.test(ps));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
