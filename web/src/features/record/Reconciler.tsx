/* Runs the reconciliation, once per change, wherever you happen to be in the app.
 *
 * Mounted in the shell rather than on the Record page, because the thing being fixed is what happens when you
 * SIGN IN on another machine - and you may well land on Create or the Dashboard. Waiting for somebody to
 * visit the right page before their recordings appear is the same bug in a longer form.
 *
 * It renders nothing. The rules are in reconcile.ts and are pure; this is the part that has to touch two
 * stores and the network, and is therefore the part worth keeping small.
 */
import { useEffect, useRef } from 'react';
import { push } from '@/lib/api';
import { useAgent, useConsole } from '@/lib/store';
import { useAccount } from '@/shell/AccountProvider';
import { flowFor } from './flow-for';
import { reconcile } from './reconcile';

export const Reconciler = () => {
  const { flows, loaded, reload } = useAccount();
  const [local, update] = useConsole();
  const { health } = useAgent();

  /* One at a time, and not again for the same pair of sides.
   *
   * Reconciling changes both sides, which changes what this effect depends on - so without a signature it
   * would run on its own output. An empty plan writes nothing, which is what makes the loop settle: the
   * second pass finds nothing to do and stops. */
  const busy = useRef(false);
  const done = useRef('');

  useEffect(() => {
    const signature = [
      flows.map((f) => f.id).sort().join(','),
      local.recordings.map((r) => `${r.id}${r.syncedAt ? '+' : '-'}`).sort().join(','),
    ].join('|');
    if (busy.current || done.current === signature) return;

    /* Until the account has answered, there is nothing to compare against - and comparing anyway is not a
     * harmless early start, it is data loss. An unanswered account looks exactly like an empty one, and an
     * empty one means "every recording you have was deleted somewhere else". Found in the browser, where the
     * rows came back a moment later and hid it. */
    if (!loaded) return;
    if (!flows.length && !local.recordings.length) return;

    const plan = reconcile({ flows, local: local.recordings });
    const nothing = !plan.pull.length && !plan.push.length && !plan.forget.length && !plan.stamp.length;
    done.current = signature;
    if (nothing) return;

    busy.current = true;
    (async () => {
      let sent: string[] = [];
      try {
        if (plan.push.length) {
          /* Up first. If this fails, nothing else in the plan is wrong - but a recording that exists only
           * here is the one thing that can actually be lost, so it goes before any local change. */
          const saved = await push({ flows: plan.push.map((rec) => flowFor(rec, health)) });
          if (!saved.problems.length) sent = plan.push.map((rec) => rec.id);
        }
      } catch (_) {
        /* Offline. The recordings stay here, unstamped, and the next reconcile tries again - which is the
         * whole reason the stamp is a fact about the account rather than a flag we set hopefully. */
      }

      const stamped = new Set([...plan.stamp, ...sent]);
      const forget = new Set(plan.forget);
      const now = new Date().toISOString();

      if (plan.pull.length || stamped.size || forget.size) {
        update((prev) => ({
          recordings: [
            ...prev.recordings
              .filter((rec) => !forget.has(rec.id))
              .map((rec) => (stamped.has(rec.id) ? { ...rec, syncedAt: rec.syncedAt ?? now } : rec)),
            /* Appended, and the ids are the account's own, so a second pass finds them already here rather
             * than pulling a duplicate under a new name. */
            ...plan.pull.filter((rec) => !prev.recordings.some((had) => had.id === rec.id)),
          ],
          /* Said, not silent. Recordings appearing is welcome; recordings DISAPPEARING because another
           * machine deleted them is the kind of thing somebody needs to be told once. */
          lastSync: {
            at: now,
            pulled: plan.pull.length,
            pushed: sent.length,
            forgotten: plan.forget.length,
            left: plan.left.length,
          },
        }));
      }

      if (sent.length) await reload();
      busy.current = false;
    })();
  }, [flows, loaded, local.recordings, health, reload, update]);

  return null;
};
