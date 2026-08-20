/* Long sessions this browser has recorded.
 *
 * A receipt, not a copy. The parts live on the account - that is the whole point, since sixteen half-hour
 * parts is more than localStorage would give for every recording put together - so what is here is counts:
 * how many parts, how much is in them, how far into the session each one was cut, and whether it arrived.
 *
 * Which makes one thing worth saying plainly rather than leaving to be discovered: a part that never reached
 * the account is only in the tab that recorded it, and a reload loses it. The row says so, in those words,
 * because "not synced" reads like something that will sort itself out.
 */
import { CircleDot, Cloud, CloudOff, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { fmtMs } from '@/lib/macro';
import { type Session, sessionTotals } from './long-session';

const when = (iso: string) => {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return 'unknown time';
  return at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export const SessionStrip = ({ sessions, onView, onForget }: {
  sessions: Session[];
  onView: (partId: string) => void;
  onForget: (session: Session) => void;
}) => {
  const [open, setOpen] = useState<string | null>(null);
  if (!sessions.length) return null;

  /* Newest first, and a running one always at the top: while a session is recording it is the thing on this
   * page somebody is watching. */
  const ordered = [...sessions].sort((a, b) => {
    if (!a.endedAt && b.endedAt) return -1;
    if (a.endedAt && !b.endedAt) return 1;
    return Date.parse(b.startedAt || '') - Date.parse(a.startedAt || '') || 0;
  });

  return (
    <section className="rounded-xl border-stroke border bg-surface-card p-4">
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <CircleDot className="size-4 shrink-0 text-brand-primary" />
        <Typography variant="h3" weight="semibold" className="text-[0.95rem]">
          Sessions
        </Typography>
        <Typography variant="span" className="text-ink-inactive text-[0.82rem]">
          Long recordings, written to your account in parts.
        </Typography>
      </div>

      <ul className="flex flex-col gap-1.5">
        {ordered.map((session) => {
          const totals = sessionTotals(session);
          const live = !session.endedAt;
          const showing = open === session.id;

          return (
            <li key={session.id} className="rounded-lg border-stroke/45 border bg-surface-card2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
                <span
                  className={cn(
                    'size-2 shrink-0 rounded-full',
                    live ? 'animate-pulse bg-fb-red' : 'bg-ink-inactive/50',
                  )}
                  aria-hidden
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <Typography variant="span" weight="semibold" className="truncate text-[0.88rem]">
                    {live ? 'Recording now' : `Session · ${when(session.startedAt)}`}
                  </Typography>
                  <span className="truncate text-[0.76rem] text-ink-inactive tabular-nums">
                    {totals.parts} part{totals.parts === 1 ? '' : 's'} · {fmtMs(totals.ms)} ·{' '}
                    {totals.events} events · {totals.clicks} click{totals.clicks === 1 ? '' : 's'} · a part
                    every {session.everyMinutes} min
                  </span>
                </span>

                {/* Only when something is actually waiting. A green "all synced" badge on every row is a
                  * decoration; this is the one state worth a colour, because it is the one that can lose
                  * something. */}
                {totals.waiting > 0 && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-fb-attention/15 px-1.5 py-0.5 text-[0.74rem] text-fb-attention">
                    <CloudOff className="size-3" />
                    {totals.waiting} not sent
                  </span>
                )}

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setOpen(showing ? null : session.id)}
                  disabled={!totals.parts}
                >
                  {showing ? 'Hide parts' : `Parts (${totals.parts})`}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  leftSlot={<Trash2 className="size-4" />}
                  disabled={live}
                  onClick={() => onForget(session)}
                >
                  Remove
                </Button>
              </div>

              {showing && (
                <ul className="border-stroke/45 border-t px-3 py-2">
                  {[...session.parts].sort((a, b) => a.n - b.n).map((part) => (
                    <li key={part.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1">
                      <span className="w-12 shrink-0 font-mono text-[0.74rem] text-ink-inactive tabular-nums">
                        {String(part.n).padStart(2, '0')}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[0.8rem] text-ink-secondary tabular-nums">
                        at {fmtMs(part.atMs)} · {part.events} events · {part.clicks} click
                        {part.clicks === 1 ? '' : 's'} · {fmtMs(part.ms)} of activity
                      </span>
                      {part.onAccount ? (
                        <span className="inline-flex shrink-0 items-center gap-1 text-[0.74rem] text-ink-inactive">
                          <Cloud className="size-3" /> on your account
                        </span>
                      ) : (
                        /* Said as what it is. "Not synced" sounds like a state that resolves itself; this
                          * one is lost by a reload, and somebody deciding whether to close the tab needs
                          * that in the sentence. */
                        <span className="inline-flex shrink-0 items-center gap-1 text-[0.74rem] text-fb-attention">
                          <CloudOff className="size-3" /> only in this tab — a reload loses it
                        </span>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!part.onAccount}
                        onClick={() => onView(part.id)}
                      >
                        View
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};
