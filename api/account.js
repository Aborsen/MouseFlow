/* Your account, and the way out of it.
 *
 *   DELETE /api/account?erase=1     delete everything this deployment holds about you
 *
 * Why a session and never a device token: erasing an account from a paired extension would mean one
 * leaked token could destroy the data it was granted to read. Revoking the token you knew about would
 * not undo it. The same reasoning as minting - see the note at the top of api/sync.js.
 *
 * What it deletes, exactly. THIS LIST USED TO NAME FOUR TABLES AND THE SCHEMA HAS ELEVEN THAT HOLD USER
 * CONTENT - so "delete everything this deployment holds about you" was a sentence about a quarter of it.
 * Left behind were the full text of every question and answer to the assistant, every preference, every
 * queued run, every team row, and every OAuth grant - which is to say a connector went on authenticating
 * as a deleted user for up to 180 days.
 *
 *   user_flow      every flow, from both halves, hard-deleted rather than tombstoned. A tombstone is
 *                  for "the client should stop showing this"; erasing an account is not that.
 *   user_run       every run: goals, models, steps, what the model said.
 *   device_token   every paired device, so nothing keeps syncing into a deleted account.
 *   chat_thread    every conversation with the assistant. chat_message cascades from it, and is also
 *                  deleted by user_id: a cascade that silently stopped working would leave the one
 *                  table here that holds whole sentences somebody typed.
 *   user_pref      every preference.
 *   run_queue      queued and running jobs. Nothing else in this repo ever deleted from this table.
 *   team_share     every skill this person shared into a team.
 *   team_member    every membership. A team they were the SOLE OWNER of is tombstoned with them - see
 *                  below; one with another owner simply loses a member.
 *   team_invite    invitations sent TO their address, by the address. An invitation they SENT is left:
 *                  it belongs to the team, not to them, and the team may still be there.
 *   oauth_token    revoked, both kinds. Access tokens live 30 days and refresh tokens 180, and
 *                  _session.js accepts any row that is not revoked - so leaving them meant a connector
 *                  kept reading an erased account for half a year.
 *   oauth_code     deleted. Short-lived, but a code outstanding at this moment is a token afterwards.
 *   gallery_skill  withdrawn, not deleted. A published skill may already be installed by other
 *                  people, and the copies they hold are theirs; withdrawing takes it out of the
 *                  gallery and off the author's name, which is what the author can actually decide.
 *
 * A TEAM THEY ALONE OWNED IS TOMBSTONED. The alternatives were worse: an ownerless team is an object
 * nobody can administer or delete, and promoting somebody else silently hands them powers they did not
 * ask for. Tombstoning is the same decision the owner is offered anyway, and the count is reported so the
 * answer can say it happened.
 *
 * ALL OF IT IN ONE TRANSACTION. A partial erase is the worst outcome available here - it answers "ok"
 * having removed some of it - and there is no state in between that anybody would want.
 *
 * What it cannot delete: the Google account, and the sign-in record Neon Auth keeps for it. That row
 * belongs to the issuer, not to this application, and reaching into another system's tables to remove
 * it would be worse than saying plainly that it is not ours. Signing out afterwards is the client's
 * job, and the response says so.
 */

import { neon } from '@neondatabase/serverless';
import { whoIsCalling } from './_session.js';
/* Server-side crashes reach Sentry from here. See api/_report.js — no dependency, and it
 * deliberately sends the route and the message, never the query string or the body. */
import { report, wrap } from './_report.js';
/* Один заголовочный набор на все маршруты - см. api/_cors.mjs. Семь копий этих строк разошлись
 * ровно в том месте, где это стоило дороже всего: chats.js отражал ЛЮБОЙ origin и выдавал
 * Allow-Credentials, то есть чужая страница читала разговоры человека его же кукой. */
import { cors } from './_cors.mjs';


const fail = (res, status, message) =>
  res.status(status).json({ error: { type: 'account_error', message } });

