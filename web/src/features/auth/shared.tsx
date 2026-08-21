/* The parts the three auth pages share: the card they sit in, the password rules, and the calls.
 *
 * The calls go to `/api/auth/*`, which is a dumb proxy onto Neon Auth - it forwards any path under it
 * unchanged, so none of this needed a line of server code. The one thing it does do matters: the session
 * cookie the upstream sets comes back rewritten to belong to THIS site, which is why a password sign-in is
 * finished the moment its POST returns. There is no redirect, no second browser, and none of the ways a
 * sign-in can get lost between one browser and another - the failure that made the Google button unusable
 * on a phone.
 */
import { type ReactNode, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { CircleAlert, Eye, EyeOff, Check, X } from 'lucide-react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';

/* ---------------------------------------------------------------- the calls */

/* Better Auth answers a failure with a message and a code. The code is the part worth branching on - the
 * message is prose and changes - so both are kept and the caller decides. */
export class AuthError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function authPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch('/api/auth/' + path, {
    method: 'POST',
    /* same-origin, because the whole point of the proxy is that this IS the origin: the session cookie
     * comes back host-only and is carried from here on without any cross-site exemption. */
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const said = (await res.json().catch(() => null)) as
    | { message?: string; code?: string; error?: { message?: string; code?: string } | string }
    | null;
  if (!res.ok) {
    const message = typeof said?.error === 'string'
      ? said.error
      : said?.error?.message ?? said?.message ?? `HTTP ${res.status}`;
    const code = said?.code
      ?? (said?.error && typeof said.error === 'object' ? said.error.code : undefined)
      ?? '';
    throw new AuthError(message, String(code), res.status);
  }
  return (said ?? {}) as T;
}

/* What each failure means, said as something to do about it.
 *
 * The codes are the instance's own; the prose is ours, because "INVALID_EMAIL_OR_PASSWORD" is not an
 * instruction. Anything unrecognised falls through to what the service said rather than to a shrug. */
export function saySo(err: unknown): string {
  if (!(err instanceof AuthError)) {
    return err instanceof Error ? err.message : 'The sign-in service could not be reached.';
  }
  switch (err.code) {
    case 'INVALID_EMAIL_OR_PASSWORD':
      return 'That email and password do not match an account. Check both, or reset the password below.';
    case 'USER_ALREADY_EXISTS':
    case 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL':
      return 'There is already an account with this email. Sign in instead, or reset the password.';
    case 'PASSWORD_TOO_SHORT':
      return 'That password is shorter than the service accepts. Use at least 8 characters.';
    case 'PASSWORD_TOO_LONG':
      return 'That password is longer than the service accepts.';
    case 'EMAIL_NOT_VERIFIED':
      return 'This account still needs its email confirmed. Open the link in the email we sent, then sign in.';
    case 'INVALID_TOKEN':
    case 'TOKEN_EXPIRED':
      return 'This link has already been used or has expired. Ask for a new one below.';
    case 'INVALID_EMAIL':
      return 'That does not look like an email address.';
    default:
      return err.message;
  }
}

/* ---------------------------------------------------------------- the password rules */

export interface Rule { label: string; ok: (pw: string) => boolean }

/* Checked here AND by the service, which enforces its own minimum. Client-side rules are a courtesy - they
 * tell somebody what is wrong while they type instead of after they submit - and are never the only guard. */
export const RULES: Rule[] = [
  { label: 'at least 8 characters', ok: (p) => p.length >= 8 },
  { label: 'a lower-case letter', ok: (p) => /[a-z]/.test(p) },
  { label: 'an upper-case letter', ok: (p) => /[A-Z]/.test(p) },
  { label: 'a number', ok: (p) => /\d/.test(p) },
  { label: 'a symbol', ok: (p) => /[^A-Za-z0-9]/.test(p) },
];

export const passwordOk = (pw: string) => RULES.every((r) => r.ok(pw));

export const PasswordRules = ({ value }: { value: string }) => (
  <ul className="mt-2 grid gap-1" aria-label="Password requirements">
    {RULES.map((rule) => {
      const ok = rule.ok(value);
      return (
        <li key={rule.label} className="flex items-center gap-1.5 text-[0.78rem]">
          {ok
            ? <Check aria-hidden className="size-3.5 shrink-0 text-brand-primary" />
            : <X aria-hidden className="size-3.5 shrink-0 text-ink-inactive" />}
          <span className={ok ? 'text-ink-body' : 'text-ink-inactive'}>{rule.label}</span>
          <span className="sr-only">{ok ? '— met' : '— not met'}</span>
        </li>
      );
    })}
  </ul>
);

/* ---------------------------------------------------------------- the shell around each page */

export const FIELD = 'h-10 w-full rounded-lg border border-stroke bg-surface-input px-3 text-sm '
  + 'text-ink-primary placeholder:text-ink-inactive focus:border-brand-primary focus:outline-none';

export const Banner = ({ kind, children }: { kind: 'error' | 'good'; children: ReactNode }) => (
  <div
    role="alert"
    className={cn(
      'flex items-start gap-2 rounded-lg border px-4 py-3 text-left text-sm leading-[1.4]',
      kind === 'error'
        ? 'border-toast-border-error bg-toast-bg-error text-fb-red-text'
        : 'border-brand-primary/40 bg-brand-primary/10 text-ink-body',
    )}
  >
    {kind === 'error' && <CircleAlert aria-hidden className="mt-0.5 size-[1.125rem] shrink-0" />}
    <span>{children}</span>
  </div>
);

/** A password field with a reveal, because a rule list you cannot check against is a guessing game. */
export const PasswordField = ({
  id, value, onChange, placeholder, autoComplete,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoComplete: string;
}) => {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        type={shown ? 'text' : 'password'}
        value={value}
        autoComplete={autoComplete}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(FIELD, 'pe-10')}
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? 'Hide the password' : 'Show the password'}
        className="absolute end-2 top-1/2 -translate-y-1/2 rounded p-1 text-ink-inactive hover:text-ink-body"
      >
        {shown ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
      </button>
    </div>
  );
};

