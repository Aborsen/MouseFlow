/* Teams: who may see whose work.
 *
 * Three roles and nothing behind them — owner, admin, member — checked in the queries that need them
 * (api/team.js). Not a permission system: that earns its keep the day somebody needs "sees the dashboard but
 * not the transcripts", and until then it is a second product to keep correct.
 *
 * THE LINE THIS SCREEN HAS TO MAKE VISIBLE, because it is the whole design and it is not obvious:
 *
 *   activity   who recorded, when, how many runs — owners and admins see it for the whole team, because a
 *              team that cannot see whether it is working is not a team.
 *   content    the events, the transcript, the chat — private until its owner shares it, one thing at a
 *              time, exactly as the gallery has always worked.
 *
 * So the roster shows counts and dates and never a payload, and sharing is a separate list with the person's
 * own skills in it. A membership that retroactively opened everything somebody had ever recorded would be a
 * surprise about other people's screens, and this screen says so in as many words rather than leaving it to
 * be discovered.
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, Plus, Share2, Trash2, Users, X } from 'lucide-react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { useAccount } from '../AccountProvider';
import { roleOf, SKILL_ROLE } from '@/lib/flow-role';
import type { Say } from '../SettingsDialog';

type Role = 'owner' | 'admin' | 'member';

interface TeamRow { id: string; name: string; role: Role; members: number; created_at?: string }

interface Member {
  id: string;
  role: Role;
  joined: string | null;
  name: string | null;
  email: string | null;
  /** Null when the caller's own role may not see it — never zero, which would read as "does nothing". */
  activity: {
    recordings: number; skills: number; runs: number;
    lastRecorded: string | null; lastRun: string | null;
  } | null;
}

interface Shared {
  flowId: string; ownerId: string; owner: string | null; name: string | null;
  description: string | null; source: string | null; kind: string | null;
  missing: boolean; at: string;
}

interface Detail {
  team: { id: string; name: string; created: string; createdBy: string };
  you: { role: Role };
  members: Member[];
  invites: { email: string; role: Role; created: string }[];
  shared: Shared[];
}

/* Two error shapes reach this: `{ error: "words" }` from api/team.js, and `{ error: { message } }` from the
 * dev mock and from a couple of the older routes. Reading only the first turns the second into the string
 * "[object Object]" on screen, which is a bug report nobody can act on. */
const saidWrong = (body: unknown, status: number): string => {
  const said = (body as { error?: unknown } | null)?.error;
  if (typeof said === 'string' && said.trim()) return said;
  const nested = (said as { message?: unknown } | null | undefined)?.message;
  if (typeof nested === 'string' && nested.trim()) return nested;
  return `HTTP ${status}`;
};

const call = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`/api/team${path}`, { credentials: 'same-origin', ...init });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(saidWrong(body, res.status));
  return body as T;
};

