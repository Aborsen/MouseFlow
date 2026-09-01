/* Бэкап базы: дамп, шифрование, выгрузка за пределы Neon - и проверка, что выгруженное на месте.
 *
 * ЗАЧЕМ ВООБЩЕ, если у Neon есть «Restore from history». Потому что это не бэкап, а «отменить»: на free-плане
 * окно шесть часов, снимков нет, расписания нет, и всё это живёт внутри того же проекта. Оно спасает от
 * «снёс не то полчаса назад» и не спасает ни от «заметили через сутки», ни от «проект удалили», ни от
 * «аккаунт заморозили». Копия внутри системы, которую она страхует, страховкой не является.
 *
 * ШИФРУЕТ ПУБЛИЧНЫМ КЛЮЧОМ, а не паролем, и это главное решение здесь. Дамп несёт то, что вся наша
 * документация называет чувствительным: заголовки чужих окон, имена элементов, адреса страниц, тексты целей.
 * При age --recipient задача, которая делает бэкапы, физически не может их прочитать - приватный ключ лежит
 * у человека, а не в CI. Пароль в секрете дал бы CI и запись, и чтение; здесь только запись.
 *
 * И НЕ УМЕЕТ МОЛЧА ВЫГРУЗИТЬ ОТКРЫТЫЙ ТЕКСТ. Без ключа получателя он останавливается и говорит, чего не
 * хватает; --plaintext существует, но его надо написать руками. Худший исход для такого скрипта - не отказ,
 * а успешно залитый в чужое ведро незашифрованный дамп.
 *
 * ДАМПИТ ЧЕРЕЗ НЕПУЛЕРНЫЙ ХОСТ. DATABASE_URL у Vercel - это `...-pooler...`, то есть pgbouncer; для
 * pg_dump Neon сам советует прямое соединение, а не пул. Хост правится здесь, а не в переменной, чтобы
 * никому не приходилось держать вторую строку подключения.
 *
 * ГРУЗИТ curl, А НЕ SDK. `curl --aws-sigv4` - это реализация подписи S3, которую уже проверили миллионы
 * запросов; своя на 70 строк была бы кодом, который проверяли только мы, а тащить @aws-sdk/client-s3 ради
 * одного PUT - несколько мегабайт зависимостей в проект, где их почти нет. Работает с B2, R2 и самим S3.
 *
 * ПРОВЕРЯЕТ ПОСЛЕ ВЫГРУЗКИ. HEAD по тому же адресу и сверка размера: бэкап, которого никто не видел на
 * месте, - это надежда, а не бэкап. Полная проверка - это восстановление, и как её сделать, написано в
 * docs/product/20-operations.md.
 *
 *   node scripts/backup.mjs                 дамп → шифр → ведро → проверка
 *   node scripts/backup.mjs --keep          то же, но файл остаётся и локально
 *   node scripts/backup.mjs --local         только локально, без ведра
 *   node scripts/backup.mjs --plaintext     без шифрования (только с --local, и только руками)
 *   node scripts/backup.mjs --list          что лежит в ведре
 *   node scripts/backup.mjs --whoami        что Backblaze говорит про этот ключ - вместо догадок
 *   node scripts/backup.mjs --restore-check самый свежий бэкап скачать и прочитать pg_restore
 *
 * Переменные: DATABASE_URL, BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_KEY_ID, BACKUP_S3_APP_KEY,
 * BACKUP_AGE_RECIPIENT, необязательные AGE_BIN и BACKUP_AGE_IDENTITY (для --restore-check). Читаются из
 * окружения или из .env.local, который уже лежит рядом после `vercel env pull`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

/* В Actions причина обязана попасть в АННОТАЦИЮ, а не только в лог шага. Первый неудачный запуск показал на
 * странице запуска ровно «Process completed with exit code 1» - то есть человек, не полезший разворачивать
 * шаг, не узнал ничего. `::error::` кладёт первую строку прямо на страницу. */
const inActions = !!process.env.GITHUB_ACTIONS;
const die = (message) => {
  if (inActions) console.log('::error title=backup::' + message.split('\n')[0].replace(/::/g, ':'));
  console.error('\n' + message + '\n');
  process.exit(1);
};
const say = (...parts) => console.log(...parts);

/* ------------------------------------------------------------------ настройки */

