/* One recording, as a row on the account.
 *
 * Three callers now: the push on stop, the restore when a recording has been deleted from Skills - the same
 * row, since recordings and skills share a table - and the reconcile that sends up whatever the account has
 * never seen. They must build the identical payload or a restored or re-synced recording quietly stops
 * matching the one that was saved, so there is one of these rather than three literals that look alike. It
 * lives in its own file for exactly that reason: the third caller is not on the Record page.
 */
import type { AgentStatus, Recording } from '@/lib/store';
import { RECORDING_ROLE } from '@/lib/flow-role';
import { fmtMs, summarize } from '@/lib/macro';

export function flowFor(rec: Recording, health: AgentStatus['health']) {
  const s = summarize(rec.events);
  const where = rec.windows ?? [];
  return {
    id: rec.id,
    // `desktop`, which decides who can replay it: these are screen coordinates, not page elements.
    source: 'desktop' as const,
    kind: 'recorded' as const,
    name: rec.name.slice(0, 80),
    description: `${s.count} events · ${s.clicks} click${s.clicks === 1 ? '' : 's'} · ${fmtMs(s.durationMs)}`,
    origins: where.map((w) => w.title).filter(Boolean).slice(0, 12),
    created: rec.created,
    payload: {
      version: 1,
      kind: 'recorded',
      agent: 'desktop',
      /* What this row IS, so the Skills page can stop listing it. Recordings and skills share a table and
       * nothing used to say which a row was, so a recording appeared under Skills looking like a skill and
       * deleting that card deleted the recording - and the transcript with it. */
      role: RECORDING_ROLE,
      /* What the agent said about ITSELF, now, because later nothing can reconstruct it.
       *
       * "Nothing was typed" and "the keyboard was not being watched" produce an identical recording, and the
       * transcript was asserting the first without being able to tell - a 0.6.0 agent names every click it
       * lands on and hooks no keyboard at all, so the named clicks it was reasoning from proved nothing.
       * Read from /health at the moment of recording, which is the only moment the answer exists.
       *
       * On a RESTORE this is whatever the agent says now, which may differ from what recorded it. Better
       * than nothing and honest either way: the flags describe an agent, and the transcript only ever uses
       * them to decide whether "no typing" means none happened. */
      recorder: {
        version: health?.version ?? null,
        canName: health?.canName === true,
        canKeys: health?.canKeys === true,
      },
      name: rec.name.slice(0, 80),
      events: rec.events,
      windows: rec.windows,
      created: rec.created,
    },
  };
}
