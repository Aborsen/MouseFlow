/* Nobody uses this without an account.
 *
 * The app is gated on landing rather than per feature: usage should be attributable, and a wall you
 * can walk around is not one. Until there is a session the tabs are not even mounted, so nothing
 * fetches and nothing renders behind it.
 *
 * What this is and is not:
 *
 *   It is  a front door. It makes the SITE require an account, which is what makes usage
 *          attributable to a person.
 *
 *   It is not  access control on the data. That lives in the API, which checks a session or a device
 *              token on every request and cannot be talked out of it - see api/sync.js and
 *              api/_session.js. A gate implemented only in a page is a suggestion; those checks are
 *              the enforcement, and they were there first.
 *
 * The gallery API stays publicly readable on purpose, because the extension installs from it directly
 * and an extension has no session until it is paired. That is the one path still open to someone
 * without an account, and it is read-only: publishing has always required a session.
 */

const AUTH = '/api/auth';

const GOOGLE_MARK = `<svg viewBox="0 0 48 48" aria-hidden="true" width="18" height="18">
  <path fill="#4285F4" d="M45 24c0-1.6-.1-2.7-.4-4H24v8h12c-.2 2-1.5 5-4.7 7l6.4 5C41.4 36.2 45 30.7 45 24z"/>
  <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.4-5C30 37 27.3 38 24 38c-6 0-11-4-12.8-9.5l-6.7 5.2C8.1 41 15.4 46 24 46z"/>
  <path fill="#FBBC05" d="M11.2 28.5C10.7 27 10.4 25.5 10.4 24s.3-3 .8-4.5l-6.7-5.2C3 17.3 2 20.5 2 24s1 6.7 2.5 9.7l6.7-5.2z"/>
  <path fill="#EA4335" d="M24 10c3.4 0 6.4 1.2 8.8 3.4l5.7-5.7C34.9 4.4 29.9 2 24 2 15.4 2 8.1 7 4.5 14.3l6.7 5.2C13 14 18 10 24 10z"/>
</svg>`;

const OUTCOMES = {
  'missing-verifier': 'Google came back without a verifier, so sign-in could not be completed.',
  'no-session-cookie': 'Sign-in was accepted but no session came back. Try again.',
  rejected: 'Neon Auth rejected the sign-in — the attempt may have expired. Try again.',
  unreachable: 'Could not reach the sign-in service.',
};

async function currentUser() {
  try {
    const res = await fetch(AUTH + '/get-session', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    // Better Auth answers null - not an error - when nobody is signed in.
    return body && body.user ? body.user : null;
  } catch (_) {
    return null;
  }
}

function screen(message) {
  const wall = document.createElement('div');
  wall.className = 'gate';
  wall.innerHTML = `
    <div class="gate-card">
      <svg class="gate-mark" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 3l14 8-6 1.6L10.5 19z" fill="currentColor"/>
      </svg>
      <h1>MouseFlow</h1>
      <p>
        Record a flow and repeat it, or describe what you need and have it done for you — in the
        browser, or across the whole desktop.
      </p>
      <button class="btn btn--google gate-go" type="button">
        ${GOOGLE_MARK}<span>Continue with Google</span>
      </button>
      <p class="gate-note"></p>
      <p class="gate-fine">
        Signing in identifies your flows and keeps a log of your runs against your account. Nothing is
        published to the gallery unless you press Publish.
      </p>
    </div>
  `;

  const note = wall.querySelector('.gate-note');
  if (message) {
    note.textContent = message;
    note.classList.add('gate-note--bad');
  }

  const button = wall.querySelector('.gate-go');
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.querySelector('span').textContent = 'Opening Google…';
    /* The callback lands on /api/auth/finish, which exchanges the one-time verifier for a session
     * cookie - only a server can do that - and sends the browser back to where it started. */
    let res;
    try {
      res = await fetch(AUTH + '/sign-in/social', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'google',
          /* Search included, not just path and hash: `?pair=extension` is how the extension asks to
           * be connected, and dropping it across sign-in turned a one-click handover into a
           * copy-and-paste. */
          callbackURL: location.origin + '/api/auth/finish?to=' +
            encodeURIComponent(location.pathname + location.search + location.hash),
        }),
      });
    } catch (_) {
      note.textContent = 'Could not reach the sign-in service.';
      note.classList.add('gate-note--bad');
      button.disabled = false;
      button.querySelector('span').textContent = 'Continue with Google';
      return;
    }
    const body = await res.json().catch(() => null);
    if (body && body.url) { location.href = body.url; return; }
    note.textContent = 'Could not start sign-in: ' +
      ((body && (body.message || body.code)) || 'HTTP ' + res.status);
    note.classList.add('gate-note--bad');
    button.disabled = false;
    button.querySelector('span').textContent = 'Continue with Google';
  });

  return wall;
}

/* Resolves once there is a signed-in user, and never otherwise - so a caller can simply await it and
 * know that everything after the await is happening for somebody identifiable. */
export async function requireAccount() {
  const params = new URLSearchParams(location.search);
  const outcome = params.get('auth');
  if (outcome) {
    /* Only the outcome is cleared, so a refresh does not repeat the message. Everything else in the
     * query string belongs to whoever put it there - `pair=extension` among them. */
    params.delete('auth');
    const rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
  }

  const user = await currentUser();
  if (user) return user;

  document.body.classList.add('gated');
  document.body.appendChild(screen(outcome && outcome !== 'ok' ? OUTCOMES[outcome] ||
    ('Sign-in did not complete (' + outcome + ').') : null));
  // Deliberately never resolves: there is nothing behind this until someone signs in.
  return new Promise(() => {});
}
