/* Making an account with an email and a password.
 *
 * Two fields for the password, checked against each other before anything is sent: a typo in the only copy
 * of a password somebody has just invented locks them out of an account they have not used yet, and the
 * service cannot tell them because it has nothing to compare against.
 *
 * `name` is required by the service, so it is asked for rather than invented from the address - a person
 * called "vicgorlenko-6241" in their own account is a small indignity that lasts forever.
 *
 * What happens after: the service sends a confirmation email, and the account is not usable until the link
 * in it is opened. So this ends on a panel that says so and offers to send it again, rather than dropping
 * somebody into an app that will refuse them.
 */
import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { signInWithGoogle } from '@/lib/api';
import {
  AuthCard, Banner, FIELD, GoogleButton, PasswordField, PasswordRules,
  authPost, passwordOk, saySo,
} from './shared';

export const SignUpView = () => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState<'email' | 'google' | 'resend' | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const navigate = useNavigate();

  const mismatch = again.length > 0 && again !== password;
  const ready = name.trim().length > 0 && email.trim().length > 0
    && passwordOk(password) && again === password;

  /* Where the confirmation link lands. Our own sign-in page rather than the app: the service verifies on ITS
   * host, so any session it establishes there is invisible here - landing on the app would show the wall and
   * read as the confirmation not having worked. Signing in once with the password just chosen is honest and
   * takes one step. */
  const confirmLanding = `${location.origin}/sign-in?verified=1`;

  const submit = async () => {
    if (!ready) return;
    setBusy('email');
    setFailed(null);
    try {
      await authPost('sign-up/email', {
        name: name.trim(),
        email: email.trim(),
        password,
        callbackURL: confirmLanding,
      });
      setSent(email.trim());
    } catch (err) {
      setFailed(saySo(err));
    } finally {
      setBusy(null);
    }
  };

  const resend = async () => {
    if (!sent) return;
    setBusy('resend');
    setFailed(null);
    try {
      await authPost('send-verification-email', { email: sent, callbackURL: confirmLanding });
    } catch (err) {
      setFailed(saySo(err));
    } finally {
      setBusy(null);
    }
  };

  if (sent) {
    return (
      <AuthCard
        title="Confirm your email"
        lead={<>We sent a link to <strong className="text-ink-primary">{sent}</strong>. Open it, and the
          account is ready to use.</>}
        footer={<Link to="/sign-in" className="text-brand-primary hover:underline">Back to sign in</Link>}
      >
        {failed && <Banner kind="error">{failed}</Banner>}
        <Banner kind="good">
          Open the link in this same browser if you can — it finishes here. If the email has not arrived in a
          minute, check the spam folder before sending another.
        </Banner>
        <Button variant="secondary" fullWidth onClick={resend} isLoading={busy === 'resend'}>
          Send it again
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create your account"
      lead="Record what you do and repeat it, or describe what you need and have it done."
      footer={<>Already have an account?{' '}
        <Link to="/sign-in" className="text-brand-primary hover:underline">Sign in</Link></>}
    >
      {failed && <Banner kind="error">{failed}</Banner>}

      <div>
        <label htmlFor="su-name" className="mb-1 block text-ink-body text-[0.82rem]">Name</label>
        <input
          id="su-name" className={FIELD} value={name} autoComplete="name" placeholder="Vic Gorlenko"
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div>
        <label htmlFor="su-email" className="mb-1 block text-ink-body text-[0.82rem]">Email</label>
        <input
          id="su-email" className={FIELD} value={email} type="email" autoComplete="email"
          placeholder="you@company.com" onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div>
        <label htmlFor="su-pw" className="mb-1 block text-ink-body text-[0.82rem]">Password</label>
        <PasswordField
          id="su-pw" value={password} onChange={setPassword}
          placeholder="Choose a password" autoComplete="new-password"
        />
        <PasswordRules value={password} />
      </div>

      <div>
        <label htmlFor="su-again" className="mb-1 block text-ink-body text-[0.82rem]">Password again</label>
        <PasswordField
          id="su-again" value={again} onChange={setAgain}
          placeholder="The same password" autoComplete="new-password"
        />
        {mismatch && (
          <Typography variant="p" className="mt-1.5 text-fb-red-text text-[0.78rem]">
            The two passwords are not the same.
          </Typography>
        )}
      </div>

      <Button fullWidth onClick={submit} isLoading={busy === 'email'} disabled={!ready || busy !== null}>
        Create account
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
      <button type="button" className="sr-only" onClick={() => void navigate({ to: '/sign-in' })}>
        Go to sign in
      </button>
    </AuthCard>
  );
};
