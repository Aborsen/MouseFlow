/* My account: who you are, the theme, what is paired with you, and the way out of all of it.
 *
 * The delete asks twice in the same button. A confirm() is easy to click through and a second dialog is
 * easy to lose behind the first; changing the button into the consequence is not.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/ui/components/Button';
import { Typography } from '@/ui/components/Typography';
import { cn } from '@/ui/lib/utils';
import { type Device, devices, eraseAccount, revokeDevice, signOut } from '@/lib/api';
import { useAccount } from '../AccountProvider';
import { Row, type Say } from '../SettingsDialog';
import { type Theme, useTheme } from '../theme';

const THEMES: { id: Theme; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
];

export const MyAccountScreen = ({ say }: { say: Say }) => {
  const { account } = useAccount();
  const [theme, setTheme] = useTheme();
  const [paired, setPaired] = useState<Device[] | null>(null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const body = await devices();
      setPaired(body.devices);
    } catch (err) {
      setPaired([]);
      say({ text: err instanceof Error ? err.message : 'could not list your devices', kind: 'bad' });
    }
  }, [say]);

  useEffect(() => { void load(); }, [load]);

  // Armed only briefly: a destructive button left cocked is one stray click away from being pressed.
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 6000);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <div>
      <Row label="Your email" note={account?.email ?? undefined} />

      <Row label="Theme" note="Follows your system unless you pick one." />
      <div className="grid grid-cols-3 gap-0.5 rounded-md border-stroke border bg-surface-card2 p-0.5">
        {THEMES.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTheme(id)}
            className={cn(
              'rounded-[5px] px-2 py-1.5 text-[0.86rem] text-ink-secondary hover:text-ink-primary',
              theme === id && 'bg-surface-card font-semibold text-ink-primary shadow-rest',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <Row
        label="Paired devices"
        note={
          paired && paired.length
            ? 'Extensions and agents signed in as you. Revoking one stops it syncing at once.'
            : 'Nothing paired yet. Connect an extension from Skills.'
        }
      />
      <ul className="mt-1 flex flex-col gap-1.5">
        {(paired ?? []).map((device) => (
          <li
            key={device.id}
            className="flex items-center gap-3 rounded-md border-stroke border px-2.5 py-2 text-[0.86rem]"
          >
            <div className="min-w-0 flex-1">
              <strong className="block font-semibold">{device.label}</strong>
              <span className="text-[0.76rem] text-ink-inactive">
                {device.lastUsedAt
                  ? `last used ${new Date(device.lastUsedAt).toLocaleString()}`
                  : 'never used since it was created'}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                try {
                  await revokeDevice(device.id);
                  say({ text: 'Revoked. That device will have to be paired again.', kind: 'good' });
                  void load();
                } catch (err) {
                  say({ text: err instanceof Error ? err.message : 'could not revoke it', kind: 'bad' });
                }
              }}
            >
              Revoke
            </Button>
          </li>
        ))}
      </ul>

      <Row
        danger
        label="Delete my data"
        note="Every flow and every run, from both halves, and all paired devices. Anything you published is withdrawn from the gallery. Your Google account is not ours to delete — sign out to finish."
      >
        <Button
          variant={armed ? 'destructive' : 'destructiveOutline'}
          size="sm"
          isLoading={busy}
          onClick={async () => {
            if (!armed) {
              setArmed(true);
              say({ text: 'This cannot be undone. Press again to go ahead.', kind: 'bad' });
              return;
            }
            setBusy(true);
            try {
              const body = await eraseAccount();
              const { flows, runs, devices: gone, withdrawn } = body.deleted;
              say({
                text: `${flows} flows, ${runs} runs and ${gone} devices deleted${
                  withdrawn ? `, ${withdrawn} withdrawn from the gallery` : ''
                }. Signing out…`,
                kind: 'good',
              });
              setTimeout(async () => {
                await signOut();
                location.href = location.origin + '/';
              }, 1200);
            } catch (err) {
              setBusy(false);
              setArmed(false);
              say({
                text: `Nothing was deleted: ${err instanceof Error ? err.message : 'unknown error'}`,
                kind: 'bad',
              });
            }
          }}
        >
          {armed ? 'Delete everything — press again' : 'Delete my data'}
        </Button>
      </Row>

      <Typography variant="p" className="mt-2 text-ink-inactive text-xs">
        Signed in as {account?.name ?? account?.email}. Log out is in the menu on the left.
      </Typography>
    </div>
  );
};
