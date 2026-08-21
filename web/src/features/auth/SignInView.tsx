/* Signing in with an email and a password.
 *
 * The whole flow is one POST that comes back with the session cookie already belonging to this site, so
 * there is nothing to redirect to and nothing to come back from. That is worth stating because the other
 * way in - Google - spent a day being unusable on a phone for precisely the reason this cannot be: a
 * sign-in that leaves the browser has to find its way back, and on iOS it did not.
 *
 * Also the landing place for a confirmed email (?verified=1) and for a finished password reset (?reset=1) -
 * both end here, because both end with somebody who now has a password and has not used it yet.
 */
import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { signInWithGoogle } from '@/lib/api';
import {
  AuthCard, Banner, FIELD, GoogleButton, PasswordField, authPost, saySo,
} from './shared';

export const SignInView = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'email' | 'google' | 'resend' | 'code' | null>(null);
  const [otp, setOtp] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const [code, setCode] = useState<string>('');
  const [note, setNote] = useState<string | null>(null);

  /* Read once, then cleared out of the address bar: a refresh should not keep congratulating somebody on
   * confirming an email they confirmed ten minutes ago. */
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get('verified')) setNote('Email confirmed. Sign in and you are in.');
    else if (q.get('reset')) setNote('Password changed. Sign in with the new one.');
    else if (q.get('error')) setFailed('That confirmation link did not work — it may already have been used.');
    if (q.get('verified') || q.get('reset') || q.get('error')) {
      const rest = new URLSearchParams(location.search);
      ['verified', 'reset', 'error'].forEach((k) => rest.delete(k));
      const query = rest.toString();
      history.replaceState(null, '', location.pathname + (query ? `?${query}` : ''));
    }
  }, []);

  const submit = async () => {
    const address = email.trim();
    if (!address || !password) return;
    setBusy('email');
    setFailed(null);
    setCode('');
    try {
      await authPost('sign-in/email', { email: address, password, rememberMe: true });
      /* A full load rather than a router navigation: the account provider reads the session once, on mount,
       * and this is the moment it changed. Reloading is the honest way to get every part of the app to
       * agree, and it happens exactly once per sign-in.
       *
       * REPLACE, not assign. Pushing left this page in history, so Back landed on a sign-in form belonging
       * to somebody already signed in - which reads as having been logged out, and was the whole of "press
       * Back and you have to type your password again". A form nobody needs any more does not deserve a
       * history entry. */
      location.replace('/record');
    } catch (err) {
      setFailed(saySo(err));
      setCode(err instanceof Error && 'code' in err ? String((err as { code?: string }).code ?? '') : '');
      setBusy(null);
    }
  };

  /* The one failure with a next step of its own: the account exists, the password is right, and the email
   * was never confirmed. Offering to send it again here saves a trip back to sign-up. */
  const unverified = code === 'EMAIL_NOT_VERIFIED';

  return (
    <AuthCard
      title="Sign in"
      lead="Record what you do and repeat it, or describe what you need and have it done — in the browser, or across the whole desktop."
      footer={<>New here?{' '}
        <Link to="/sign-up" className="text-brand-primary hover:underline">Create an account</Link></>}
    >
      {note && <Banner kind="good">{note}</Banner>}
      {failed && <Banner kind="error">{failed}</Banner>}

      {/* The account exists, the password is right, and the email was never confirmed. Finished here rather
        * than sent back to sign-up: everything needed is already on this page. A code rather than a link
        * for the same reason as sign-up - the built-in sender does not do links. */}
      {unverified && (
        <div className="grid gap-2 rounded-lg border border-stroke p-3">
          <Typography variant="p" className="text-ink-body text-[0.82rem]">
            This account still needs its email confirmed.
          </Typography>
          <Button
            variant="secondary" fullWidth isLoading={busy === 'resend'}
            onClick={async () => {
              setBusy('resend');
              try {
                await authPost('email-otp/send-verification-otp', {
                  email: email.trim(), type: 'email-verification',
                });
                setNote('Code sent. Type it below.');
                setFailed(null);
              } catch (err) {
                setFailed(saySo(err));
              } finally {
                setBusy(null);
              }
            }}
          >
            Send me a code
          </Button>
          <input
            className={`${FIELD} text-center font-mono tracking-[0.35em]`}
            value={otp}
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={8}
            placeholder="000000"
            aria-label="Code from the email"
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
          />
          <Button
            fullWidth isLoading={busy === 'code'} disabled={otp.trim().length < 4 || busy !== null}
            onClick={async () => {
              setBusy('code');
              setFailed(null);
              try {
                await authPost('email-otp/verify-email', { email: email.trim(), otp: otp.trim() });
                await authPost('sign-in/email', { email: email.trim(), password, rememberMe: true });
                location.replace('/record');
              } catch (err) {
                setFailed(saySo(err));
                setBusy(null);
              }
            }}
          >
            Confirm and sign in
          </Button>
        </div>
      )}

      <div>
        <label htmlFor="si-email" className="mb-1 block text-ink-body text-[0.82rem]">Email</label>
        <input
          id="si-email" className={FIELD} value={email} type="email" autoComplete="email"
          placeholder="you@company.com" onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
        />
      </div>

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <label htmlFor="si-pw" className="block text-ink-body text-[0.82rem]">Password</label>
          <Link to="/reset-password" className="text-brand-primary text-[0.78rem] hover:underline">
            Forgot it?
          </Link>
        </div>
        <PasswordField
          id="si-pw" value={password} onChange={setPassword}
          placeholder="Your password" autoComplete="current-password"
        />
      </div>

      <Button
        fullWidth
        onClick={submit}
        isLoading={busy === 'email'}
        disabled={!email.trim() || !password || busy !== null}
      >
        Sign in
      </Button>

      <GoogleButton
        busy={busy === 'google'}
        onClick={async () => {
          setBusy('google');
          setFailed(null);
          try {
            location.href = await signInWithGoogle('/record');
          } catch (err) {
            setFailed(saySo(err));
            setBusy(null);
          }
        }}
      />

      <Typography variant="p" className="mt-1 text-center text-ink-inactive text-[0.78rem] leading-relaxed">
        Signing in identifies your flows and keeps a log of your runs against your account. Nothing is
        published to the gallery unless you press Publish.
      </Typography>
    </AuthCard>
  );
};