/* .env.local читается ТОЛЬКО как источник по умолчанию: в CI переменные приходят из секретов, и окружение
 * должно перебивать файл, а не наоборот. */
const fromFile = (() => {
  const at = join(ROOT, '.env.local');
  if (!existsSync(at)) return {};
  const out = {};
  for (const line of readFileSync(at, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
})();
/* .trim() НЕ косметика. Секрет в GitHub набирается вставкой, и перевод строки в конце вставленного ключа
 * невидим в поле ввода, а подпись S3 с ним не сходится - ответ приходит «SignatureDoesNotMatch», то есть
 * ровно тот же, что и при неверном ключе. Пробел по краям не может быть частью ни одного из этих
 * значений, поэтому срезать его безопаснее, чем однажды искать его глазами. */
const conf = (name) => String(process.env[name] || fromFile[name] || '').trim();

const DATABASE_URL = conf('DATABASE_URL');
const ENDPOINT = conf('BACKUP_S3_ENDPOINT').replace(/^https?:\/\//, '').replace(/\/$/, '');
const BUCKET = conf('BACKUP_S3_BUCKET');
const KEY_ID = conf('BACKUP_S3_KEY_ID');
const APP_KEY = conf('BACKUP_S3_APP_KEY');
const RECIPIENT = conf('BACKUP_AGE_RECIPIENT');

/* ПРОВЕРЯЕТСЯ НЕ ЗДЕСЬ, а там, где нужен, - и это была моя ошибка. Стояло наверху, поэтому `--list`, которому
 * база не нужна вовсе, падал с «DATABASE_URL не задан» в шаге, где этой переменной и не передавали. Диагностика
 * соврала о причине сбоя ровно в том запуске, который её и должен был назвать. */

/* Регион вынимается из имени endpoint - s3.us-west-004.backblazeb2.com → us-west-004. Подпись SigV4 его
 * требует, и просить его отдельной переменной значило бы держать два способа сказать одно. */
const region = (() => {
  const m = ENDPOINT.match(/^s3[.-]([a-z0-9-]+)\./);
  return m ? m[1] : 'us-east-1';
})();

/* ------------------------------------------------------------------ pg_dump */

/* Версия дампера не ниже версии сервера - иначе pg_dump отказывается работать, и это правильно. Локально его
 * может не быть вообще (на этой машине нет), поэтому вторая дорога - официальный образ той же мажорной
 * версии: одна команда вместо инструкции «поставьте клиентские утилиты». */
function dumper(serverMajor) {
  const local = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  if (!local.error && local.status === 0) {
    const major = Number((local.stdout.match(/(\d+)\./) || [])[1] || 0);
    if (major >= serverMajor) return { kind: 'local', major };
    say(`pg_dump ${major} старее сервера (${serverMajor}) - беру образ postgres:${serverMajor}-alpine`);
  }
  const docker = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (docker.error || docker.status !== 0) {
    die(`Нужен pg_dump версии ${serverMajor} или новее, либо docker, чтобы взять его образом.\n`
      + `  Windows: winget install PostgreSQL.PostgreSQL.${serverMajor}\n`
      + '  или поставьте Docker Desktop - скрипт сам возьмёт postgres:' + serverMajor + '-alpine');
  }
  return { kind: 'docker', major: serverMajor };
}

/** Прямой хост вместо пулерного - см. заголовок. */
const unpooled = (url) => url.replace(/-pooler\./, '.');

async function serverMajorOf(url) {
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(url);
  const rows = await sql`select current_setting('server_version_num') as num`;
  return Math.floor(Number(rows[0].num) / 10000);
}

/* ------------------------------------------------------------------ имя объекта */

/* ГОД/МЕСЯЦ В ПУТИ, а не в одном плоском списке: правило удаления по префиксу и глазами читается, и
 * настраивается в любом ведре. Секунды в имени - чтобы два запуска в один день не перезаписали друг друга,
 * а именно перезапись и есть худший способ потерять бэкап. */
function objectName(now, encrypted) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}`
    + `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
  return `mouseflow/${now.getUTCFullYear()}/${p(now.getUTCMonth() + 1)}/${stamp}.dump`
    + (encrypted ? '.age' : '');
}

/* ------------------------------------------------------------------ S3 */

/* ВЕДРО В ХОСТЕ ИЛИ В ПУТИ, и решает это само имя.
 *
 * Обычный S3-адрес - virtual-hosted: `https://<ведро>.<endpoint>/<ключ>`. Но имя ведра в нём становится
 * частью ИМЕНИ ХОСТА, а хосты нечувствительны к регистру - значит ведро с заглавными буквами таким адресом
 * не назвать вовсе. Backblaze создать «MouseFlow» позволяет, и такое ведро отвечает `NoSuchBucket` на
 * каждый virtual-hosted запрос: он ищет «mouseflow», которого нет.
 *
 * Поэтому имя, непригодное для хоста (заглавные, подчёркивание, точки), адресуется path-style -
 * `https://<endpoint>/<ведро>/<ключ>`, - где регистр сохраняется. AWS такой стиль объявил устаревшим,
 * Backblaze и R2 его поддерживают, и это лучше, чем требовать от человека пересоздать ведро: переименовать
 * его в B2 нельзя.
 */
const dnsSafe = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(BUCKET);
const s3url = (key) => (dnsSafe
  ? `https://${BUCKET}.${ENDPOINT}/${key}`
  : `https://${ENDPOINT}/${BUCKET}/${key}`);

function s3(method, key, { upload, out } = {}) {
  const argv = [
    '--silent', '--show-error', '--fail-with-body',
    '--aws-sigv4', `aws:amz:${region}:s3`,
    '--user', `${KEY_ID}:${APP_KEY}`,
    '--request', method,
  ];
  if (upload) argv.push('--upload-file', upload);
  if (method === 'HEAD') argv.push('--head');
  if (out) argv.push('--output', out);
  argv.push(s3url(key));
  const run = spawnSync('curl', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.error) die('curl не запустился: ' + run.error.message);
  if (run.status !== 0) {
    /* Тело ошибки B2/S3 - это XML с внятным кодом, и его надо не просто показать, а ПЕРЕВЕСТИ в действие:
     * «SignatureDoesNotMatch» не говорит человеку, что чинить, а «регион в endpoint не тот» - говорит.
     * Ключи лежат в argv, поэтому наружу уходит только код и текст ответа. */
    const body = run.stdout || '';
    const code = (body.match(/<Code>([^<]+)<\/Code>/) || [])[1] || '';
    const hint = {
      /* Порядок - по тому, что случалось на самом деле. keyID уже принят (иначе был бы InvalidAccessKeyId),
       * значит подпись не сошлась из-за САМОГО ключа, а не из-за того, кто его предъявил. */
      SignatureDoesNotMatch: 'подпись не сошлась, а keyID при этом принят - значит дело в самом ключе.\n'
        + '  1) keyID и applicationKey взяты от РАЗНЫХ ключей. Пара показывается вместе только один раз, '
        + 'при создании; keyID виден в списке всегда, и его легко соединить с ключом от прошлой попытки. '
        + 'Создайте ключ заново и обновите ОБА секрета значениями с одного экрана.\n'
        + '  2) значение обрезано при копировании - applicationKey длинный и начинается с K005.\n'
        + `  3) регион: взят «${region}» из endpoint, и он должен совпадать с регионом ведра.`,
      /* Порядок причин - по тому, как часто это случается в жизни, а первая пришла из настоящего запуска. */
      InvalidAccessKeyId: 'ключ не опознан. Три причины, по убыванию вероятности:\n'
        + '  1) это МАСТЕР-КЛЮЧ аккаунта. С S3-совместимым API он не работает вовсе - нужен обычный '
        + 'Application Key, созданный через «Add a New Application Key» и ограниченный этим ведром.\n'
        + '  2) в BACKUP_S3_KEY_ID попал сам ключ, а не keyID: в Backblaze это два разных значения, и '
        + 'keyID - короткое, оно же в первой колонке списка ключей.\n'
        + `  3) endpoint от другого региона: взят «${region}», и ключ к чужому региону не подойдёт.`,
      AccessDenied: 'доступа нет. У ключа должно быть writeFiles и listFiles ИМЕННО на это ведро. И учтите: '
        + 'мастер-ключ аккаунта с S3-совместимым API не работает вовсе - нужен обычный Application Key.',
      NoSuchBucket: `ведра «${BUCKET}» по этому адресу нет, а ключ при этом принят и подпись сошлась.\n`
        + `  Адрес собран ${dnsSafe ? 'через хост (virtual-hosted)' : 'через путь (path-style, потому что '
          + 'имя ведра непригодно для имени хоста)'}.\n`
        + '  1) РЕГИСТР имени. B2 позволяет создать «MouseFlow», а в секрете должно стоять ровно то, что '
        + 'показано в списке Buckets, символ в символ.\n'
        + `  2) РЕГИОН: ведро живёт не в «${region}». На странице Buckets у каждого ведра свой endpoint - `
        + 'возьмите оттуда.\n'
        + '  3) ключ выдан на другое ведро - тогда B2 отвечает так же, не подтверждая, что ведро есть.',
      RequestTimeTooSkewed: 'часы машины разошлись с сервером - подпись S3 действительна 15 минут.',
    }[code];
    die(`S3 ${method} ${key}: ${code || 'curl ' + run.status}${hint ? ' - ' + hint : ''}\n\n`
      + `${body.slice(0, 800)}\n`
      + `Ведро ${BUCKET}, endpoint ${ENDPOINT}, регион ${region}.`);
  }
  return run.stdout || '';
}

/* ------------------------------------------------------------------ кто мы для Backblaze
 *
 * СПРАШИВАЕТ У ПРОВАЙДЕРА ВМЕСТО ГАДАНИЯ, и появилось это после четырёх неудачных запусков, каждый из
 * которых проверял одну догадку: мастер-ключ? регистр имени? регион? Ошибки S3 намеренно не выдают, что
 * именно не так - «NoSuchBucket» одинаков и для опечатки в имени, и для ключа, выданного на другое ведро,
 * потому что иначе он подтверждал бы существование чужих ведёр.
 *
 * А НАТИВНЫЙ API B2 говорит прямо. b2_authorize_account по тому же keyID и ключу возвращает, к какому ведру
 * ключ привязан, какие у него права, какой префикс имён ему разрешён - и КАКОЙ S3-ENDPOINT у этого аккаунта.
 * То есть все три подозреваемых сразу, из первоисточника, одним запросом и без изменения чего-либо.
 *
 * Токен из ответа не печатается: он и есть учётные данные на следующие сутки. */
async function whoami() {
  if (!KEY_ID || !APP_KEY) die('Нужны BACKUP_S3_KEY_ID и BACKUP_S3_APP_KEY.');
  const basic = Buffer.from(`${KEY_ID}:${APP_KEY}`).toString('base64');
  let body;
  try {
    const res = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account',
      { headers: { authorization: 'Basic ' + basic } });
    body = await res.json();
    if (!res.ok) {
      die(`Backblaze не принял ключ (HTTP ${res.status}): ${body && body.message ? body.message : ''}\n`
        + 'Это про сам ключ, а не про ведро: keyID и applicationKey должны быть от одного ключа.');
    }
  } catch (err) {
    die('Не удалось спросить Backblaze: ' + err.message);
  }
  /* v3 кладёт всё в apiInfo.storageApi, v2 - в allowed рядом с корнем. Обе формы читаются, потому что
   * версия API - не то, из-за чего должна падать диагностика. */
  const api = (body.apiInfo && body.apiInfo.storageApi) || {};
  const allowed = body.allowed || api;
  const s3 = api.s3ApiUrl || body.s3ApiUrl || '';
  const caps = (allowed.capabilities || api.capabilities || []).join(', ');

  say('\nЧто Backblaze говорит про этот ключ:');
  say(`  ведро            ${allowed.bucketName || api.bucketName || '(ключ не привязан к одному ведру)'}`);
  say(`  префикс имён     ${allowed.namePrefix || api.namePrefix || '(любой)'}`);
  say(`  права            ${caps || '(не сообщены)'}`);
  say(`  S3 endpoint      ${s3.replace(/^https?:\/\//, '') || '(не сообщён)'}`);

  const theirs = s3.replace(/^https?:\/\//, '');
  const bucket = allowed.bucketName || api.bucketName || '';
  say('\nЧто настроено у нас:');
  say(`  BACKUP_S3_BUCKET    ${BUCKET || '(пусто)'}`);
  say(`  BACKUP_S3_ENDPOINT  ${ENDPOINT || '(пусто)'}   → регион «${region}»`);
  say(`  стиль адреса        ${dnsSafe ? 'virtual-hosted' : 'path-style'}`);

  const wrong = [];
  if (theirs && ENDPOINT && theirs !== ENDPOINT) {
    wrong.push(`endpoint: у аккаунта «${theirs}», а в BACKUP_S3_ENDPOINT «${ENDPOINT}»`);
  }
  if (bucket && BUCKET && bucket !== BUCKET) {
    wrong.push(`имя ведра: ключ привязан к «${bucket}», а в BACKUP_S3_BUCKET «${BUCKET}»`
      + (bucket.toLowerCase() === BUCKET.toLowerCase() ? ' - различие только в РЕГИСТРЕ' : ''));
  }
  if (caps && !/writeFiles/.test(caps)) wrong.push('у ключа нет writeFiles - выгружать он не сможет');
  if (caps && !/readFiles/.test(caps)) wrong.push('у ключа нет readFiles - проверка после выгрузки не пройдёт');

  if (wrong.length) {
    say('');
    die('Расхождения:\n  - ' + wrong.join('\n  - '));
  }
  say('\nВсё сходится. Если выгрузка всё равно падает - дело не в этих трёх значениях.');
}

if (has('--whoami')) { await whoami(); process.exit(0); }

/* ------------------------------------------------------------------ шифрование */

/* AGE_BIN, потому что на Windows этого не миновать: winget ставит age в
 * %LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\FiloSottile.age_…\\age\\age.exe и НЕ добавляет его в PATH:
 * `age-keygen` в консоли отвечает «не распознан как имя командлета», хотя пакет установлен. Полный путь
 * в переменной решает это без правки PATH, которую человек не просил. */
const AGE = conf('AGE_BIN') || 'age';

function encrypt(from, to) {
  const age = spawnSync(AGE, ['--version'], { encoding: 'utf8' });
  if (age.error || age.status !== 0) {
    die('BACKUP_AGE_RECIPIENT задан, а age не найден - зашифровать нечем, и открытый дамп я не выгружу.\n'
      + '  Ubuntu: apt-get install -y age    macOS: brew install age\n'
      + '  Windows: winget install FiloSottile.age - в PATH он после этого НЕ появляется,\n'
      + '           так что путь к age.exe положите в AGE_BIN');
  }
  const run = spawnSync(AGE, ['--encrypt', '--recipient', RECIPIENT, '--output', to, from],
    { encoding: 'utf8' });
  if (run.status !== 0) die('age не смог зашифровать: ' + (run.stderr || '').slice(0, 400));
}

/* ------------------------------------------------------------------ дело */

const work = join(tmpdir(), 'mf-backup');
mkdirSync(work, { recursive: true });

if (has('--list')) {
  if (!BUCKET || !KEY_ID) die('Для --list нужны BACKUP_S3_BUCKET, BACKUP_S3_KEY_ID, BACKUP_S3_APP_KEY.');
  /* prefix=mouseflow%2F, а не с косой чертой: канонический запрос SigV4 требует значения параметров
   * закодированными, и «/» в них - это %2F. curl подписывает то, что дали; сервер канонизирует по
   * правилу. Разойдись они - и получится SignatureDoesNotMatch, который не про ключи. */
  const xml = s3('GET', '?list-type=2&prefix=mouseflow%2F&max-keys=1000');
  const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>\s*<LastModified>([^<]+)<\/LastModified>\s*(?:<ETag>[^<]*<\/ETag>\s*)?<Size>(\d+)</g)];
  if (!keys.length) { say('В ведре пока ничего нет по префиксу mouseflow/.'); process.exit(0); }
  for (const [, key, when, size] of keys) {
    say(`${(Number(size) / 1024 / 1024).toFixed(2).padStart(7)} MB  ${when}  ${key}`);
  }
  say(`\n${keys.length} файл(ов).`);
  process.exit(0);
}