/* One card, centred, on the same gradient the sign-in wall uses - these pages are the same moment in the
 * product and should not look like three different apps. */
export const AuthCard = ({ title, lead, children, footer }: {
  title: string;
  lead?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) => (
  <div className="flex min-h-screen items-center justify-center bg-surface-page px-4 py-10">
    <div className="w-full max-w-[27rem]">
      <div className="mb-5 text-center">
        <Link to="/record" className="inline-flex items-center gap-2">
          <span className="text-brand-primary">▸</span>
          <Typography variant="h1" weight="semibold" className="text-[1.35rem]">MouseFlow</Typography>
        </Link>
      </div>
      <div className="rounded-xl border border-stroke bg-surface-card p-6 shadow-lg">
        <Typography variant="h2" weight="semibold" className="text-[1.1rem]">{title}</Typography>
        {lead && (
          <Typography variant="p" className="mt-1.5 text-ink-inactive text-[0.86rem] leading-relaxed">
            {lead}
          </Typography>
        )}
        <div className="mt-5 grid gap-3">{children}</div>
      </div>
      {footer && (
        <div className="mt-4 text-center text-ink-inactive text-[0.85rem]">{footer}</div>
      )}
    </div>
  </div>
);

/** Google, on the pages that offer it, so the two ways in sit side by side rather than on two screens. */
export const GoogleButton = ({ busy, onClick }: { busy: boolean; onClick: () => void }) => (
  <>
    <div className="my-1 flex items-center gap-3">
      <span className="h-px flex-1 bg-stroke" />
      <span className="text-ink-inactive text-[0.75rem]">OR</span>
      <span className="h-px flex-1 bg-stroke" />
    </div>
    <Button variant="outline" fullWidth onClick={onClick} isLoading={busy} type="button">
      Continue with Google
    </Button>
  </>
);
