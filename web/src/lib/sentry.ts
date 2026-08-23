/* Error reporting, on a product whose whole promise is that it does not watch you.
 *
 * That tension is the only interesting thing about this file, so it goes first. MouseFlow tells people, on
 * the record page and in the documentation and in every team invitation, that it writes down THAT a key was
 * pressed and never WHICH key. A crash reporter that shipped the contents of a form to a third party would
 * make that sentence false — not in the recorder, but in the same product, which is the same thing to the
 * person reading it. So the defaults here are the strict ones, and each is deliberate rather than inherited:
 *
 *   sendDefaultPii: false     no IP address, no cookies, no request headers attached to an event. Sentry's
 *                             own default is false; it is written out anyway, because a later reader
 *                             turning it on should have to delete a line that says why it is off.
 *   no Session Replay         the integration that records the DOM as a video. It is the single feature
 *                             most at odds with the promise above, and it is not installed — not disabled
 *                             by a sample rate somebody can raise, not imported at all.
 *   beforeSend scrubs         the two places a value can ride along accidentally: the URL's query string,
 *                             and the breadcrumb trail. Both are rewritten below.
 *
 * WHY THE DSN IS AN ENVIRONMENT VARIABLE rather than a constant. A DSN is not a secret — it ships inside
 * the bundle by design, and anybody can read it out of the page. It is a variable for two duller reasons:
 * it keeps the identity of one Sentry project out of the source, and it makes reporting OFF by default
 * everywhere it is not set. A developer running `npm run dev` should not be filling a production issue
 * feed with their own typos, and `MOCK_API=1` should certainly not report anything at all.
 *
 * So: no DSN, no Sentry. Nothing here throws, nothing warns, and the app behaves exactly as it did before
 * this file existed.
 */
import * as Sentry from '@sentry/react';

/** Vite inlines anything prefixed VITE_ at build time; unset is `undefined`, which reads as off. */
const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;

/* How much tracing to keep. Traces are the expensive half of Sentry and this is an early-access product
 * with modest traffic, so the default is generous enough to be useful and small enough not to surprise
 * anybody with a bill. Overridable without a code change. */
const TRACES = Number(import.meta.env.VITE_SENTRY_TRACES ?? '0.2');

/* Which deployment an event came from. The hostname decides rather than a build flag, because this app is
 * served from more than one and they are all built the same way. */
function environmentOf(host: string): string {
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(host)) return 'development';
  if (host === 'mouseflowapp.vercel.app' || host === 'mouse-agent.vercel.app') return 'production';
  return 'preview';
}

/* Anything that could be a value somebody typed, taken out of a URL before it leaves the browser.
 *
 * Not a blocklist of known-sensitive names: the parameters this app puts in an address are few and all of
 * them are ids, so the rule is the other way round — an ALLOWLIST of the ones known to be harmless, and
 * everything else is replaced. A parameter added next year is redacted by default rather than reported by
 * default, which is the direction this product errs in everywhere else. */
const KEEP = new Set(['team', 'person', 'days', 'next', 'make', 'auth', 'why', 'from', 'to']);

function scrubUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const [key] of [...url.searchParams]) {
      if (!KEEP.has(key)) url.searchParams.set(key, '[redacted]');
    }
    /* An address is the one thing here that can carry an email — the sign-up link an invitation sends
     * carries the address it was sent to. It is the recipient's own and it is in the To: header of a
     * message they already have, but it has no business in an issue tracker. */
    if (url.searchParams.has('email')) url.searchParams.set('email', '[redacted]');
    return url.toString();
  } catch (_) {
    return raw;
  }
}

export function startReporting(): void {
  if (!DSN) return;

  Sentry.init({
    dsn: DSN,
    environment: environmentOf(location.hostname),
    /* No IP, no cookies, no headers. See the header of this file. */
    sendDefaultPii: false,
    integrations: [
      Sentry.browserTracingIntegration(),
      /* Deliberately absent: replayIntegration(). It records the DOM as a video, which is the one thing
       * this product promises not to do. */
    ],
    tracesSampleRate: Number.isFinite(TRACES) ? TRACES : 0.2,
    /* Only our own deployments get a trace header. The default would attach one to every outbound request,
     * including the local agent on loopback, which has no idea what to do with it. */
    tracePropagationTargets: [/^\//, /^https:\/\/mouseflowapp\.vercel\.app/, /^https:\/\/mouse-agent\.vercel\.app/],
    enableLogs: true,

    beforeSend(event) {
      if (event.request?.url) event.request.url = scrubUrl(event.request.url);
      /* The breadcrumb trail is where a URL turns up a second time — every navigation and every fetch
       * leaves one, and scrubbing only `request.url` would send the same query string anyway. */
      if (event.breadcrumbs) {
        event.breadcrumbs = event.breadcrumbs.map((crumb) => {
          const next = { ...crumb };
          if (typeof next.data?.url === 'string') {
            next.data = { ...next.data, url: scrubUrl(next.data.url) };
          }
          if (typeof next.message === 'string' && next.message.includes('?')) {
            next.message = next.message.replace(/https?:\/\/\S+/g, (m) => scrubUrl(m));
          }
          return next;
        });
      }
      return event;
    },
  });
}

/** Re-exported so the entry file imports one thing and callers do not each reach for the SDK. */
export const ErrorBoundary = Sentry.ErrorBoundary;
