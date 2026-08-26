/* My account: who you are, the theme, what is paired with you, and the way out of all of it.
 *
 * The delete asks twice in the same button. A confirm() is easy to click through and a second dialog is
 * easy to lose behind the first; changing the button into the consequence is not.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { cn } from '@insightis/ui/cn';
import { ArmedButton } from '@/components/ArmedButton';
import { type Device, devices, mintDeviceToken, eraseAccount, revokeDevice, signOut } from '@/lib/api';
import { useAccount } from '../AccountProvider';
import { Row, type Say } from '../SettingsDialog';
import { type Theme, useTheme } from '../theme';

const THEMES: { id: Theme; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
];

interface Grant {
  clientId: string;
  name: string;
  since: string | null;
  lastUsed: string | null;
  tokens: number;
}

export const MyAccountScreen = ({ say }: { say: Say }) => {
  const { account } = useAccount();
  const [theme, setTheme] = useTheme();
  const [paired, setPaired] = useState<Device[] | null>(null);
  /* Things that signed in AS this person through OAuth, as opposed to devices holding a token this person
   * copied. Two lists rather than one because they are taken back differently and mean different things: a
   * device is a machine you paired, a grant is a client you let act as you. */
  const [grants, setGrants] = useState<Grant[] | null>(null);
  /* A token that has just been minted, held only long enough to be copied.
   *
   * Shown here because this is where somebody looks for it. Until now the only thing that minted one was
   * "Connect extension" on the Skills page - right for an extension and wrong for everything else that
   * pairs the same way: an MCP worker, a CLI. Being told to come here and finding only a list to revoke
   * from is the kind of instruction that reads as a lie. */
  const [minted, setMinted] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadGrants = useCallback(async () => {
    try {
      const res = await fetch('/api/oauth?do=grants', { credentials: 'same-origin' });
      const body = await res.json();
      setGrants(res.ok && body && body.grants ? body.grants : []);
    } catch (_) {
      /* An older deployment has no such route. An empty list is the honest reading of "nothing authorised
       * here", and the block hides itself rather than showing an error about a feature nobody used. */
      setGrants([]);
    }
  }, []);

  const load = useCallback(async () => {
    void loadGrants();
    try {
      const body = await devices();
      setPaired(body.devices);
    } catch (err) {
      setPaired([]);
      say({ text: err instanceof Error ? err.message : 'could not list your devices', kind: 'bad' });
    }
  }, [say, loadGrants]);

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
            ? 'Each one is signed in as you. Revoking one stops it at once.'
            : 'Nothing paired yet. A device token is how the browser extension, an MCP worker or a CLI '
              + 'signs in as you.'
        }
      >
        <Button
          variant="secondary"
          size="sm"
          isLoading={pairing}
          onClick={async () => {
            setPairing(true);
            setMinted(null);
            try {
              const body = await mintDeviceToken('Device');
              setMinted(body.token);
              /* Copied for them, because it is shown once and a token somebody has to retype is a token
               * somebody mistypes. The clipboard can be refused, and then the field below is the answer. */
              try {
                await navigator.clipboard.writeText(body.token);
                say({ text: 'Copied. It is shown once — only its hash is stored.', kind: 'good' });
              } catch (_) {
                say({ text: 'Shown once — only its hash is stored, so copy it now.', kind: 'good' });
              }
              void load();
            } catch (err) {
              say({ text: err instanceof Error ? err.message : 'a token could not be made', kind: 'bad' });
            } finally {
              setPairing(false);
            }
          }}
        >
          Pair a device
        </Button>
      </Row>

      {minted && (
        <div className="grid gap-1.5 rounded-lg border border-brand-primary/40 bg-brand-primary/10 p-3">
          <span className="text-[0.8rem] text-ink-body">
            Shown once. Only a hash of it is stored, so if this is lost, pair again.
          </span>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={minted}
              onFocus={(e) => e.currentTarget.select()}
              className="h-9 min-w-0 flex-1 rounded-md border border-stroke bg-surface-card2 px-2.5 font-mono text-[0.78rem] text-ink-primary"
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(minted);
                  say({ text: 'Copied.', kind: 'good' });
                } catch (_) {
                  say({ text: 'The clipboard was blocked — select it and copy.', kind: 'bad' });
                }
              }}
            >
              Copy
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setMinted(null)}>Done</Button>
          </div>
        </div>
      )}
      {/* The one genuinely unbounded thing on this screen, so it is the one thing that scrolls - rather
          than the screen growing past the size every settings screen shares. Two rows are visible and a
          third is half-visible, which is what tells you there is more. */}
      <ul className="mt-1 flex max-h-[6.5rem] flex-col gap-1.5 overflow-y-auto">
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

      {grants && grants.length > 0 && (
        <>
          <Row
            label="Signed in with your account"
            note="Clients you allowed to act as you. Taking one back cuts it off at once — it will have to
                  ask again."
          />
          <ul className="mt-1 flex max-h-[6.5rem] flex-col gap-1.5 overflow-y-auto">
            {grants.map((grant) => (
              <li
                key={grant.clientId}
                className="flex items-center gap-3 rounded-md border-stroke border px-2.5 py-2 text-[0.86rem]"
              >
                <div className="min-w-0 flex-1">
                  <strong className="block font-semibold">{grant.name}</strong>
                  <span className="text-[0.76rem] text-ink-inactive">
                    {grant.lastUsed
                      ? `last used ${new Date(grant.lastUsed).toLocaleString()}`
                      : 'never used since you allowed it'}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    try {
                      const res = await fetch(
                        `/api/oauth?do=grants&client=${encodeURIComponent(grant.clientId)}`,
                        { method: 'DELETE', credentials: 'same-origin' },
                      );
                      if (!res.ok) throw new Error('it could not be taken back');
                      say({ text: `${grant.name} can no longer act as you.`, kind: 'good' });
                      void loadGrants();
                    } catch (err) {
                      say({ text: err instanceof Error ? err.message : 'could not revoke it', kind: 'bad' });
                    }
                  }}
                >
                  Take it back
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}

      <Row
        danger
        label="Delete my data"
        note="Every flow, every run and every paired device. Anything you published is withdrawn. Your Google account is not ours to delete."
      >
        <ArmedButton
          label="Delete my data"
          armedLabel="Delete everything — press again"
          restingVariant="destructiveOutline"
          armed={armed}
          /* The warning belongs to the FIRST press here: everything on the account goes, and there is no
           * row left afterwards to explain it. */
          onArm={() => {
            setArmed(true);
            say({ text: 'This cannot be undone. Press again to go ahead.', kind: 'bad' });
          }}
          onDisarm={() => setArmed(false)}
          busy={busy}
          onConfirm={async () => {
            setBusy(true);
            try {
              const body = await eraseAccount();
              /* НАЗВАНО ТО, ЧТО И ПРАВДА УДАЛЕНО. Маршрут трогал четыре таблицы из четырнадцати, что
               * держат содержимое человека, и отвечал «удалено всё»; экран пересказывал эти четыре. Теперь
               * удаляются все, и сообщение перечисляет то, что было ненулевым: список из тринадцати нулей
               * не читают, а «0 conversations» рядом с настоящими цифрами читается как ошибка. */
              const d = body.deleted;
              const counted: string[] = [];
              const add = (n: number | undefined, one: string, many: string) => {
                if (n) counted.push(`${n} ${n === 1 ? one : many}`);
              };
              add(d.flows, 'flow', 'flows');
              add(d.runs, 'run', 'runs');
              add(d.conversations, 'conversation', 'conversations');
              add(d.devices, 'paired device', 'paired devices');
              add(d.connectors, 'connector token', 'connector tokens');
              add(d.queuedRuns, 'queued run', 'queued runs');
              add(d.teamMemberships, 'team membership', 'team memberships');
              add(d.teamsClosed, 'team you alone owned, closed', 'teams you alone owned, closed');
              add(d.withdrawn, 'skill withdrawn from the gallery', 'skills withdrawn from the gallery');
              say({
                text: `${counted.length ? `Deleted: ${counted.join(', ')}.` : 'There was nothing left to delete.'} Signing out…`,
                kind: 'good',
              });
              setTimeout(async () => {
                /* The data is already gone, so the page has to leave whatever the sign-out says. Caught
                 * rather than ignored: signOut() throws now, and an unhandled rejection in here would skip
                 * the redirect and leave somebody looking at an emptied account. */
                try {
                  await signOut();
                } catch (err) {
                  say({
                    text: `Your data was deleted, but signing out failed: ${
                      err instanceof Error ? err.message : 'unknown error'
                    }. Leaving anyway.`,
                    kind: 'bad',
                  });
                }
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
        />
      </Row>

    </div>
  );
};
