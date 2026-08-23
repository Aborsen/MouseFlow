/* Teams: who may see whose work.
 *
 * WHY THIS IS A PAGE AND NOT A SETTINGS PANE. It was one — the fourth screen inside a 680×560 dialog, next
 * to the theme switch and the log-out button. That was the right size while a team was one roster you set
 * up once. It is the wrong size now: somebody running several teams is adding people, moving roles,
 * chasing invitations that have not been accepted and reading a dashboard scoped to each one, and none of
 * that is a settings task. A dialog also cannot be linked to, and "open Teams" is exactly what an
 * invitation email has to be able to say.
 *
 * THE LINE THIS SCREEN HAS TO MAKE VISIBLE, because it is the whole design and it is not obvious:
 *
 *   activity   who recorded, when, how many runs — owners and admins see it for the whole team, because a
 *              team that cannot see whether it is working is not a team. It is also what the Dashboard's
 *              team view counts, and the button to it is on this page.
 *   content    the events, the transcript, the chat — private until its owner shares it, one thing at a
 *              time, exactly as the gallery has always worked.
 *
 * So the roster shows counts and dates and never a payload, and sharing is a separate list with the
 * person's own skills in it. A membership that retroactively opened everything somebody had ever recorded
 * would be a surprise about other people's screens, and this page says so in as many words rather than
 * leaving it to be discovered.
 *
 * SEVERAL TEAMS IS THE NORMAL CASE, not an edge one — an operations team, a finance team, a client. So the
 * teams are a column of their own rather than a row of pills that wraps at the fourth name, and every
 * write reloads both the list and the open team, since a role change alters what the list may show.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  ChartNoAxesColumn,
  Check,
  Mail,
  MailWarning,
  Plus,
  Send,
  Share2,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { Badge } from '@insightis/ui/Badge';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { useAccount } from '@/shell/AccountProvider';
import { roleOf, SKILL_ROLE } from '@/lib/flow-role';

type Role = 'owner' | 'admin' | 'member';

interface TeamRow { id: string; name: string; role: Role; members: number; created_at?: string }

/** Whether a message would actually reach anybody, answered by the endpoint before an address is typed. */
interface MailState { configured: boolean; problem: string | null }

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

/* Second person, because the only place these are shown says them ABOUT the reader. They were written in
 * the third — "owns it", "adds and removes members" — and rendered after the word "you", which put "you
 * owns it" on the screen. */
const ROLE_WORDS: Record<Role, string> = {
  owner: 'You own it — you can rename it, delete it, and move anybody’s role',
  admin: 'You add and remove members, and see everyone’s activity',
  member: 'You see the team’s shared skills, and your own activity',
};

/* The Badge's own vocabulary, not a colour invented here: primary, accent and secondary are three of the
 * six it ships, so a theme change moves these with everything else. */
const ROLE_TONE: Record<Role, 'primary' | 'accent' | 'secondary'> = {
  owner: 'primary',
  admin: 'accent',
  member: 'secondary',
};

const CARD = 'rounded-xl border border-stroke bg-surface-card p-4';
const FIELD = 'h-9 rounded-lg border border-stroke bg-surface-card2 px-3 text-[0.86rem] text-ink-primary '
  + 'placeholder:text-ink-inactive focus:border-brand-primary focus:outline-none';