const when = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}`;
};

const ROLE_WORDS: Record<Role, string> = {
  owner: 'owns it — can rename it, delete it and move anybody’s role',
  admin: 'adds and removes members, and sees everyone’s activity',
  member: 'sees the team’s shared skills, and their own activity',
};

export const TeamScreen = ({ say }: { say: Say }) => {
  const { account, flows } = useAccount();
  const [teams, setTeams] = useState<TeamRow[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [invite, setInvite] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('member');
  const [sharing, setSharing] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);

  const loadTeams = useCallback(async () => {
    try {
      const body = await call<{ teams: TeamRow[] }>('');
      setTeams(body.teams);
      setOpenId((was) => was ?? (body.teams[0] ? body.teams[0].id : null));
    } catch (err) {
      say({ text: err instanceof Error ? err.message : 'your teams could not be read', kind: 'bad' });
      setTeams([]);
    }
  }, [say]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await call<Detail>(`?id=${encodeURIComponent(id)}`));
    } catch (err) {
      setDetail(null);
      say({ text: err instanceof Error ? err.message : 'that team could not be read', kind: 'bad' });
    }
  }, [say]);

  useEffect(() => { void loadTeams(); }, [loadTeams]);
  useEffect(() => { if (openId) void loadDetail(openId); else setDetail(null); }, [openId, loadDetail]);

  const act = async (what: () => Promise<unknown>, said: string) => {
    setBusy(true);
    try {
      await what();
      await loadTeams();
      if (openId) await loadDetail(openId);
      say({ text: said, kind: 'good' });
    } catch (err) {
      say({ text: err instanceof Error ? err.message : 'that did not work', kind: 'bad' });
    } finally {
      setBusy(false);
      setArmed(null);
    }
  };

  const mine = detail?.you.role;
  const manages = mine === 'owner' || mine === 'admin';

  /* Only skills, and only mine. Sharing a raw recording would put a payload in front of a team without the
   * step that turns it into something meant to be handed over. */
  const shareable = flows.filter((f) => roleOf(f) === SKILL_ROLE
    && !detail?.shared.some((s) => s.flowId === f.id && s.ownerId === account?.id));

  return (
    <div className="grid gap-4">
      <div>
        <Typography variant="h3" weight="semibold" className="text-[0.95rem]">Teams</Typography>
        <Typography variant="p" className="mt-1 text-ink-inactive text-[0.84rem] leading-relaxed">
          A team lets the people running it see <span className="text-ink-body">that</span> work is happening
          — who recorded, when, how runs ended. It does <span className="text-ink-body">not</span> open what
          is in a recording: joining a team hands over nothing you have already made, and a skill becomes
          visible to it only when you share that one skill, here.
        </Typography>
      </div>

      {/* --------------------------------------------------------------- the teams */}
      <div className="flex flex-wrap items-center gap-1.5">
        {(teams ?? []).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setOpenId(t.id)}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.85rem] transition-colors duration-fast',
              t.id === openId
                ? 'on-accent bg-brand-primary font-semibold'
                : 'text-ink-body hover:bg-state-hover',
            )}
          >
            <Users className="size-3.5" />
            {t.name}
            <span className={cn('text-[0.74rem]', t.id === openId ? 'opacity-70' : 'text-ink-inactive')}>
              {t.members}
            </span>
          </button>
        ))}
        {teams && teams.length === 0 && (
          <Typography variant="span" className="text-ink-inactive text-[0.84rem]">
            You are not in a team yet.
          </Typography>
        )}
      </div>

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const name = newName.trim();
          if (!name) return;
          void act(async () => {
            const made = await call<{ id: string }>('', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name }),
            });
            setNewName('');
            setOpenId(made.id);
          }, 'Team made. You own it.');
        }}
      >
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value.slice(0, 60))}
          placeholder="Name a new team…"
          className="h-9 min-w-[200px] flex-1 rounded-lg border border-stroke bg-surface-card2 px-3 text-[0.86rem] text-ink-primary placeholder:text-ink-inactive focus:border-brand-primary focus:outline-none"
        />
        <Button size="sm" type="submit" disabled={busy || !newName.trim()} leftSlot={<Plus className="size-4" />}>
          Make a team
        </Button>
      </form>

      {/* --------------------------------------------------------------- one team */}
      {detail && (
        <div className="grid gap-3.5 rounded-xl border border-stroke p-3.5">
          <div className="flex flex-wrap items-baseline gap-2">
            <Typography variant="h3" weight="semibold" className="text-[0.92rem]">{detail.team.name}</Typography>
            <span className="text-[0.78rem] text-ink-inactive">you {ROLE_WORDS[detail.you.role]}</span>
          </div>

          {/* -------- members */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px]">
              <thead>
                <tr>
                  {['Person', 'Role', ...(manages ? ['Rec.', 'Skills', 'Runs', 'Last run'] : []), ''].map((h, i) => (
                    <th
                      key={h || `x${i}`}
                      className={cn(
                        'px-2 py-1.5 text-left font-semibold text-[0.7rem] text-ink-inactive uppercase tracking-wide',
                        i > 1 && 'text-right',
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detail.members.map((m) => (
                  <tr key={m.id} className="border-stroke border-t">
                    <td className="px-2 py-2">
                      <div className="text-[0.86rem] text-ink-primary">{m.name || m.email || m.id}</div>
                      {m.name && m.email && (
                        <div className="text-[0.74rem] text-ink-inactive">{m.email}</div>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {detail.you.role === 'owner' && m.id !== account?.id ? (
                        <select
                          value={m.role}
                          disabled={busy}
                          onChange={(e) => void act(
                            () => call(`?id=${encodeURIComponent(detail.team.id)}`, {
                              method: 'PATCH',
                              headers: { 'content-type': 'application/json' },
                              body: JSON.stringify({ userId: m.id, role: e.target.value }),
                            }),
                            'Role changed.',
                          )}
                          className="h-7 rounded-md border border-stroke bg-surface-card2 px-1.5 text-[0.8rem] text-ink-primary focus:border-brand-primary focus:outline-none"
                        >
                          {(['owner', 'admin', 'member'] as Role[]).map((r) => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-[0.82rem] text-ink-secondary">{m.role}</span>
                      )}
                    </td>
                    {manages && (
                      <>
                        <td className="px-2 py-2 text-right text-[0.84rem] text-ink-body">{m.activity?.recordings ?? '—'}</td>
                        <td className="px-2 py-2 text-right text-[0.84rem] text-ink-body">{m.activity?.skills ?? '—'}</td>
                        <td className="px-2 py-2 text-right text-[0.84rem] text-ink-body">{m.activity?.runs ?? '—'}</td>
                        <td className="px-2 py-2 text-right text-[0.82rem] text-ink-inactive">{when(m.activity?.lastRun)}</td>
                      </>
                    )}
                    <td className="px-2 py-2 text-right">
                      {(m.id === account?.id || manages) && (
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={busy}
                          title={m.id === account?.id ? 'Leave this team' : 'Remove from the team'}
                          onClick={() => void act(
                            () => call(`?id=${encodeURIComponent(detail.team.id)}`
                              + (m.id === account?.id ? '' : `&user=${encodeURIComponent(m.id)}`),
                              { method: 'DELETE' }),
                            m.id === account?.id ? 'You left the team.' : 'Removed.',
                          )}
                        >
                          <X className="size-3.5" />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* -------- adding somebody */}
          {manages && (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const email = invite.trim();
                if (!email) return;
                void act(async () => {
                  const out = await call<{ added: boolean; note?: string }>(
                    `?id=${encodeURIComponent(detail.team.id)}`,
                    {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ email, role: inviteRole }),
                    },
                  );
                  setInvite('');
                  if (!out.added && out.note) say({ text: out.note, kind: 'good' });
                }, `${email} is in.`);
              }}
            >
              <input
                value={invite}
                onChange={(e) => setInvite(e.target.value.slice(0, 200))}
                placeholder="their email address"
                className="h-9 min-w-[200px] flex-1 rounded-lg border border-stroke bg-surface-card2 px-3 text-[0.86rem] text-ink-primary placeholder:text-ink-inactive focus:border-brand-primary focus:outline-none"
              />
              {detail.you.role === 'owner' && (
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as Role)}
                  className="h-9 rounded-lg border border-stroke bg-surface-card2 px-2 text-[0.84rem] text-ink-primary focus:border-brand-primary focus:outline-none"
                >
                  {(['member', 'admin', 'owner'] as Role[]).map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              )}
              <Button variant="secondary" size="sm" type="submit" disabled={busy || !invite.trim()}>
                Add
              </Button>
            </form>
          )}

          {detail.invites.length > 0 && (
            <div className="grid gap-1">
              <span className="text-[0.76rem] text-ink-inactive uppercase tracking-wide">
                Waiting for an account
              </span>
              {detail.invites.map((i) => (
                <div key={i.email} className="flex items-center gap-2 text-[0.83rem] text-ink-body">
                  <span className="truncate">{i.email}</span>
                  <span className="text-[0.76rem] text-ink-inactive">{i.role}</span>
                  <Button
                    variant="ghost" size="xs" className="ms-auto" disabled={busy}
                    onClick={() => void act(
                      () => call(`?id=${encodeURIComponent(detail.team.id)}&invite=${encodeURIComponent(i.email)}`,
                        { method: 'DELETE' }),
                      'Invitation cancelled.',
                    )}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              ))}
              <Typography variant="span" className="text-[0.76rem] text-ink-inactive leading-relaxed">
                Nothing was emailed — there is no sender here, and an invitation that depended on a message
                arriving would be one that silently did not happen. Tell them yourself; they are in as soon as
                they sign up with that address and open this screen.
              </Typography>
            </div>
          )}

          {/* -------- shared skills */}
          <div className="grid gap-1.5 border-stroke border-t pt-3">
            <div className="flex items-center gap-2">
              <span className="text-[0.76rem] text-ink-inactive uppercase tracking-wide">
                Shared with this team
              </span>
              {shareable.length > 0 && (
                <Button
                  variant="ghost" size="xs" className="ms-auto"
                  onClick={() => setSharing((was) => !was)}
                  leftSlot={<Share2 className="size-3.5" />}
                >
                  {sharing ? 'Never mind' : 'Share one of mine'}
                </Button>
              )}
            </div>

            {sharing && (
              <div className="grid max-h-40 gap-0.5 overflow-auto rounded-lg border border-stroke p-1.5">
                {shareable.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    disabled={busy}
                    onClick={() => void act(
                      () => call(`?id=${encodeURIComponent(detail.team.id)}&share=${encodeURIComponent(f.id)}`,
                        { method: 'POST' }),
                      `"${f.name}" is visible to ${detail.team.name}.`,
                    ).then(() => setSharing(false))}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.84rem] text-ink-body hover:bg-state-hover"
                  >
                    <Plus className="size-3.5 shrink-0 text-ink-inactive" />
                    <span className="truncate">{f.name}</span>
                  </button>
                ))}
              </div>
            )}

            {detail.shared.length === 0 ? (
              <Typography variant="span" className="text-[0.82rem] text-ink-inactive">
                Nothing yet. Sharing is per skill and always deliberate.
              </Typography>
            ) : (
              detail.shared.map((s) => (
                <div key={`${s.ownerId}:${s.flowId}`} className="flex items-center gap-2 text-[0.84rem]">
                  <Check className="size-3.5 shrink-0 text-brand-primary" />
                  <span className={cn('truncate', s.missing ? 'text-ink-inactive line-through' : 'text-ink-body')}>
                    {s.name || s.flowId}
                  </span>
                  <span className="shrink-0 text-[0.76rem] text-ink-inactive">
                    {s.ownerId === account?.id ? 'yours' : s.owner || 'someone'}
                    {s.missing ? ' · since deleted' : ''}
                  </span>
                  {s.ownerId === account?.id && (
                    <Button
                      variant="ghost" size="xs" className="ms-auto" disabled={busy}
                      onClick={() => void act(
                        () => call(`?id=${encodeURIComponent(detail.team.id)}&share=${encodeURIComponent(s.flowId)}`,
                          { method: 'DELETE' }),
                        'No longer shared.',
                      )}
                    >
                      <X className="size-3.5" />
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>

          {/* -------- the end of a team */}
          {detail.you.role === 'owner' && (
            <div className="border-stroke border-t pt-3">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                className="text-fb-red-text"
                leftSlot={<Trash2 className="size-4" />}
                onClick={() => {
                  if (armed !== detail.team.id) {
                    setArmed(detail.team.id);
                    say({ text: 'That cannot be undone. Press again to delete the team.', kind: 'bad' });
                    return;
                  }
                  void act(
                    () => call(`?id=${encodeURIComponent(detail.team.id)}&team=1`, { method: 'DELETE' }),
                    'Team deleted. Nobody’s recordings were touched — a team never held any.',
                  ).then(() => setOpenId(null));
                }}
              >
                {armed === detail.team.id ? 'Delete it — press again' : 'Delete this team'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
