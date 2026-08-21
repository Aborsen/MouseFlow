/* The first screen: how big this deployment is, in six numbers. */
import { Link } from '@tanstack/react-router';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { CARD, NotFound, Stat, useAdmin } from './shell';

interface Summary {
  users: number;
  flows: { n: number; recordings: number; skills: number };
  runs: { n: number; week: number };
  chats: number;
  published: number;
}

export const AdminOverview = () => {
  const { data, failed, refused } = useAdmin<{ summary: Summary }>('summary');

  if (refused) return <NotFound />;
  if (failed) {
    return <Typography variant="p" className="text-fb-red-text text-[0.88rem]">{failed}</Typography>;
  }
  if (!data) return <Typography variant="p" className="text-ink-inactive">Loading…</Typography>;

  const s = data.summary;
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <Stat label="Users" value={s.users} />
        <Stat label="Recordings" value={s.flows.recordings} />
        <Stat label="Skills" value={s.flows.skills} />
        <Stat label="Runs" value={s.runs.n} note={`${s.runs.week} in the last 7 days`} />
        <Stat label="Chats" value={s.chats} />
        <Stat label="Published" value={s.published} note="in the gallery" />
      </div>

      <div className={cn(CARD, 'p-4')}>
        <Typography variant="h3" weight="semibold" className="text-[0.95rem]">Where to go</Typography>
        <Typography variant="p" className="mt-1 text-ink-inactive text-[0.85rem] leading-relaxed">
          <Link to="/admin/users" className="text-brand-primary hover:underline">Users</Link> lists everyone
          with what they hold — open one to see their recordings, runs and chats. {' '}
          <Link to="/admin/models" className="text-brand-primary hover:underline">Models</Link> decides what
          each part of the product thinks with; a change there reaches the next run everywhere without a
          deploy.
        </Typography>
      </div>
    </div>
  );
};
