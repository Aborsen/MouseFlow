/* The front door, on insightis's auth page.
 *
 * Gated on landing rather than per feature: usage should be attributable, and a wall you can walk around is
 * not one. What this is NOT is access control on the data - that lives in the API, which checks a session or
 * a device token on every request.
 *
 * The layout is theirs, from insightis/apps/web/src/features/auth: forced dark whatever the viewer's theme
 * is, one centred card at 27rem on a gradient, the logo above it, an email field, an OR rule, and the Google
 * button below. Two of their pieces could not be vendored as code - AuthPageLayout leans on an app-level
 * `bg-auth-registration-gradient` token that is not in the design-system package, and GoogleAuthButton
 * imports an SVG through a Vite plugin we do not run - so the gradient is written out here from the tokens
 * that ARE vendored, and the mark is inline.
 *
 * About the email field: it is real, and it is honest about not always being available. This deployment's
 * accounts come from Neon Auth, where email sign-in is a project setting - Google is enabled, email may not
 * be. So submitting an address attempts a real sign-in link and, if the auth project has not got that
 * method turned on, says exactly that instead of pretending to send something. A field that silently does
 * nothing would be worse than no field.
 */
import { useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Separator } from '@insightis/ui/Separator';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { CircleAlert, Mail } from 'lucide-react';

const GoogleMark = () => (
  <svg viewBox="0 0 48 48" aria-hidden className="size-5">
    <path fill="#4285F4" d="M45 24c0-1.6-.1-2.7-.4-4H24v8h12c-.2 2-1.5 5-4.7 7l6.4 5C41.4 36.2 45 30.7 45 24z" />
    <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.4-5C30 37 27.3 38 24 38c-6 0-11-4-12.8-9.5l-6.7 5.2C8.1 41 15.4 46 24 46z" />
    <path fill="#FBBC05" d="M11.2 28.5C10.7 27 10.4 25.5 10.4 24s.3-3 .8-4.5l-6.7-5.2C3 17.3 2 20.5 2 24s1 6.7 2.5 9.7l6.7-5.2z" />
    <path fill="#EA4335" d="M24 10c3.4 0 6.4 1.2 8.8 3.4l5.7-5.7C34.9 4.4 29.9 2 24 2 15.4 2 8.1 7 4.5 14.3l6.7 5.2C13 14 18 10 24 10z" />
  </svg>
);

/* Their AuthErrorBanner, in their colours. An error on a sign-in page is the only thing on screen worth
 * reading, so it gets a shape rather than a line of red text. */
const Problem = ({ children }: { children: React.ReactNode }) => (
  <div
    role="alert"
    className={cn(
      'flex items-start gap-2 rounded-lg border px-4 py-3',
      'border-toast-border-error bg-toast-bg-error',
      'text-left text-fb-red-text text-sm leading-[1.4]',
    )}
  >
    <CircleAlert aria-hidden className="mt-0.5 size-[1.125rem] shrink-0" />
    <span>{children}</span>
  </div>
);

/* A sign-in failure the user can do something about, said in those terms.
 *
 * INVALID_CALLBACKURL is the one worth naming: it means the auth project does not trust the host the app is
 * being served from, which happens the moment a deployment gains a second domain - and the raw code tells
 * somebody nothing about where to go and fix it. */
function explain(message: string, host: string, code?: string | null): string {
  if (/INVALID_CALLBACKURL/i.test(code ?? '') || /INVALID_CALLBACKURL|Invalid callbackURL/i.test(message)) {
    return `The sign-in service does not trust ${host} yet, so it refused to send you to Google. Add ` +
      `https://${host} to the allowed domains and callback URLs on the Neon Auth project - and to the ` +
      `authorised redirect URIs of the Google client it uses - then try again.`;
  }
  if (/not enabled|unsupported|not found|404/i.test(message)) {
    return 'This deployment signs in with Google only: email sign-in is not switched on for its Neon Auth ' +
      'project. Use Continue with Google, or enable the email method there.';
  }
  return message;
}

interface Props {
  problem: string | null;
  onSignIn: () => Promise<void>;
}