export const TeamView = () => {
  const { account, flows } = useAccount();
  const [teams, setTeams] = useState<TeamRow[] | null>(null);
  const [mail, setMail] = useState<MailState | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; kind: 'good' | 'bad' } | null>(null);
  const [newName, setNewName] = useState('');
  const [invite, setInvite] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('member');
  const [sharing, setSharing] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);

  const loadTeams = useCallback(async () => {
    try {
      const body = await call<{ teams: TeamRow[]; mail?: MailState }>('');
      setTeams(body.teams);
      setMail(body.mail ?? null);
      setOpenId((was) => (was && body.teams.some((t) => t.id === was) ? was : body.teams[0]?.id ?? null));
    } catch (err) {
      setSaid({ text: err instanceof Error ? err.message : 'your teams could not be read', kind: 'bad' });
      setTeams([]);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await call<Detail>(`?id=${encodeURIComponent(id)}`));
    } catch (err) {
      setDetail(null);
      setSaid({ text: err instanceof Error ? err.message : 'that team could not be read', kind: 'bad' });
    }
  }, []);

  useEffect(() => { void loadTeams(); }, [loadTeams]);
  useEffect(() => { if (openId) void loadDetail(openId); else setDetail(null); }, [openId, loadDetail]);

  const act = async (what: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await what();
      await loadTeams();
      if (openId) await loadDetail(openId);
      setSaid({ text: done, kind: 'good' });
    } catch (err) {
      setSaid({ text: err instanceof Error ? err.message : 'that did not work', kind: 'bad' });
    } finally {
      setBusy(false);
      setArmed(null);
    }
  };

  const mine = detail?.you.role;
  const manages = mine === 'owner' || mine === 'admin';

  /* Only skills, and only mine. Sharing a raw recording would put a payload in front of a team without the
   * step that turns it into something meant to be handed over. */
  const shareable = useMemo(
    () => flows.filter((f) => roleOf(f) === SKILL_ROLE
      && !detail?.shared.some((s) => s.flowId === f.id && s.ownerId === account?.id)),
    [flows, detail, account?.id],
  );

  return (
    <div className="mx-auto max-w-[1180px] p-5">
      <header className="mb-4">
        <Typography variant="span" className="block text-[0.7rem] text-ink-inactive uppercase tracking-wide">
          Teams
        </Typography>
        <Typography variant="h2" weight="semibold" className="mt-0.5 text-[1.5rem] leading-tight tracking-tight">
          Who may see whose work
        </Typography>
        <Typography variant="p" className="mt-1 max-w-[76ch] text-ink-inactive text-[0.85rem] leading-relaxed">
          A team lets the people running it see <span className="text-ink-body">that</span> work is happening
          — who recorded, when, how runs ended. It does <span className="text-ink-body">not</span> open what
          is in a recording: joining a team hands over nothing you have already made, and a skill becomes
          visible to it only when you share that one skill, here.
        </Typography>
      </header>

      {said && (
        <div
          role="status"
          className={cn(
            'mb-4 rounded-lg border px-3.5 py-2.5 text-[0.85rem] leading-relaxed',
            said.kind === 'bad'
              ? 'border-fb-red/40 bg-fb-red/5 text-fb-red-text'
              : 'border-fb-green/40 bg-fb-green/5 text-ink-body',
          )}
        >
          {said.text}
          <button
            type="button"
            onClick={() => setSaid(null)}
            aria-label="Dismiss"
            className="ms-2 align-middle text-ink-inactive hover:text-ink-primary"
          >
            <X className="inline size-3.5" />
          </button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        {/* ------------------------------------------------------------- the teams you are in */}
        <div className={cn(CARD, 'h-fit')}>
          <Typography variant="span" className="text-[0.72rem] text-ink-inactive uppercase tracking-wide">
            Your teams
          </Typography>

          <div className="mt-2.5 grid gap-1">
            {(teams ?? []).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setOpenId(t.id)}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[0.88rem] transition-colors duration-fast',
                  t.id === openId
                    ? 'bg-state-pressed font-semibold text-ink-primary'
                    : 'text-ink-body hover:bg-state-hover',
                )}
              >
                <Users className={cn('size-4 shrink-0', t.id === openId && 'text-brand-primary')} />
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                <span className="shrink-0 text-[0.74rem] text-ink-inactive tabular-nums">{t.members}</span>
              </button>
            ))}

            {teams && teams.length === 0 && (
              <Typography variant="p" className="py-1 text-ink-inactive text-[0.84rem] leading-relaxed">
                You are not in a team yet. Make one below — you will own it.
              </Typography>
            )}
            {!teams && (
              <Typography variant="span" className="py-1 text-ink-inactive text-[0.84rem]">Reading…</Typography>
            )}
          </div>

          {/* One person can run several teams, so this is a permanent control rather than an empty state. */}
          <form
            className="mt-3 grid gap-2 border-stroke border-t pt-3"
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
              placeholder="Name another team…"
              className={FIELD}
            />
            <Button size="sm" type="submit" disabled={busy || !newName.trim()} leftSlot={<Plus className="size-4" />}>
              Make a team
            </Button>
          </form>
        </div>

        {/* ------------------------------------------------------------- one team */}
        {detail ? (
          <div className="grid gap-4">
            <div className={CARD}>
              <div className="flex flex-wrap items-center gap-2">
                <Typography variant="h3" weight="semibold" className="text-[1.05rem]">
                  {detail.team.name}
                </Typography>
                <Badge variant={ROLE_TONE[detail.you.role]} size="xs" rounded="full">{detail.you.role}</Badge>
                <span className="text-[0.8rem] text-ink-inactive">{ROLE_WORDS[detail.you.role]}</span>

                {/* The other half of this feature, and the only place it is discoverable from. */}
                {manages && (
                  <Link
                    to="/dashboard"
                    search={{ team: detail.team.id } as never}
                    className="ms-auto inline-flex items-center gap-1.5 rounded-lg border border-stroke px-2.5 py-1.5 text-[0.82rem] text-ink-body hover:border-stroke-hover hover:text-ink-primary"
                  >
                    <ChartNoAxesColumn className="size-4" />
                    This team’s dashboard
                  </Link>
                )}
              </div>

              {/* -------- members */}
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[520px]">
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
                          <div className="text-[0.88rem] text-ink-primary">
                            {m.name || m.email || m.id}
                            {m.id === account?.id && (
                              <span className="ms-1.5 text-[0.74rem] text-ink-inactive">you</span>
                            )}
                          </div>
                          {m.name && m.email && (
                            <div className="text-[0.75rem] text-ink-inactive">{m.email}</div>
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
                            <td className="px-2 py-2 text-right text-[0.85rem] text-ink-body tabular-nums">{m.activity?.recordings ?? '—'}</td>
                            <td className="px-2 py-2 text-right text-[0.85rem] text-ink-body tabular-nums">{m.activity?.skills ?? '—'}</td>
                            <td className="px-2 py-2 text-right text-[0.85rem] text-ink-body tabular-nums">{m.activity?.runs ?? '—'}</td>
                            <td className="px-2 py-2 text-right text-[0.82rem] text-ink-inactive tabular-nums">{when(m.activity?.lastRun)}</td>
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

              {manages && (
                <Typography variant="p" className="mt-2 max-w-[76ch] text-[0.78rem] text-ink-inactive leading-relaxed">
                  Counts are account-wide and cover everything each person has, not only what they did here —
                  a recording belongs to an account, and only a share connects one to a team.
                </Typography>
              )}
            </div>

            {/* -------- adding somebody */}
            {manages && (
              <div className={CARD}>
                <Typography variant="span" className="text-[0.72rem] text-ink-inactive uppercase tracking-wide">
                  Add somebody
                </Typography>

                <form
                  className="mt-2.5 flex flex-wrap items-center gap-2"
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
                      /* The endpoint's own sentence, which knows whether the message went and why not.
                       * A generic "done" here would be the app claiming something it did not check. */
                      if (out.note) setSaid({ text: out.note, kind: 'good' });
                    }, `${email} is in.`);
                  }}
                >
                  <input
                    value={invite}
                    onChange={(e) => setInvite(e.target.value.slice(0, 200))}
                    placeholder="their email address"
                    type="email"
                    className={cn(FIELD, 'min-w-[220px] flex-1')}
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

                {/* Whether a message will actually go, said BEFORE an address is typed rather than after
                  * four colleagues have been added on the assumption that one would. */}
                <div className="mt-2.5 flex items-start gap-2 text-[0.79rem] leading-relaxed">
                  {mail?.configured ? (
                    <>
                      <Mail className="mt-0.5 size-3.5 shrink-0 text-brand-primary" />
                      <span className="text-ink-inactive">
                        They are emailed who added them, what a team does and does not open, and a link to
                        this page. Somebody with no account yet is told to sign up with that same address.
                      </span>
                    </>
                  ) : (
                    <>
                      <MailWarning className="mt-0.5 size-3.5 shrink-0 text-fb-attention" />
                      <span className="text-ink-inactive">
                        No email leaves this deployment yet{mail?.problem ? ` — ${mail.problem}` : ''}.
                        Somebody added is still in; tell them yourself, and they are in as soon as they sign
                        up with that address and open this page.
                      </span>
                    </>
                  )}
                </div>

                {detail.invites.length > 0 && (
                  <div className="mt-3.5 grid gap-1 border-stroke border-t pt-3">
                    <span className="text-[0.72rem] text-ink-inactive uppercase tracking-wide">
                      Waiting for an account
                    </span>
                    {detail.invites.map((i) => (
                      <div key={i.email} className="flex items-center gap-2 text-[0.85rem] text-ink-body">
                        <span className="min-w-0 truncate">{i.email}</span>
                        <span className="shrink-0 text-[0.76rem] text-ink-inactive">{i.role}</span>
                        <span className="shrink-0 text-[0.76rem] text-ink-inactive">asked {when(i.created)}</span>
                        {mail?.configured && (
                          <Button
                            variant="ghost" size="xs" className="ms-auto" disabled={busy}
                            title="Send that invitation again"
                            onClick={() => void act(
                              () => call(`?id=${encodeURIComponent(detail.team.id)}`
                                + `&remind=${encodeURIComponent(i.email)}`, { method: 'POST' }),
                              `Sent to ${i.email} again.`,
                            )}
                          >
                            <Send className="size-3.5" />
                          </Button>
                        )}
                        <Button
                          variant="ghost" size="xs" className={cn(!mail?.configured && 'ms-auto')} disabled={busy}
                          title="Cancel this invitation"
                          onClick={() => void act(
                            () => call(`?id=${encodeURIComponent(detail.team.id)}`
                              + `&invite=${encodeURIComponent(i.email)}`, { method: 'DELETE' }),
                            'Invitation cancelled.',
                          )}
                        >
                          <X className="size-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* -------- shared skills */}
            <div className={CARD}>
              <div className="flex items-center gap-2">
                <span className="text-[0.72rem] text-ink-inactive uppercase tracking-wide">
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
                <div className="mt-2 grid max-h-52 gap-0.5 overflow-auto rounded-lg border border-stroke p-1.5">
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
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.85rem] text-ink-body hover:bg-state-hover"
                    >
                      <Plus className="size-3.5 shrink-0 text-ink-inactive" />
                      <span className="truncate">{f.name}</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="mt-2 grid gap-1.5">
                {detail.shared.length === 0 ? (
                  <Typography variant="span" className="text-[0.84rem] text-ink-inactive">
                    Nothing yet. Sharing is per skill and always deliberate.
                  </Typography>
                ) : (
                  detail.shared.map((s) => (
                    <div key={`${s.ownerId}:${s.flowId}`} className="flex items-center gap-2 text-[0.85rem]">
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
            </div>

            {/* -------- the end of a team */}
            {detail.you.role === 'owner' && (
              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  className="text-fb-red-text"
                  leftSlot={<Trash2 className="size-4" />}
                  onClick={() => {
                    if (armed !== detail.team.id) {
                      setArmed(detail.team.id);
                      setSaid({ text: 'That cannot be undone. Press again to delete the team.', kind: 'bad' });
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
        ) : (
          <div className={cn(CARD, 'grid place-items-center py-16 text-center')}>
            <Users className="size-7 text-ink-inactive" />
            <Typography variant="p" className="mt-2 max-w-[46ch] text-ink-inactive text-[0.86rem] leading-relaxed">
              {teams && teams.length === 0
                ? 'Make a team, then add the people you work with by their email address. You can run as many as you need — one per client, one per department.'
                : 'Pick a team on the left.'}
            </Typography>
          </div>
        )}
      </div>
    </div>
  );
};
