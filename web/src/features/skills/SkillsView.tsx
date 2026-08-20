/* Skills: the flows on your account, from both halves, and the way to connect the extension.
 *
 * Each flow carries the half that made it, because that decides what can run it: a `web` flow points at
 * page elements and only the extension can replay it; a `desktop` flow points at screen coordinates and
 * only the local agent can. Offering the wrong one is a button that does something meaningless.
 */
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowRight, Braces, CircleDot, Cloud, Copy, Ellipsis, Globe, Link2, Lock, Monitor,
  MousePointerClick, Puzzle, RefreshCw, Search, Share2, Sparkles, Trash2, Upload, Wand2,
} from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { type Flow, galleryPublish, mintDeviceToken, push } from '@/lib/api';
import { handToExtension, watchBridge } from '@/lib/bridge';
import { listedInSkills } from '@/lib/flow-role';
import { Signal } from '@/components/Signal';
import { type RecordedEvent, useConsole } from '@/lib/store';
import { useAccount } from '@/shell/AccountProvider';
import { adoptRecording } from '@/features/record/adopt';
import {
  type SkillStructure,
  type WireFormat,
  WIRE_FORMATS,
  WIRE_LABELS,
  structureOf,
  wireFor,
} from '@/lib/skill-schema';

/* Same shape as the recordings table, and its last column is a FIXED width for the reason that one learned
 * the hard way: `auto` sizes to content, so a header word narrower than the buttons under it puts the whole
 * row out by hundreds of pixels. */
const SKILL_COLUMNS = 'grid-cols-[2rem_minmax(12rem,1fr)_7.5rem_7rem_6rem_6.5rem_15rem]';

/* Filters over the library. `all` is not a state a skill is in - it is the absence of a filter - so it sits
 * beside them rather than being one of them in the data. */
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'published', label: 'Published' },
  { id: 'private', label: 'Private' },
] as const;
type SkillFilter = typeof FILTERS[number]['id'];

/* Whether this skill has been published, and where to.
 *
 * Recorded by the publish itself - see `publish` below for why it cannot be read back out of the gallery -
 * so the answer is "yes and here is the listing id", or "not as far as this app knows". The second one is
 * deliberately not called a draft: a skill that runs and is simply not shared is not unfinished. */
const publishedAs = (flow: Flow): string | null => {
  const payload = flow.payload as Record<string, unknown> | undefined;
  const id = payload && typeof payload.publishedAs === 'string' ? payload.publishedAs.trim() : '';
  return id || null;
};

/* The events a skill carries, for the bars. A created skill has none - it holds a goal - and an empty list
 * draws an empty meter rather than nothing, which is the honest picture of "there are no events here". */
const eventsOf = (flow: Flow): RecordedEvent[] => {
  const raw = (flow.payload as Record<string, unknown> | undefined)?.events;
  return Array.isArray(raw) ? (raw as RecordedEvent[]) : [];
};

/* ------------------------------------------------------------------ what a skill is, spelled out
 *
 * A skill already has the shape of a tool: a name, a description, and the variable parts lifted out of the
 * goal by parameterise(). This is that shape made visible, and then written the three ways the APIs want it
 * - which differ by one key each, and seeing that is most of the value.
 */