/* ------------------------------------------------------------------ репетиция восстановления
 *
 * ТО, ЧТО ОТЛИЧАЕТ БЭКАП ОТ ФАЙЛА. Успешная выгрузка говорит, что байты доехали; она не говорит, что из них
 * что-то восстановится. Пока никто не развернул ни один дамп, всё это - надежда, и ровно тем же доводом
 * написана проверка обещаний рядом: проверка, которую никто не видел падающей, ничего не проверяет.
 *
 * НЕ ТРОГАЕТ НИ ОДНУ БАЗУ. `pg_restore --list` читает оглавление дампа и печатает, что в нём лежит - это
 * доказывает, что файл целый и его понимает восстановитель, и при этом никуда ничего не пишет. Полное
 * восстановление в свежую ветку Neon - следующий шаг, и он описан в 20-operations; здесь то, что можно
 * сделать за минуту и без риска.
 *
 * ПРИВАТНЫЙ КЛЮЧ ОСТАЁТСЯ У ЧЕЛОВЕКА. Расшифровать может только тот, у кого он есть, поэтому это локальная
 * команда, а не шаг в CI: задача, которая делает бэкапы, читать их не должна - на этом построено всё
 * шифрование здесь. Без ключа проверяется меньшее: что объект на месте, что он не пуст и что это
 * действительно файл age.
 *
 *   BACKUP_AGE_IDENTITY=путь/к/backup-key.txt node scripts/backup.mjs --restore-check
 */
