/* Making this browser and the account agree, without asking.
 *
 * Signing in on a second machine used to show a strip offering to "bring them here". That is the wrong shape
 * for the question: on a fresh machine the rows on your account are not an anomaly to be adopted, they are
 * your recordings, and an offer means two devices can quietly hold different sets. Reconciling on load is the
 * answer, and it has three directions rather than one.
 *
 * THE DIRECTION THAT IS NOT OBVIOUS, AND THE TRAP IN IT
 *
 * Pulling down is easy. Pushing up is where a naive two-way sync destroys data, because api/sync.js upserts
 * with `deleted_at = null`: re-pushing an id that was deleted somewhere else RESURRECTS it. So "the account
 * does not have this, therefore send it" would undo every delete made on another machine, and the delete
 * would come back looking like a sync.
 *
 * What separates the two cases is one fact nobody was recording: whether the account has ever acknowledged
 * this recording. So a recording now carries `syncedAt`, stamped when a push comes back clean, and the rules
 * follow from it:
 *
 *   never acknowledged, absent from the account   -> send it up. It only exists here.
 *   acknowledged, absent from the account          -> it was deleted elsewhere. Drop it here.
 *   on the account, not here                       -> bring it down.
 *
 * Recordings made before `syncedAt` existed have no answer. They are stamped on the first reconcile if the
 * account already holds them, and otherwise pushed - which can resurrect something deleted elsewhere BEFORE
 * this existed, once. That is the lesser harm: the alternative deletes a recording that may be the only copy,
 * and losing work is not recoverable while an unexpected row is.
 */
import type { Flow } from '@/lib/api';
import type { Recording } from '@/lib/store';
import { SKILL_ROLE, roleOf } from '@/lib/flow-role';
import { sessionOf } from './long-session';

/* How much of the account to hold in this browser.
 *
 * localStorage gives one origin about 5MB for everything together, so "pull it all" is not a plan - a
 * recording is measured in hundreds of kilobytes. The newest fit; the rest stay on the account, where the
 * transcript and the dashboard read them from anyway. Said out loud rather than silently truncated. */
export const PULL_BUDGET_BYTES = 3_000_000;

export interface Plan {
  /** Account rows to add to this browser, newest first. */
  pull: Recording[];
  /** Local recordings the account has never acknowledged. */
  push: Recording[];
  /** Local recordings the account acknowledged and no longer has: deleted elsewhere. */
  forget: string[];
  /** Local recordings the account holds that were never stamped. Stamping is not a change of content. */
  stamp: string[];
  /** Rows left on the account because this browser has no room for them. */
  left: { id: string; name: string }[];
}

const eventsOf = (flow: Flow): unknown[] => {
  const payload = flow.payload as { events?: unknown } | undefined;
  return Array.isArray(payload?.events) ? payload.events : [];
};

/* Rows that are recordings, as opposed to everything else sharing the table.
 *
 * A skill is not a recording, a session part lives on the account BY DESIGN - that is the whole point of the
 * chunking - and a row with no events has nothing to bring. Each exclusion is a different reason and none of
 * them is "kind of like a recording". */
const isRecording = (flow: Flow): boolean => (
  flow.kind === 'recorded'
  && roleOf(flow) !== SKILL_ROLE
  && !flow.id.startsWith('dr_')
  && !sessionOf(flow.payload)
  && eventsOf(flow).length > 0
);

const newestFirst = (a: Flow, b: Flow) => {
  const at = (flow: Flow) => {
    const t = Date.parse(flow.created ?? '');
    return Number.isFinite(t) ? t : 0;
  };
  return at(b) - at(a);
};

const recordingFrom = (flow: Flow): Recording => {
  const payload = flow.payload as {
    events?: Recording['events'];
    windows?: Recording['windows'];
  } | undefined;
  return {
    id: flow.id,
    name: flow.name || 'From your account',
    created: flow.created ?? new Date().toISOString(),
    events: payload?.events ?? [],
    windows: payload?.windows ?? [],
    /* Stamped on arrival: it came FROM the account, so the account has acknowledged it by definition. Without
     * this the next reconcile would try to push back what it just pulled. */
    syncedAt: new Date().toISOString(),
  };
};

/** What to do, given what each side holds. Pure, so the rules can be run rather than read. */
export function reconcile(
  { flows, local, budgetBytes = PULL_BUDGET_BYTES }:
  { flows: Flow[]; local: Recording[]; budgetBytes?: number },
): Plan {
  const mine = new Map(local.map((rec) => [rec.id, rec]));
  const theirs = new Map(flows.filter(isRecording).map((flow) => [flow.id, flow]));

  const plan: Plan = { pull: [], push: [], forget: [], stamp: [], left: [] };

  // ---------------------------------------------------------------- down
  let spent = 0;
  for (const flow of [...theirs.values()].sort(newestFirst)) {
    if (mine.has(flow.id)) continue;
    const size = JSON.stringify(flow.payload ?? {}).length;
    if (spent + size > budgetBytes && plan.pull.length > 0) {
      plan.left.push({ id: flow.id, name: flow.name || 'a recording' });
      continue;
    }
    spent += size;
    plan.pull.push(recordingFrom(flow));
  }

  // ---------------------------------------------------------------- up, and the tombstone rule
  for (const rec of local) {
    if (theirs.has(rec.id)) {
      /* Held by both. Stamp it if it was never stamped, so the next reconcile can tell an unsynced recording
       * from one that was deleted elsewhere - which is the whole difference between sending it and dropping
       * it. */
      if (!rec.syncedAt) plan.stamp.push(rec.id);
      continue;
    }
    /* Absent from the account. Which way this goes depends entirely on whether the account ever had it, and
     * that is what `syncedAt` records. Re-pushing a deleted id would resurrect it - api/sync.js clears
     * `deleted_at` on upsert - so a delete made on another machine would come back as a sync. */
    if (rec.syncedAt) plan.forget.push(rec.id);
    else plan.push.push(rec);
  }

  return plan;
}
