/* Sending one email, and being honest when it cannot.
 *
 * WHY THIS EXISTS AT ALL. Until now this product sent nothing, and said so in as many words: an invitation
 * was a row, and the person doing the inviting was told to go and tell their colleague themselves. That is
 * a defensible design - an invitation that depends on a message arriving is one that silently does not
 * happen - but it makes the common case ("add my team") a job with homework. So mail is now sent, and the
 * ROW IS STILL THE INVITATION. Membership is decided by the address on the account, on read, exactly as
 * before. The message is a courtesy that points at a page; it carries no authority of its own.
 *
 * That distinction is the whole security design of this file, so it is worth stating plainly:
 *
 *   the link in the mail is NOT a bearer token. It is a deep link to the Teams page. Opening it as the
 *   wrong person joins nothing, because the claim is matched on the address of the account that opens it.
 *   A tokenised join link would mean anyone who saw the message - a forward, a shared inbox, a mail log -
 *   could take the seat it was meant for.
 *
 * NEVER THROWS. A send that fails must not fail the invitation, because the invitation already succeeded:
 * the row is written before this is called. Every path here returns { sent, why } and the caller reports it.
 *
 * NO DEPENDENCY. Resend's API is one POST with a JSON body; a package for that would be a package to keep
 * current for the sake of `fetch`. If RESEND_API_KEY is absent the product behaves exactly as it did last
 * week and says which variable is missing, rather than pretending a message is on its way.
 *
 * Configure with:
 *   RESEND_API_KEY   from resend.com
 *   MAIL_FROM        a verified sender, e.g. "MouseFlow <team@yourdomain>". No default on purpose: the
 *                    sandbox sender only delivers to the account holder, which looks like working in
 *                    testing and like nothing at all in production.
 */

const ENDPOINT = 'https://api.resend.com/emails';
const TIMEOUT_MS = 8_000;

/** Enough of an address to be worth a request. Not validation - the provider does that - just a filter. */
export const looksLikeEmail = (value) => typeof value === 'string' && /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(value.trim());

export const mailConfigured = () => Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);

/* Why it is not configured - the CAUSE only, with no sentence around it.
 *
 * It used to return a whole sentence ("no mail is sent from this deployment: ..."), and every caller
 * already had a sentence of its own to put it in. So the panel read "No email leaves this deployment - no
 * mail is sent from this deployment: RESEND_API_KEY and MAIL_FROM are not set", which is the same thing
 * said twice and reads as a bug. The cause belongs to this file; the framing belongs to whoever is
 * speaking. */
export function mailProblem() {
  const missing = [
    process.env.RESEND_API_KEY ? null : 'RESEND_API_KEY',
    process.env.MAIL_FROM ? null : 'MAIL_FROM',
  ].filter(Boolean);
  if (!missing.length) return null;
  return `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set`;
}

/**
 * Send one message. Returns { sent: true, id } or { sent: false, why } - never throws, never rejects.
 */
export async function sendMail({ to, subject, text, html, replyTo }) {
  const why = mailProblem();
  if (why) return { sent: false, why };
  if (!looksLikeEmail(to)) return { sent: false, why: 'that is not an address mail could go to' };

  /* A hung provider must not hold a serverless invocation open until the platform kills it - the caller is
   * waiting to tell somebody their colleague was added, which already happened. */
  const stop = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM,
        to: [String(to).trim()],
        subject,
        text,
        ...(html ? { html } : {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
      signal: stop,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      /* The provider's own words. A status code alone tells whoever reads the response nothing about
       * whether the sender is unverified, the domain unconfirmed or the address refused. */
      return { sent: false, why: (body && (body.message || body.error)) || `the mail service answered ${res.status}` };
    }
    return { sent: true, id: (body && body.id) || null };
  } catch (err) {
    return { sent: false, why: err && err.name === 'TimeoutError' ? 'the mail service did not answer' : String(err && err.message || err) };
  }
}

/* ------------------------------------------------------------------------------ the invitation itself */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The message somebody gets when they are put in a team.
 *
 * Two shapes, one function, because they differ in exactly one paragraph: somebody who already has an
 * account is IN and needs a link; somebody who does not has to sign up with this address first, and being
 * told that after clicking is a worse minute than being told before.
 *
 * Every version carries the same three things, in this order, because that is the order the reader's
 * questions arrive in: who did this, what it means for their own recordings, and what to do if this is
 * nothing to do with them.
 */
export function invitationMail({ teamName, inviterName, inviterEmail, toEmail, url, hasAccount, role }) {
  const who = inviterName && inviterEmail && inviterName !== inviterEmail
    ? `${inviterName} (${inviterEmail})`
    : inviterEmail || inviterName || 'Somebody';
  const team = teamName || 'a team';
  const asRole = role === 'owner' ? ' as an owner' : role === 'admin' ? ' as an admin' : '';

  /* One verb, used by the subject and the first line alike. They said different things - "invited" on the
   * envelope and "added" in the body - which reads, to somebody with no account, as a claim that one was
   * made for them. */
  const verb = hasAccount ? 'added you to' : 'invited you to join';
  const subject = `${who} ${verb} ${team} on MouseFlow`;

  /* Said in the message rather than left to be discovered, because it is the thing people are actually
   * worried about when a tool tells them their colleague can now see something. */
  const privacy = 'Being in a team does not open your recordings. The people running it can see THAT you '
    + 'recorded something, when, and how a run ended — never what is in it. A skill becomes visible to a '
    + 'team only when you share that one skill, yourself.';

  const next = hasAccount
    ? `You already have a MouseFlow account with this address, so you are in${asRole}. Open the Teams page:`
    : `You do not have a MouseFlow account yet. Create one with this address — ${toEmail} — and you will be `
      + `in${asRole} the moment you open the Teams page:`;

  const text = [
    `${who} ${verb} “${team}” on MouseFlow.`,
    '',
    next,
    url,
    '',
    privacy,
    '',
    'If you do not recognise this, delete this email. Nothing was shared with you, nothing of yours was '
      + 'shared, and no account was created for you.',
  ].join('\n');

  const html = `<!doctype html>
<div style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1d21">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e6e7eb;border-radius:12px;padding:28px">
    <p style="margin:0 0 18px;font-size:15px;line-height:1.5">
      <strong>${esc(who)}</strong> ${esc(verb)} <strong>${esc(team)}</strong> on MouseFlow.
    </p>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.5">${esc(next)}</p>
    <p style="margin:0 0 22px">
      <a href="${esc(url)}" style="display:inline-block;background:#1c1d21;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-size:14px;font-weight:600">Open Teams</a>
    </p>
    <p style="margin:0 0 18px;font-size:13px;line-height:1.55;color:#5b5d66">${esc(privacy)}</p>
    <p style="margin:0;padding-top:16px;border-top:1px solid #e6e7eb;font-size:12px;line-height:1.55;color:#84868f">
      If you do not recognise this, delete this email. Nothing was shared with you, nothing of yours was
      shared, and no account was created for you.
    </p>
  </div>
</div>`;

  return { subject, text, html };
}