if (has('--restore-check')) {
  if (!BUCKET || !KEY_ID) die('Нужны BACKUP_S3_BUCKET, BACKUP_S3_KEY_ID, BACKUP_S3_APP_KEY.');
  const xml = s3('GET', '?list-type=2&prefix=mouseflow%2F&max-keys=1000');
  const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]).sort();
  if (!keys.length) die('В ведре нет ни одного бэкапа - проверять нечего.');
  const newest = keys[keys.length - 1];
  say(`Самый свежий: ${newest}`);

  const got = join(work, 'check.age');
  s3('GET', newest, { out: got });
  const size = statSync(got).size;
  if (!size) die('Скачался пустой файл - в ведре лежит ноль байт.');
  const head = readFileSync(got).subarray(0, 22).toString('latin1');
  if (!head.startsWith('age-encryption.org/')) {
    die(`Это не файл age: начинается с «${head.slice(0, 20)}». Ключ шифрования тут не поможет - `
      + 'выгружено что-то другое.');
  }
  say(`скачан: ${(size / 1024 / 1024).toFixed(2)} MB, и это файл age`);

  const identity = conf('BACKUP_AGE_IDENTITY');
  if (!identity) {
    unlinkSync(got);
    say('\nДальше нужен ПРИВАТНЫЙ ключ, которого в CI нет и быть не должно:');
    say('  BACKUP_AGE_IDENTITY=путь/к/backup-key.txt node scripts/backup.mjs --restore-check');
    say('Тогда дамп будет расшифрован и прочитан pg_restore --list - без записи в какую-либо базу.');
    process.exit(0);
  }
  if (!existsSync(identity)) die(`Файла с ключом нет: ${identity}`);

  const plainOut = join(work, 'check.dump');
  const dec = spawnSync(AGE, ['--decrypt', '--identity', identity, '--output', plainOut, got],
    { encoding: 'utf8' });
  if (dec.status !== 0) {
    unlinkSync(got);
    die('age не расшифровал: ' + (dec.stderr || '').slice(0, 300) + '\n'
      + 'Обычно это НЕ ТОТ ключ - шифровалось для другого получателя.');
  }
  say(`расшифрован: ${(statSync(plainOut).size / 1024 / 1024).toFixed(2)} MB`);

  /* pg_restore той же мажорной версии, что дамп; локально его может не быть - тогда образом, как и pg_dump. */
  const tool = dumper(17);
  const listing = tool.kind === 'local'
    ? spawnSync('pg_restore', ['--list', plainOut], { encoding: 'utf8' })
    : spawnSync('docker', ['run', '--rm', '-v', `${work}:/out`, 'postgres:17-alpine',
      'pg_restore', '--list', '/out/check.dump'], { encoding: 'utf8' });
  /* Файлы убираются в любом случае: это настоящие данные живого аккаунта, и оставлять их в temp - ровно то,
   * от чего защищает шифрование в ведре. */
  unlinkSync(got);
  unlinkSync(plainOut);
  if (listing.status !== 0) {
    die('pg_restore не прочитал дамп: ' + (listing.stderr || '').slice(0, 400) + '\n'
      + 'Вот это и был бы тот случай, ради которого проверка написана.');
  }
  const tables = [...(listing.stdout || '').matchAll(/TABLE DATA public (\S+)/g)].map((m) => m[1]);
  say(`\npg_restore прочитал оглавление: ${tables.length} таблиц с данными`);
  if (tables.length) say('  ' + tables.slice(0, 12).join(', ') + (tables.length > 12 ? ', …' : ''));
  say('\nДамп восстановим. Временные файлы удалены.');
  say('Полное восстановление - в свежую ветку Neon, никогда поверх живой: docs/product/20-operations.md.');
  process.exit(0);
}

