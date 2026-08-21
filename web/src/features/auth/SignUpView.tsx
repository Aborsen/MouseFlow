/* Making an account with an email and a password.
 *
 * Two fields for the password, checked against each other before anything is sent: a typo in the only copy
 * of a password somebody has just invented locks them out of an account they have not used yet, and the
 * service cannot tell them because it has nothing to compare against.
 *
 * `name` is required by the service, so it is asked for rather than invented from the address - a person
 * called "vicgorlenko-6241" in their own account is a small indignity that lasts forever.
 *
 * What happens after: a CODE, not a link, and that is a decision rather than a preference. Neon's built-in
 * sender - the one in use until a real provider is configured - does not support verification links at all
 * ("Verification links require a custom email provider"), so a page promising a link promised something
 * nobody was ever going to receive. A code also happens to be the better answer on a phone: it is typed
 * where it is read, so it cannot start in one browser and finish in another, which is the exact way the
 * Google button spent a day being unusable.
 *
 * And the code is the last step rather than a detour: verifying signs the account in - the session cookie
 * comes back through our own proxy, first-party - so "create account" ends in the app.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
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
  const [busy, setBusy] = useState<'email' | 'google' | 'resend' | 'code' | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [otp, setOtp] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const mismatch = again.length > 0 && again !== password;
  const ready = name.trim().length > 0 && email.trim().length > 0
    && passwordOk(password) && again === password;

  const submit = async () => {
    if (!ready) return;
    setBusy('email');
    setFailed(null);
    try {
      const address = email.trim();
      await authPost('sign-up/email', { name: name.trim(), email: address, password });
      /* Asked for explicitly rather than relied on. Whether creating an account sends anything by itself is
       * a project setting we do not own, and a sign-up that silently sends nothing looks exactly like one
       * that did. Worst case somebody gets two codes and the newer one works. */
      await authPost('email-otp/send-verification-otp', { email: address, type: 'email-verification' });
      setSent(address);
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
      await authPost('email-otp/send-verification-otp', { email: sent, type: 'email-verification' });
      setNote('Sent. It can take a minute.');
    } catch (err) {
      setFailed(saySo(err));
    } finally {
      setBusy(null);
    }
  };

  /* The code, and then straight in.
   *
   * Verifying may sign the account in by itself, and may not - it depends on a setting we do not own. So the
   * password just chosen is used to finish the job either way: it is still in memory on this page, it is
   * known to be correct, and one POST is cheaper than sending somebody to a sign-in form to retype what they
   * invented ninety seconds ago. */
  const confirm = async () => {
    if (!sent || otp.trim().length < 4) return;
    setBusy('code');
    setFailed(null);
    try {
      await authPost('email-otp/verify-email', { email: sent, otp: otp.trim() });
      try {
        await authPost('sign-in/email', { email: sent, password, rememberMe: true });
      } catch (_) {
        /* Verified but not signed in - a password that no longer matches, or auto sign-in switched off.
         * The account is real and confirmed, so the sign-in page is the right place, not an error. */
        location.replace('/sign-in?verified=1');
        return;
      }
      location.replace('/record');
    } catch (err) {
      setFailed(saySo(err));
      setBusy(null);
    }
  };

  if (sent) {
    return (
      <AuthCard
        title="Enter the code"
        lead={<>We sent a code to <strong className="text-ink-primary">{sent}</strong>. Type it here and you
          are in.</>}
        footer={<Link to="/sign-in" className="text-brand-primary hover:underline">Back to sign in</Link>}
      >
        {failed && <Banner kind="error">{failed}</Banner>}
        {note && <Banner kind="good">{note}</Banner>}

        <div>
          <label htmlFor="su-otp" className="mb-1 block text-ink-body text-[0.82rem]">Code from the email</label>
          <input
            id="su-otp"
            className={`${FIELD} text-center font-mono text-lg tracking-[0.4em]`}
            value={otp}
            /* One-time-code, so a phone offers the code from the notification instead of making somebody
             * memorise six digits between two apps. */
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={8}
            placeholder="000000"
            autoFocus
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') void confirm(); }}
          />
        </div>

        <Button
          fullWidth onClick={confirm} isLoading={busy === 'code'}
          disabled={otp.trim().length < 4 || busy !== null}
        >
          Confirm and sign in
        </Button>
        <Button variant="ghost" fullWidth onClick={resend} isLoading={busy === 'resend'}>
          Send another code
        </Button>
        <Typography variant="p" className="text-center text-ink-inactive text-[0.78rem] leading-relaxed">
          Codes expire after about fifteen minutes. If nothing arrives, look in the spam folder before
          asking for another.
        </Typography>
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
    </AuthCard>
  );
};
