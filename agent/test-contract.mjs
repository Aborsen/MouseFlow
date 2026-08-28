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
/* Модификатор `win` добавлен в 0.12.0, и повтор обязан его читать: аккорд, записанный сборкой, умеющей
 * держать Win, должен воспроизводиться как аккорд, а не как его остаток. Проверяется, что путь повтора и
 * путь /do ведут в ОДНУ функцию с одинаковым набором модификаторов, а не совпадение строки. */
check('и windows играет её через тот же PressKey, что и /do',
  /PressKey\(name, wantCtrl, wantShift, wantAlt, wantWin\)/.test(ps)
  && /static string PressKey\(string key, bool ctrl, bool shift, bool alt, bool win\)/.test(ps));

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
   * действия, и сравнение индексов по всему тексту проходило бы всегда.
   *
   * Окно - эвристика близости, и его пришлось раздвинуть с 900 до 1400, когда между паузой и отправкой
   * появился `output`: то, что проверяется, - порядок, а не расстояние, и число здесь лишь бюджет на код
   * между ними. Если оно снова упрётся, раздвигать его правильнее, чем ослаблять проверку. */
  const emit = text.indexOf('\\"moved\\":');
  check(`${name}: сравнение ПОСЛЕ паузы, иначе всё выглядит неподвижным`,
    emit > 0 && /350/.test(text.slice(Math.max(0, emit - 1400), emit)));
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
  /* ДВА ВИДА, ОДНИ ПРАВИЛА. История стоит колонкой справа на широком окне (EarlierPanel) и лентой над
   * полем ввода на узком (Earlier). Всё, от чего зависит, какой прогон показывать и можно ли из него
   * сделать скилл, лежит в run-history.ts - иначе колонка однажды посчитала бы прогон удачным, а лента
   * тот же самый нет. */
  const rules = read('web/src/features/create/run-history.ts');
  const panel = read('web/src/features/create/EarlierPanel.tsx');
  check('оба вида читают одни и те же правила',
    /from '\.\/run-history'/.test(earlier) && /from '\.\/run-history'/.test(panel));

  check('повторы записей в ленту не попадают',
    /r\.kind === 'agent' && !!r\.goal/.test(rules));
  /* После удачного прогона страница перечитывает аккаунт - и без этого он оказался бы в ленте дважды.
   * Множество считается ОДИН раз на оба вида, иначе они разошлись бы в том, что уже показано. */
  check('и прогон этой сессии не показывается вторым разом как своя же история',
    /const earlierHide = useMemo\(\s*\(\) => new Set\(turns\.map/.test(create)
      && (create.match(/hide=\{earlierHide\}/g) || []).length === 2
      && /!hide\.has\(r\.id\)/.test(rules));

  /* Скилл собирается с agent: 'desktop' из шагов вида {tool, input}. У расширения форма другая, и
   * предложить из неё десктопный скилл значило бы собрать то, что не запустится. */
  /* Комментарии сняты, и в этом весь смысл проверки: файл ОБЪЯСНЯЕТ, почему не различает по
   * `extension === null`, так что искать эту строку в исходнике целиком - значит найти собственное
   * объяснение и посчитать его нарушением. */
  const rulesCode = rules.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('«сделать скилл» предлагается по ФОРМЕ шагов, а не по отсутствию поля',
    /typeof \(s as Step\)\.tool === 'string'/.test(rulesCode) && !/extension === null/.test(rulesCode));
  check('и только с прогона, который дошёл до конца',
    /run\.outcome === 'ok' && stepsOf\(run\)\.length > 0/.test(rules));
  /* Окна спрашиваются у машины в момент, когда прогон кончился. Неделю спустя их не восстановить, а
   * выдуманные origins - это скилл, который врёт, где он применим. */
  check('окна не выдумываются, а остаются пустыми', /windows: \[\],/.test(rules));

  /* Колонка справа держит историю, а не снимок рабочего стола. Панель Live Context снята целиком: её
   * прямоугольник почти всё время стоял пустым - снимок читался по кнопке, - а место занимал постоянно. */
  check('правая колонка - это история, и снимка экрана в ней больше нет',
    /<EarlierPanel/.test(create) && !/LiveContext/.test(create));
  /* Ниже xl второй колонки нет вовсе, и без ленты история стала бы недостижимой на окне поменьше. */
  check('на узком окне история остаётся над полем ввода',
    /<div className="xl:hidden">\s*<Earlier/.test(create));

  /* user_run.said существует с самого начала и на этом пути не заполнялся - api/insights.js вынужден
   * объяснять, что пустая колонка не значит «прогон молчал». */
  check('и слова прогона наконец записываются',
    /if \(event\.type === 'text' && event\.text\) commentary\.push/.test(create)
      && /said: commentary\.slice\(0, 200\)/.test(create));

  /* Одно действие - одна строка, на обе стороны. Иначе «click at 220,540» живьём и «click» в истории
   * разошлись бы молча. */
  check('шаг описывается одной функцией на живой фид и на историю',
    /export function describe\(did: Did, /.test(read('web/src/features/create/describe.ts'))
      && /from '\.\/describe'/.test(create) && /from '\.\/describe'/.test(earlier));
}

/* ------------------------------------------------------------------- порог: кого агент слушает */

/* До 0.9.7 -AllowOrigin только отражался в заголовок и не отвергал ничего - на ОБОИХ агентах, с одинаковым
 * комментарием, объясняющим, что схему аутентификации выбирают и второй реализации нельзя изобретать свою.
 * Прочтение было неверным: незаэнфорсенный пин это не незаконченная функция, а слушатель на 127.0.0.1,
 * который выполнит `action=type text=curl … | sh` от любой страницы, открытой в Safari или Firefox.
 *
 * Здесь проверяется РОВНО ОДНО: что оба агента отвечают на этот вопрос одинаково. Исполнение правила
 * проверяется в agent/check-swift.mjs, который компилирует вырезанную из исходника функцию и гоняет её на
 * настоящих origin'ах; регулярка так не умеет и притворяться не должна. */
group('оба агента одинаково решают, кого слушать');
{
  const sw = swift.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const ps1 = ps.replace(/\/\*[\s\S]*?\*\//g, '');

  check('у обоих есть функция допуска',
    /func originAllowed\(_ origin: String\?\) -> Bool/.test(sw)
      && /public static bool OriginAllowed\(string origin\)/.test(ps1));
  /* Порог ДО маршрутизации: маршрут, добавленный завтра, наследует проверку, а не забывает её. */
  check('и оба спрашивают её перед маршрутизацией, а не внутри маршрутов',
    /if !originAllowed\(request\.origin\)/.test(sw) && /if \(!OriginAllowed\(origin\)\)/.test(ps1));

  /* Умолчание перестало значить «все». Агент без аргументов - это то, что запускает «Quit & Reopen». */
  check('умолчание у обоих - пусто, а не звёздочка',
    /var allowOrigin = ""/.test(sw) && /public static string AllowOrigin = "";/.test(ps1));
  check('и параметр PowerShell тоже', /\[string\]\$AllowOrigin = '',/.test(ps));

  /* Список собственных origin'ов обязан совпадать: агент, знающий одно развёртывание из двух, - это агент,
   * который «просто не находится» на втором. */
  /* Из СЫРОГО исходника, а не из очищенного от комментариев: снятие `//` не различает комментарий и
   * строковый литерал, и первая же попытка срезала «//mouseflowapp.vercel.app» прямо из URL, оставив
   * «https:». Список читается из самого объявления, что заодно точнее - проверяется он, а не любой адрес,
   * который случайно упомянут в файле. */
  /* Swift закрывает список `]`, C# - `}`. Берётся то, что встретилось раньше: закрывающую скобку своего
   * языка знает каждый, а тест, знающий только одну, молча читает пустой список и объявляет расхождение. */
  const listOf = (text, from) => {
    const at = text.indexOf(from);
    if (at < 0) return [];
    const ends = [text.indexOf(']', at + from.length), text.indexOf('}', at + from.length)]
      .filter((i) => i >= 0);
    if (!ends.length) return [];
    return [...text.slice(at, Math.min(...ends)).matchAll(/"(https:\/\/[^"]+)"/g)].map((m) => m[1]);
  };
  const swShipped = listOf(swift, 'let SHIPPED_ORIGINS = [');
  const psShipped = listOf(ps, 'public static readonly string[] ShippedOrigins = new string[] {');
  for (const origin of ['https://mouseflowapp.vercel.app', 'https://mouse-agent.vercel.app']) {
    check(`оба знают ${origin}`, swShipped.includes(origin) && psShipped.includes(origin),
      `swift ${swShipped.join(',')} | ps ${psShipped.join(',')}`);
  }

  /* Хост сравнивается целиком. По префиксу `https://localhost.evil.example` прошло бы внутрь. */
  check('loopback опознаётся по хосту, а не по началу строки',
    /host == "localhost" \|\| host == "127\.0\.0\.1"/.test(sw)
      && /host == "localhost" \|\| host == "127\.0\.0\.1"/.test(ps1));
  check('и оба разбирают адрес разбором, а не строковой хирургией',
    /URL\(string: origin\)/.test(sw) && /Uri\.TryCreate\(origin, UriKind\.Absolute, out parsed\)/.test(ps1));

  /* Отражать отказанному его Origin значило бы выдать право читать ответ, которого он не получил. */
  check('отказанному не отражается его origin ни там, ни там',
    /!originAllowed\(asked\) \{ allow = "" \}/.test(sw)
      && /if \(origin != null && !OriginAllowed\(origin\)\) allow = "";/.test(ps1));

  /* Без DELETE браузер отказывает собственному preflight, и «Отсоединить» нажать нельзя вовсе. */
  check('DELETE перечислен у обоих',
    /Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS/.test(sw)
      && /Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS/.test(ps1));

  /* Автозапуск - решение другого веса: не «страница, которой мы отвечаем», а «оператор, назвавший её». */
  check('автозапуск требует ЯВНОГО пина у обоих',
    /allowOrigin\.isEmpty \|\| allowOrigin == "\*"/.test(sw)
      && /AllowOrigin\.Length > 0 && AllowOrigin != "\*"/.test(ps1));
  check('и оба сообщают «закреплён» одинаково - про названную страницу, а не про наличие проверки',
    /!allowOrigin\.isEmpty && allowOrigin != "\*"/.test(sw)
      && /AllowOrigin\.Length > 0 && AllowOrigin != "\*"/.test(ps1));

  /* И протокол больше не учит следующую реализацию не проверять. */
  check('протокол больше не говорит, что аутентификации нет',
    !/Today: \*\*none\*\*/.test(protocol) && /Who may talk to the agent/.test(protocol));
  check('и называет правило, которое обе стороны обязаны повторить',
    /No `Origin` header \| \*\*allowed\*\*/.test(protocol));
}

/* --------------------------------------------------------------- пачка действий за один ход */

/* Ход стоил снимок и решение, а нёс одно действие: «кликнуть в поле, напечатать адрес, нажать Tab» - три
 * картинки и три решения там, где решается одно. Оба драйвера всегда умели выполнить несколько действий за
 * ход; запрещал это промпт. Разрешив, нужно было провести границу - и она в КОДЕ, потому что промпт говорит
 * модели, что делать, а код решает, что произойдёт.
 *
 * Проверяется здесь, а не только в api/_test-step.mjs, потому что драйверов два: правило, применённое одним
 * и забытое другим, - это ровно тот класс расхождения, ради которого существует и _brain.mjs, и этот файл. */
group('пачку режет одно правило, и его читают оба драйвера');
{
  const brain = read('api/_brain.mjs');
  const cloud = read('api/_step.mjs');
  const local = read('web/src/lib/desktop-engine.ts');

  check('правило живёт в мозге, а не в драйвере',
    /export function sameTurn\(/.test(brain) && /export function notBatched\(/.test(brain));
  /* Первое действие целилось в картинку, которую модель видела. Всё, что за ним, - в картинку, которой уже
   * нет: клик и прокрутка берут координату оттуда, поэтому в пачку они не идут.
   *
   * Две работы с буфером обмена вошли сюда потому, что не целятся НИКУДА - ни в окно, ни в точку. Ради
   * этого они и батчатся: clipboard_write и следом Control+V - это один ход. А capture_window намеренно
   * НЕ здесь: снимок сразу после клика гонится с окном, которое пытается снять. */
  /* read_window и find_element только СМОТРЯТ: они ничего не трогают, поэтому «кликнуть и посмотреть, что
   * получилось» - это один ход. Но за ними ничего идти не может, и это не противоречие: их ответ приходит
   * вместе со следующим снимком, а до него целиться нечем. */
  check('в пачку идут только то, что не целится в картинку',
    /'type_text', 'press_key', 'wait', 'clipboard_read', 'clipboard_write', 'read_window', 'find_element',/
      .test(brain));
  /* Состав закреплён ТОЧНО, а не по вхождению, и это осознанно: новое терминальное действие меняет то,
   * что модели разрешено уложить в один ход, и должно требовать правки теста, а не проезжать молча.
   * Наведение попало сюда по причине, которой нет ни у ожидания, ни у активации: оно терминально потому,
   * что СРАБОТАЛО - наводят ровно затем, чтобы экран стал другим. */
  /* open_url и open_app - по той же причине, что активация окна, только сильнее: окно вот-вот появится И
   * на это нужно время, поэтому всё прицельное в том же ходе целилось бы в экран, где его ещё не было. */
  /* scroll_to и drag двигают экран под тем, что пойдёт следом, а scroll_to вдобавок может ехать секунды. */
  /* refresh_page и wait_for_window оба ЗАКАНЧИВАЮТСЯ экраном, на который никто не смотрел: один его
   * перезагрузил, другой дождался, пока он изменится. Ровно то же основание, что у `wait`. */
  check('а после всего, что оставляет экран непросмотренным, - ничего',
    /'wait', 'activate_window', 'hover', 'open_url', 'open_app', 'scroll_to', 'drag',\s*\n\s*'refresh_page', 'wait_for_window',/
      .test(brain));
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
/* ДВА ВОПРОСА, А НЕ ОДИН, и оба агента обязаны отвечать на них одинаково - иначе модель услышит про одно и
 * то же действие разное на двух платформах. «Что-то произошло?» спрашивают после действия, и ложное НЕТ
 * останавливает прогон (шесть подряд - и он закончен). «Оно перестало меняться?» спрашивает ожидание, и
 * ложное НЕТ сжигает весь лимит. До 0.14.0 это был один тест `mean > 3`, и набор пятнадцати символов даёт
 * среднюю 0.049 - то есть переименование документа читалось как «ничего не произошло». Числа - в
 * api/_brain.mjs, вместе с таблицей, с которой они сняты. */
check('и одинаково решают, что экран шевельнулся',
  /private static let stirLevel = 8/.test(swift) && /private static let stirCells = 1/.test(swift)
    && /const int StirLevel = 8;/.test(ps) && /const int StirCells = 1;/.test(ps));
check('и одинаково решают, что он перестал',
  /private static let quietMean = 3\.0/.test(swift) && /const int QuietMean = 3;/.test(ps));
/* И спрашивают их в правильных местах: отчёт о действии - «произошло», ожидание - «перестало». */
check('и спрашивают их там, где надо',
  /stirred = jsonBool\(self\.stirred\(a, b\)\)/.test(swift) && /if let was = last, quiet\(was, now\)/.test(swift)
    && /return Agent\.GridStirred\(a, b\)/.test(ps) && /GridQuiet\(last, now\)/.test(ps));
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

/* Часы записи и то, чем они заведены.
 *
 * Карточка говорила «Recording» по `health.recording` - то есть по самому агенту, - а секунды шли только
 * из `live`, состояния этого компонента. Разные вопросы, и расходились они ровно там, где это важно:
 * `live` обнуляется при любом перемонтировании, а запись принадлежит агенту и идёт дальше. Ушёл с экрана и
 * вернулся, перезагрузил вкладку, нажал «Record» в строке меню - и карточка показывала
 * «Recording · 00:00 · 0 events» и стояла так, потому что опрос был заперт на `live` и не запускался.
 *
 * Остановившиеся часы над идущей записью хуже отсутствующих: число не пропало, оно врёт, а смотрят на него
 * ровно затем, чтобы понять, идёт ли ещё запись. */
group('часы записи заведены от записи, а не от памяти вкладки');
{
  const rec = read('web/src/features/record/RecordView.tsx');
  /* Искать отсутствие можно только в коде: абзац выше рассказывает про `live` теми же словами. */
  const code = rec.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  check('«идёт ли запись» - это агент, а не состояние компонента',
    /const recording = live !== null \|\| !!health\?\.recording;/.test(code));
  check('опрос заперт на неё же',
    /if \(!recording\) return;[\s\S]{0,4000}\}, \[recording, port\]\);/.test(code));
  /* Того, из-за чего это сломалось, в коде больше нет ни под каким именем. */
  check('и старого ключа по `live` не осталось', !/capturing/.test(code));
  /* Секунды переживают перемонтирование не потому, что их сохранили, а потому что они никогда не были
   * вкладкины: /record/status несёт часы самого агента. */
  check('секунды приезжают от агента, а не считаются здесь',
    /setLive\(\{ count: s\.count, elapsedMs: s\.elapsedMs \}\)/.test(code)
    && /elapsedMs=\{live\?\.elapsedMs \?\? 0\}/.test(code));
  check('и агент их правда отдаёт',
    /"elapsedMs\\":\\\(s\.elapsedMs\)/.test(read('agent/mouseflow-agent.swift'))
    && /\\"elapsedMs\\":" \+ RecordElapsed/.test(read('agent/mouseflow-agent.ps1')));
}

/* Enter делал не то, что написано на кнопке.
 *
 * Кнопка - «Plan it», а Enter отправлял. Под полем об этом была строчка, и это ровно тот случай, когда
 * сноска не работает: человек печатает задачу, по привычке жмёт Enter, и агент уже водит мышью по
 * настоящему рабочему столу. Плана нет - значит нет и чекпоинтов, то есть остановить его нечем.
 *
 * Починка - не «Enter теперь планирует», а «кнопка одна, и на ней написано, что произойдёт». Чем она
 * является, выбирают стрелкой рядом; строчка-объяснение убрана, потому что объяснять больше нечего. */
group('кнопка говорит, что произойдёт, и Enter делает то же самое');
{
  const create = read('web/src/features/create/CreateView.tsx');
  /* Искать отсутствие можно только в коде: абзац выше рассказывает про старое поведение теми же словами. */
  const code = create.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  /* Одно значение на всех, иначе кнопка снова сможет говорить одно, а клавиша делать другое. */
  check('«план есть для этого текста» - одно значение',
    /const planned = !!plan && plan\.for === goal\.trim\(\);/.test(code));
  check('«что сейчас сделает кнопка» - тоже одно',
    /const wants: StartWith = planned \? 'run' : startWith;/.test(code));
  check('и действие у кнопки с клавишей общее',
    /const act = \(\) => \(wants === 'run' \? send\(\) : makePlan\(\)\);/.test(code));

  /* Обе двери в одно и то же действие. Разными их сделать больше нельзя, не тронув `act`. */
  check('кнопка зовёт его', /onClick=\{\(\) => void act\(\)\}/.test(code));
  check('и Enter зовёт его же', /if \(ev\.key !== 'Enter' \|\| ev\.shiftKey\) return;\s*ev\.preventDefault\(\);\s*void act\(\);/.test(code));
  check('и надпись на кнопке - это он же',
    /\{wants === 'run' \? 'Run it' : 'Plan it'\}/.test(code));

  /* Того, чем это чинили раньше, в коде не осталось: ни тайного ускорителя, ни строчки, которая его
   * объясняла. Сноска под полем была не решением, а признанием, что кнопка врёт. */
  check('скрытого быстрого пути больше нет', !/ev\.metaKey \|\| ev\.ctrlKey/.test(code));
  check('и строчки про Enter под полем тоже', !/<kbd/.test(code));

  /* Выбор - предпочтение, а не решение про один прогон, и по умолчанию он безопасный. */
  check('выбор помнится между прогонами', /localStorage\.setItem\('mouseflow\.startWith', how\)/.test(code));
  check('и по умолчанию это план',
    /localStorage\.getItem\('mouseflow\.startWith'\) === 'run' \? 'run' : 'plan'/.test(code));
  /* Обе половинки названы там же, где живёт тип, и обе говорят про последствия. */
  check('обе половинки говорят, что случится с экраном',
    /Nothing happens yet\./.test(create) && /with no checkpoints\./.test(create));
  /* Когда план уже на экране, выбирать нечего - и предлагать выбор, ничего не меняющий, хуже, чем не
   * предлагать. */
  check('стрелка исчезает, когда выбирать нечего',
    /\{!planned && \(\s*<DropdownMenu>/.test(code));

  /* И то, ради чего план вообще существует: прогон берёт ИМЕННО одобренный, иначе чекпоинты не сработают. */
  check('одобренный план доезжает до цикла',
    /checkpoints: approved\?\.checkpoints,/.test(code) && /onCheckpoint: approved/.test(code));
}

/* Переименовать и удалить прогон - и ни то, ни другое не переписывает того, что произошло.
 *
 * Подпись живёт РЯДОМ с целью, а не вместо неё: цель - то, что действительно ушло в работу, и то, что
 * посылает «Ask again». Дать её переписать значило бы, что строка после правки утверждает, будто запускали
 * не то, что запускали, - и следующее нажатие «Ask again» это доказало бы.
 *
 * Удаление - надгробие, и причина не та же, что у скиллов: прогон пишется, ПОКА ИДЁТ (api/mcp.js обновляет
 * строку на каждом ходу), так что hard delete идущего прогона вернул бы его следующим ходом молча. */
group('прогон можно назвать и удалить, не переписав того, что было');
{
  const sync = read('api/sync.js');
  const rules = read('web/src/features/create/run-history.ts');
  const panel = read('web/src/features/create/EarlierPanel.tsx');
  const feed = read('web/src/features/create/Earlier.tsx');
  const migration = read('db/013_run_named.sql');

  check('колонки заведены миграцией',
    /add column if not exists name text/.test(migration)
    && /add column if not exists deleted_at timestamptz/.test(migration));

  /* Читается только живое, и подпись едет вместе со строкой. */
  check('список не отдаёт удалённые', /from user_run\s*\n\s*where user_id = \$\{who\.id\} and deleted_at is null/.test(sync));
  check('и везёт подпись', /select client_id, kind, goal, name,/.test(sync) && /name: r\.name,/.test(sync));

  /* САМОЕ ВАЖНОЕ ЗДЕСЬ. Ни один путь после записи не трогает goal - искать это можно только в коде, потому
   * что абзацы вокруг рассказывают про goal теми же словами. */
  const syncCode = sync.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('переименование правит подпись, а не цель',
    /update user_run set name = /.test(syncCode) && !/set goal/.test(syncCode));
  check('удаление ставит надгробие, а не удаляет строку',
    /update user_run set deleted_at = now\(\)/.test(syncCode) && !/delete from user_run/.test(syncCode));
  /* Иначе идущий прогон воскресает следующим же ходом - без следа, что его удаляли. */
  check('и запись прогона не воскрешает удалённый',
    /select deleted_at from user_run[\s\S]{0,200}if \(before && before\.deleted_at\) continue;/.test(syncCode));

  /* Показывается подпись, если она есть, - но цель при этом остаётся видна в обоих видах. */
  check('в списке показывается подпись, а под ней - настоящая цель',
    /\(run\.name && run\.name\.trim\(\)\) \|\| run\.goal/.test(rules)
    && /asked for: \{run\.goal\}/.test(panel) && /asked for: \{run\.goal\}/.test(feed));
  /* «Ask again» посылает то, что запускали, а не то, как это назвали. */
  check('и «Ask again» посылает цель, а не подпись',
    /onAskAgain\(run\.goal!\)/.test(panel) && /onAskAgain\(run\.goal!\)/.test(feed));

  /* Строка прогона - единственная его запись: удаление уносит и итоги на Dashboard, и то, что видит
   * ассистент. Поэтому спрашивается дважды, обоими видами, одной и той же кнопкой. */
  check('удаление спрашивает дважды в обоих видах',
    (panel.match(/<ArmedButton/g) || []).length === 1 && (feed.match(/<ArmedButton/g) || []).length === 1);
  /* Отказ сервера при HTTP 200 приезжает в `problems`; проглотить его значило бы нарисовать успех. */
  check('отказ аккаунта называется, а не глотается',
    /if \(saved\.problems\?\.length\) throw new Error\(saved\.problems\[0\]\)/.test(read('web/src/features/create/CreateView.tsx')));

  /* Секцию можно свернуть, и выбор переживает перезагрузку - как остальные предпочтения этой страницы. */
  check('секцию истории можно свернуть',
    /aria-expanded=\{shown\}/.test(panel) && /localStorage\.setItem\(OPEN_KEY/.test(panel));
}

/* Высота шапки и высота страницы - одно число в двух файлах, и разошлись они молча.
 *
 * Страница, занимающая остаток окна, вычитает высоту шапки числом. Вычиталось 3.25rem, а шапка со своим
 * padding'ом выходила 65px: тринадцать пикселей, которые видно СНИЗУ - правая колонка на Create уезжала под
 * нижний край окна вместе со своим нижним отступом, так что сверху зазор был, а снизу нет.
 *
 * Чинится это не тем, что число поправили, а тем, что шапка его теперь ОБЪЯВЛЯЕТ: у неё задана высота, и
 * складываться из содержимого ей больше нечего. Проверка держит обе половины вместе. */
group('шапка объявляет свою высоту, и страница вычитает ту же самую');
{
  const layout = read('web/src/shell/AppLayout.tsx');
  const surface = read('web/src/shell/Surface.tsx');
  check('у шапки задана высота, а не padding', /<header className="[^"]*\bh-16\b/.test(layout));
  check('и padding по вертикали ей больше не нужен', !/<header className="[^"]*\bpy-3\b/.test(layout));
  check('страница вычитает ровно её', /const APP_PAGE_HEIGHT = 'h-\[calc\(100dvh-4rem\)\]'/.test(surface));
  /* Третья копия этого числа жила в CreateView - о чём Surface.tsx писал в собственном комментарии, - и
   * именно она была неверной дольше всех. */
  check('и своей копии числа у Create больше нет',
    !/100dvh/.test(read('web/src/features/create/CreateView.tsx'))
    && /const page = usePageChrome\(\)/.test(read('web/src/features/create/CreateView.tsx')));
}

/* Сказать об исходе за пределами экрана - это не сказать.
 *
 * Reported: «когда скилл запаблишился - у меня не было уведомления». Уведомление было: Said рисуется наверху
 * страницы Skills. Но Publish жмут в строке таблицы, до которой пролистали, и строка эта оказывается выше
 * окна. Человек видит, что ничего не произошло, и жмёт второй раз - на действии, которое необратимо.
 *
 * Чинится в Said, а не на странице Skills: восемь экранов держат свой `said`, и починка на одном оставила бы
 * семь. Ровно та причина, по которой этот компонент вообще существует - см. его заголовок. */
group('сказанное об исходе показывается на глаза');
{
  const said = read('web/src/components/Said.tsx');
  const code = said.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  check('строка сама прокручивается к себе', /scrollIntoView\(/.test(code));
  /* `nearest` прокручивает ровно столько, сколько нужно, и ноль, когда уже видно: короткая страница не
   * должна дёргаться на каждое сохранение. */
  check('и только когда её не видно', /block: 'nearest'/.test(code));
  /* Просивший меньше движения получает меньше движения. */
  check('и уважает просьбу о меньшем движении',
    /prefers-reduced-motion: reduce/.test(code) && /behavior: still \? 'auto' : 'smooth'/.test(code));
  /* Эффект на ТЕКСТ: восемь экранов зовут setSaid новым объектом, и зависимость от объекта прокручивала бы
   * на каждый ререндер. */
  check('и не дёргается на каждый ререндер', /\}, \[text\]\);/.test(code));
  /* То, ради чего компонент был написан, никуда не делось: объявляется, не забирая фокус. */
  check('и по-прежнему объявляется, не забирая фокус',
    /role="status"/.test(code) && !/\.focus\(\)/.test(code));
  /* Хуки до раннего выхода, иначе порядок хуков меняется между рендерами. */
  check('хуки стоят до раннего выхода',
    said.indexOf('useEffect(') < said.indexOf('if (!note) return null;'));
}

/* ------------------------------------------------------------------ macOS catches up with Windows
 *
 * За шесть релизов Windows-агент ушёл с 0.9.9 на 0.15.0, а macOS шёл следом отказами по имени. Волна,
 * которую проверяют эти группы, закрывает разрыв - и проверяются именно ОБЕ половины, потому что расходятся
 * они всегда одинаково: одна сторона умеет, вторая молчит, и видно это только у пользователя. */

/* ДВЕ УТЕЧКИ, и они первыми не потому, что сложнее, а потому, что это не функции, а то, что агент СОБИРАЕТ
 * и не должен. Всё ниже по течению копирует payload куда угодно - на аккаунт, в модель, в SKILL.md, который
 * скачивают и пересылают, - и значение, не попавшее в запись, не утечёт ни оттуда, ни оттуда. */
group('подпись отличается от содержимого длиной, и это делают оба агента');
{
  /* Тип не различает: в Outlook `option` бывает 275-376 символов, а `radio button` 174 - те же типы, что
   * несут трёхсимвольные подписи. Самое длинное имя на НАЖИМАЕМОМ - 43 символа по трём приложениям. */
  check('порог один и тот же, и он назван числом',
    /static let NAME_MAX = 60\b/.test(swift) && /const int NameMax = 60;/.test(ps));
  check('выше порога пишется длина, а имя выбрасывается',
    /target\.control = nil\s*\n\s*target\.nameLength = name\.count/.test(swift)
      && /target\.Control = null;\s*\n\s*target\.NameLength = name\.Length;/.test(ps));
  /* Никогда оба: у вырезанного имени нет `control=`, так что старый читатель видит шаг с типом и без
   * имени - то есть ровно то, что он показал бы для безымянного элемента. */
  check('и на провод уходит либо имя, либо длина, никогда оба',
    /if let v = e\.control \{ out \+= "\\tcontrol=" \+ v \}\s*\n(?:\s*\/\*[\s\S]*?\*\/\s*\n)?\s*else if e\.nameLength > 0/.test(swift)
      && /else if \(e\.NameLength > 0\)/.test(ps));
  /* САМОЕ ЛЁГКОЕ МЕСТО ЭТО ПОТЕРЯТЬ. Имя МЕРЯЮТ, и обрезанное до 120 имя длиной 376 сообщает о себе «120» -
   * то есть ровно то число, по которому нельзя понять, сколько текста там было. */
  check('macOS меряет имя ДО того, как его укоротит',
    /private static func nameAttr\([\s\S]{0,240}return flatten\(raw\)/.test(swift)
      && /if let name = nameAttr\(current, kAXTitleAttribute\)/.test(swift));
  /* И читающая сторона применяет то же правило к записям, сделанным до этой сборки. */
  check('читающая сторона знает то же правило',
    /function nameOrLength\(name, said\)/.test(read('api/_transcript.js'))
      && /namelen/.test(read('api/_macro.mjs')));
}

group('заголовок окна, который является адресом, теряет строку запроса');
{
  /* Из настоящей записи: `auth.doubleword.ai/u/login?state=hKFo2SAw…` - одноразовый токен входа. У
   * страницы без <title> заголовком становится её адрес, и страница-редирект входа - ровно такая. */
  check('обрезка есть у обоих и живёт отдельной функцией',
    /static func bareTitle\(_ title: String\) -> String\?/.test(swift)
      && /static string BareTitle\(string title\)/.test(ps));
  /* Только когда заголовок ЦЕЛИКОМ адрес: иначе «What is a good name? - Google Search» превратится в мусор. */
  check('и срабатывает только на том, что целиком адрес',
    /if said\.contains\(" "\) \{ return nil \}/.test(swift)
      && /if \(said\.IndexOf\(' '\) >= 0\) return null;/.test(ps));
  check('оба берут только http и https и требуют точку в хосте',
    /scheme == "http" \|\| scheme == "https"[\s\S]{0,200}host\.contains\("\."\)/.test(swift)
      && /parsed\.Scheme != Uri\.UriSchemeHttp[\s\S]{0,300}Host\.IndexOf\('\.'\) < 0/.test(ps));
  /* Резать надо ДО укорачивания: заголовок, обрезанный посреди query, разобрался бы как путь. */
  check('macOS режет раньше, чем укорачивает',
    /clip\(bareTitle\(flat\) \?\? flat, 120\)/.test(swift));
  /* И это тот же путь, которым `window=` попадает в запись, а не соседний. */
  check('и это тот путь, которым заголовок попадает в запись',
    /static func frontWindowTitle\(pid: pid_t\) -> String\? \{[\s\S]{0,400}titleOf\(window\)/.test(swift));
}

/* ДЕЙСТВИЕ, КОТОРОМУ ЕСТЬ ЧТО СКАЗАТЬ. Без него capture и clipread нечем ответить: снимок сделан, а куда он
 * лёг, никто не узнает. Нового в протоколе при этом нет - деплой уже передаёт модели любой output, отличный
 * от "done". */
group('действие умеет ответить словами, и слова складывает агент');
{
  check('у обоих есть один канал, читаемый один раз',
    /static func take\(\) -> String\? \{/.test(swift) && /public static string TakeOutput\(\)/.test(ps));
  check('и он сбрасывается в начале каждого действия',
    /Output\.reset\(\)/.test(swift) && /ResetOutput\(\);/.test(ps));
  /* `{"ok":true}` обязано остаться ровно тем же для действий, которым сказать нечего. */
  check('/do добавляет output только когда он есть',
    /if let said = Output\.take\(\) \{[\s\S]{0,200}\\"output\\":/.test(swift)
      && /said == null\s*\n\s*\? "\{\\"ok\\":true\}"/.test(ps));
  check('и курьер говорит "done", когда сказать нечего',
    /jsonString\(told \?\? "done"\)/.test(swift) && /told == null \? "done" : told/.test(ps));
  /* Предложение из этого складывает деплой одной функцией на оба драйвера - иначе две реализации научат
   * модель двум разным привычкам. */
  check('а сентенцию для модели строит одно место на оба драйвера',
    /export const actionSaid = \(output, moved, streak = 0\)/.test(read('api/_brain.mjs')));
}

group('наружу отвечают в пикселях скриншота, а не в экранных');
{
  /* Всё остальное в actionBody переводит ВНУТРЬ, и одно место для этого - правило. Действия, отвечающие
   * координатами, едут в обратную сторону, и формула здесь та же наизнанку. */
  check('формула одна и та же у обоих',
    /Int\(\(\(screenX - ox\) \* scale\)\.rounded\(\)\)/.test(swift)
      && /\(int\)Math\.Round\(\(screenX - _shotOx\) \* _shotScale\)/.test(ps));
  check('и её читают все четыре действия, которые отвечают координатами',
    (swift.match(/Geometry\.read\(fields\)/g) || []).length >= 4
      && (ps.match(/ReadGeometry\(a\);/g) || []).length >= 4);
  check('и деплой шлёт эти три числа',
    /const geometry = \(\) => `scale=\$\{frame\.scale \|\| 1\} ox=/.test(read('api/_brain.mjs')));
}

/* ОКНО, КОТОРОЕ АГЕНТ НЕ ТРОГАЕТ. На Windows модель однажды сама вывела опасность и оставила записку прозой
 * следующей за собой: «вкладка 1 - сессия агента (НЕ Ctrl+C)». Записка прозой - не охрана. */
group('ни один агент не водит окно, в котором запущен сам');
{
  check('охрана есть у обоих',
    /static func refusal\(pid: pid_t\) -> String\?/.test(swift) && /static string Mine\(IntPtr hwnd\)/.test(ps));
  /* Построено на дереве процессов, а не на «своей консоли»: под Windows Terminal GetConsoleWindow()
   * возвращает ноль, и первая версия охраны была мертва ровно в той среде, для которой писалась. На macOS
   * та же форма: видимое окно принадлежит РОДИТЕЛЮ. */
  check('и оба строят её на дереве процессов, а не на своём окне',
    /private static func parent\(of pid: pid_t\) -> pid_t/.test(swift)
      && /hasVisibleWindow\(walker\)/.test(swift)
      && /static int HostOf\(int pid, DateTime childStarted\)/.test(ps));
  /* Ещё уровень вверх - и запрещённым окажется рабочий стол: на Windows это explorer, на macOS Finder и Dock. */
  check('и оба не заходят в оболочку системы',
    /"launchd", "loginwindow", "Finder", "Dock"/.test(swift) && /"explorer", "services"/.test(ps));
  check('набор спрашивается по переднему окну, а клик - по точке',
    /if action == "type" \|\| action == "key" \{[\s\S]{0,300}frontmostApplication/.test(swift)
      && /if \(action == "type" \|\| action == "key"\)[\s\S]{0,200}GetForegroundWindow\(\)/.test(ps));
  /* Снимок - нет: картинка ничего не меняет, а сфотографировать собственный терминал, когда в нём что-то
   * пошло не так, - разумное желание. */
  check('а снимок намеренно не охраняется ни там, ни там',
    /НЕ охраняется Own\.refusal намеренно/.test(swift)
      && /Deliberately NOT guarded by Mine\(\)/.test(ps));
}

group('боковая прокрутка: записать, повторить и скомандовать');
{
  /* Дыра была тройная, и закрывать надо все три: без записи не с чего повторять, без повтора запись
   * бесполезна, без команды модель не может прокрутить вбок вовсе. */
  check('оба ЗАПИСЫВАЮТ горизонтальную ось',
    /scrollWheelEventDeltaAxis2/.test(swift) && /case Native\.WM_MOUSEHWHEEL:/.test(ps));
  check('оба ПОВТОРЯЮТ её',
    /case "Scroll Left":/.test(swift) && /case "Scroll Left": flags \|= Native\.MOUSEEVENTF_HWHEEL/.test(ps));
  check('и оба принимают dir= в команде',
    /case "left": sideways = true/.test(swift) && /if \(dir == "left"\) which = "Scroll Left";/.test(ps));
  /* Знак у двух платформ РАЗНЫЙ - на Windows положительное вправо, у CGEvent наоборот, - и потому у macOS
   * он живёт в одном месте, которое спрашивают и запись, и впрыск: перепутать значит записывать каждую
   * боковую прокрутку зеркально. */
  check('и знак у macOS назван один раз на обе половины',
    /static let rightIsPositive = false/.test(swift)
      && /Sideways\.wheel2\(right: positive\)/.test(swift)
      && /Sideways\.name\(delta: side\)/.test(swift));
  /* `min(30, …)` и ответ «ок» - это недопоставка, поданная как факт: запрос на пятьдесят щелчков доставлял
   * тридцать, и модель дальше рассуждала о положении, до которого не доехала. */
  check('и оба отдают ЧЕСТНЫЙ счёт, а не молча урезают',
    /min\(120, wanted\)/.test(swift) && /Math\.Min\(120, wanted\)/.test(ps)
      && /notches, not/.test(swift) && /notches, not/.test(ps));
}

group('десять действий есть у обеих платформ');
for (const wire of ['capture', 'clipread', 'clipwrite', 'open', 'read', 'find', 'scrollto', 'drag',
  'refresh', 'waitwindow']) {
  check(`"${wire}" - в обоих`,
    new RegExp(`case "${wire}"`).test(swift) && new RegExp(`action == "${wire}"`).test(ps));
}
/* Отказ, оставленный при живой реализации, отвергает работающее действие - и это худшая из двух ошибок,
 * потому что выглядит как «платформа не умеет». Убирается ВМЕСТЕ с реализацией, а не следующим заходом. */
check('и ни одного отказа "пока не сделано" рядом с живой реализацией',
  !/not implemented on the macOS agent yet/.test(swift));
/* Читает их одна таблица на оба драйвера: инструмент, которого нет в actionBody, до агента не доедет. */
check('и деплой умеет построить провод для каждого',
  ['capture_window', 'clipboard_read', 'clipboard_write', 'open_url', 'open_app', 'read_window',
    'find_element', 'scroll_to', 'drag', 'refresh_page', 'wait_for_window']
    .every((tool) => new RegExp(`name === '${tool}'`).test(read('api/_brain.mjs'))));

/* ДВА ПУТИ, ОДНО ПРАВИЛО РАЗОШЛОСЬ НАДВОЕ - и это главное, что здесь надо удержать.
 *
 * Запись не берёт набранное НИКОГДА: она хранится, экспортируется в SKILL.md, скачивается и пересылается.
 * Чтение окна берёт: его зовёт модель между ходами, ответ живёт один ход и не сохраняется (прогон пишет
 * `{tool, input, ms}` - вывод действия в строку не попадает), а СНИМОК, который модели и так шлют каждый
 * ход, это набранное уже содержит.
 *
 * Слить их обратно легко и незаметно: обе половины читают kAXValue / ValuePattern, и одна общая функция
 * снова сделала бы из двух правил одно. Поэтому проверяется, что путь записи по-прежнему слеп. */
group('набранный текст: запись слепа, чтение окна - нет');
{
  /* Путь ЗАПИСИ - без изменений, и это то, что было бы потеряно молча. */
  check('macOS: запись по-прежнему не читает значение у того, во что можно писать',
    /depth == 0, valueMayName, !holdsTypedText\(current\)/.test(swift));
  check('и у сфокусированного элемента - вовсе',
    /nameByClimbing\(focused, valueMayName: false\)/.test(swift));
  check('windows: запись по-прежнему меряет имя, а не читает содержимое',
    /static void RecordName\(Ev target, string name, string type\)/.test(ps)
      && !/ValuePattern/.test(ps.slice(0, ps.indexOf('static void RecordName'))));

  /* Путь ЧТЕНИЯ - отдельной функцией у обоих, а не веткой внутри имени. */
  check('чтение окна отдаёт содержимое поля у обоих',
    /private static func readableValue\(_ element: AXUIElement\) -> String\?/.test(swift)
      && /static string ValueOf\(AutomationElement el\)/.test(ps));
  check('и только у того, во что можно писать',
    /guard !isSecure\(element\), holdsTypedText\(element\) else \{ return nil \}/.test(swift)
      && /if \(!\(locked is bool\) \|\| \(bool\)locked\) return null;/.test(ps));
  /* Обрезано одинаково: значение AXTextArea - это весь документ, а вывод режется на 2000 символах. */
  check('и обрезано одним и тем же числом',
    /VALUE_MAX = 80\b/.test(swift) && /const int ValueMax = 80;/.test(ps));
  check('строка ответа устроена одинаково у обеих половин',
    swift.includes('(seen.secret ? " = (password, not read)" : (seen.value.map { " = \\"\\($0)\\"" } ?? ""))')
      && ps.includes('(secret ? " = (password, not read)" : (value == null ? "" : " = \\"" + value + "\\""))'));

  /* ПАРОЛЬ - НЕ ЧАСТЬ ЭТОГО РАЗДЕЛЕНИЯ, ни на одном пути и ни при какой формулировке. Отдельный замок
   * отдельной функцией: правило, живущее внутри другого правила, теряется вместе с ним - а то правило
   * только что и поменяли. */
  check('поле пароля не читается ни на одном пути, отдельным замком',
    /private static func isSecure\(_ element: AXUIElement\) -> Bool/.test(swift)
      && /kAXSubroleAttribute\), sub == "AXSecureTextField"/.test(swift));
  check('и оно спрашивается ПЕРВЫМ, до чтения значения',
    /guard !isSecure\(element\), holdsTypedText/.test(swift)
      && /if \(IsSecret\(el\)\) return null;/.test(ps));
  /* И запись тоже продолжает считать его набранным текстом - оба замка, а не один вместо другого. */
  check('и запись по-прежнему считает его набранным текстом',
    /if isSecure\(element\) \{ return true \}/.test(swift));

  /* И ЖУРНАЛ НЕ ДОЛЖЕН ВРАТЬ ПРО ТО, ЧТО НАЖАЛИ.
   *
   * `ctrl` на проводе - это КОМАНДНЫЙ модификатор, а не клавиша Control: агент на маке ставит из него ⌘.
   * Строка в журнале при этом писала «press Ctrl+V» - то есть называла нажатие, которого на этой машине не
   * было, потому что Ctrl+V на маке не существует.
   *
   * Стоило это дороже, чем выглядит: владелец продукта прочитал СВОЙ ЖЕ журнал, увидел виндовые аккорды и
   * сделал ровно тот вывод, который эта строка предлагает - «он жмёт шорткаты Windows, они на маке не
   * работают». Вставка при этом работала: в том же прогоне ⌘V, ⌘N и ⌘S сработали четыре раза. Врущая
   * подпись увела диагностику от настоящей причины на целый круг. */
  {
    const describer = read('web/src/features/create/describe.ts');
    check('аккорд подписывается по платформе, а не одним словом',
      /const command = on === 'macos' \? 'Cmd' : 'Ctrl';/.test(describer)
        && /input\.ctrl && command/.test(describer));
    /* Три вида читают одну функцию - иначе живой фид и история назовут одно нажатие по-разному. */
    check('и платформу передают все три вида',
      /describe\(event, health\?\.platform\)/.test(read('web/src/features/create/CreateView.tsx'))
        && /describe\(asDid\(step\), platform\)/.test(read('web/src/features/create/EarlierPanel.tsx'))
        && /describe\(asDid\(step\), platform\)/.test(read('web/src/features/create/Earlier.tsx')));
    /* Без агента платформа неизвестна, и выдумывать одну из двух значит ошибаться в половине случаев. */
    check('а без агента остаётся словарь провода',
      /export function describe\(did: Did, on: On = undefined\): string/.test(describer));
  }

  /* ПОЛЕ ВВОДА ВИДНО ВСЕГДА  /* ПОЛЕ ВВОДА ВИДНО ВСЕГДА - и обе оговорки найдены пробой на живом окне, а не рассуждением.
   *
   * Условие «есть подпись ИЛИ есть значение» оставляло невидимыми ровно те два поля, ради которых всё
   * писалось: ПУСТОЕ (до того, как в него напечатали, - то есть в тот момент, когда его надо найти) и
   * ПАРОЛЬ (значение запрещено навсегда). Кликнуть в то, чего не видно, нельзя. */
  check('безымянное и пустое поле ввода всё равно попадает в ответ',
    /guard \(name\?\.isEmpty == false\) \|\| value != nil \|\| typed else \{ return nil \}/.test(swift));
  /* Пустое поле и поле пароля иначе выглядят в ответе ОДИНАКОВО - ни там, ни там значения нет, - и модель,
   * решившая, что поле просто пустое, напечатает в него то, что собиралась. Слова вместо значения ничего не
   * раскрывают и снимают двусмысленность. */
  check('а поле пароля названо словами, а не показано пустым',
    /seen\.secret \? " = \(password, not read\)"/.test(swift)
      && /secret \? " = \(password, not read\)"/.test(ps));
  check('и «это пароль» спрашивается отдельно от «что в нём» у обоих',
    /secret: isSecure\(element\)/.test(swift) && /static bool IsSecret\(AutomationElement el\)/.test(ps));

  /* Инструмент, о возможности которого не сказано, не вызывается: в измеренном прогоне read_window и
   * find_element не позваны ни разу, при том что промпт про них говорил. */
  const brain = read('api/_brain.mjs');
  check('и модели сказано, что поле можно прочитать обратно',
    /WHAT IS IN a field/.test(brain) && /CHECK THAT TYPING LANDED/.test(brain));
  check('и что пароль так не читается',
    /Password fields never report their contents/.test(brain));
  check('и что перенабор - не способ проверки',
    /NEVER TYPE THE SAME THING TWICE/.test(brain));
  /* Промах в строку меню стоил двух ходов: Cmd+S, клик в «Файл», Escape. */
  check('и что после Cmd\\+S печатать можно сразу',
    /SAVE DIALOG OPENS WITH ITS NAME FIELD ALREADY FOCUSED/.test(brain));
}

/* ВЗГЛЯД, КОТОРОГО НИКТО НЕ ПРОСИЛ.
 *
 * Правило «когда клик сделал не то, прочитай окно» промпт несёт с 0.11.0; описание read_window переписано;
 * добавлено «не набирай одно и то же дважды, прочитай поле обратно». После всего этого в ДВУХ измеренных
 * прогонах подряд read_window и find_element вызваны НОЛЬ раз - и оба раза модель залипала ровно на том,
 * что эти инструменты и отвечают. Третья формулировка того же совета была бы ставкой на то же в третий раз.
 *
 * Поэтому правило переехало в код - как BATCHABLE, и по той же причине: промпт говорит модели, что делать,
 * а драйвер решает, что произойдёт. */
group('на застрявшем ходу окно читается само, обоими драйверами');
{
  const brain = read('api/_brain.mjs');
  const cloud = read('api/_step.mjs');
  const local = read('web/src/lib/desktop-engine.ts');

  /* Правило - в мозге, а не по копии в каждом драйвере: два условия под одним именем разъедутся молча. */
  check('условие живёт в мозге и одно на двоих',
    /export const shouldPeek = \(still\) => Number\(still\) >= 1;/.test(brain)
      && /shouldPeek\(loop\.still\)/.test(cloud) && /shouldPeek\(still\)/.test(local));
  /* Кадр обязан доехать до openList у ОБОИХ: без него список печатает экранные числа рядом с картинкой, в
   * которой модель кликает, - две системы координат в одном сообщении. Локальную половину regex поймал бы
   * только здесь: у неё нет исполняемого набора, который прошёл бы этот путь. */
  check('кадр доезжает до списка окон у обоих драйверов',
    /openList\(windows, shot\)/.test(cloud) && /openWindows\(machine, frame\)/.test(local)
      && /openList\(\(await machine\.windows\(\)\)\.windows, frame\)/.test(local));

  check('и провод для него строит тоже мозг',
    /export const peekBody = \(frame\) =>/.test(brain)
      && /peekBody\(shot\)/.test(cloud) && /peekBody\(frame\)/.test(local));
  /* Координаты чтения - в системе той картинки, которая поедет вместе с ним, иначе модель получит позиции
   * из другой системы координат и промахнётся на любом масштабированном экране. */
  check('и он спрашивает те же scale/ox/oy, что у снимка',
    /action=read scale=\$\{\(frame && frame\.scale\) \|\| 1\} ox=/.test(brain));

  /* Момент срабатывания тоже один: решает ПРЕДЫДУЩИЙ ход, чтение идёт ПОСЛЕ действий текущего. На облачном
   * пути иначе и нельзя - деплой до агента не дотягивается и может только приложить действие, - а локальный
   * приведён к тому же нарочно. */
  check('решает предыдущий ход, а не текущий',
    /const peekNow = shouldPeek\(still\);/.test(local)
      && local.indexOf('const peekNow = shouldPeek(still);') < local.indexOf('still = stirred ? 0 : still + 1;'));
  check('а читается после действий хода',
    /if \(peekNow && results\.length\) \{/.test(local)
      && local.indexOf('if (peekNow && results.length)') > local.indexOf('still = stirred ? 0 : still + 1;'));
  check('на облачном пути чтение приложено последним к действиям хода',
    /if \(actions\.length && shouldPeek\(loop\.still\)\) \{\s*\n\s*actions\.push\(\{ id: PEEK_ID/.test(cloud));

  /* Это НЕ ответ на вызов инструмента: под него нет tool_use, а API отвергает результат без вызова. */
  check('и оно не выдаётся за ответ на вызов инструмента',
    !/loop\.pending\.push\(\{ id: PEEK_ID/.test(cloud) && /screenMessage\(shot, openList\(windows, shot\), saw\)/.test(cloud));
  /* И не становится шагом: человек читает в журнале СВОИ намерения, а этого он не заказывал. */
  check('и не попадает в журнал прогона отдельной строкой',
    !/loop\.steps\.push\(\{ tool: 'read_window'/.test(cloud));

  /* Агент старее 0.16.0 ответит на read отказом. Показать его модели значило бы научить её, что смотреть
   * бесполезно, - то есть добиться обратного тому, ради чего всё это. */
  check('отказ старого агента проглатывается, а не показывается модели',
    /peeked\.isError !== true/.test(cloud) && /catch \(_\) \{ saw = null; \}/.test(local));

  /* Слова - в мозге, как у waitReport и actionSaid: два драйвера, сказавшие это по-разному, научат модель
   * двум разным привычкам. */
  check('слова про прочитанное складывает мозг',
    /Nothing on screen moved when the last actions ran/.test(brain)
      && /export function screenMessage\(frame, open, saw\)/.test(brain));
  /* И тип для TS-половины - иначе локальный драйвер просто не соберётся. */
  check('и TypeScript-половина объявлена',
    /export function shouldPeek\(still: number\): boolean;/.test(read('api/_brain.d.mts')));
}

/* ПАНЕЛЬ СОХРАНЕНИЯ - НЕ ОКНО, КОТОРОЕ МОЖНО ПОДНЯТЬ, и стоило это живого хода.
 *
 * Из прогона: `activate_window {title: "Открыть"}` → «macOS refused to bring Open and Save Panel Service
 * (Pages) forward». Читается как поломка macOS. Измерено на этой машине, при живой панели на экране, -
 * список окон агента выглядит так:
 *
 *   panel                       title='Save'                        active  on screen   ← настоящий лист
 *   Open and Save Panel Service title='Save'                        minimised           ← леса
 *   Open and Save Panel Service title='Open and Save Panel Service'  minimised           ← леса
 *
 * Видимая панель принадлежит ПРИЛОЖЕНИЮ, а у отдельного процесса-службы остаются свои окна, ни одного на
 * экране. Заголовок лесов содержит то же слово и стоит В СПИСКЕ РАНЬШЕ, поэтому совпадало с ними - а поднять
 * XPC-службу macOS не даёт никогда. */
group('панель сохранения не подсовывается как окно, которое можно активировать');
{
  check('леса службы отфильтрованы - и только пока они вне экрана',
    /if !onscreenNow && owner\.hasPrefix\("Open and Save Panel Service"\) \{ continue \}/.test(swift));
  /* Панель, показанная отдельным окном (runModal, не begin), на экране будет - и прятать её нельзя, в неё
   * придётся целиться. Поэтому условие двойное, и вторая половина проверяется отдельно. */
  check('и видимую панель фильтр не трогает',
    /let onscreenNow = \(entry\[kCGWindowIsOnscreen as String\] as\? Bool\) \?\? false/.test(swift));
  /* Второй замок: даже если такое окно совпадёт, отказ должен объяснять, а не сообщать о поломке. */
  check('а совпавший служебный процесс объясняется, а не отвергается',
    /if app\.activationPolicy != \.regular \{/.test(swift)
      && /which macOS will not bring forward on its/.test(swift));
  check('и говорит, что с этим делать',
    /already in front of that window\. Aim at it directly/.test(swift));
  /* «Не нашли» - неверный ответ для окна, которое на экране: модель пойдёт открывать заново то, что открыто. */
  check('и это отдельная ветка, до «ничего не совпало»',
    swift.indexOf('which macOS will not bring forward on its') < swift.indexOf('nothing open matches that title or process'));
}

/* ТРИ ПОЛОВИНЫ ОДНОЙ ПОЧИНКИ, и каждая закрывает свою форму провала - поэтому проверяются порознь.
 *
 * Событие, созданное из `.hidSystemState` и не получившее флагов, забирает текущее состояние модификаторов
 * системы. До 0.19.0 флаги ставила только key(...), и потому после любого аккорда клик становился
 * Cmd-кликом, прокрутка - зумом, а набор - чередой Cmd+буква. Измерено тапом на живой машине. */
group('синтетический ввод несёт ровно те модификаторы, о которых просили');
{
  /* 1. Флаги ставятся ЯВНО на каждом событии, а не «как получится». */
  check('отправка ставит флаги явно, и по умолчанию пустые',
    /private static func send\(_ event: CGEvent\?, flags: CGEventFlags = \[\]\) \{/.test(swift)
      && /event\.flags = flags/.test(swift));
  /* У повтора своя копия отправки - и правило приходится повторить там же. */
  /* У повтора отправка своя, и правило приходится повторить там же. С 0.21.0 флаги у него не пустые
   * ВСЕГДА, а те, что несёт жест: модифицированный клик - это клик с флагом. Свойство осталось тем же -
   * флаги ставятся ЯВНО, а не наследуются от состояния системы. */
  check('и у повтора, где отправка своя, тоже',
    /event\.flags = flags\s*\n\s*event\.setIntegerValueField\(\.eventSourceUserData, value: INJECTED_MARK\)/.test(swift)
      && /flags: CGEventFlags = \[\]\) \{\s*\n\s*guard let source = CGEventSource/.test(swift));

  /* 2. Аккорд отпускает модификатор КЛАВИШЕЙ - чистых флагов мало, состояние залипает глобально. */
  check('аккорд идёт шагами из одного правила',
    /let plan = chordSteps\(flags, key: code\)/.test(swift));
  /* Аккорд уходит целиком или не уходит вовсе: send\(\) молча роняет nil, и уроненное ОТПУСКАНИЕ - это
   * Command, оставшийся зажатым для всей машины, о котором отчитались «ок». */
  check('и события создаются все до того, как отправлено хоть одно',
    /for step in plan \{[\s\S]{0,400}events\.append\(\(event, step\.flags\)\)[\s\S]{0,120}for \(event, stepFlags\) in events \{ send/.test(swift));
  /* Модификатор, залипший НЕ от нас, не снимается chordSteps и при этом добавляется к тому, о чём просили:
   * `key=w` под чужим Command закрывает окно, и key\(\) отвечала на это «сделано». */
  check('и чужое зажатое снимается ДО того, как строится аккорд',
    /releaseModifiers\(\)\s*\n\s*\n?\s*\/\* ВСЕ СОБЫТИЯ СОЗДАЮТСЯ/.test(swift));
  check('и правило это - отдельная чистая функция, чтобы её можно было выполнить',
    /^func chordSteps\(_ flags: CGEventFlags, key: CGKeyCode\)/m.test(swift));

  /* 3. Набор отпускает всё зажатое ПЕРЕД собой: залипнуть могло что угодно - другое приложение, прошлая
   * сборка агента, - а набор обязан быть набором в любом случае. */
  check('набор отпускает зажатое перед тем, как печатать',
    /static func type\(_ text: String\) \{[\s\S]{0,900}releaseModifiers\(\)/.test(swift));
  /* По КОДУ, а не по файлу: абзац выше рассказывает про это состояние теми же словами, и проверка на
   * файле прошла бы на коде, из которого вызов убрали, оставив комментарий. */
  check('и отпускание спрашивает состояние системы, а не помнит своё',
    /releaseSteps\(CGEventSource\.flagsState\(\.combinedSessionState\)\)/
      .test(swift.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')));

  /* И ЗАПИСЬ НАЧИНАЕТСЯ С ЧИСТОГО СОСТОЯНИЯ, потому что у залипшего Command есть последствие для
   * ОБЕЩАНИЯ, а не только для точности. Буква читается только под Command или Control - на том и держится
   * «клавиша, которая может что-то написать, никогда не называется». При зажатом Command каждое нажатие
   * человека приходит как аккорд, и буква НАЗЫВАЕТСЯ. Второй замок, потому что залипнуть могло и не от
   * нас. */
  check('запись начинается с отпущенных модификаторов',
    /func start\(moveMs: Int\) -> String\? \{[\s\S]{0,1600}Input\.releaseModifiers\(\)/.test(swift));
  check('и до того, как встанет флаг записи',
    swift.indexOf('Input.releaseModifiers()\n        gate.lock()') > 0);

  /* И на Windows-половине этой аварии нет по устройству: там модификатор - это отдельный вход в SendInput,
   * и PressKey шлёт его отпускание сам. Проверяется, потому что «у них этого нет» - тоже утверждение. */
  check('на Windows отпускание модификатора идёт тем же вызовом, что и нажатие',
    /KEYEVENTF_KEYUP/.test(ps) && /static string PressKey\(/.test(ps));
  /* Половина этой аварии на Windows невозможна: у клавиатурного SendInput нет поля флагов вовсе. А ВТОРОЙ
   * половины там не было совсем - ничего не снимало модификатор, залипший чужим приложением или зависшей
   * клавишей, - и последствие то же самое, включая то, что про обещание: рекордер строит `Ctrl+` по
   * GetAsyncKeyState, и при залипшем Ctrl буква человека НАЗЫВАЕТСЯ. */
  check('и у Windows теперь есть то же отпускание чужого',
    /public static void ReleaseModifiers\(\)/.test(ps)
      && /GetAsyncKeyState\(vk\) & 0x8000\) != 0\) SendVk\(\(ushort\)vk, true\)/.test(ps));
  check('и обе стороны каждой клавиши, потому что общий код их не различает',
    /0xA0, 0xA1/.test(ps) && /0xA2, 0xA3/.test(ps) && /0xA4, 0xA5/.test(ps));
  check('и оба агента чистят состояние в одних и тех же трёх местах',
    /Input\.releaseModifiers\(\)/.test(swift.slice(swift.indexOf('func start(moveMs: Int)'), swift.indexOf('func start(moveMs: Int)') + 1600))
      && /ReleaseModifiers\(\);/.test(ps.slice(ps.indexOf('public static string RecordStart'), ps.indexOf('public static string RecordStart') + 800))
      && /ReleaseModifiers\(\);/.test(ps.slice(ps.indexOf('static string TypeText'), ps.indexOf('static string TypeText') + 900)));
  /* Между нажатием и отпусканием стоит Thread.Sleep(25): брошенное в это окно прерывание оставило бы
   * модификатор зажатым для всей машины. */
  check('и аккорд на Windows отпускается через finally',
    /try\s*\n\s*\{\s*\n\s*if \(win\) SendVk\(0x5B, false\)[\s\S]{0,400}finally\s*\n\s*\{\s*\n\s*if \(alt\) SendVk\(0x12, true\)/.test(ps));

  /* ПОВТОР ЧИСТИТ ЗА СОБОЙ С ОБЕИХ СТОРОН, и вторая половина - та, которую легче всего написать мёртвой.
   *
   * Залипший модификатор превращает первый клик повтора в Cmd-клик, а «Key Enter» - в Cmd+Enter, и повтор
   * при этом отчитается о безупречном прогоне: он делал ровно то, что записано, а система прочла другое. */
  check('повтор начинается с отпущенных модификаторов',
    /func start\(body: String\) -> String\? \{[\s\S]{0,700}Input\.releaseModifiers\(\)/.test(swift));
  /* И ВЫШЕ проверки на зажатые кнопки мыши: повтор, кончившийся аккордом, кнопок не держит, так что всё,
   * что стоит ниже guard, в этом случае мёртвый код - в том самом случае, ради которого пишется. */
  check('и убирает их за собой ВЫШЕ проверки на зажатые кнопки',
    /private func releaseEverything\(\) \{[\s\S]{0,900}Input\.releaseModifiers\(\)[\s\S]{0,200}guard !holding\.isEmpty else \{ return \}/.test(swift));
}

/* ОДНА ОСТАНОВКА - ОДНА ЗАГРУЗКА, и это измерено, а не выведено.
 *
 * Каждая остановка отправляла payload ДВАЖДЫ, одновременно. `end()` кладёт запись в общий стор за двадцать
 * строк до того, как разрешится её собственный push; сигнатура эффекта Reconciler'а построена по
 * `local.recordings`, так что запись его будит; у новорождённой нет `syncedAt` и на аккаунте её нет, значит
 * reconcile относит её к `push`; те же байты уезжают вторым запросом. Оба несут `updated: null`, ни один не
 * отвергается, побеждает поздний.
 *
 * По метаданным живого аккаунта: КАЖДАЯ строка `kind='recorded'` переписана через 1.0-5.5 с после создания,
 * и разрыв растёт с размером - 697 КБ через 2.75 с, 5850 КБ через 3.4 с. Для четырёхчасовой записи это
 * 11.7 МБ трафика вместо 5.85. */
group('одна остановка - одна загрузка');
{
  const sending = read('web/src/features/record/sending.ts');
  const view = read('web/src/features/record/RecordView.tsx');
  const reconciler = read('web/src/features/record/Reconciler.tsx');
  const rules = read('web/src/features/record/reconcile.ts');

  check('реестр того, что в полёте, существует и живёт отдельно',
    /export function claim\(ids: string\[\]\): string\[\]/.test(sending)
      && /export function release\(ids: string\[\]\): void/.test(sending));

  /* КАЖДЫЙ отправитель заявляется - иначе остаётся дверь, через которую двойная отправка возвращается.
   * Пять мест: остановка, две сессионных отправки, импорт и «положить обратно». */
  check('заявляются все пять отправителей записи',
    (view.match(/claim\(/g) || []).length === 5 && /mine = claim\(plan\.push\.map/.test(reconciler),
    String((view.match(/claim\(/g) || []).length));
  /* И отдают в `finally`: незакрытая заявка - это запись, которую reconcile будет пропускать вечно. */
  check('и каждая заявка отдаётся в finally',
    (view.match(/\} finally \{\s*\n\s*release\(mine\);/g) || []).length === 5,
    String((view.match(/\} finally \{\s*\n\s*release\(mine\);/g) || []).length));

  /* Фильтр стоит НА ВЫЗОВЕ, а не внутри правил: reconcile - чистая функция от (flows, local), и такой она
   * нужна, чтобы её можно было прогнать в тесте без сети и без сторов. Реестр в полёте - состояние сети. */
  check('в полёте не отправляется второй раз',
    /plan\.push = plan\.push\.filter\(\(rec\) => !isSending\(rec\.id\)\)/.test(reconciler));
  /* By CODE, not by file: reconcile.ts uses the word "sending" in a paragraph about something else, and a
   * file-level test would be catching prose. What matters is exactly one thing - the rules import nothing
   * from the registry. */
  /* И НЕ ЗАБЫВАЕТСЯ ТОЖЕ - это уже не про трафик, а про потерю данных.
   *
   * На пути остановки штамп `syncedAt` ставится ДО `await reload()`. В этом промежутке подпись эффекта уже
   * изменилась, а `flows` ещё старые - строки там нет. reconcile видит запись со штампом, которой нет на
   * аккаунте, и по правилу «была и исчезла» кладёт её в `forget`: только что сделанная запись стирается из
   * браузера. Правило верное, неверно лишь то, что «нет на аккаунте» здесь значит «мы его ещё не
   * перечитали». Заявка снимается только после reload, то есть стоит ровно на этом промежутке. */
  check('и то, что в полёте, не забывается из браузера',
    /plan\.forget = plan\.forget\.filter\(\(id\) => !isSending\(id\)\)/.test(reconciler));

  check('а правила остаются чистыми',
    !/from '\.\/sending'/.test(rules)
      && !/isSending/.test(rules.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')));

  /* Заявка снимается ПОСЛЕ reload: между push и reload запись, отпущенная рано, успевает попасть в
   * следующий проход как «только здесь» - то есть в тот самый второй запрос. */
  /* Ровно одна отдача, и она ПОСЛЕ reload. Две - это уже дверь: ранняя отпускает запись до того, как
   * аккаунт перечитан, и следующий проход видит её как «только здесь». */
  check('и заявка снимается после reload, а не сразу после push',
    (reconciler.match(/release\(mine\);/g) || []).length === 1
      && reconciler.indexOf('release(mine);') > reconciler.indexOf('if (sent.length) await reload();'),
    String((reconciler.match(/release\(mine\);/g) || []).length));
}

/* И ПОКА ОНО ЕДЕТ - ОБ ЭТОМ ГОВОРЯТ. Строка уже в таблице, подпись говорила «54157 events captured» - то
 * есть «готово», - и только потом начиналась загрузка. Человек жал View, панель спрашивала у аккаунта
 * строку, которой там ещё нет, и получала «no recording with that id on this account». */
group('пока запись едет на аккаунт, это видно');
{
  const view = read('web/src/features/record/RecordView.tsx');
  const table = read('web/src/features/record/RecordingsTable.tsx');
  const panel = read('web/src/features/record/TranscriptPanel.tsx');
  const sending = read('web/src/features/record/sending.ts');

  /* Счёт событий объявляется ПОСЛЕ подтверждения аккаунта, а не до начала загрузки. */
  /* И «captured» не звучит НИ РАЗУ до отправки: проверяется отрезок между записью в стор и push, потому
   * что именно там эта строка и стояла. Проверка «есть после» одна прошла бы и на коде, где она есть в
   * обоих местах. */
  /* Comments stripped first: the paragraph explaining this very decision quotes the old sentence, and a
   * test that reads prose is a test that fails on its own explanation. It has happened here before. */
  const stopBlock = view.slice(
    view.indexOf('update((prev) => ({ recordings: [...prev.recordings, made] }));'),
    view.indexOf('const saved = await push({ flows: [flowFor(made, health)] });'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('карточка говорит «отправляется», а счёт - только после подтверждения',
    /setNote\(`Sending \$\{s\.count\} events to your account…`\)/.test(view)
      && !/events captured/.test(stopBlock)
      && /const saved = await push\(\{ flows: \[flowFor\(made, health\)\] \}\);[\s\S]{0,400}events captured/.test(view));

  /* В таблице «Sending…» ПЕРЕД остальными состояниями: пока запись едет, и «Ready», и «Skill saved»
   * утверждают, что она на аккаунте, а её там нет. */
  /* Positions compared in the CODE: the comment above the branch explains the decision in the same words
   * and sits earlier in the file. */
  const tableCode = table.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  check('строка таблицы показывает отправку, и раньше остальных состояний',
    /\{sending\(rec\.id\) \? \(/.test(tableCode) && /Sending…/.test(tableCode)
      && tableCode.indexOf('sending(rec.id)') < tableCode.indexOf('Skill saved'));
  check('и это спиннер, а не статичная плашка', /Loader2 className="size-3 animate-spin"/.test(table));

  /* Панель говорит «ещё не доехало» вместо «нет такой записи» - и это не ошибка, а ожидание: транскрипт
   * выводится на сервере из сохранённого payload, так что у не доехавшей записи его нет по устройству. */
  check('панель говорит «ещё едет» вместо ошибки',
    /\{sending && \(/.test(panel) && /Still going up to your account/.test(panel));
  check('и блок ошибки при этом не показывается', /\{!sending && problem && \(/.test(panel));
  /* И дочитывается само: `sending` перестанет быть true, и эффект перечитает транскрипт без нажатия. */
  check('и транскрипт перечитывается сам, когда загрузка кончилась',
    /\}, \[flowId, attempt, sending\]\);/.test(panel));

  /* Панель смотрит на ОДНУ запись: подписка на весь реестр будила бы её на каждую чужую загрузку, а на
   * длинной сессии с частями это не редкость. */
  check('панель подписана на одну запись, а список - на все',
    /useIsSending\(flowId\)/.test(panel) && /const sending = useSending\(\)/.test(table)
      && /export function useIsSending/.test(sending) && /export function useSending/.test(sending));
}

/* ЗАПИСЬ, НЕ ПОМЕСТИВШАЯСЯ НА ДИСК, БОЛЬШЕ НЕ ТЕРЯЕТСЯ МОЛЧА (Fix 3 work order'а).
 *
 * Консоль пишется в localStorage ОДНОЙ строкой - все записи вместе, - а квота около 5000КБ на origin.
 * Четырёхчасовая запись это 5850КБ сама по себе. Раньше здесь стоял пустой catch с комментарием «только
 * персистентность потеряна», и это было неправдой дважды: терялась персистентность ВСЕГО, что писалось
 * после (строка одна, и одна непомещающаяся запись роняла каждую следующую попытку), и никому об этом не
 * сообщалось - человек узнавал, перезагрузив вкладку. */
group('переполнение диска: отступление вместо молчания');
{
  const store = read('web/src/lib/store.ts');
  const quota = read('api/_quota.mjs');
  const flowFor = read('api/_flow-for.mjs');
  const table = read('web/src/features/record/RecordingsTable.tsx');
  const view = read('web/src/features/record/RecordView.tsx');

  /* Приватный режим и переполнение бросают неразличимые ошибки: Safari в приватном шлёт то же
   * QuotaExceededError с квотой ноль, Firefox зовёт это иначе, коды по браузерам разные. Надёжный вопрос
   * один - записывается ли КРОШЕЧНОЕ значение. */
  check('приватный режим отличается от переполнения пробной записью, а не именем ошибки',
    /function storageWorks\(\): boolean/.test(store)
      && /localStorage\.setItem\(PROBE, '1'\)/.test(store)
      && !/QuotaExceededError/.test(store.replace(/\/\*[\s\S]*?\*\//g, '')));
  check('и факт остаётся читаемым, а не глотается',
    /export const persistTrouble = \(\): PersistTrouble \| null/.test(store)
      && /kind: 'no-storage'/.test(store) && /kind: 'too-big'/.test(store));

  /* САМОЕ ВАЖНОЕ ЗДЕСЬ. Запись без штампа - единственная копия, и выложить её события значит их потерять,
   * то есть сделать ровно то, ради предотвращения чего всё это написано. Правило живёт отдельным чистым
   * файлом ИМЕННО чтобы это проверялось выполнением - см. api/_test-quota.mjs. */
  check('правило отступления - чистая функция, которую можно выполнить',
    /export function freeingOrder\(recordings\)/.test(quota));
  check('и оно НИКОГДА не трогает запись без второй копии',
    /\.filter\(\(rec\) => rec && rec\.id && heldElsewhere\(rec\)\)/.test(quota)
      && /export const heldElsewhere = \(rec\) => !!\(rec && rec\.syncedAt\);/.test(quota));
  check('и стор берёт правило оттуда, а не заводит своё',
    /import \{ freeingOrder \} from '\.\.\/\.\.\/\.\.\/api\/_quota\.mjs';/.test(store)
      && /for \(const id of freeingOrder\(attempt\.recordings\)\)/.test(store));

  /* УЖЕ НАЙДЕННОЕ НЕ ИЩЕТСЯ ЗАНОВО. Лестница стоит одного JSON.stringify консоли на ступень, а консоль -
   * мегабайты; прогонять её на каждый коммит значит на каждое нажатие клавиши в поле переименования. */
  check('и найденное однажды применяется сразу, без повторного поиска',
    /let shedFor: \{ key: string; ids: string\[\] \} \| null = null;/.test(store)
      && /const remembered = shedFor && shedFor\.key === key/.test(store));
  /* И забывается вместе со слотом: это факт про ушедшего человека, а не про машину. */
  check('и забывается на выходе',
    /heldFor = null;[\s\S]{0,240}trouble = null;\s*\n\s*shedFor = null;/.test(store));

  /* САМОЕ ГРОМКОЕ СОСТОЯНИЕ НЕ ДОЛЖНО УТВЕРЖДАТЬ САМУЮ УВЕРЕННУЮ НЕПРАВДУ. `freed` собирался ДО того, как
   * запись удастся, так что при полном провале экран говорил «четыре записи теперь на вашем аккаунте» -
   * ровно тогда, когда на диск не легло ничего. */
  check('и при полном провале не заявляется освобождённым ничего',
    /trouble = \{ kind: 'too-big', freed: \[\], atRisk: unsynced\(\), stillFailing: true \};/.test(store));
  /* И называется то, что действительно под угрозой: без штампа - единственная копия. */
  check('а под угрозой называются только записи без второй копии',
    /const unsynced = \(\) => next\.recordings\.filter\(\(rec\) => !rec\.syncedAt && !rec\.borrowed\)/.test(store));

  /* Отправить наверх запись с выложенными событиями значило бы записать поверх хорошего payload пустой -
   * то есть уничтожить единственную оставшуюся копию действием под названием «сохранить». Отказ стоит в
   * ЕДИНСТВЕННОМ месте, где payload собирается, потому что вызывающих у него четыре. */
  check('пустую запись наверх не отправить, и отказ стоит у сборщика payload',
    /if \(rec\.eventsOnAccount && \(!rec\.events \|\| rec\.events\.length === 0\)\) \{/.test(flowFor)
      && /throw new Error\(/.test(flowFor));

  /* Числа сохраняются вместе с решением их выложить: «0 событий» про четырёхчасовую запись - это не
   * «неизвестно», а неверное число, поданное как факт. */
  check('числа переживают выкладывание событий',
    /summary: rec\.summary \?\? summarize\(rec\.events\)/.test(store)
      && /const s = rec\.summary \?\? summarize\(rec\.events\);/.test(table));
  check('и сортировка по размеру тоже ими пользуется',
    /\(a\.summary\?\.count \?\? a\.events\.length\) - \(b\.summary\?\.count \?\? b\.events\.length\)/.test(table));

  /* И человеку сказано - двумя разными предложениями, потому что это две разные беды, и ни одно из них не
   * говорит «потеряно» про то, что лежит на аккаунте. */
  check('строка показывает такую запись как живущую на аккаунте, а не как готовую',
    /rec\.eventsOnAccount \? \(/.test(table) && /On your account/.test(table));
  check('и экран говорит, что случилось с диском',
    /trouble\?\.kind === 'no-storage'/.test(view) && /trouble\?\.kind === 'too-big'/.test(view));
  /* Разные слова для «не поместилось, но всё на аккаунте» и «не поместилось, и на аккаунт ещё не уехало» -
   * второе единственное, где действительно можно потерять работу. */
  check('и различает «всё цело» от «не закрывайте вкладку»',
    /Nothing was lost: playing or exporting one fetches it/.test(view)
      && /do not `\s*\n?\s*\+ 'close this tab until they do\./.test(view) && /trouble\.stillFailing/.test(view));

  /* И ОБЕЩАНИЕ ВЫПОЛНЯЕТСЯ. Два места обещали, что события вернутся, а вернуть их было нечем: поле только
   * ставилось и никогда не снималось. Обещание, которого код не выполняет, хуже отсутствующей функции -
   * по нему принимают решения. */
  const back = read('web/src/features/record/events-for.ts');
  check('дорога назад существует',
    /export async function eventsFor\(rec: Recording\): Promise<RecordedEvent\[\]>/.test(back)
      && /await fetchPayload\(rec\.id\)/.test(back));
  check('и ею пользуются те, кому события действительно нужны',
    /events = await eventsFor\(rec\);/.test(view)
      && /events = await eventsFor\(rec\);/.test(read('web/src/features/record/RecordingsTable.tsx')));
  /* Повтор строится из ЗАБРАННЫХ событий: из `rec` он собрал бы пустое тело, и агент отчитался бы о
   * безупречном прогоне, не сделав ничего. */
  check('и повтор играет забранное, а не пустое',
    /\[playing\],/.test(view) && /const playing = \{ \.\.\.rec, events \};/.test(view));
  /* Обратно в консоль не пишется: положить 5850КБ на место значит снова не поместиться и снова всё
   * выложить - круг. */
  check('и обратно в консоль не записывается',
    !/update\(/.test(back) && /НА ОДИН ВЫЗОВ/.test(back));
}

/* Fix 4, 5 и 6 work order'а - три независимых дефекта на пути от Stop до читаемого транскрипта. */
group('старая ошибка не остаётся под новой');
{
  const panel = read('web/src/features/record/TranscriptPanel.tsx');
  /* Удачное «положить обратно» двигало `attempt` и перечитывало тело; неудачное только ставило `note`, а
   * тело оставалось со своим 404 и кнопкой. `problem` же чистится только при смене `flowId`. Так на одном
   * экране оказывались фраза про состояние строки СЕЙЧАС и фраза про её состояние минуты назад. */
  /* По КОДУ: объяснение этой правки занимает восемь строк комментария ровно между теми двумя, которые
   * проверяются, и оно длиннее любого разумного окна. */
  const panelCode = panel.replace(/\/\*[\s\S]*?\*\//g, '');
  /* ДВА подъёма `attempt` в обработчике «положить обратно»: один на удаче, один на неудаче. Проверка на
   * «есть хотя бы один» прошла бы и на прежнем коде, где он был только на удаче. */
  const restoreHandler = panelCode.slice(panelCode.indexOf('await onRestore();'),
    panelCode.indexOf('Put it back on my account'));
  check('неудачная попытка тоже перечитывает тело',
    (restoreHandler.match(/setAttempt\(\(n\) => n \+ 1\);/g) || []).length === 2,
    String((restoreHandler.match(/setAttempt\(\(n\) => n \+ 1\);/g) || []).length));
}

group('404 больше не говорит три разные вещи одними словами');
{
  const route = read('api/transcript.js');
  const panel = read('web/src/features/record/TranscriptPanel.tsx');

  /* Условие ушло из WHERE в SELECT: пока `deleted_at is null` стояло в запросе, надгробие и никогда не
   * существовавшая строка возвращались одинаково, и одна фраза обязана была покрыть обе. Не может: одна
   * чинится нажатием, вторая нет. */
  /* Именно у readFlow, а не по всему файлу: у `save` то же условие стоит и стоит ВЕРНО - редактировать
   * надгробие нельзя, и снять его там значило бы починить одно, сломав другое. */
  const readFlowBody = route.slice(route.indexOf('async function readFlow'),
    route.indexOf('/* ТРИ ОТВЕТА ВМЕСТО ОДНОГО'));
  check('надгробие теперь отличимо от «не было никогда»',
    /created_at, updated_at, deleted_at/.test(readFlowBody)
      && !/deleted_at is null/.test(readFlowBody));
  check('а у пути правки то же условие осталось - редактировать надгробие нельзя',
    /update user_flow[\s\S]{0,300}deleted_at is null/.test(route));
  check('и на каждую причину свой ответ и свой код',
    /const notThere = \(res\) => fail\(res, 404,/.test(route)
      && /const wasDeleted = \(res, when\) => fail\(res, 410,/.test(route)
      && /const notARecording = \(res\) => fail\(res, 409,/.test(route));
  /* И РАЗВИЛКА ДЕЙСТВИТЕЛЬНО ВЕТВИТСЯ. Три объявленных ответа, из которых зовётся один, - это тот же
   * единственный ответ, только с двумя неиспользуемыми константами рядом. */
  check('и развилка действительно спрашивает про каждую',
    /if \(!row\) return notThere\(res\);\s*\n\s*if \(row\.deleted_at\) return wasDeleted\(res, row\.deleted_at\);\s*\n\s*if \(row\.kind !== 'recorded'\) return notARecording\(res\);/.test(route));
  check('и оба маршрута спрашивают одно и то же место',
    (route.match(/const refused = unusable\(res, row\);/g) || []).length === 2);
  /* Отдельного «эта запись чужая» нет и быть не может: запрос идёт по паре (user_id, client_id), так что
   * чужая строка и несуществующая неразличимы - и подтвердить существование чужой записи было бы ответом
   * на незаданный вопрос. Сказано в коде, чтобы следующий не «доделал» третий случай. */
  check('и сказано, почему «чужая» отдельным ответом быть не может',
    /чужая строка и несуществующая неразличимы/.test(route));

  /* Кнопка предлагается ровно там, где push действительно чинит. Удалённую он не чинит - sync.js отвергает
   * запись поверх надгробия; созданный скилл записью не станет от повторной отправки. */
  check('кнопка предлагается только для того, что push чинит',
    /const canRestore = !!onRestore && !!problem\s*\n\s*&& \/\^no recording with that id on this account\/i\.test\(problem\);/.test(panel));
  /* И причинное утверждение, которого никто не проверял, из текста ушло. */
  check('и прежнего необоснованного объяснения там больше нет',
    !/deleting it in Skills takes the recording with it/.test(panel));
}

group('штамп синхронизации приходит с тех же часов, с какими сравнивается');
{
  const sync = read('api/sync.js');
  const api = read('web/src/lib/api.ts');
  const view = read('web/src/features/record/RecordView.tsx');
  const rec = read('web/src/features/record/Reconciler.tsx');

  /* Клиент штамповал `syncedAt` своим `new Date()`, сервер сравнивал это с `updated_at` из Postgres. Две
   * часовые области в одном `<`. Браузер, отстающий от сервера, получал отказ НАВСЕГДА: ответ не нёс
   * никакой отметки, которую клиент мог бы принять за свою. */
  /* `returning updated_at` есть в этом файле и у прогонов - проверяется тот, что у ВСТАВКИ ПОТОКА, вместе
   * с тем, что его ответ действительно куда-то кладут. */
  check('сервер возвращает то, что записал',
    /const \[wrote\] = await sql`\s*\n\s*insert into user_flow[\s\S]{0,900}returning updated_at/.test(sync)
      && /if \(wrote\) stamped\.push\(\{ id: clientId, updated:/.test(sync)
      && /\n    stamped,/.test(sync));
  check('и клиент это объявляет',
    /stamped\?: \{ id: string; updated: string \}\[\];/.test(api));
  check('путь остановки берёт отметку сервера',
    /const said = saved\.stamped\?\.find\(\(one\) => one\.id === made\.id\)\?\.updated;/.test(view)
      && /syncedAt: said \?\? new Date\(\)\.toISOString\(\)/.test(view));
  /* И сверка тоже - из двух серверных источников: отправленное несёт отметку в ответе push, лежащее на
   * аккаунте несёт её в самом списке. */
  check('и сверка берёт её из ответа push и из списка аккаунта',
    /for \(const one of pushed\?\.stamped \?\? \[\]\) fromServer\.set\(one\.id, one\.updated\);/.test(rec)
      && /for \(const flow of flows\) if \(flow\.updated\) fromServer\.set\(flow\.id, flow\.updated\);/.test(rec));
  /* Свои часы остаются последним запасом - ровно для старого деплоя, который поля не шлёт. */
  check('а свои часы остаются только запасом для старого деплоя',
    /syncedAt: rec\.syncedAt \?\? fromServer\.get\(rec\.id\) \?\? now/.test(rec));
}

/* ЖЕСТ С МОДИФИКАТОРОМ - записать, воспроизвести, и не потерять по дороге.
 *
 * Shift-клик, Cmd-клик, Option-перетаскивание и Cmd+прокрутку нельзя было ни сделать, ни ЗАПИСАТЬ. Запись
 * человека, делавшего такое, воспроизводилась как жест БЕЗ модификатора и отчитывалась о чистом прогоне -
 * не потому, что повтор его срезал, а потому, что запись его не видела.
 *
 * Проверено на живой машине в обе стороны: впрыснутый Shift-клик записался как `mods=Shift`, а повтор
 * Option-перетаскивания ушёл с флагом на нажатии, движении и отпускании. Ниже - то, что держит это на месте. */
group('модификатор жеста записывается - и только там, где должен');
{
  check('имя аккорда для жеста отдельно от клавиатурного, и без хвостового плюса',
    /func chordName\(_ flags: CGEventFlags\) -> String \{/.test(swift)
      && /return parts\.joined\(separator: "\+"\)/.test(swift));
  /* Четыре маски и ни одной больше: у ноутбучных стрелок стоит .maskSecondaryFn, и стоит начать его
   * читать, как каждое нажатие стрелки станет «Fn+Down». Тот же фильтр не пускает сюда caps lock. */
  /* По КОДУ: абзац над функцией объясняет, почему этих двух масок здесь нет, и называет их по именам -
   * проверка на файле ловила бы собственное объяснение. Ловушка в этом наборе не первая. */
  const swiftCode = swift.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('и ровно четыре маски, без Fn и caps lock',
    /func chordName[\s\S]{0,400}maskShift[\s\S]{0,80}return parts/.test(swiftCode)
      && !/maskSecondaryFn|maskAlphaShift/.test(swiftCode));

  /* Только нажатие и прокрутка. НЕ движение - и это не про размер файла: выборка глобального состояния
   * клавиатуры на каждом движении, пересечённая с потактовой лентой нажатий, восстанавливает маску Shift
   * для текста, который формат обещает не хранить. */
  const code = swift.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('пишется у нажатия кнопки',
    (code.match(/capture\(action: "\w+ Click Down", x: x, y: y, mods: chordName\(event\.flags\)\)/g) || []).length === 3);
  /* ОБЕ ветки прокрутки - вертикальная и боковая. Проверка «есть хотя бы одна» прошла бы на коде, где
   * модификатор потеряла ровно одна из двух, а это половина жеста. */
  check('и у прокрутки, у которой пары нет - в обеих её ветках',
    (code.match(/mods: wheelMods/g) || []).length === 2,
    String((code.match(/mods: wheelMods/g) || []).length));
  check('но НЕ у движения', !/action: "Mouse Movement", x: x, y: y, mods:/.test(code));
  check('и НЕ у отпускания - повтор держит его от нажатия до пары',
    !/Click Release", x: x, y: y, mods:/.test(code));
  /* Клавиатурного пути это не касается вовсе - там обещание про буквы. */
  check('и клавиатурный путь не тронут',
    !/captureKey\([^)]*mods/.test(code) && !/captureNamedKey\([^)]*mods/.test(code));

  /* Пропустить `mods` в guard'е серialize - невидимая ошибка, теряющая ровно Cmd+прокрутку: у неё в
   * контексте больше ничего и нет. */
  check('и строка с одними модификаторами доживает до провода',
    /\|\| e\.nameLength > 0 \|\| e\.mods != nil \{/.test(swift)
      && /if let v = e\.mods \{ out \+= "\\tmods=" \+ v \}/.test(swift));
}

group('и воспроизводится тем же жестом');
{
  /* Флагов на событии ДОСТАТОЧНО - измерено окном, сообщавшим, что оно видит: событие, посланное только с
   * флагами, дало NSEvent.modifierFlags = Alt ровно так же, как событие с физически зажатой клавишей.
   * Поэтому никакой машинерии с удержанием клавиш здесь нет. */
  check('повтор разбирает mods из #ctx', /if parts\[0\] == "mods" \{ ctx\.mods = value \}/.test(swift));
  /* Без второй половины получается функция, работающая для названных элементов и молча не работающая
   * везде остальном - форма, проходящая демонстрацию. */
  check('и строка с одними модификаторами его не теряет',
    /ctx\.control == nil && ctx\.type == nil && ctx\.mods == nil/.test(swift));
  /* `Ctrl` здесь - клавиша Control, а не «командный модификатор». Повторить Control-клик как Cmd-клик
   * значит сделать другой жест и отчитаться о чистом прогоне. */
  check('и Ctrl остаётся Control, а не превращается в Command',
    /case "ctrl", "control": out\.insert\(\.maskControl\)/.test(swift));
  /* Отпускание и движения внутри перетаскивания своего #ctx не несут - берут у открытого нажатия. Иначе
   * Option-перетаскивание распалось бы на Option-нажатие и обычное перетаскивание: в Finder это разница
   * между копированием и перемещением. */
  check('перетаскивание несёт модификатор до самого отпускания',
    /private var gestureMods: CGEventFlags = \[\]/.test(swift)
      && /if event\.action\.hasSuffix\("Click Down"\) \{ gate\.lock\(\); gestureMods = carried; gate\.unlock\(\) \}/.test(swift));
  /* Флаг на событии ЗАЛИПАЕТ в состоянии сессии ровно как аккорд на клавиатуре - измерено. Не отпустить
   * значит отдать следующему клику чужой Option, а человеку за клавиатурой - зажатую клавишу. */
  check('и модификатор отпускается, когда жест закрылся',
    /if !mods\.isEmpty && event\.action\.hasSuffix\("Click Release"\) \{ Input\.releaseModifiers\(\) \}/.test(swift)
      && /if !mods\.isEmpty && event\.action\.hasPrefix\("Scroll"\) \{ Input\.releaseModifiers\(\) \}/.test(swift));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