const local = has('--local');
const plaintext = has('--plaintext');
if (plaintext && !local) {
  die('--plaintext только вместе с --local. Незашифрованный дамп в чужое ведро - это не бэкап, а утечка.');
}
if (!plaintext && !RECIPIENT) {
  die('BACKUP_AGE_RECIPIENT не задан.\n'
    + '  Сгенерируйте пару:  age-keygen -o backup-key.txt\n'
    + '  Публичный ключ (age1…) - в переменную, приватный - в менеджер паролей.\n'
    + '  Так задача, которая делает бэкапы, не сможет их прочитать.\n'
    + '  Совсем без шифрования: --local --plaintext.');
}
if (!local && (!ENDPOINT || !BUCKET || !KEY_ID || !APP_KEY)) {
  die('Для выгрузки нужны BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_KEY_ID, BACKUP_S3_APP_KEY.\n'
    + '  Только дамп на диск: --local.');
}

if (!DATABASE_URL) die('DATABASE_URL не задан. `vercel env pull .env.local` или переменная окружения.');

const major = await serverMajorOf(DATABASE_URL);
const tool = dumper(major);
const now = new Date();
const plain = join(work, objectName(now, false).split('/').pop());
const direct = unpooled(DATABASE_URL);

say(`Postgres ${major}, дамп через ${tool.kind === 'local' ? 'локальный pg_dump' : `postgres:${major}-alpine`}`);