export const SignInWall = ({ problem, onSignIn }: Props) => {
  const [busy, setBusy] = useState<'google' | 'email' | null>(null);
  const [failed, setFailed] = useState<string | null>(problem);
  const [sent, setSent] = useState<string | null>(null);
  const [email, setEmail] = useState('');

  const host = typeof location === 'undefined' ? 'this deployment' : location.host;

  const google = async () => {
    setBusy('google');
    setFailed(null);
    setSent(null);
    try {
      await onSignIn();
    } catch (err) {
      setBusy(null);
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: string }).code ?? '') : null;
      setFailed(explain(err instanceof Error ? err.message : 'Could not reach the sign-in service.', host, code));
    }
  };

  /* A sign-in link rather than a password: there is no password on these accounts to check, and inventing a
   * password field for an account created through Google is how somebody gets locked out of their own data. */
  const withEmail = async () => {
    const address = email.trim();
    if (!address) return;
    setBusy('email');
    setFailed(null);
    setSent(null);
    try {
      const res = await fetch('/api/auth/sign-in/magic-link', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: address,
          callbackURL: `${location.origin}/api/auth/finish?to=${encodeURIComponent(location.pathname)}`,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { error?: { message?: string; code?: string } | string; code?: string; message?: string }
        | null;
      if (!res.ok) {
        /* Same two shapes as lib/api.ts reads, and for the same reason: the auth service sends `error` as a
         * string with the code beside it, and reading only our own shape is what turned a precise refusal
         * into "HTTP 403" on this very screen. */
        const said = typeof body?.error === 'string'
          ? body.error
          : body?.error?.message ?? body?.message ?? `HTTP ${res.status}`;
        const failure = new Error(said) as Error & { code?: string };
        failure.code = body?.code
          ?? (body?.error && typeof body.error === 'object' ? body.error.code : undefined);
        throw failure;
      }
      setSent(address);
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: string }).code ?? '') : null;
      setFailed(explain(err instanceof Error ? err.message : 'the sign-in link could not be sent', host, code));
    } finally {
      setBusy(null);
    }
  };

  return (
    /* Forced dark, as theirs is: an auth page is one screen with one job, and it should look the same to
     * everybody. The gradient is theirs in spirit - two brand stops over the page ground - written from
     * vendored tokens because the token their layout names lives in their app rather than the package. */
    <div
      className={cn(
        'dark relative flex min-h-dvh w-full flex-col items-center justify-center',
        'bg-surface-page px-6 pt-10 pb-16',
        'bg-[radial-gradient(60rem_40rem_at_50%_-10rem,hsl(var(--brand-primary)/0.16),transparent_70%)]',
      )}
    >
      <div
        className={cn(
          'flex w-full max-w-[27rem] flex-col gap-4',
          'rounded-xl border border-stroke bg-surface-card p-6 max-[37.5rem]:p-5',
          'shadow-overlay-soft',
        )}
      >
        <div className="flex flex-col items-center gap-1 text-center">
          <svg viewBox="0 0 24 24" aria-hidden className="size-8 text-logo-mark">
            <path d="M5 4l14 8-6 1.6L10.5 20z" fill="currentColor" />
          </svg>
          <Typography variant="h1" weight="semibold" className="text-[1.35rem] text-ink-primary">
            MouseFlow
          </Typography>
          <Typography variant="p" className="max-w-[34ch] text-ink-secondary text-[0.88rem]">
            Record what you do and repeat it, or describe what you need and have it done — in the browser, or
            across the whole desktop.
          </Typography>
        </div>

        {failed && <Problem>{failed}</Problem>}

        {sent ? (
          /* Their AuthEmailSentPanel, reduced to what is true here: the link was accepted for sending. It
           * does not claim the mail has arrived, because this page cannot know that. */
          <div className="flex flex-col gap-2 rounded-lg border-stroke border bg-surface-card2 px-4 py-3.5 text-center">
            <Typography variant="span" weight="semibold" className="text-[0.92rem]">
              Check {sent}
            </Typography>
            <Typography variant="p" className="text-ink-secondary text-[0.84rem]">
              A sign-in link is on its way. Opening it in this browser finishes the sign-in here.
            </Typography>
            <Button variant="ghost" size="sm" onClick={() => setSent(null)}>
              Use a different address
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-2.5"
            onSubmit={(ev) => { ev.preventDefault(); void withEmail(); }}
          >
            <label className="relative">
              <Mail aria-hidden className="absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-inactive" />
              <input
                type="email"
                value={email}
                autoComplete="email"
                onChange={(ev) => setEmail(ev.target.value)}
                placeholder="you@company.com"
                aria-label="Email"
                className={cn(
                  'h-11 w-full rounded-md border-stroke border bg-surface-card2 pr-3.5 pl-10',
                  'text-ink-primary placeholder:text-ink-inactive',
                  'focus:border-input-focus focus:outline-none',
                  '[&:hover:not(:focus)]:border-stroke-field-hover',
                )}
              />
            </label>

            <Button
              type="submit"
              size="lg"
              fullWidth
              disabled={!email.trim() || busy !== null}
              isLoading={busy === 'email'}
            >
              Continue with email
            </Button>
          </form>
        )}

        <div className="flex items-center gap-3">
          <Separator className="flex-1" />
          <Typography variant="p" className="text-ink-secondary text-xs uppercase tracking-[0.04em]">
            or
          </Typography>
          <Separator className="flex-1" />
        </div>

        <Button
          type="button"
          variant="secondary"
          size="lg"
          fullWidth
          disabled={busy !== null}
          isLoading={busy === 'google'}
          onClick={google}
          leftSlot={<GoogleMark />}
          className="gap-2 [&>span]:flex-none"
        >
          Continue with Google
        </Button>

        <Typography variant="p" className="text-center text-ink-inactive text-xs">
          Signing in identifies your flows and keeps a log of your runs against your account. Nothing is
          published to the gallery unless you press Publish.
        </Typography>
      </div>
    </div>
  );
};
