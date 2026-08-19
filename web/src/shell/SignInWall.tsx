/* Nobody uses this without an account.
 *
 * Gated on landing rather than per feature: usage should be attributable, and a wall you can walk around
 * is not one. What this is NOT is access control on the data - that lives in the API, which checks a
 * session or a device token on every request. This is the front door.
 */
import { useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';

const GoogleMark = () => (
  <svg viewBox="0 0 48 48" aria-hidden className="size-[18px]">
    <path fill="#4285F4" d="M45 24c0-1.6-.1-2.7-.4-4H24v8h12c-.2 2-1.5 5-4.7 7l6.4 5C41.4 36.2 45 30.7 45 24z" />
    <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.4-5C30 37 27.3 38 24 38c-6 0-11-4-12.8-9.5l-6.7 5.2C8.1 41 15.4 46 24 46z" />
    <path fill="#FBBC05" d="M11.2 28.5C10.7 27 10.4 25.5 10.4 24s.3-3 .8-4.5l-6.7-5.2C3 17.3 2 20.5 2 24s1 6.7 2.5 9.7l6.7-5.2z" />
    <path fill="#EA4335" d="M24 10c3.4 0 6.4 1.2 8.8 3.4l5.7-5.7C34.9 4.4 29.9 2 24 2 15.4 2 8.1 7 4.5 14.3l6.7 5.2C13 14 18 10 24 10z" />
  </svg>
);

interface Props {
  problem: string | null;
  onSignIn: () => Promise<void>;
}

export const SignInWall = ({ problem, onSignIn }: Props) => {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(problem);

  return (
    <div className="grid min-h-screen place-items-center bg-surface-page p-6">
      <div className="w-full max-w-[380px] text-center">
        <svg viewBox="0 0 24 24" aria-hidden className="mx-auto size-9 text-logo-mark">
          <path d="M5 4l14 8-6 1.6L10.5 20z" fill="currentColor" />
        </svg>

        <Typography variant="h1" weight="semibold" className="mt-3 text-[1.4rem] text-ink-primary">
          MouseFlow
        </Typography>

        <Typography variant="p" className="mt-2 mb-5 text-ink-secondary">
          Record what you do and repeat it, or describe what you need and have it done — in the browser,
          or across the whole desktop.
        </Typography>

        <Button
          fullWidth
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setFailed(null);
            try {
              await onSignIn();
            } catch (err) {
              setBusy(false);
              setFailed(err instanceof Error ? err.message : 'Could not reach the sign-in service.');
            }
          }}
        >
          <GoogleMark />
          {busy ? 'Opening Google…' : 'Continue with Google'}
        </Button>

        {failed && (
          <Typography variant="p" className="mt-3.5 text-fb-red-text text-sm">
            {failed}
          </Typography>
        )}

        <Typography variant="p" className="mt-4 text-ink-inactive text-xs">
          Signing in identifies your flows and keeps a log of your runs against your account. Nothing is
          published to the gallery unless you press Publish.
        </Typography>
      </div>
    </div>
  );
};