async function handler(req, res) {
  cors(req, res, 'DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'DELETE') return fail(res, 405, 'DELETE only');
  if (!process.env.DATABASE_URL) return fail(res, 503, 'This deployment has no database configured.');

  const sql = neon(process.env.DATABASE_URL);

  let who;
  try {
    who = await whoIsCalling(req, sql);
  } catch (err) {
    await report(err, req, { route: 'account' });
    return fail(res, 500, 'could not check who is calling: ' + err.message);
  }
  if (!who) return fail(res, 401, 'sign in first');
  if (who.via !== 'session') {
    return fail(res, 403, 'only a signed-in browser can delete an account, not a paired device');
  }

  /* Deliberately explicit rather than a flag with a default: a request that erases everything should
   * not be something a mistyped URL can perform. */
  if (!(req.query && req.query.erase)) {
    return fail(res, 400, 'add ?erase=1 to confirm - this route only deletes');
  }

  try {
    /* Which teams die with them - read BEFORE anything is deleted, because after team_member is gone the
     * question cannot be asked. Sole owner: they are the owner and nobody else is. */
    const alone = await sql`
      select m.team_id from team_member m
      join team t on t.id = m.team_id and t.deleted_at is null
      where m.user_id = ${who.id} and m.role = 'owner'
        and not exists (
          select 1 from team_member o
          where o.team_id = m.team_id and o.role = 'owner' and o.user_id <> ${who.id}
        )
    `;
    const doomed = alone.map((row) => row.team_id);
    const email = String(who.email || '');

    /* ОДНОЙ ТРАНЗАКЦИЕЙ. Частичное удаление - худший из доступных исходов: оно отвечает «ok», убрав часть.
     * Порядок внутри роли не играет, но читается сверху вниз как список выше. */
    const done = await sql.transaction([
      // user_flow is keyed by (user_id, client_id) and has no id column of its own.
      sql`delete from user_flow where user_id = ${who.id} returning client_id`,
      sql`delete from user_run where user_id = ${who.id} returning id`,
      /* Кадры прогонов - ЧУЖИЕ ЭКРАНЫ, и удалить их обязательнее, чем строки: в words попадает то, что
       * прогон сказал, а в картинку - всё, что было на экране, включая соседние окна. См. db/020. */
      sql`delete from run_artifact where user_id = ${who.id} returning id`,
      sql`delete from device_token where user_id = ${who.id} returning id`,
      /* chat_message каскадом от chat_thread, и ЗАОДНО по user_id: каскад, тихо переставший работать,
       * оставил бы единственную таблицу здесь, где лежат целые предложения, набранные человеком. */
      sql`delete from chat_message where user_id = ${who.id} returning user_id`,
      sql`delete from chat_thread where user_id = ${who.id} returning id`,
      sql`delete from user_pref where user_id = ${who.id} returning key`,
      sql`delete from run_queue where user_id = ${who.id} returning id`,
      sql`delete from team_share where user_id = ${who.id} returning flow_id`,
      sql`delete from team_member where user_id = ${who.id} returning team_id`,
      /* Приглашения, присланные ЕМУ. Отправленные им остаются: они принадлежат команде, а не ему, и
       * команда может быть жива. */
      sql`delete from team_invite where lower(email) = lower(${email}) returning team_id`,
      sql`update team set deleted_at = now() where id = any(${doomed}) and deleted_at is null returning id`,
      /* Обе разновидности. _session.js принимает любую строку, у которой revoked_at пуст, а живут они 30 и
       * 180 дней - значит коннектор читал бы стёртый аккаунт ещё полгода. */
      sql`update oauth_token set revoked_at = now() where user_id = ${who.id} and revoked_at is null returning token_hash`,
      sql`delete from oauth_code where user_id = ${who.id} returning code_hash`,
      sql`
        update gallery_skill set withdrawn_at = now(), updated_at = now()
        where author_id = ${who.id} and withdrawn_at is null
        returning id
      `,
    ]);

    const [
      flows, runs, frames, devices, messages, threads, prefs, queued,
      shares, memberships, invites, teamsGone, tokens, codes, published,
    ] = done;

    return res.status(200).json({
      ok: true,
      /* Настоящие числа, а не четыре из четырнадцати. Экран, который говорит «удалено», обязан уметь
       * сказать, ЧТО именно, - иначе это то же обещание, только с цифрой. */
      deleted: {
        flows: flows.length,
        runs: runs.length,
        frames: frames.length,
        devices: devices.length,
        conversations: threads.length,
        messages: messages.length,
        preferences: prefs.length,
        queuedRuns: queued.length,
        teamMemberships: memberships.length,
        teamShares: shares.length,
        invitations: invites.length,
        teamsClosed: teamsGone.length,
        connectors: tokens.length + codes.length,
        withdrawn: published.length,
      },
      /* Said out loud because the UI has to be able to tell the truth about what just happened, and
       * "account deleted" would not be it. */
      note: 'Your flows, runs and the frames they kept, conversations, preferences, queued runs and paired '
        + 'devices are gone, every connector is revoked, and anything you published is withdrawn'
        + (teamsGone.length
          ? `. ${teamsGone.length} team${teamsGone.length === 1 ? '' : 's'} you alone owned ${
            teamsGone.length === 1 ? 'was' : 'were'} closed`
          : '')
        + '. Your Google account is not ours to delete - sign out to finish.',
    });
  } catch (err) {
    await report(err, req, { route: 'account' });
    return fail(res, 500, err.message);
  }
}

/* The outer net: anything thrown before or around the handler's own try block. */
export default wrap(handler, 'account');
