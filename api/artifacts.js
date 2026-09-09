/* Кадры прогона: перечислить, отдать один, положить новый.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МАРШРУТ, если облачный путь пишет их сам (см. ?worker=step в api/mcp.js). Потому что
 * прогон, который ведёт страница Create, идёт мимо облака целиком: модель зовёт /api/claude, действия уходят
 * агенту по локальной сети, и на аккаунт попадает только итог через /api/sync. Кадру нужна своя дверь, и
 * предъявитель у неё сессионная кука - а не токен устройства, которым приходит агент.
 *
 * ЧТЕНИЕ РАЗДЕЛЕНО НАДВОЕ НАРОЧНО. `?run=` отдаёт список БЕЗ картинок - двенадцать кадров это до трёх
 * мегабайт, и панель истории, показывающая десять прогонов, утащила бы тридцать. `?id=` отдаёт один, с
 * картинкой, и кэшируется браузером на сутки: содержимое кадра неизменно по определению, это снимок момента.
 *
 * SCOPING. Каждый запрос фильтрует по id, который вернул whoIsCalling, ВНУТРИ условия. Чужой кадр и
 * несуществующий отвечают одинаковым 404 - как в api/schedules.js и по той же причине: разные ответы
 * подтверждали бы, что такой id есть.
 */
import { neon } from '@neondatabase/serverless';

import { whoIsCalling } from './_session.js';
import { report, wrap } from './_report.js';
import { cors } from './_cors.mjs';
import {
  ARTIFACT_KEEP_DAYS, ARTIFACTS_PER_RUN, KINDS, artifactId, dropWhich, tooBig,
} from './_artifact.mjs';

const fail = (res, status, message) =>
  res.status(status).json({ error: { type: 'artifact_error', message } });

const ID = /^[A-Za-z0-9_.:-]{1,80}$/;
/* Что вообще может быть картинкой. Список, а не проверка «начинается с image/»: строка от клиента едет
 * обратно в заголовок и в src, и принимать туда произвольное значение незачем. */
const MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

async function list(res, sql, userId, runId) {
  /* Без `bytes`. Это не оптимизация, а разница между списком в килобайт и списком в три мегабайта. */
  const rows = await sql`
    select id, run_id, step_no, kind, mime, w, h, said, created_at
    from run_artifact
    where user_id = ${userId} and run_id = ${runId}
    order by step_no, created_at
  `;
  return res.status(200).json({
    ok: true,
    artifacts: rows.map((one) => ({
      id: one.id,
      runId: one.run_id,
      stepNo: one.step_no,
      kind: one.kind,
      mime: one.mime,
      w: one.w,
      h: one.h,
      said: one.said || null,
      at: one.created_at,
    })),
  });
}

async function one(res, sql, userId, id) {
  const rows = await sql`
    select id, mime, w, h, said, bytes from run_artifact
    where user_id = ${userId} and id = ${id}
  `;
  if (!rows.length) return fail(res, 404, 'no such frame on this account');
  const it = rows[0];
  /* Сутки в приватном кэше: содержимое кадра не меняется никогда - это снимок момента, - а панель истории
   * открывают по многу раз. `private`, потому что это чей-то экран. */
  res.setHeader('Cache-Control', 'private, max-age=86400');
  return res.status(200).json({
    ok: true,
    artifact: { id: it.id, mime: it.mime, w: it.w, h: it.h, said: it.said || null, bytes: it.bytes },
  });
}