const Structure = ({ skill, wire, onWire }: {
  skill: SkillStructure;
  wire: WireFormat;
  onWire: (next: WireFormat) => void;
}) => {
  const json = useMemo(() => JSON.stringify(wireFor(wire, skill), null, 2), [wire, skill]);
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (_) {
      /* Refused, which happens without a secure context or a user gesture the browser believes in. The
       * text is on screen and selectable either way, so this is not worth an error state. */
    }
  }, [json]);

  return (
    <details className="group mt-3 rounded-lg border-stroke border bg-surface-card2">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2">
        <Braces className="size-4 shrink-0 text-ink-inactive" />
        <Typography variant="span" weight="semibold" className="text-[0.82rem] text-ink-secondary">
          Structure
        </Typography>
        <span className="ms-auto shrink-0 font-mono text-[0.72rem] text-ink-inactive">
          {skill.toolName}
        </span>
      </summary>

      <div className="space-y-3 border-stroke border-t px-3 py-2.5">
        {/* The parsed skill first, in words, because the JSON below is the same thing for a machine. */}
        <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1 text-[0.8rem]">
          <dt className="text-ink-inactive">Runs on</dt>
          <dd className="break-words text-ink-body">{skill.runsHow}</dd>

          {skill.goalTemplate && (
            <>
              <dt className="text-ink-inactive">Goal</dt>
              <dd className="break-words font-mono text-[0.78rem] text-ink-body">{skill.goalTemplate}</dd>
            </>
          )}

          {skill.kind === 'recorded' && (
            <>
              <dt className="text-ink-inactive">Replays</dt>
              <dd className="text-ink-body">
                {skill.events} recorded action{skill.events === 1 ? '' : 's'}
              </dd>
            </>
          )}

          <dt className="text-ink-inactive">Takes</dt>
          <dd className="text-ink-body">
            {Object.keys(skill.schema.properties).length === 0 ? (
              <span className="text-ink-inactive">nothing — it replays as recorded</span>
            ) : (
              <ul className="space-y-0.5">
                {Object.entries(skill.schema.properties).map(([name, shape]) => (
                  <li key={name} className="break-words">
                    <span className="font-mono text-[0.78rem]">{name}</span>
                    <span className="text-ink-inactive">
                      {' '}{shape.format ?? shape.type}
                      {skill.schema.required.includes(name) ? ' · required' : ' · optional'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </dd>

          {skill.steps.length > 0 && (
            <>
              <dt className="text-ink-inactive">One run did</dt>
              {/* Evidence, not steps to replay - which is what a created skill keeps beside its goal. */}
              <dd className="break-words text-ink-secondary">
                {skill.steps.map((step) => step.name).join(' → ')}
              </dd>
            </>
          )}
        </dl>

        {/* --------------------------------------------------------- the same thing, on the wire */}
        <div>
          <div className="mb-1.5 flex items-center gap-1.5">
            <div className="flex gap-1">
              {WIRE_FORMATS.map((format) => (
                <button
                  key={format}
                  type="button"
                  onClick={() => onWire(format)}
                  className={cn(
                    'rounded-md px-2 py-1 text-[0.75rem] transition-colors duration-base',
                    wire === format
                      ? 'bg-brand-primary/15 font-semibold text-brand-primary'
                      : 'text-ink-inactive hover:bg-state-hover',
                  )}
                >
                  {WIRE_LABELS[format]}
                </button>
              ))}
            </div>
            <Button
              variant="tertiary"
              size="sm"
              className="ms-auto"
              leftSlot={<Copy className="size-3.5" />}
              onClick={() => { void copy(); }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          {/* Its own scroller: a schema is wide, and a page that scrolls sideways because of one code
            * block is a page nobody can read. */}
          <pre className="max-h-72 overflow-auto rounded-md border-stroke border bg-surface-chips p-2.5 font-mono text-[0.72rem] leading-relaxed text-ink-secondary">
            {json}
          </pre>
          <Typography variant="p" className="mt-1.5 text-ink-inactive text-[0.74rem]">
            {wire === 'openai'
              ? 'Responses API shape — name and parameters sit on the tool itself, not under a function key.'
              : wire === 'anthropic'
                ? 'Messages API shape — the schema goes under input_schema.'
                : 'What an MCP server advertises in tools/list — the schema goes under inputSchema.'}
            {' '}The work still happens on this machine: a tool definition is how something is asked for,
            not a promise about who does it.
          </Typography>
        </div>
      </div>
    </details>
  );
};

export const SkillsView = () => {
  const { flows, reload } = useAccount();
  /* The recordings this browser holds. Two uses, and the first one is a guarantee rather than a caution:
   * a row this browser knows to be a recording is not listed here at all, so the delete button below cannot
   * be over one. See lib/flow-role.ts for why an UNSTAMPED row defaults the way it does. */
  const [local] = useConsole();
  const localRecordings = useMemo(
    () => new Set(local.recordings.map((rec) => rec.id)),
    [local.recordings],
  );
  const skills = useMemo(
    () => flows.filter((flow) => listedInSkills(flow, localRecordings)),
    [flows, localRecordings],
  );

  const [term, setTerm] = useState('');
  const [filter, setFilter] = useState<SkillFilter>('all');
  /* Which row has its structure open. One at a time: two open panels push the list twice and the second is
   * never the one being read. */
  const [openRow, setOpenRow] = useState<string | null>(null);

  const shownSkills = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return skills.filter((flow) => {
      if (filter === 'published' && !publishedAs(flow)) return false;
      if (filter === 'private' && publishedAs(flow)) return false;
      if (!needle) return true;
      /* Searched over what is on the row plus where it runs, because "the one for outlook" is how somebody
       * looks for a skill they named something else. */
      return `${flow.name} ${flow.description} ${flow.origins.join(' ')}`.toLowerCase().includes(needle);
    });
  }, [skills, term, filter]);
  const navigate = useNavigate();
  const [bridge, setBridge] = useState({ present: false, paired: false, version: null as string | null });
  const [said, setSaid] = useState<{ text: string; kind: 'good' | 'bad' } | null>(null);
  /* Which delete is cocked. One at a time, and it disarms itself: a destructive button left ready is one
   * stray click from being pressed, which is the reasoning MyAccountScreen already carries. */
  const [armed, setArmed] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), 6000);
    return () => clearTimeout(timer);
  }, [armed]);

  const remove = useCallback(async (flow: Flow) => {
    setRemoving(flow.id);
    setSaid(null);
    try {
      /* Tombstoned rather than erased, which is the sync contract: a delete on one machine has to be able to
       * propagate instead of the flow reappearing from the next machine that syncs. */
      const done = await push({ deleted: [flow.id] });
      if (done.problems.length) throw new Error(done.problems.join('; '));
      await reload();
      setSaid({
        text: `Deleted "${flow.name}".`,
        kind: 'good',
      });
    } catch (err) {
      setSaid({ text: err instanceof Error ? err.message : 'could not delete it', kind: 'bad' });
    } finally {
      setRemoving(null);
      setArmed(null);
    }
  }, [reload]);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /* One choice for the page, not one per skill: somebody is integrating with a provider, not comparing
   * providers per skill, and a switch that reset itself on every row would be the wrong shape. */
  const [wire, setWire] = useState<WireFormat>('anthropic');

  useEffect(() => watchBridge((b) => setBridge({ present: b.present, paired: b.paired, version: b.version })), []);

  const connect = useCallback(async () => {
    setBusy(true);
    setToken(null);
    try {
      const body = await mintDeviceToken(bridge.present ? 'Chrome extension' : 'Device');
      /* With the extension present the token never has to be seen, let alone copied: it goes straight
       * across. It is only printed when nothing answered. */
      if (bridge.present) {
        const done = await handToExtension(body.token);
        if (done?.ok) {
          setSaid({ text: `The extension is connected${done.who?.name ? ` as ${done.who.name}` : ''}.`, kind: 'good' });
          setBridge((b) => ({ ...b, paired: true }));
          return;
        }
        setSaid({ text: done?.error ?? 'the extension did not answer - paste the token in by hand', kind: 'bad' });
      }
      setToken(body.token);
      try {
        await navigator.clipboard.writeText(body.token);
        setSaid({ text: 'Token copied. It is shown once — only its hash is stored.', kind: 'good' });
      } catch (_) {
        setSaid({ text: 'Shown once — only its hash is stored, so copy it now.', kind: 'good' });
      }
    } catch (err) {
      setSaid({ text: err instanceof Error ? err.message : 'could not create a token', kind: 'bad' });
    } finally {
      setBusy(false);
    }
  }, [bridge.present]);

  /* Arriving from the extension's sign-in button, which opens /skills?pair=extension.
   *
   * The click that started this was made in the extension and a Google sign-in has just been completed, so
   * there is nothing left to confirm - connect it and say so. Only when the extension reports it is NOT
   * already attached, so reopening this page does not mint a token every time. */
  const [autoTried, setAutoTried] = useState(false);
  useEffect(() => {
    const wants = new URLSearchParams(location.search).get('pair') === 'extension';
    if (!wants || autoTried || !bridge.present || bridge.paired) return;
    setAutoTried(true);
    void connect();
  }, [bridge, autoTried, connect]);

  const publish = useCallback(async (flow: Flow) => {
    if (!confirm(`Publish "${flow.name}" to the gallery? Anyone signed in can install it.`)) return;
    try {
      const body = await galleryPublish(flow.payload);
      /* Written down, because nothing else can answer it later. gallery_skill has no back-reference to the
       * flow it came from, and the listing does not carry the payload, so reading the gallery to find out
       * whether THIS skill is in it would be a fetch per skill. This is knowledge we have at the moment we
       * have it - and it keeps the gallery id, so a published skill can be linked to or withdrawn without a
       * search for it. */
      const listedId = body?.skill?.id ?? null;
      try {
        const saved = await push({
          flows: [{
            id: flow.id,
            source: flow.source,
            kind: flow.kind,
            name: flow.name,
            description: flow.description,
            origins: flow.origins,
            created: flow.created,
            payload: {
              ...(flow.payload as Record<string, unknown>),
              publishedAs: listedId,
              publishedAt: new Date().toISOString(),
            },
          }],
        });
        if (saved.problems.length) throw new Error(saved.problems.join('; '));
        await reload();
      } catch (err) {
        /* The publish itself worked, so this is not a failure of the thing that was asked for - it is the
         * bookkeeping about it. Said plainly rather than reported as a failed publish. */
        setSaid({
          text: `Published, but this app could not record that it was: ${
            err instanceof Error ? err.message : 'unknown error'
          }. It will keep reading as private here.`,
          kind: 'bad',
        });
        return;
      }
      setSaid({ text: 'Published. It is in the gallery under your name.', kind: 'good' });
    } catch (err) {
      setSaid({ text: err instanceof Error ? err.message : 'could not publish it', kind: 'bad' });
    }
  }, [reload]);

  return (
    <div className="p-5">
      {/* What a skill is made from, as the three things it passes through.
        *
        * The reference shows these stages as a promise - Recording, Structure, Skill. They carry the count on
        * THIS account instead, which makes the same card an answer to "what have I got" rather than an
        * explanation somebody reads once. */}
      <section className="mb-4 overflow-hidden rounded-xl border-stroke border bg-surface-card">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4 p-4">
          <div className="relative grid size-[104px] shrink-0 place-items-center">
            <span aria-hidden className="absolute size-full rounded-full border-stroke border-2" />
            <span aria-hidden className="absolute size-[76px] rounded-full border-stroke/60 border" />
            <span className="grid size-14 place-items-center rounded-full bg-brand-tertiary/20">
              <Wand2 className="size-6 text-brand-tertiary" />
            </span>
          </div>

          <div className="min-w-0 flex-1">
            <Typography variant="span" className="block text-[0.7rem] uppercase tracking-wide text-ink-inactive">
              Skill builder
            </Typography>
            <div className="mt-0.5 flex items-center gap-2">
              <span className={cn('size-2 shrink-0 rounded-full', local.recordings.length ? 'bg-fb-green' : 'bg-ink-inactive/60')} />
              <Typography variant="span" weight="semibold" className="text-[1.05rem]">
                {local.recordings.length ? 'Ready to build' : 'Nothing to build from yet'}
              </Typography>
            </div>
            <Typography variant="p" className="mt-1 max-w-[62ch] text-ink-inactive text-[0.85rem]">
              A skill is a recording with its variable parts lifted out, so it can be run again, handed to a
              model, or published for somebody else.
            </Typography>
          </div>

          {/* The three stages, each with what this account actually holds. An arrow between them because the
            * order is the point: nothing here can be made out of order. */}
          <div className="flex min-w-0 flex-wrap items-stretch gap-2">
            {[
              {
                icon: <CircleDot className="size-4" />,
                label: 'Recording',
                said: local.recordings.length
                  ? `${local.recordings.length} on this machine`
                  : 'none yet — record something',
              },
              {
                icon: <Braces className="size-4" />,
                label: 'Structure',
                said: 'steps and inputs',
              },
              {
                icon: <Sparkles className="size-4" />,
                label: 'Skill',
                said: `${skills.length} ready to run`,
              },
            ].map((stage, i) => (
              <Fragment key={stage.label}>
                {i > 0 && <ArrowRight className="size-4 self-center shrink-0 text-ink-inactive" />}
                <div className="min-w-[10rem] rounded-lg border-stroke/60 border bg-surface-card2 px-3 py-2.5">
                  <span className="flex items-center gap-1.5 text-ink-inactive">{stage.icon}</span>
                  <Typography variant="span" weight="semibold" className="mt-1 block text-[0.9rem]">
                    {stage.label}
                  </Typography>
                  <Typography variant="span" className="block text-[0.76rem] text-ink-inactive">
                    {stage.said}
                  </Typography>
                </div>
              </Fragment>
            ))}
          </div>
        </div>

        {/* Its own line, out of the card it was crowding: whether the extension in THIS browser is connected
          * is a fact about the browser, not about the library. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-stroke/60 border-t bg-surface-card2/40 px-4 py-2.5">
          <Cloud className="size-4 shrink-0 text-ink-inactive" />
          <Typography variant="span" weight="semibold" className="text-[0.85rem]">
            {bridge.paired ? 'Workspace synced' : 'One library, both halves'}
          </Typography>
          <Typography variant="span" className="min-w-0 text-ink-inactive text-[0.82rem]">
            {bridge.present
              ? bridge.paired
                ? `Desktop and browser skills are in one library${bridge.version ? ` · extension v${bridge.version}` : ''}.`
                : 'The extension is installed in this browser but not connected yet.'
              : 'A page and an extension cannot see each other’s storage — a browser guarantee, not an oversight — so an account is the only place the two halves meet.'}
          </Typography>
          <span className="ms-auto flex flex-wrap items-center gap-1.5">
            <Button
              variant={bridge.paired ? 'ghost' : 'primary'}
              size="sm"
              leftSlot={<Link2 className="size-4" />}
              isLoading={busy}
              onClick={connect}
            >
              {bridge.paired ? 'Extension connected' : bridge.present ? 'Connect this browser’s extension' : 'Connect an extension'}
            </Button>
            <Button variant="ghost" size="sm" leftSlot={<RefreshCw className="size-4" />} onClick={() => void reload()}>
              Refresh
            </Button>
          </span>
        </div>

        {token && (
          <div className="mt-3 rounded-md border-fb-green/40 border bg-surface-accent p-3">
            <Typography variant="span" weight="semibold" className="block text-[0.86rem]">
              Paste this into the extension, under Skills → Account
            </Typography>
            <pre className="mt-1.5 overflow-x-auto font-mono text-[0.78rem] text-ink-primary">{token}</pre>
            <Typography variant="p" className="mt-1 text-ink-inactive text-xs">
              Shown once — only its hash is stored, so it cannot be shown again. Make another any time.
            </Typography>
          </div>
        )}

        {said && (
          <Typography
            variant="p"
            className={cn('mt-3 text-[0.86rem]', said.kind === 'bad' ? 'text-fb-red-text' : 'text-fb-green')}
          >
            {said.text}
          </Typography>
        )}
      </section>

      {/* The library's own heading, under the builder rather than inside it: what a skill is and what you
        * have are two different statements, and one card saying both said neither clearly. */}
      {skills.length > 0 && (
        <div className="mb-3 flex flex-wrap items-end gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1">
            <Typography variant="span" className="block text-[0.7rem] uppercase tracking-wide text-ink-inactive">
              Library · {skills.length} skill{skills.length === 1 ? '' : 's'}
            </Typography>
            <Typography variant="h2" weight="semibold" className="mt-0.5 text-[1.35rem]">
              Your skills
            </Typography>
            <Typography variant="p" className="mt-0.5 max-w-[64ch] text-ink-inactive text-[0.85rem]">
              Open one, publish it, copy its definition, or trace it back to the recording it came from.
            </Typography>
          </div>

          <label className="relative min-w-[12rem] flex-1 sm:max-w-[22rem]">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-inactive" />
            <input
              value={term}
              onChange={(ev) => setTerm(ev.target.value)}
              placeholder="Search skills…"
              aria-label="Search skills"
              className={cn(
                'h-9 w-full rounded-md border-stroke border bg-surface-card2 pr-3 pl-8',
                'text-ink-primary placeholder:text-ink-inactive',
                'focus:border-input-focus focus:outline-none',
              )}
            />
          </label>

          {/* Counted, so choosing one is not a guess about whether it will be empty. */}
          <div className="flex shrink-0 items-center gap-0.5 rounded-md border-stroke border bg-surface-card2 p-0.5">
            {FILTERS.map(({ id, label }) => {
              const n = id === 'all'
                ? skills.length
                : skills.filter((flow) => (id === 'published') === !!publishedAs(flow)).length;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setFilter(id)}
                  className={cn(
                    'rounded px-2.5 py-1 text-[0.8rem] transition-colors duration-base',
                    filter === id
                      ? 'bg-brand-primary/15 font-semibold text-brand-primary'
                      : 'text-ink-secondary hover:bg-state-hover',
                  )}
                >
                  {label}
                  <span className="ms-1 text-ink-inactive tabular-nums">{n}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {skills.length === 0 ? (
        <Typography variant="p" className="max-w-[60ch] text-ink-inactive">
          {/* Two different emptinesses, and saying the first over the second would be a worse lie than the
            * bug this replaced: an account holding four recordings is not an empty account. */}
          {flows.length === 0 ? (
            <>
              Nothing on your account yet. Record something and press <strong>Save as skill</strong>, or
              connect the extension above and press <strong>Sync now</strong> in it.
            </>
          ) : (
            <>
              No skills yet — your {flows.length} recording{flows.length === 1 ? '' : 's'}{' '}
              {flows.length === 1 ? 'is' : 'are'} on the <strong>Record</strong> page. Press{' '}
              <strong>Save as skill</strong> on one there to make a skill from it, which is a separate copy:
              deleting the skill afterwards leaves the recording alone.
            </>
          )}
        </Typography>
      ) : (
        <div className="overflow-x-auto pb-1">
          <div className="min-w-[56rem]">
          {/* Same template as the rows, so the labels line up rather than approximately line up - the lesson
              the recordings table learned when its last column was `auto` and the header sat 280px off. */}
          <div
            className={cn(
              SKILL_COLUMNS,
              'grid w-full items-center gap-x-3 px-3 pb-1.5',
              'text-[0.7rem] uppercase tracking-wide text-ink-inactive',
            )}
          >
            <span />
            <span>Skill</span>
            <span title="When its events happened, and what it takes as input">Structure</span>
            <span title="Which half can run it">Source</span>
            <span>Updated</span>
            <span>Status</span>
            <span className="text-right">Actions</span>
          </div>

          {shownSkills.length === 0 && (
            <Typography variant="p" className="py-6 text-center text-ink-inactive text-[0.88rem]">
              {term
                ? `Nothing matches “${term}”${filter === 'all' ? '' : ` in ${filter} skills`}.`
                : `No ${filter} skills.`}
            </Typography>
          )}

          <ul className="flex flex-col gap-1.5">
            {shownSkills.map((flow) => {
              const structure = structureOf(flow);
              const listing = publishedAs(flow);
              const events = eventsOf(flow);
              const inputs = Object.keys(structure.schema.properties).length;

              return (
                <li key={flow.id}>
                  <div
                    className={cn(
                      SKILL_COLUMNS,
                      'grid w-full items-center gap-x-3 rounded-lg px-3 py-2',
                      'border border-stroke/45 bg-surface-card shadow-rest transition-colors duration-fast',
                      'hover:border-card-border-hover',
                      openRow === flow.id && 'border-brand-primary',
                    )}
                  >
                    <span className="grid size-8 place-items-center rounded-lg bg-surface-card2">
                      {flow.kind === 'created'
                        ? <Sparkles className="size-4 text-brand-tertiary" />
                        : <MousePointerClick className="size-4 text-brand-primary" />}
                    </span>

                    <span className="flex min-w-0 flex-col">
                      <Typography variant="span" weight="semibold" className="truncate text-[0.9rem]">
                        {flow.name || 'Untitled'}
                      </Typography>
                      <span className="truncate text-[0.78rem] text-ink-inactive">
                        {flow.description
                          || (flow.origins.length ? `In ${flow.origins.slice(0, 3).join(', ')}.` : 'No description.')}
                      </span>
                    </span>

                    {/* The bars from its own events, and the counts from its schema. A created skill has no
                        events - it holds a goal - so the meter is empty and says so rather than being hidden,
                        which would make the column look broken for half the rows. */}
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <Signal events={events} bars={10} className="h-4" />
                      <span className="text-[0.74rem] text-ink-inactive tabular-nums">
                        {events.length
                          ? `${events.length} step${events.length === 1 ? '' : 's'}`
                          : 'a goal'}
                        {' · '}
                        {inputs} input{inputs === 1 ? '' : 's'}
                      </span>
                    </span>

                    <span>
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-state-hover px-2 py-0.5 text-[0.74rem] text-ink-secondary"
                        title={flow.source === 'desktop'
                          ? 'Points at screen coordinates — the local agent replays it'
                          : 'Points at page elements — the extension replays it'}
                      >
                        {flow.source === 'desktop'
                          ? <><Monitor className="size-3" />Desktop</>
                          : <><Puzzle className="size-3" />Extension</>}
                      </span>
                    </span>

                    <span className="text-[0.76rem] text-ink-secondary tabular-nums">
                      {flow.updated || flow.created
                        ? new Date((flow.updated || flow.created) as string).toLocaleDateString()
                        : '—'}
                    </span>

                    {/* Published because publishing recorded it. The other state is NOT called a draft: a
                        skill that runs and is simply not shared is not unfinished. */}
                    <span>
                      {listing ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-fb-green/12 px-2 py-0.5 text-[0.72rem] font-semibold text-fb-green"
                          title={`In the gallery as ${listing}`}
                        >
                          <Globe className="size-3" />
                          Published
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-state-hover px-2 py-0.5 text-[0.72rem] font-semibold text-ink-secondary"
                          title="Not in the gallery, as far as this app knows. A skill published before this app started recording that will read as private until it is published again."
                        >
                          <Lock className="size-3" />
                          Private
                        </span>
                      )}
                    </span>

                    <span className="flex items-center justify-end gap-1">
                      {flow.source === 'desktop' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          leftSlot={<Monitor className="size-4" />}
                          onClick={() => {
                            adoptRecording(flow);
                            void navigate({ to: '/record' });
                          }}
                        >
                          Open
                        </Button>
                      ) : (
                        <span
                          className="px-1 text-[0.76rem] text-ink-inactive"
                          title="This one aims at page elements, so the extension is the half that can replay it"
                        >
                          In the extension
                        </span>
                      )}

                      <Button
                        variant="ghost"
                        size="sm"
                        leftSlot={<Share2 className="size-4" />}
                        onClick={() => void publish(flow)}
                      >
                        {listing ? 'Republish' : 'Publish'}
                      </Button>

                      <Button
                        variant={openRow === flow.id ? 'secondary' : 'ghost'}
                        size="sm"
                        aria-label={`More for ${flow.name}`}
                        aria-expanded={openRow === flow.id}
                        title="Its structure, a copy of it, and delete"
                        className="!size-8 !p-0"
                        onClick={() => setOpenRow((open) => (open === flow.id ? null : flow.id))}
                      >
                        <Ellipsis className="size-4" />
                      </Button>
                    </span>
                  </div>

                  {openRow === flow.id && (
                    <div className="mt-1 rounded-lg border-stroke/45 border bg-surface-card2 p-3">
                      <Structure skill={structure} wire={wire} onWire={setWire} />

                      <div className="mt-3 flex flex-wrap items-center gap-1.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          leftSlot={<Copy className="size-4" />}
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(JSON.stringify(flow.payload, null, 2));
                              setSaid({ text: 'Copied it.', kind: 'good' });
                            } catch (_) {
                              setSaid({ text: 'The clipboard was blocked.', kind: 'bad' });
                            }
                          }}
                        >
                          Copy the payload
                        </Button>

                        <Button
                          variant={armed === flow.id ? 'destructive' : 'destructiveTertiary'}
                          size="sm"
                          className="ms-auto"
                          isLoading={removing === flow.id}
                          leftSlot={<Trash2 className="size-4" />}
                          onClick={() => {
                            if (armed !== flow.id) { setArmed(flow.id); return; }
                            void remove(flow);
                          }}
                        >
                          {armed === flow.id ? 'Delete — press again' : 'Delete'}
                        </Button>
                      </div>

                      {/* Only when it is cocked, and only what is true. Three separate facts, and the first
                        * one is the one that cost somebody a transcript: a recording and the skill listed
                        * here can be the same row, so deleting it here deletes the recording. A published
                        * copy is a different thing on a different table and survives; withdrawing is in the
                        * gallery. */}
                      {armed === flow.id && (
                        <Typography variant="p" className="mt-2 max-w-[76ch] text-fb-attention text-[0.78rem]">
                          {local.recordings.some((rec) => rec.id === flow.id) ? (
                            <>
                              This is the recording “{flow.name}” on the Record page — the same thing, not a
                              copy. Deleting it here removes it from Record too, and its transcript with
                              it.{' '}
                            </>
                          ) : null}
                          This removes it from your account and from every machine that syncs.
                          {listing ? ' The gallery listing stays until you withdraw it there.' : ''}
                        </Typography>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          </div>
        </div>
      )}

      <Typography variant="p" className="mt-5 max-w-[70ch] text-ink-inactive text-xs">
        <Upload className="mb-0.5 inline size-3.5" /> A skill made in the extension appears here once it
        syncs; one made here appears there after the extension’s next sync. Publishing is always a separate,
        deliberate act.
      </Typography>
    </div>
  );
};
