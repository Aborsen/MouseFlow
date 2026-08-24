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
 *              team view counts, and the button to it is in every team's panel.
 *   content    the events, the transcript, the chat — private until its owner shares it, one thing at a
 *              time, exactly as the gallery has always worked.
 *
 * A LIST, THEN A PANEL. Two shapes were tried before this one and both failed the same way: they assumed a
 * full team. A rail of team names spent a column on two names, and a grid of member cards put two people
 * into three columns and left most of the page empty — with the per-person activity bars, which were the
 * whole argument for cards, collapsing into stubs because one person had twenty-three runs and the other
 * had none. Cards flatter a full team and expose a small one; a table does the opposite, and everybody
 * starts small.
 *
 * So the teams are ROWS, in the anatomy the Recordings table already uses — same grid template, same row
 * border, same column labels — and opening one slides a panel over the list rather than navigating away.
 * The list staying put is the point: moving between teams is one click each, and adding somebody here and
 * fixing a role there does not cost two page loads.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  ChartNoAxesColumn,
  Check,
  Mail,
  MailWarning,
  Pencil,
  Plus,
  Send,
  Share2,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { Badge } from '@insightis/ui/Badge';
import { Button } from '@insightis/ui/Button';
import { Checkbox } from '@insightis/ui/Checkbox';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { SelectionBar } from '@/components/SelectionBar';
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
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()}`;
};

/** The same date without its year, for the places a row has no room for one. */
const short = (iso: string | null | undefined) => {
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

/* ONE grid template for the header and every row, which is what makes a label sit over the column it
 * names. The same rule RecordingsTable records for its own COLUMNS: every track but the name is FIXED,
 * because an `auto` actions column sizes to its content — and the header's word ACTIONS is narrower than
 * the buttons beneath it, so the flexible name column absorbs a different amount in each and the two
 * disagree by exactly that difference. */
const COLUMNS = 'grid-cols-[1.5rem_minmax(11rem,1fr)_6.5rem_7rem_8rem_7rem_9.5rem]';
const ROW = 'grid w-full items-center gap-x-3 rounded-lg px-3 py-2.5 border border-stroke/45 '
  + 'bg-surface-card transition-colors duration-fast hover:border-stroke-hover';
const LABEL = 'text-[0.7rem] uppercase tracking-wide text-ink-inactive';
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
  const [making, setMaking] = useState(false);
  const [newName, setNewName] = useState('');
  const [invite, setInvite] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('member');
  const [sharing, setSharing] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  const loadTeams = useCallback(async () => {
    try {
      const body = await call<{ teams: TeamRow[]; mail?: MailState }>('');
      setTeams(body.teams);
      setMail(body.mail ?? null);
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

  /* The panel's contents are read when it opens and dropped when it closes, rather than kept for the team
   * you last looked at. A stale roster under a fresh title is the shape of "I removed them and they are
   * still there". */
  useEffect(() => {
    if (!openId) { setDetail(null); return; }
    setDetail(null);
    void loadDetail(openId);
  }, [openId, loadDetail]);

  /* Escape closes it, because every overlay in every app does and one that does not feels stuck. */
  useEffect(() => {
    if (!openId) return undefined;
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setOpenId(null); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [openId]);

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

  /* Who is ticked, across both lists in the roster.
   *
   * ONE SELECTION FOR PEOPLE AND INVITATIONS, because from the outside they are one thing: somebody
   * offboarding a project wants these five off the team, and whether a given one has an account yet is our
   * problem rather than theirs. The key says which is which - `m:<id>` for a member, `i:<email>` for an
   * invitation - and what happens to each is different underneath.
   *
   * YOU CANNOT TICK YOURSELF. Leaving a team is not the same act as removing somebody from it: it is
   * irreversible for the person doing it and it is the one row where "remove" would take away the ability
   * to undo the rest. Leaving stays its own button. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const memberKey = (id: string) => `m:${id}`;
  const inviteKey = (email: string) => `i:${email}`;

  /* A tick only counts while the row it is on is still there. Somebody else can remove a person while this
   * panel is open, and a selection that outlived its row is how you remove somebody you cannot see. */
  const pickable = useMemo(() => {
    if (!detail || !manages) return [] as string[];
    return [
      ...detail.members.filter((m) => m.id !== account?.id).map((m) => memberKey(m.id)),
      ...detail.invites.map((i) => inviteKey(i.email)),
    ];
  }, [detail, manages, account?.id]);
  const live = useMemo(
    () => new Set([...picked].filter((key) => pickable.includes(key))),
    [picked, pickable],
  );
  const tick = useCallback((key: string) => setPicked((was) => {
    const next = new Set(was);
    if (!next.delete(key)) next.add(key);
    return next;
  }), []);

  /* Nothing stays ticked across teams. Opening another panel with three ticks carried over from the last
   * one is a selection nobody made. */
  useEffect(() => { setPicked(new Set()); }, [openId]);

  /* Taking several people off at once.
   *
   * ONE REQUEST PER PERSON, and this is the one place in the app where that is the right answer rather
   * than the lazy one: /api/team's DELETE removes one member, and each removal is a separate permission
   * decision on the server - an owner may not be removed by an admin, the last owner may not be removed at
   * all. A list parameter would have to re-decide all of that in a second place. The roster is a handful of
   * people, so the cost is a handful of requests.
   *
   * WHAT IT COSTS IS HONESTY ABOUT PARTIAL FAILURE, which is paid below: every one is awaited on its own,
   * failures are collected, and the report names them. "Removed 3 of 4" is a sentence somebody can act on;
   * "that did not work" after three of them already happened is not. */
  const removePicked = useCallback(async () => {
    if (!detail || !live.size) return;
    setBusy(true);
    setSaid(null);
    const team = encodeURIComponent(detail.team.id);
    let members = 0;
    let invites = 0;
    const failed: string[] = [];

    for (const key of live) {
      const isMember = key.startsWith('m:');
      const value = key.slice(2);
      const who = isMember
        ? (detail.members.find((m) => m.id === value)?.name
          || detail.members.find((m) => m.id === value)?.email || 'somebody')
        : value;
      try {
        await call(isMember
          ? `?id=${team}&user=${encodeURIComponent(value)}`
          : `?id=${team}&invite=${encodeURIComponent(value)}`, { method: 'DELETE' });
        if (isMember) members += 1; else invites += 1;
      } catch (err) {
        failed.push(`${who} (${err instanceof Error ? err.message : 'refused'})`);
      }
    }

    await loadTeams();
    if (openId) await loadDetail(openId);
    setPicked(new Set());
    setBusy(false);

    /* Said as two counts rather than one, because they are two different things that happened: a person
     * lost access, an invitation that was never accepted is simply gone. */
    const done = [
      members ? `Removed ${members} ${members === 1 ? 'person' : 'people'}` : '',
      invites ? `cancelled ${invites} invitation${invites === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(', ');
    setSaid(failed.length
      ? { text: `${done || 'Nothing was removed'}. Could not remove ${failed.join('; ')}.`, kind: 'bad' }
      : { text: `${done}.`, kind: 'good' });
  }, [detail, live, openId, loadTeams, loadDetail]);

  /* Which TEAMS are ticked, on the list. A different selection from the roster's - one is people inside a
   * team, this is the teams themselves - so a different set, and they can never be on screen together.
   *
   * ONLY THE ONES YOU OWN can be ticked, because only an owner may delete a team. A tick that leads to
   * "not found" is a promise the row could not keep, and the row knows in advance. */
  const [pickedTeams, setPickedTeams] = useState<Set<string>>(new Set());
  const ownTeams = useMemo(() => (teams ?? []).filter((t) => t.role === 'owner').map((t) => t.id), [teams]);
  const liveTeams = useMemo(
    () => new Set([...pickedTeams].filter((id) => ownTeams.includes(id))),
    [pickedTeams, ownTeams],
  );

  /* Deleting several teams.
   *
   * One request each, for the reason the roster has: /api/team decides per team whether the caller may,
   * and every deletion takes a team away from everybody in it. Awaited one at a time, and what failed is
   * named - "Deleted 2 of 3" is a sentence somebody can act on. */
  const deletePickedTeams = useCallback(async () => {
    if (!liveTeams.size) return;
    setBusy(true);
    setSaid(null);
    const names = new Map((teams ?? []).map((t) => [t.id, t.name]));
    let gone = 0;
    const failed: string[] = [];

    for (const id of liveTeams) {
      try {
        await call(`?id=${encodeURIComponent(id)}&team=1`, { method: 'DELETE' });
        gone += 1;
        /* The panel is showing a team that no longer exists. Closed here rather than left to fail on its
         * next read. */
        if (id === openId) setOpenId(null);
      } catch (err) {
        failed.push(`${names.get(id) ?? id} (${err instanceof Error ? err.message : 'refused'})`);
      }
    }

    await loadTeams();
    setPickedTeams(new Set());
    setBusy(false);
    setSaid(failed.length
      ? {
        text: `${gone ? `Deleted ${gone} team${gone === 1 ? '' : 's'}` : 'Nothing was deleted'}. `
          + `Could not delete ${failed.join('; ')}.`,
        kind: 'bad',
      }
      : { text: `Deleted ${gone} team${gone === 1 ? '' : 's'}.`, kind: 'good' });
  }, [liveTeams, teams, openId, loadTeams]);

  /* Only skills, and only mine. Sharing a raw recording would put a payload in front of a team without the
   * step that turns it into something meant to be handed over. */
  const shareable = useMemo(
    () => flows.filter((f) => roleOf(f) === SKILL_ROLE
      && !detail?.shared.some((s) => s.flowId === f.id && s.ownerId === account?.id)),
    [flows, detail, account?.id],
  );

  const totals = useMemo(() => {
    const rows = teams ?? [];
    return { teams: rows.length, people: rows.reduce((n, t) => n + t.members, 0) };
  }, [teams]);

  return (
    <div className="relative min-h-full">
      <div className="mx-auto max-w-[1180px] p-5">

        {/* ------------------------------------------------------------ what this is, and the one act */}
        <header className="mb-5 flex flex-wrap items-start gap-5">
          <div className="min-w-[22rem] flex-1">
            <Typography variant="span" className={cn(LABEL, 'block')}>Teams</Typography>
            <Typography variant="h2" weight="semibold" className="mt-1 text-[1.7rem] leading-tight tracking-tight">
              Who may see whose work
            </Typography>
            <Typography variant="p" className="mt-1.5 max-w-[74ch] text-ink-inactive text-[0.86rem] leading-relaxed">
              A team lets the people running it see <span className="font-semibold text-ink-body">that</span>{' '}
              work is happening — who recorded, when, how runs ended. It does{' '}
              <span className="font-semibold text-ink-body">not</span> open what is in a recording: joining a
              team hands over nothing you have already made, and a skill becomes visible to it only when you
              share that one skill.
            </Typography>
          </div>

          <Button
            size="lg"
            className="shrink-0"
            leftSlot={<Plus className="size-[18px]" />}
            onClick={() => setMaking((was) => !was)}
          >
            Create a team
          </Button>
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

        {/* Naming it happens here rather than in a dialog: it is one field, and a dialog for one field is a
          * second window to open and close for something that takes four seconds. */}
        {making && (
          <form
            className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-stroke bg-surface-card p-3.5"
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
                setMaking(false);
                /* Straight into the new team: you made it in order to put somebody in it. */
                setOpenId(made.id);
              }, 'Team made. You own it.');
            }}
          >
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value.slice(0, 60))}
              placeholder="Name the team — Operations, Finance, a client…"
              className={cn(FIELD, 'min-w-[16rem] flex-1')}
            />
            <Button size="sm" type="submit" disabled={busy || !newName.trim()}>Create</Button>
            <Button
              variant="ghost" size="sm" type="button"
              onClick={() => { setMaking(false); setNewName(''); }}
            >
              Cancel
            </Button>
          </form>
        )}

        {/* ------------------------------------------------------------ the teams, one per row */}
        {teams && teams.length > 0 && (
          <SelectionBar
            className="pb-2"
            total={ownTeams.length}
            selected={liveTeams.size}
            onSelectAll={(all) => setPickedTeams(all ? new Set(ownTeams) : new Set())}
            onClear={() => setPickedTeams(new Set())}
            onConfirm={() => void deletePickedTeams()}
            busy={busy}
            busyLabel="Deleting…"
            label={(
              <span className="flex items-center gap-2.5 text-ink-inactive">
                <span>{totals.teams} {totals.teams === 1 ? 'team' : 'teams'}</span>
                <span className="h-3 w-px bg-stroke" />
                <span>{totals.people} {totals.people === 1 ? 'seat' : 'seats'} in total</span>
              </span>
            )}
          />
        )}

        <div className="overflow-x-auto pb-1">
          <div className="min-w-[52rem]">
            {teams && teams.length > 0 && (
              <div className={cn(COLUMNS, 'grid w-full items-center gap-x-3 px-3 pb-1.5', LABEL)}>
                <span />
                <span>Team</span>
                <span>Your role</span>
                <span>People</span>
                <span title="Skills members have deliberately shown this team">Shared skills</span>
                <span>Created</span>
                <span className="text-right">Actions</span>
              </div>
            )}

            <ul className="flex flex-col gap-1.5">
              {(teams ?? []).map((t) => {
                const ticked = liveTeams.has(t.id);
                return (
                <li key={t.id}>
                  {/* The whole row opens the team, not just the word at the end of it.
                    *
                    * NOT a <button> around all of this: it already contains a checkbox and a button, and a
                    * control inside a control is invalid HTML that behaves differently in every browser.
                    * The row is a MOUSE shortcut on top of a control that is still there - "Open" keeps the
                    * keyboard and the screen reader, so nothing is lost by this being a plain div.
                    *
                    * Anything that is itself a control has already done its own job, which is why the tick
                    * does not open the panel underneath it. */}
                  <div
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('button,input,select,a,[role="checkbox"]')) return;
                      setOpenId(t.id === openId ? null : t.id);
                    }}
                    className={cn(
                      ROW, COLUMNS, 'cursor-pointer',
                      ticked && 'border-brand-primary bg-state-pressed',
                      t.id === openId && !ticked && 'border-brand-primary bg-state-pressed',
                    )}
                  >
                    {t.role === 'owner' ? (
                      <Checkbox
                        checked={ticked}
                        aria-label={`Select ${t.name}`}
                        onCheckedChange={() => setPickedTeams((was) => {
                          const next = new Set(was);
                          if (!next.delete(t.id)) next.add(t.id);
                          return next;
                        })}
                      />
                    ) : (
                      /* Not yours to delete, so not yours to tick - but it keeps the column, or every name
                         below sits a checkbox further left than the ones above it. */
                      <span className="size-4 shrink-0" aria-hidden />
                    )}
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-state-pressed font-bold text-[0.75rem] text-brand-primary">
                        {(t.name || '?').trim()[0]?.toUpperCase()}
                      </span>
                      <span className="truncate font-semibold text-[0.9rem] text-ink-primary">{t.name}</span>
                    </span>
                    <span>
                      <Badge variant={ROLE_TONE[t.role]} size="xs" rounded="full">{t.role}</Badge>
                    </span>
                    <span className="flex items-center gap-1.5 text-[0.85rem] text-ink-body">
                      <Users className="size-3.5 shrink-0 text-ink-inactive" />
                      <span className="tabular-nums">{t.members}</span>
                    </span>
                    {/* Only the open team has been read in detail, so only it can say. A number for the
                      * others would be a number, and invented. */}
                    <span className="text-[0.84rem] text-ink-inactive">
                      {t.id === openId && detail ? (detail.shared.length || 'none yet') : '—'}
                    </span>
                    <span className="text-[0.82rem] text-ink-inactive tabular-nums">{when(t.created_at)}</span>
                    <span className="flex items-center justify-end gap-1.5">
                      {/* No chevron beside the word: the Button lays its children out in a row that wraps,
                        * and at this column width "Open" and the arrow came out on two lines. The word is
                        * doing the work anyway. */}
                      <Button
                        variant={t.id === openId ? 'secondary' : 'ghost'}
                        size="sm"
                        onClick={() => setOpenId(t.id === openId ? null : t.id)}
                      >
                        {t.id === openId ? 'Close' : 'Open'}
                      </Button>
                    </span>
                  </div>
                </li>
                );
              })}
            </ul>

            {teams && teams.length === 0 && (
              <div className="grid place-items-center rounded-xl border border-stroke border-dashed py-16 text-center">
                <Users className="size-7 text-ink-inactive" />
                <Typography variant="p" className="mt-2 max-w-[46ch] text-ink-inactive text-[0.86rem] leading-relaxed">
                  You are not in a team yet. Make one, then add the people you work with by their email
                  address — as many teams as you need, one per client or per department.
                </Typography>
              </div>
            )}

            {!teams && (
              <Typography variant="span" className="text-ink-inactive text-[0.85rem]">Reading…</Typography>
            )}
          </div>
        </div>
      </div>

      {/* -------------------------------------------------------------- one team, over the list */}
      {openId && (
        <>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpenId(null)}
            className="fixed inset-0 z-40 cursor-default bg-black/45"
          />
          <aside
            role="dialog"
            aria-label={detail ? detail.team.name : 'Team'}
            className={cn(
              'fixed inset-y-0 end-0 z-50 flex w-[min(560px,100vw)] flex-col',
              'border-stroke border-s bg-surface-card shadow-dropdown',
            )}
          >
            {!detail ? (
              <div className="grid flex-1 place-items-center text-[0.85rem] text-ink-inactive">Reading…</div>
            ) : (
              <>
                <div className="flex items-center gap-2.5 border-stroke border-b p-4">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-state-pressed font-bold text-[0.85rem] text-brand-primary">
                    {(detail.team.name || '?').trim()[0]?.toUpperCase()}
                  </span>

                  {renaming === detail.team.id ? (
                    <form
                      className="flex min-w-0 flex-1 items-center gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const name = newName.trim();
                        if (!name) return;
                        void act(
                          () => call(`?id=${encodeURIComponent(detail.team.id)}`, {
                            method: 'PATCH',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ name }),
                          }),
                          'Renamed.',
                        ).then(() => { setRenaming(null); setNewName(''); });
                      }}
                    >
                      <input
                        autoFocus
                        value={newName}
                        onChange={(e) => setNewName(e.target.value.slice(0, 60))}
                        className={cn(FIELD, 'min-w-0 flex-1')}
                      />
                      <Button size="xs" type="submit" disabled={busy || !newName.trim()}>Save</Button>
                      <Button variant="ghost" size="xs" type="button" onClick={() => setRenaming(null)}>
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <span className="flex min-w-0 flex-1 flex-col leading-[1.25]">
                      <strong className="truncate font-bold text-[1.05rem] text-ink-primary">
                        {detail.team.name}
                      </strong>
                      <span className="truncate text-[0.76rem] text-ink-inactive">
                        {detail.members.length} {detail.members.length === 1 ? 'person' : 'people'}
                        {detail.invites.length > 0
                          && ` · ${detail.invites.length} invitation${detail.invites.length === 1 ? '' : 's'} waiting`}
                        {` · made ${when(detail.team.created)}`}
                      </span>
                    </span>
                  )}

                  <Badge variant={ROLE_TONE[detail.you.role]} size="xs" rounded="full" className="shrink-0">
                    {detail.you.role}
                  </Badge>
                  <button
                    type="button"
                    onClick={() => setOpenId(null)}
                    aria-label="Close"
                    className="grid size-7 shrink-0 place-items-center rounded-md text-ink-inactive hover:bg-state-hover hover:text-ink-primary"
                  >
                    <X className="size-4" />
                  </button>
                </div>

                <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
                  <Typography variant="p" className="text-[0.8rem] text-ink-inactive leading-relaxed">
                    {ROLE_WORDS[detail.you.role]}.
                  </Typography>

                  {manages && (
                    <Link
                      to="/dashboard"
                      search={{ team: detail.team.id } as never}
                      className="flex items-center justify-center gap-2 rounded-lg border border-stroke px-3 py-2 text-[0.85rem] text-ink-body hover:border-stroke-hover hover:text-ink-primary"
                    >
                      <ChartNoAxesColumn className="size-4" />
                      This team’s dashboard
                    </Link>
                  )}

                  {/* -------- adding somebody */}
                  {manages && (
                    <div className="grid gap-2">
                      <span className={LABEL}>Add somebody</span>
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
                            /* The endpoint's own sentence, which knows whether the message went and why
                             * not. A generic "done" would be the app claiming something it did not check. */
                            if (out.note) setSaid({ text: out.note, kind: 'good' });
                          }, `${email} is in.`);
                        }}
                      >
                        <input
                          value={invite}
                          onChange={(e) => setInvite(e.target.value.slice(0, 200))}
                          placeholder="their email address"
                          type="email"
                          className={cn(FIELD, 'min-w-[12rem] flex-1')}
                        />
                        {detail.you.role === 'owner' && (
                          <select
                            value={inviteRole}
                            onChange={(e) => setInviteRole(e.target.value as Role)}
                            aria-label="Their role"
                            className="h-9 rounded-lg border border-stroke bg-surface-card2 px-2 text-[0.84rem] text-ink-primary focus:border-brand-primary focus:outline-none"
                          >
                            {(['member', 'admin', 'owner'] as Role[]).map((r) => (
                              <option key={r} value={r}>{r}</option>
                            ))}
                          </select>
                        )}
                        <Button size="sm" type="submit" disabled={busy || !invite.trim()}>Add</Button>
                      </form>

                      {/* Whether a message will actually go, said BEFORE an address is typed rather than
                        * after four colleagues have been added on the assumption that one would. */}
                      <div className="flex items-start gap-2 text-[0.76rem] leading-relaxed">
                        {mail?.configured ? (
                          <>
                            <Mail className="mt-0.5 size-3.5 shrink-0 text-brand-primary" />
                            <span className="text-ink-inactive">
                              They are emailed who added them, what a team does and does not open, and a
                              link. Somebody with no account yet is sent to sign up with that same address.
                            </span>
                          </>
                        ) : (
                          <>
                            <MailWarning className="mt-0.5 size-3.5 shrink-0 text-fb-attention" />
                            <span className="text-ink-inactive">
                              No email leaves this deployment yet{mail?.problem ? ` — ${mail.problem}` : ''}.
                              Somebody added is still in; tell them yourself.
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  )}

                  {/* -------- who is in it */}
                  <div className="grid gap-1.5">
                    <SelectionBar
                      total={pickable.length}
                      selected={live.size}
                      onSelectAll={(all) => setPicked(all ? new Set(pickable) : new Set())}
                      onClear={() => setPicked(new Set())}
                      onConfirm={() => void removePicked()}
                      verb="Remove"
                      busy={busy}
                      busyLabel="Removing…"
                      size="xs"
                      label={(
                        <span className={LABEL}>
                          {detail.members.length} {detail.members.length === 1 ? 'member' : 'members'}
                        </span>
                      )}
                    />

                    {detail.members.map((m) => {
                      const key = memberKey(m.id);
                      const yours = m.id === account?.id;
                      const ticked = live.has(key);
                      return (
                      <div
                        key={m.id}
                        className={cn(
                          'flex items-center gap-2.5 rounded-lg border border-stroke/45 bg-surface-card2 px-3 py-2.5',
                          ticked && 'border-brand-primary bg-state-pressed',
                        )}
                      >
                        {manages && (yours
                          /* Your own row cannot be ticked - see the note by `picked` - but it keeps the
                             space, or every name below it sits a checkbox further left than yours. */
                          ? <span className="size-4 shrink-0" aria-hidden />
                          : (
                            <Checkbox
                              checked={ticked}
                              aria-label={`Select ${m.name || m.email || 'this member'}`}
                              onCheckedChange={() => tick(key)}
                            />
                          ))}
                        <span
                          className={cn(
                            'grid size-8 shrink-0 place-items-center rounded-full font-bold text-[0.8rem]',
                            m.id === account?.id ? 'on-accent bg-brand-tertiary' : 'bg-grey-600 text-ink-primary',
                          )}
                        >
                          {(m.name || m.email || '?').trim()[0]?.toUpperCase()}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
                          <strong className="truncate font-semibold text-[0.86rem] text-ink-primary">
                            {m.name || m.email || m.id}
                            {m.id === account?.id && (
                              <span className="ms-1.5 font-normal text-[0.74rem] text-ink-inactive">you</span>
                            )}
                          </strong>
                          {/* One line, because the panel is 560px wide: the counts read as a sentence
                            * rather than as five columns each too narrow to label. */}
                          <span className="truncate text-[0.75rem] text-ink-inactive">
                            {m.activity
                              ? `${m.activity.recordings} recording${m.activity.recordings === 1 ? '' : 's'} · `
                                + `${m.activity.skills} skill${m.activity.skills === 1 ? '' : 's'} · `
                                + `${m.activity.runs} run${m.activity.runs === 1 ? '' : 's'}`
                                + (m.activity.lastRun ? ` · ran ${short(m.activity.lastRun)}` : ' · never ran')
                              : (m.email ?? 'in this team')}
                          </span>
                        </span>

                        {detail.you.role === 'owner' && m.id !== account?.id ? (
                          <select
                            value={m.role}
                            disabled={busy}
                            aria-label={`Role for ${m.name || m.email || 'this member'}`}
                            onChange={(e) => void act(
                              () => call(`?id=${encodeURIComponent(detail.team.id)}`, {
                                method: 'PATCH',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({ userId: m.id, role: e.target.value }),
                              }),
                              'Role changed.',
                            )}
                            className="h-7 shrink-0 rounded-md border border-stroke bg-surface-card px-1.5 text-[0.76rem] text-ink-primary focus:border-brand-primary focus:outline-none"
                          >
                            {(['owner', 'admin', 'member'] as Role[]).map((r) => (
                              <option key={r} value={r}>{r}</option>
                            ))}
                          </select>
                        ) : (
                          <Badge variant={ROLE_TONE[m.role]} size="xs" rounded="full" className="shrink-0">
                            {m.role}
                          </Badge>
                        )}

                        {(m.id === account?.id || manages) && (
                          <button
                            type="button"
                            disabled={busy}
                            title={m.id === account?.id ? 'Leave this team' : 'Remove from the team'}
                            aria-label={m.id === account?.id ? 'Leave this team' : `Remove ${m.name || m.email}`}
                            onClick={() => void act(
                              () => call(`?id=${encodeURIComponent(detail.team.id)}`
                                + (m.id === account?.id ? '' : `&user=${encodeURIComponent(m.id)}`),
                                { method: 'DELETE' }),
                              m.id === account?.id ? 'You left the team.' : 'Removed.',
                            )}
                            className="grid size-7 shrink-0 place-items-center rounded-md text-ink-inactive hover:bg-state-hover hover:text-fb-red-text"
                          >
                            <X className="size-3.5" />
                          </button>
                        )}
                      </div>
                      );
                    })}

                    {/* An invitation is a row here, not a section further down: a person who is not here
                      * yet, in the place people are. */}
                    {manages && detail.invites.map((i) => {
                      const key = inviteKey(i.email);
                      const ticked = live.has(key);
                      return (
                      <div
                        key={i.email}
                        className={cn(
                          'flex items-center gap-2.5 rounded-lg border border-stroke border-dashed px-3 py-2.5',
                          ticked && 'border-brand-primary bg-state-pressed',
                        )}
                      >
                        <Checkbox
                          checked={ticked}
                          aria-label={`Select the invitation to ${i.email}`}
                          onCheckedChange={() => tick(key)}
                        />
                        <span className="grid size-8 shrink-0 place-items-center rounded-full border border-stroke border-dashed text-ink-inactive">
                          <Mail className="size-3.5" />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
                          <strong title={i.email} className="truncate font-medium text-[0.84rem] text-ink-secondary">
                            {i.email}
                          </strong>
                          <span className="truncate text-[0.75rem] text-ink-inactive">
                            asked {short(i.created)} · no account yet
                          </span>
                        </span>
                        <Badge variant="attention" size="xs" rounded="full" className="shrink-0">{i.role}</Badge>
                        {mail?.configured && (
                          <button
                            type="button"
                            disabled={busy}
                            title="Send that invitation again"
                            aria-label={`Send the invitation to ${i.email} again`}
                            onClick={() => void act(
                              () => call(`?id=${encodeURIComponent(detail.team.id)}`
                                + `&remind=${encodeURIComponent(i.email)}`, { method: 'POST' }),
                              `Sent to ${i.email} again.`,
                            )}
                            className="grid size-7 shrink-0 place-items-center rounded-md text-ink-inactive hover:bg-state-hover hover:text-ink-primary"
                          >
                            <Send className="size-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busy}
                          title="Cancel this invitation"
                          aria-label={`Cancel the invitation to ${i.email}`}
                          onClick={() => void act(
                            () => call(`?id=${encodeURIComponent(detail.team.id)}`
                              + `&invite=${encodeURIComponent(i.email)}`, { method: 'DELETE' }),
                            'Invitation cancelled.',
                          )}
                          className="grid size-7 shrink-0 place-items-center rounded-md text-ink-inactive hover:bg-state-hover hover:text-fb-red-text"
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                      );
                    })}
                  </div>

                  {/* -------- shared skills */}
                  <div className="grid gap-1.5">
                    <span className="flex items-center gap-2">
                      <span className={LABEL}>Shared with this team</span>
                      {shareable.length > 0 && (
                        <Button
                          variant="ghost" size="xs" className="ms-auto"
                          onClick={() => setSharing((was) => !was)}
                          leftSlot={<Share2 className="size-3.5" />}
                        >
                          {sharing ? 'Never mind' : 'Share one of mine'}
                        </Button>
                      )}
                    </span>

                    {sharing && (
                      <div className="grid max-h-44 gap-0.5 overflow-auto rounded-lg border border-stroke p-1.5">
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
                          <span className="shrink-0 text-[0.75rem] text-ink-inactive">
                            {s.ownerId === account?.id ? 'yours' : s.owner || 'someone'}
                            {s.missing ? ' · since deleted' : ''}
                          </span>
                          {s.ownerId === account?.id && (
                            <button
                              type="button"
                              disabled={busy}
                              aria-label={`Stop sharing ${s.name || 'this skill'}`}
                              onClick={() => void act(
                                () => call(`?id=${encodeURIComponent(detail.team.id)}&share=${encodeURIComponent(s.flowId)}`,
                                  { method: 'DELETE' }),
                                'No longer shared.',
                              )}
                              className="ms-auto grid size-6 shrink-0 place-items-center rounded-md text-ink-inactive hover:bg-state-hover hover:text-fb-red-text"
                            >
                              <X className="size-3.5" />
                            </button>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* -------- the two things that change the team itself, together and out of the way */}
                {detail.you.role === 'owner' && (
                  <div className="flex items-center gap-2 border-stroke border-t p-4">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      leftSlot={<Pencil className="size-3.5" />}
                      onClick={() => { setRenaming(detail.team.id); setNewName(detail.team.name); }}
                    >
                      Rename
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      className="ms-auto text-fb-red-text"
                      leftSlot={<Trash2 className="size-3.5" />}
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
              </>
            )}
          </aside>
        </>
      )}
    </div>
  );
};
