/* Who this browser is signed in as, at the foot of the rail — where the app puts it.
 *
 * The app's sidebar ends with the person and the hours their runs took, and somebody moving between the two
 * should find the same thing in the same corner. What is different is the ONE act offered here: detaching
 * this browser. Everything else about an account - the email, the devices, deleting it - is in the app,
 * because those are decisions with consequences and a 60px rail is not where they belong.
 */
import { useCallback, useEffect, useState } from 'react';
import { LogOut } from 'lucide-react';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { api, ask, openApp } from './worker';

interface Who { name?: string; email?: string; image?: string }

export const Account = ({ onDetached }: { onDetached: () => void }) => {
  const [who, setWho] = useState<Who | null>(null);
  const [hours, setHours] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const read = useCallback(async () => {
    const status = await ask('sync/status');
    if (status.ok) setWho((status.who as Who) ?? null);
    /* The same number the app's sidebar shows, from the same place: measured agent time over the window,
     * not an estimate of time saved. */
    try {
      const body = await api<{ totals?: { agentHours?: number } }>('/api/insights?days=7');
      setHours(body.totals?.agentHours ?? null);
    } catch (_) {
      /* The hours are a nicety beside the person's name; a panel that could not read them should still
       * show who is signed in. */
      setHours(null);
    }
  }, []);

  useEffect(() => { void read(); }, [read]);

  const initial = (who?.name || who?.email || '?').trim()[0]?.toUpperCase();

  return (
    <div className="relative mt-auto flex w-full flex-col items-center gap-1 border-stroke border-t pt-2">
      {hours !== null && (
        <span className="text-[0.6rem] text-ink-inactive tabular-nums" title="Hours these runs took — wall clock, not time saved">
          {hours} h
        </span>
      )}

      <button
        type="button"
        title={who?.name || who?.email || 'Your account'}
        aria-label="Your account"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className={cn(
          'grid size-8 place-items-center rounded-full font-bold text-[0.75rem]',
          'on-accent bg-brand-tertiary transition-opacity duration-base hover:opacity-90',
        )}
      >
        {initial}
      </button>

      {open && (
        /* Over the rail rather than inside it: the rail is 60px and this has words in it. Anchored to the
         * bottom so it opens upwards, which is where the space is. */
        <div className="absolute bottom-full left-1 z-20 mb-1 w-[13rem] rounded-lg border border-stroke bg-surface-card p-2.5 shadow-dropdown">
          <Typography variant="span" weight="semibold" className="block truncate text-[0.82rem]">
            {who?.name || 'Signed in'}
          </Typography>
          {who?.email && (
            <span className="block truncate text-[0.72rem] text-ink-inactive">{who.email}</span>
          )}

          <button
            type="button"
            onClick={() => { setOpen(false); openApp('/skills'); }}
            className="mt-2 block w-full rounded-md px-2 py-1.5 text-left text-[0.78rem] text-ink-secondary hover:bg-state-hover"
          >
            Account and devices…
          </button>
          {/* ONE ACT, NOT TWO. "Detach this browser" on its own was a menu item that left the session
              alive on the app's origin, so signing in again did nothing visible and there was no way to
              actually leave. Signing out ends both: the session over there and this browser's pairing,
              which is what a person means by the words. */}
          <button
            type="button"
            onClick={async () => {
              setOpen(false);
              setLeaving(true);
              /* Best effort, in this order. If the session cannot be ended - offline, already expired -
               * the pairing still goes, because the alternative is a panel that says it signed you out
               * and did not. */
              try {
                await api('/api/auth/sign-out', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: '{}',
                });
              } catch (_) { /* said nothing, did the rest */ }
              await ask('sync/unpair');
              setLeaving(false);
              onDetached();
            }}
            disabled={leaving}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[0.78rem] text-fb-red-text hover:bg-state-hover disabled:opacity-60"
          >
            <LogOut className="size-3.5" />
            {leaving ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  );
};