/* --format=custom, потому что его понимает pg_restore: выборочное восстановление одной таблицы из
 * plain-текста означает редактирование SQL руками. -Z 6 - сжатие внутри дампа, чтобы 15 МБ базы не ехали
 * как 15 МБ. --no-owner/--no-privileges: роли на новом проекте другие, и восстановление не должно падать
 * из-за отсутствующего neondb_owner. */
const DUMP_ARGS = ['--format=custom', '--compress=6', '--no-owner', '--no-privileges'];

try {
  if (tool.kind === 'local') {
    execFileSync('pg_dump', [direct, ...DUMP_ARGS, '--file=' + plain], { stdio: ['ignore', 'inherit', 'inherit'] });
  } else {
    execFileSync('docker', [
      'run', '--rm', '-e', 'PGCONNECT_TIMEOUT=30',
      '-v', `${work}:/out`, `postgres:${major}-alpine`,
      'pg_dump', direct, ...DUMP_ARGS, '--file=/out/' + plain.split(/[\\/]/).pop(),
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
  }
} catch (err) {
  die('pg_dump не справился. Часто это непулерный хост, до которого нет доступа, или истёкший пароль.\n'
    + String(err.message).slice(0, 300));
}

const dumpSize = statSync(plain).size;
say(`дамп: ${(dumpSize / 1024 / 1024).toFixed(2)} MB`);

let toSend = plain;
if (!plaintext) {
  toSend = plain + '.age';
  encrypt(plain, toSend);
  say(`зашифровано для ${RECIPIENT.slice(0, 16)}…: ${(statSync(toSend).size / 1024 / 1024).toFixed(2)} MB`);
  if (!has('--keep')) unlinkSync(plain);
}

if (local) {
  const kept = join(process.cwd(), toSend.split(/[\/]/).pop());
  copyFileSync(toSend, kept);
  say(`
лежит здесь: ${kept}`);
  if (plaintext) say('Это ОТКРЫТЫЙ дамп живой базы - не оставляйте его в рабочей папке.');
  process.exit(0);
}

const key = objectName(now, !plaintext);
s3('PUT', key, { upload: toSend });

/* И СРАЗУ ПРОВЕРКА, тем же ключом, но на чтение: размер должен совпасть. Выгрузка, которая ответила 200 и
 * положила ноль байт, выглядит как успех ровно до того дня, когда её понадобится развернуть. */
const head = s3('HEAD', key);
const got = Number((head.match(/content-length:\s*(\d+)/i) || [])[1] || 0);
const sent = statSync(toSend).size;
if (got !== sent) {
  die(`В ведре ${got} байт, отправлено ${sent}. Файл на месте, но не тот - разбираться до следующего запуска.`);
}

say(`\nв ведре: ${key}`);
say(`проверено: ${got} байт, столько же, сколько отправлено.`);
say('\nВосстановление и как его проверить - docs/product/20-operations.md, раздел «Бэкап и восстановление».');
