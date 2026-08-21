/* Forgetting a password, and setting a new one. One page, two halves, decided by the URL.
 *
 * Without a token it asks for the address and sends the email. With `?token=` - which is where the link in
 * that email lands - it asks for the new password. One page rather than two because they are one errand,
 * and because the second half is unreachable except by the first.
 *
 * The request half ALWAYS says the same thing, whether or not the address has an account, and that is the
 * service's own behaviour rather than ours to soften: a reset form that says "no such user" is a form that
 * tells a stranger which of your colleagues have accounts.
 */
import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import {
  AuthCard, Banner, FIELD, PasswordField, PasswordRules, authPost, passwordOk, saySo,
} from './shared';

export const ResetPasswordView = () => {
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  /* The token arrives in the query. Read into state rather than read on every render, so clearing it from
   * the address bar - which is worth doing, a reset token should not sit in history - does not take the
   * form with it. */
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const t = q.get('token');
    const err = q.get('error');
    if (err) setFailed('That reset link did not work — it may already have been used, or expired.');
    if (t) {
      setToken(t);
      const rest = new URLSearchParams(location.search);
      rest.delete('token');
      const query = rest.toString();
      history.replaceState(null, '', location.pathname + (query ? `?${query}` : ''));
    }
  }, []);

  const ask = async () => {
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    setFailed(null);
    try {
      await authPost('request-password-reset', {
        email: address,
        redirectTo: `${location.origin}/reset-password`,
      });
      setSent(true);
    } catch (err) {
      setFailed(saySo(err));
    } finally {
      setBusy(false);
    }
  };

  const setNew = async () => {
    if (!token || !passwordOk(password) || password !== again) return;
    setBusy(true);
    setFailed(null);
    try {
      await authPost('reset-password', { newPassword: password, token });
      /* Straight to sign-in: the reset does not sign anybody in, and a page saying "done" with no way
       * forward is a dead end. */
      location.href = '/sign-in?reset=1';
    } catch (err) {
      setFailed(saySo(err));
      setBusy(false);
    }
  };

  /* ---- second half: a token is in hand ---- */
  if (token) {
    const mismatch = again.length > 0 && again !== password;
    return (
      <AuthCard
        title="Choose a new password"
        lead="This link works once. Pick something you have not used here before."
        footer={<Link to="/sign-in" className="text-brand-primary hover:underline">Back to sign in</Link>}
      >
        {failed && <Banner kind="error">{failed}</Banner>}
        <div>
          <label htmlFor="rp-pw" className="mb-1 block text-ink-body text-[0.82rem]">New password</label>
          <PasswordField
            id="rp-pw" value={password} onChange={setPassword}
            placeholder="Choose a password" autoComplete="new-password"
          />
          <PasswordRules value={password} />
        </div>
        <div>
          <label htmlFor="rp-again" className="mb-1 block text-ink-body text-[0.82rem]">Password again</label>
          <PasswordField
            id="rp-again" value={again} onChange={setAgain}
            placeholder="The same password" autoComplete="new-password"
          />
          {mismatch && (
            <Typography variant="p" className="mt-1.5 text-fb-red-text text-[0.78rem]">
              The two passwords are not the same.
            </Typography>
          )}
        </div>
        <Button
          fullWidth
          onClick={setNew}
          isLoading={busy}
          disabled={!passwordOk(password) || password !== again || busy}
        >
          Set the new password
        </Button>
      </AuthCard>
    );
  }

  /* ---- first half: ask for the email ---- */
  return (
    <AuthCard
      title="Reset your password"
      lead="Tell us the address on the account and we will send a link that sets a new password."
      footer={<Link to="/sign-in" className="text-brand-primary hover:underline">Back to sign in</Link>}
    >
      {failed && <Banner kind="error">{failed}</Banner>}
      {sent ? (
        <Banner kind="good">
          If there is an account for <strong className="text-ink-primary">{email.trim()}</strong>, a reset
          link is on its way. It works once, and it expires — ask for another if it goes stale.
        </Banner>
      ) : (
        <>
          <div>
            <label htmlFor="rp-email" className="mb-1 block text-ink-body text-[0.82rem]">Email</label>
            <input
              id="rp-email" className={FIELD} value={email} type="email" autoComplete="email"
              placeholder="you@company.com" onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void ask(); }}
            />
          </div>
          <Button fullWidth onClick={ask} isLoading={busy} disabled={!email.trim() || busy}>
            Send the reset link
          </Button>
        </>
      )}
    </AuthCard>
  );
};
