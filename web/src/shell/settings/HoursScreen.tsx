/* Hours: their Balance screen, in the unit that means something here.
 *
 * Insightis counts credits, because a question costs tokens. This counts hours, because a flow costs time
 * it would otherwise have cost you - and the number is measured rather than estimated: every run on the
 * account has a start and a finish, and a span that cannot be real is discarded instead of displayed.
 */
import { Typography } from '@/ui/components/Typography';
import { hoursOf } from '@/lib/api';
import { useAccount } from '../AccountProvider';

const fmt = (hours: number) => (hours >= 10 ? hours.toFixed(0) : hours.toFixed(1));

export const HoursScreen = () => {
  const { flows, runs } = useAccount();

  const timed = runs.filter((run) => hoursOf(run) > 0);
  const total = timed.reduce((sum, run) => sum + hoursOf(run), 0);

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const month = timed
    .filter((run) => run.startedAt && new Date(run.startedAt) >= monthStart)
    .reduce((sum, run) => sum + hoursOf(run), 0);

  const oldest = timed.length ? timed[timed.length - 1]?.startedAt : null;

  return (
    <div>
      <Typography variant="span" weight="semibold" className="block text-[0.9rem]">
        Hours of work run
      </Typography>
      <Typography variant="p" className="mt-0.5 max-w-[52ch] text-ink-inactive text-[0.82rem]">
        Time these flows have spent working, across this browser, the extension and the desktop agent.
        Every run on your account counts, whichever half did it.
      </Typography>

      <div className="mt-3 mb-4 flex items-baseline gap-1.5">
        <strong className="font-semibold text-[2rem] text-ink-primary tabular-nums tracking-tight">
          {fmt(total)}
        </strong>
        <span className="text-ink-secondary">hours</span>
        {oldest && (
          <span className="ms-auto text-ink-inactive text-[0.8rem]">
            since {new Date(oldest).toLocaleDateString()}
          </span>
        )}
      </div>

      <div className="mb-5 grid grid-cols-3 gap-2">
        {[
          { value: fmt(month), label: 'this month' },
          { value: String(runs.length), label: 'runs' },
          { value: String(flows.length), label: 'flows' },
        ].map(({ value, label }) => (
          <div key={label} className="rounded-md border-stroke border bg-surface-chips px-2.5 py-2">
            <strong className="block font-semibold text-[1.1rem] tabular-nums">{value}</strong>
            <span className="text-[0.78rem] text-ink-secondary">{label}</span>
          </div>
        ))}
      </div>

      {timed.length === 0 ? (
        <Typography variant="p" className="text-ink-inactive text-[0.85rem]">
          Nothing has run yet. Record something, or describe a goal in Create.
        </Typography>
      ) : (
        <table className="w-full border-collapse text-[0.85rem]">
          <thead>
            <tr className="bg-tbl-header text-ink-secondary">
              <th className="rounded-l-md px-2.5 py-2 text-left font-medium">Date</th>
              <th className="px-2.5 py-2 text-left font-medium">What</th>
              <th className="rounded-r-md px-2.5 py-2 text-right font-medium">Hours</th>
            </tr>
          </thead>
          <tbody>
            {timed.slice(0, 12).map((run) => (
              <tr key={run.id} className="border-stroke border-b last:border-0">
                <td className="px-2.5 py-2 text-ink-body">
                  {run.startedAt
                    ? new Date(run.startedAt).toLocaleDateString(undefined, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })
                    : '—'}
                </td>
                <td className="px-2.5 py-2 text-ink-secondary">
                  {run.kind === 'replay'
                    ? 'Replay'
                    : run.goal
                      ? run.goal.slice(0, 48) + (run.goal.length > 48 ? '…' : '')
                      : 'Created flow'}
                </td>
                <td className="px-2.5 py-2 text-right text-ink-primary tabular-nums">
                  {hoursOf(run).toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