async function put(req, res, sql, userId) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const runId = String(body.runId || '').trim();
  if (!ID.test(runId)) return fail(res, 400, 'which run? pass runId');
  const kind = String(body.kind || '');
  if (!KINDS.includes(kind)) return fail(res, 400, `kind must be one of ${KINDS.join(', ')}`);
  const mime = String(body.mime || 'image/jpeg');
  if (!MIMES.has(mime)) return fail(res, 400, `mime must be one of ${[...MIMES].join(', ')}`);
  const bytes = String(body.bytes || '');
  if (!bytes) return fail(res, 400, 'nothing to keep');
  /* Слишком тяжёлый кадр ОТКЛАДЫВАЕТСЯ с причиной, а не режется молча: уменьшить его здесь нечем, а
   * сохранить обрезанным значило бы положить в отчёт картинку, которая не то, что было на экране. */
  const heavy = tooBig(bytes);
  if (heavy) return res.status(200).json({ ok: true, kept: false, why: heavy });

  /* ПОТОЛОК НА ПРОГОН, и выбрасываются самые старые ПРОШЕДШИЕ проверки: они подтверждают то, что и так
   * зелёное. Провал и финал остаются - ради них таблица и существует. Расчёт в _artifact.mjs, общий с
   * облачным путём. */
  const have = await sql`
    select id, kind, step_no from run_artifact where user_id = ${userId} and run_id = ${runId}
  `;
  const drop = dropWhich(have, 1);
  if (drop.length) {
    await sql`delete from run_artifact where user_id = ${userId} and id = any(${drop})`;
  }

  const id = artifactId();
  await sql`
    insert into run_artifact (id, user_id, run_id, step_no, kind, mime, w, h, bytes, said)
    values (${id}, ${userId}, ${runId}, ${Math.max(0, Math.round(Number(body.stepNo) || 0))},
            ${kind}, ${mime}, ${Number(body.w) || null}, ${Number(body.h) || null},
            ${bytes}, ${String(body.said || '').slice(0, 2000) || null})
  `;

  /* УБОРКА ПО ХОДУ ДЕЛА, а не кроном. Тот же приём, что у расписаний, и по той же причине: крон в облаке -
   * это второй механизм, который может сломаться так, что никто не заметит, пока база не кончится. Только
   * свои строки и только старше окна. */
  await sql`
    delete from run_artifact
    where user_id = ${userId} and created_at < now() - ${`${ARTIFACT_KEEP_DAYS} days`}::interval
  `.catch(() => {});

  return res.status(200).json({ ok: true, kept: true, id, dropped: drop.length });
}

async function handler(req, res) {
  cors(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!process.env.DATABASE_URL) return fail(res, 503, 'This deployment has no database configured.');

  const sql = neon(process.env.DATABASE_URL);
  let who;
  try {
    who = await whoIsCalling(req, sql);
  } catch (err) {
    await report(err, req, { route: 'artifacts' });
    return fail(res, 500, 'could not check who is calling: ' + err.message);
  }
  if (!who) return fail(res, 401, 'sign in first');

  try {
    if (req.method === 'GET') {
      const asked = String((req.query && req.query.id) || '').trim();
      if (asked) {
        if (!ID.test(asked)) return fail(res, 400, 'that is not a frame id');
        return one(res, sql, who.id, asked);
      }
      const runId = String((req.query && req.query.run) || '').trim();
      if (!ID.test(runId)) return fail(res, 400, 'which run? pass ?run=<id>, or ?id=<frame>');
      return list(res, sql, who.id, runId);
    }
    if (req.method === 'POST') return put(req, res, sql, who.id);
    return fail(res, 405, 'GET or POST');
  } catch (err) {
    /* Таблицы может не быть - миграция не применена на этом деплое. Сказать это прямо: прогоны при этом
     * работают полностью, теряются только картинки, и разница между «сломано» и «не установлено» здесь
     * стоит ровно того часа, который иначе уйдёт на поиск несуществующей поломки. */
    if (/run_artifact/.test(String(err.message))) {
      return fail(res, 503, 'Kept frames need db/020_run_artifact.sql applied on this deployment. '
        + 'Runs and their words are unaffected.');
    }
    await report(err, req, { route: 'artifacts' });
    return fail(res, 500, err.message);
  }
}

export default wrap(handler, 'artifacts');

/* Сколько это весит, чтобы не считать в уме: до ARTIFACTS_PER_RUN кадров на прогон по ARTIFACT_MAX_BYTES -
 * то есть до трёх мегабайт у самого разговорчивого прогона, и это потолок, а не средний случай (обычный
 * прогон с одной проверкой оставляет два кадра). Живут ARTIFACT_KEEP_DAYS суток. */
export const CAPS = { ARTIFACTS_PER_RUN, ARTIFACT_KEEP_DAYS };
