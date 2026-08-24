/* Which teams this account is in, and who is in them.
 *
 * Read-only on purpose. Adding somebody, moving a role and deleting a team are acts with consequences for
 * other people, and a 400px panel beside a web page is not where they belong - the app has the room to say
 * what each of them means. What the panel is for is the question somebody actually has while working:
 * "who can see this, and am I in the right team?"
 */
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Users } from 'lucide-react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { Pill } from '@/components/Pill';
import { Said, type SaidNote } from '@/components/Said';
import { ask, openApp } from './worker';

interface Team { id: string; name: string; role: string; members: number }

export const TeamsScreen = () => {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [note, setNote] = useState<SaidNote | null>(null);

  const read = useCallback(async () => {
    const res = await ask('app/read', { what: 'teams' });
    if (!res.ok) { setNote({ text: res.error ?? 'Could not read the account.', kind: 'bad' }); return; }
    const body = res.body as { teams?: Team[] } | undefined;
    setTeams(body?.teams ?? []);
  }, []);

  useEffect(() => { void read(); }, [read]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      <header className="flex items-center justify-between gap-2">
        <Typography variant="h2" weight="semibold" className="text-[1.05rem]">Teams</Typography>
        <Button
          variant="ghost"
          size="xs"
          title="Add people, move roles, share a skill — opens the app in a tab"
          onClick={() => openApp('/team')}
          leftSlot={<ExternalLink className="size-3.5" />}
        >
          Manage
        </Button>
      </header>

      <Typography variant="p" className="text-ink-inactive text-[0.78rem] leading-relaxed">
        A team sees <span className="font-semibold text-ink-body">that</span> work happened — never what is
        inside a recording. A skill becomes visible to one only when you share that skill.
      </Typography>

      <Said note={note} onDismiss={() => setNote(null)} />

      {teams === null ? (
        <Typography variant="p" className="text-ink-inactive text-[0.8rem]">Reading…</Typography>
      ) : teams.length === 0 ? (
        <div className="grid place-items-center gap-2 rounded-lg border border-stroke border-dashed py-8 text-center">
          <Users className="size-6 text-ink-inactive" />
          <Typography variant="p" className="max-w-[24ch] text-ink-inactive text-[0.8rem]">
            You are not in a team yet.
          </Typography>
          <Button size="xs" variant="ghost" onClick={() => openApp('/team')}>Make one</Button>
        </div>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
          {teams.map((team) => (
            <li key={team.id}>
              <button
                type="button"
                title="Open this team in the app"
                onClick={() => openApp('/team')}
                className="flex w-full items-center gap-2 rounded-lg border border-stroke/45 bg-surface-card px-2.5 py-2 text-left transition-colors duration-fast hover:border-card-border-hover"
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-state-pressed font-bold text-[0.72rem] text-brand-primary">
                  {(team.name || '?').trim()[0]?.toUpperCase()}
                </span>
                <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
                  <span className="truncate font-semibold text-[0.84rem] text-ink-primary">{team.name}</span>
                  <span className="text-[0.72rem] text-ink-inactive">
                    {team.members} {team.members === 1 ? 'person' : 'people'}
                  </span>
                </span>
                <Pill>{team.role}</Pill>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
