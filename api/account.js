/* Your account, and the way out of it.
 *
 *   DELETE /api/account?erase=1     delete everything this deployment holds about you
 *
 * Why a session and never a device token: erasing an account from a paired extension would mean one
 * leaked token could destroy the data it was granted to read. Revoking the token you knew about would
 * not undo it. The same reasoning as minting - see the note at the top of api/sync.js.
 *
 * What it deletes, exactly:
 *
 *   user_flow      every flow, from both halves, hard-deleted rather than tombstoned. A tombstone is
 *                  for "the client should stop showing this"; erasing an account is not that.
 *   user_run       every run: goals, models, steps, what the model said.
 *   device_token   every paired device, so nothing keeps syncing into a deleted account.
 *   gallery_skill  withdrawn, not deleted. A published skill may already be installed by other
 *                  people, and the copies they hold are theirs; withdrawing takes it out of the
 *                  gallery and off the author's name, which is what the author can actually decide.
 *
 * What it cannot delete: the Google account, and the sign-in record Neon Auth keeps for it. That row
 * belongs to the issuer, not to this application, and reaching into another system's tables to remove
 * it would be worse than saying plainly that it is not ours. Signing out afterwards is the client's
 * job, and the response says so.
 */

import { neon } from '@neondatabase/serverless';
import { whoIsCalling } from './_session.js';

function cors(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin',
    /^chrome-extension:\/\//.test(origin) ? origin : 'https://mouse-agent.vercel.app');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

const fail = (res, status, message) =>
  res.status(status).json({ error: { type: 'account_error', message } });

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'DELETE') return fail(res, 405, 'DELETE only');
  if (!process.env.DATABASE_URL) return fail(res, 503, 'This deployment has no database configured.');

  const sql = neon(process.env.DATABASE_URL);

  let who;
  try {
    who = await whoIsCalling(req, sql);
  } catch (err) {
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
    // user_flow is keyed by (user_id, client_id) and has no id column of its own.
    const flows = await sql`delete from user_flow where user_id = ${who.id} returning client_id`;
    const runs = await sql`delete from user_run where user_id = ${who.id} returning id`;
    const devices = await sql`delete from device_token where user_id = ${who.id} returning id`;
    const published = await sql`
      update gallery_skill set withdrawn_at = now(), updated_at = now()
      where author_id = ${who.id} and withdrawn_at is null
      returning id
    `;

    return res.status(200).json({
      ok: true,
      deleted: {
        flows: flows.length,
        runs: runs.length,
        devices: devices.length,
        withdrawn: published.length,
      },
      /* Said out loud because the UI has to be able to tell the truth about what just happened, and
       * "account deleted" would not be it. */
      note: 'Your flows, runs and paired devices are gone, and anything you published is withdrawn. ' +
        'Your Google account is not ours to delete - sign out to finish.',
    });
  } catch (err) {
    return fail(res, 500, err.message);
  }
}
