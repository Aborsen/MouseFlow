/* Skills: the flows on your account, from both halves, and the way to connect the extension.
 *
 * Each flow carries the half that made it, because that decides what can run it: a `web` flow points at
 * page elements and only the extension can replay it; a `desktop` flow points at screen coordinates and
 * only the local agent can. Offering the wrong one is a button that does something meaningless.
 */
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowRight, Braces, CircleDot, Copy, Ellipsis, Globe, Link2, Lock, Monitor,
  MousePointerClick, Puzzle, RefreshCw, Search, Share2, Sparkles, Trash2, Upload, Wand2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { describeRecording, hasSkillFor, saveAsSkill } from '@/features/record/save-as-skill';
import { SkillWizard } from '@/features/record/SkillWizard';
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

/* Блок «Ready to become a skill» - одного размера всегда.
 *
 * Шесть строк это и максимум (больше здесь не нужно - остальные на Record), и МИНИМУМ высоты. Без второго
 * блок терял строку на каждое «Save as skill»: страница подпрыгивала под курсором ровно в тот момент, когда
 * человек тянулся к следующей кнопке, и вторым нажатием попадал не туда, куда смотрел.
 *
 * Высота строки и высота списка выведены из ОДНОГО числа. Два похожих литерала - `3.25rem` в строке и
 * посчитанный руками итог в списке - однажды разойдутся, и разойдутся молча: список станет короче своего
 * содержимого и обрежет последнюю строку. minHeight, а не height, по той же причине: в узком окне строка
 * переносит кнопку на второй ряд и должна вырасти, а не спрятать её под краем.
 */
const READY_SHOWN = 6;
/* Измеренная высота строки, а не выбранная: две строки текста (0.88rem и 0.76rem) плюс py-2 дают ровно
 * 57px = 3.5625rem. Число, взятое на глаз, я тут уже поставил - 3.25rem - и получил блок, который при шести
 * строках всё равно выше, чем при трёх, то есть ровно ту прыгающую страницу, от которой резерв и заводился.
 * Проверяется единственным способом, которым такое проверяется: измерить блок с одной строкой и с шестью и
 * сравнить: 57.33px на строку, шесть строк и пять промежутков - 374px, и столько же при одной строке. */
const READY_ROW = 3.583;
const READY_GAP = 0.375;  // rem - gap-1.5 между строками
const READY_MIN = `${READY_SHOWN * READY_ROW + (READY_SHOWN - 1) * READY_GAP}rem`;

/* Когда запись сделана. Нечитаемое значение - 0, чтобы оно тонуло в конец списка, а не тасовало его: NaN в
 * компараторе оставляет порядок на усмотрение движка. */
const madeAt = (rec: { created?: string }) => {
  const t = Date.parse(rec.created ?? '');
  return Number.isFinite(t) ? t : 0;
};

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
  /* Какая запись сейчас превращается в скилл. По одной: две одновременные записи в аккаунт по одной кнопке -
   * это два прогона одного намерения, и второй не нужен. */
  const [making, setMaking] = useState<string | null>(null);

  /* Записи, из которых скилла ещё НЕТ.
   *
   * Только такие: предложить «сделать скилл» из записи, у которой он есть, значит пригласить к дублю - а id
   * выведен из id записи, поэтому второе нажатие молча перезаписало бы существующий скилл. Те, что уже
   * превращены, и так ниже, в списке скиллов. */
  const convertible = useMemo(
    () => local.recordings
      .filter((rec) => !hasSkillFor(flows, rec.id))
      /* Новейшие первыми, и это исправление, а не вкус: записи дописываются в КОНЕЦ списка, а список
       * обрезан шестью - то есть показывались шесть самых СТАРЫХ, а сделанная минуту назад пряталась за
       * «4 more are on the Record page». Ровно наоборот тому, зачем сюда приходят.
       *
       * Ключ - created, а не позиция в массиве: после восстановления с аккаунта порядок массива - это
       * порядок ответа сервера, а created переживает и сохранение, и восстановление. Нечитаемое значение
       * тонет в конец, а не тасует список: NaN в компараторе делает порядок неопределённым. */
      .sort((a, b) => madeAt(b) - madeAt(a)),
    [local.recordings, flows],
  );

  /* Который скилл делаем визардом. Отдельная величина, а не флаг рядом с `making`: буквальный повтор
   * сохраняется одним нажатием, а этот путь - разговор, и пока он идёт список должен жить дальше. */
  const [wizardFor, setWizardFor] = useState<typeof local.recordings[number] | null>(null);

  /* Arriving here from the Record page's Skill button, which sends `?make=<recording id>`.
   *
   * Waits for the recordings to load rather than reading them once: they come out of the local console
   * asynchronously, so on the first render after a navigation the list is usually still empty and a
   * one-shot lookup would silently find nothing. The parameter is dropped as soon as it is used, so going
   * back to this page later does not reopen a wizard nobody asked for.
   *
   * An id this browser does not have is SAID rather than ignored — a recording lives in the browser that
   * made it, so following the link on a second machine finds nothing, and silence would read as a broken
   * button. */
  /* Read here, ACTED ON below `said` — the effect that consumes it calls setSaid, and putting the two
   * beside each other keeps a reader from having to know that a closure defers the lookup. */
  const [asked, setAsked] = useState<string | null>(() => {
    try {
      return new URLSearchParams(window.location.search).get('make');
    } catch (_) {
      return null;
    }
  });


  const convert = useCallback(async (rec: typeof local.recordings[number]) => {
    setMaking(rec.id);
    setSaid(null);
    try {
      await saveAsSkill(rec);
      await reload();
      setSaid({ text: `"${rec.name}" is a skill now — the recording is untouched.`, kind: 'good' });
    } catch (err) {
      setSaid({
        text: err instanceof Error ? err.message : 'it could not be saved as a skill',
        kind: 'bad',
      });
    } finally {
      setMaking(null);
    }
  }, [reload]);

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

  useEffect(() => {
    if (!asked || !local.recordings.length) return;
    const found = local.recordings.find((rec) => rec.id === asked);
    setAsked(null);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('make');
      window.history.replaceState(null, '', url.toString());
    } catch (_) { /* the address is a convenience here, not the state */ }
    if (found) setWizardFor(found);
    else {
      setSaid({
        text: 'That recording is not in this browser. A recording stays on the machine that made it, so '
          + 'open the link there — or record it again here.',
        kind: 'bad',
      });
    }
  }, [asked, local.recordings]);
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
      {/* КУЗНИЦА.
        *
        * Два размера, и это не украшение. В макете, по которому это сделано, библиотеки нет вовсе - там «No
        * skills yet» - то есть макет показывает ПУСТОЕ состояние. Копировать его буквально значило бы отдать
        * пол-экрана объяснению человеку с двадцатью скиллами. Поэтому при нуле скиллов страница выглядит как
        * макет, а как только скилл появился, кузница сжимается в полосу и место уходит библиотеке. */}
      {skills.length === 0 ? (
        <section className="mb-4 overflow-hidden rounded-2xl border-stroke border bg-gradient-to-br from-surface-card via-surface-card to-brand-tertiary/[0.07] p-6">
          <div className="grid gap-6 xl:grid-cols-[minmax(20rem,32rem)_1fr]">
            <div className="min-w-0">
              <Typography variant="span" className="block text-[0.7rem] uppercase tracking-[0.14em] text-ink-inactive">
                Skill foundry
                {' · '}
                <span className={convertible.length ? 'text-fb-green' : 'text-ink-inactive'}>
                  {convertible.length ? 'ready' : 'nothing to build from'}
                </span>
              </Typography>

              <Typography variant="h2" weight="semibold" className="mt-2 max-w-[26ch] text-[2rem] leading-[1.12] tracking-tight">
                Turn one recording into a reusable skill.
              </Typography>

              <Typography variant="p" className="mt-2.5 max-w-[52ch] text-ink-secondary text-[0.9rem]">
                {convertible.length
                  ? `Your ${convertible.length === 1 ? 'first recording is' : `${convertible.length} recordings are`} ready. A skill is a separate copy with the variable parts lifted out — the recording stays exactly as it is.`
                  : 'Record something on the Record page first, then it can be shaped into a skill here — a separate copy, with the recording left exactly as it is.'}
              </Typography>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                {convertible.length ? (
                  <Button
                    leftSlot={<Sparkles className="size-4" />}
                    isLoading={making === convertible[0].id}
                    disabled={!!making}
                    onClick={() => void convert(convertible[0])}
                  >
                    Build from “{(convertible[0].name || 'recording').slice(0, 22)}”
                  </Button>
                ) : (
                  <Button
                    leftSlot={<CircleDot className="size-4" />}
                    onClick={() => void navigate({ to: '/record' })}
                  >
                    Record something
                  </Button>
                )}
                <Button
                  variant="ghost"
                  leftSlot={<Link2 className="size-4" />}
                  isLoading={busy}
                  onClick={connect}
                >
                  {bridge.paired ? 'Extension connected' : 'Connect extension'}
                </Button>
              </div>
            </div>

            {/* Три стадии. В 01 - настоящая запись; в 02 и 03 скелетоны, потому что структуры и скилла ещё
              * нет, и цифры там пришлось бы придумать. Скелетон читается как «дальше будет», число - как
              * «уже есть». */}
            <div className="grid min-w-0 gap-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:items-stretch">
              <div className="min-w-0 rounded-xl border-brand-primary/40 border bg-surface-card2 p-3.5">
                <span className="inline-flex rounded-md border-brand-primary/40 border bg-brand-primary/10 px-1.5 py-0.5 font-mono text-[0.68rem] text-brand-primary">01</span>
                <Typography variant="span" weight="semibold" className="mt-2 block text-[0.92rem]">Recording</Typography>
                <Typography variant="span" className="block text-[0.76rem] text-ink-inactive">
                  Captured behaviour from this machine
                </Typography>
                {convertible.length > 0 ? (
                  <div className="mt-2.5 rounded-lg border-stroke border bg-surface-card p-2.5">
                    <Typography variant="span" weight="semibold" className="block truncate text-[0.84rem]">
                      {convertible[0].name || 'Untitled recording'}
                    </Typography>
                    <span className="block truncate text-[0.74rem] text-ink-inactive">
                      {describeRecording(convertible[0]).replace(/^Repeats /, '').replace(/\.$/, '')}
                    </span>
                  </div>
                ) : (
                  <Typography variant="p" className="mt-2.5 text-ink-inactive text-[0.76rem]">
                    Nothing recorded in this browser yet.
                  </Typography>
                )}
              </div>

              <ArrowRight className="hidden size-4 self-center text-ink-inactive sm:block" />

              <div className="min-w-0 rounded-xl border-stroke/60 border bg-surface-card2/60 p-3.5">
                <span className="inline-flex rounded-md border-stroke border px-1.5 py-0.5 font-mono text-[0.68rem] text-ink-inactive">02</span>
                <Typography variant="span" weight="semibold" className="mt-2 block text-[0.92rem]">Structure</Typography>
                <Typography variant="span" className="block text-[0.76rem] text-ink-inactive">
                  Steps and the inputs that can change
                </Typography>
                {/* Скелетон, а не цифры: структуры ещё нет. */}
                <div className="mt-3 space-y-1.5" aria-hidden>
                  <span className="block h-1.5 w-full rounded-full bg-stroke" />
                  <span className="block h-1.5 w-3/5 rounded-full bg-stroke" />
                </div>
              </div>

              <ArrowRight className="hidden size-4 self-center text-ink-inactive sm:block" />

              <div className="min-w-0 rounded-xl border-stroke/60 border bg-surface-card2/60 p-3.5">
                <span className="inline-flex rounded-md border-stroke border px-1.5 py-0.5 font-mono text-[0.68rem] text-ink-inactive">03</span>
                <Typography variant="span" weight="semibold" className="mt-2 block text-[0.92rem]">Skill</Typography>
                <Typography variant="span" className="block text-[0.76rem] text-ink-inactive">
                  A reusable workflow you control
                </Typography>
                <span className="mt-3 grid size-9 place-items-center rounded-full border-brand-tertiary/40 border bg-brand-tertiary/10">
                  <Sparkles className="size-4 text-brand-tertiary" />
                </span>
              </div>
            </div>
          </div>
        </section>
      ) : (
        /* Есть скиллы - кузница сжимается в полосу. Те же факты, одна строка. */
        <section className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border-stroke border bg-surface-card px-4 py-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-tertiary/15">
            <Wand2 className="size-4 text-brand-tertiary" />
          </span>
          <div className="min-w-0 flex-1">
            <Typography variant="span" weight="semibold" className="block text-[0.92rem]">
              {convertible.length
                ? `${convertible.length} recording${convertible.length === 1 ? '' : 's'} ready to become a skill`
                : 'Every recording here is already a skill'}
            </Typography>
            <Typography variant="span" className="block text-[0.8rem] text-ink-inactive">
              A skill is a separate copy — deleting it later leaves the recording alone.
            </Typography>
          </div>
          <Button
            variant="ghost"
            size="sm"
            leftSlot={<Link2 className="size-4" />}
            isLoading={busy}
            onClick={connect}
          >
            {bridge.paired ? 'Extension connected' : 'Connect extension'}
          </Button>
          <Button variant="ghost" size="sm" leftSlot={<RefreshCw className="size-4" />} onClick={() => void reload()}>
            Refresh
          </Button>
        </section>
      )}


      {/* Токен для расширения. Показывается один раз - хранится только его хэш - поэтому он не может быть
        * ни всплывашкой, ни строчкой, которая исчезнет при следующем рендере. */}
      {token && (
        <div className="mb-4 rounded-xl border-fb-green/40 border bg-surface-accent p-3.5">
          <Typography variant="span" weight="semibold" className="block text-[0.88rem]">
            Paste this into the extension, under Skills → Account
          </Typography>
          <pre className="mt-1.5 overflow-x-auto font-mono text-[0.78rem] text-ink-primary">{token}</pre>
          <Typography variant="p" className="mt-1 text-ink-inactive text-xs">
            Shown once — only its hash is stored, so it cannot be shown again. Make another any time.
          </Typography>
        </div>
      )}

      {/* Чем кончилось последнее действие. Без этого «Save as skill» и «Publish» молчат. */}
      {said && (
        <Typography
          variant="p"
          className={cn(
            'mb-4 max-w-[86ch] break-words text-[0.85rem]',
            said.kind === 'good' ? 'text-fb-green' : 'text-fb-red-text',
          )}
        >
          {said.text}
        </Typography>
      )}

      {/* Записи, готовые стать скиллом.
        *
        * Раньше за этим надо было идти на Record - при том что вся страница про скиллы и человек пришёл сюда
        * именно за этим. Показываются только те, у которых скилла ещё нет: id скилла выведен из id записи,
        * так что второе нажатие перезаписало бы существующий, а список, приглашающий к этому, - ловушка. */}
      <div className={cn('mb-4 grid gap-4', skills.length === 0 && convertible.length > 0 && 'xl:grid-cols-2')}>
      {convertible.length > 0 && (
        <section className="rounded-xl border-stroke border bg-surface-card p-4">
          <div className="mb-2.5 flex flex-wrap items-center gap-2">
            <CircleDot className="size-4 shrink-0 text-brand-primary" />
            <Typography variant="h3" weight="semibold" className="text-[0.95rem]">
              Ready to become a skill
            </Typography>
            <span className="ms-auto shrink-0 rounded-full bg-brand-primary/12 px-2 py-0.5 text-[0.74rem] font-semibold text-brand-primary tabular-nums">
              {convertible.length} recording{convertible.length === 1 ? '' : 's'}
            </span>
          </div>

          <Typography variant="p" className="mb-2.5 max-w-[74ch] text-ink-inactive text-[0.82rem]">
            Recordings in this browser that have no skill yet. Making one is a separate copy — the recording
            stays exactly as it is, and deleting the skill later leaves it alone.
          </Typography>

          <ul className="flex flex-col gap-1.5" style={{ minHeight: READY_MIN }}>
            {convertible.slice(0, READY_SHOWN).map((rec) => (
              <li
                key={rec.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border-stroke/45 border bg-surface-card2 px-3 py-2"
                style={{ minHeight: `${READY_ROW}rem` }}
              >
                <span className="flex items-center"><Signal events={rec.events} bars={10} className="h-4" /></span>

                <span className="flex min-w-0 flex-1 flex-col">
                  <Typography variant="span" weight="semibold" className="truncate text-[0.88rem]">
                    {rec.name || 'Untitled recording'}
                  </Typography>
                  <span className="truncate text-[0.76rem] text-ink-inactive">
                    {describeRecording(rec)}
                  </span>
                </span>

                {/* Два исхода, и разница между ними стоит того, чтобы стоять рядом. «Repeat it exactly» -
                  * то, что было: буквальный повтор координат, бесплатный и быстрый, и он не печатает,
                  * потому что содержимое нажатий нигде не хранится. Визард спрашивает недостающий текст
                  * один раз и делает скилл-ЦЕЛЬ: он печатает, перечитывает экран и уезжает к ИИ с
                  * параметрами. См. SkillWizard.tsx. */}
                <Button
                  variant="secondary"
                  size="sm"
                  isLoading={making === rec.id}
                  disabled={!!making}
                  onClick={() => void convert(rec)}
                >
                  Repeat it exactly
                </Button>
                <Button
                  size="sm"
                  leftSlot={<Sparkles className="size-4" />}
                  disabled={!!making}
                  onClick={() => setWizardFor(rec)}
                >
                  Make a skill
                </Button>
              </li>
            ))}
          </ul>

          {/* Молчаливое усечение читается как «это все»: если их больше, чем показано, надо сказать где
            * остальные, а не оставить человека считать. */}
          {/* Молчаливое усечение читается как «это все»: если их больше, чем показано, надо сказать где
            * остальные, а не оставить человека считать. Показаны при этом САМЫЕ СВЕЖИЕ - что и делает
            * усечение приемлемым: спрятано старое, а не только что записанное. */}
          {convertible.length > READY_SHOWN && (
            <Typography variant="p" className="mt-2 text-ink-inactive text-[0.78rem]">
              {convertible.length - READY_SHOWN} older{' '}
              {convertible.length - READY_SHOWN === 1 ? 'one is' : 'ones are'} on the{' '}
              <strong>Record</strong> page.
            </Typography>
          )}
        </section>
      )}

      {/* Что дальше. Метки справа - три факта, каждый из которых иначе спрашивают вслух: структура
        * открывается сразу, тест идёт здесь и никуда не уходит, публикация никогда не случается сама. Только
        * в пустом состоянии: человеку с двадцатью скиллами нужно место, а не объяснение. */}
      {skills.length === 0 && convertible.length > 0 && (
        <section className="rounded-xl border-stroke border bg-surface-card p-4">
          <Typography variant="h3" weight="semibold" className="text-[0.95rem]">
            What happens next
          </Typography>
          <Typography variant="p" className="mt-0.5 mb-2.5 text-ink-inactive text-[0.82rem]">
            You stay in control at every stage.
          </Typography>

          <ol className="divide-stroke/60 divide-y">
            {[
              {
                n: 1,
                title: 'Look at the structure',
                said: 'Its steps and inputs, and the same definition an API would be handed.',
                tag: 'Next',
                tone: 'text-brand-primary',
              },
              {
                n: 2,
                title: 'Run it on this machine',
                said: 'The local agent replays it here. Nothing about the run leaves your account.',
                tag: 'Private',
                tone: 'text-ink-inactive',
              },
              {
                n: 3,
                title: 'Publish it, if you want to',
                said: 'It never happens on its own, and withdrawing is a separate act too.',
                tag: 'Optional',
                tone: 'text-ink-inactive',
              },
            ].map((step) => (
              <li key={step.n} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border-stroke border bg-surface-card2 font-mono text-[0.72rem] text-ink-secondary">
                  {step.n}
                </span>
                <span className="min-w-0 flex-1">
                  <Typography variant="span" weight="semibold" className="block text-[0.88rem]">
                    {step.title}
                  </Typography>
                  <Typography variant="span" className="block text-[0.8rem] text-ink-inactive">
                    {step.said}
                  </Typography>
                </span>
                <span className={cn('shrink-0 text-[0.74rem]', step.tone)}>{step.tag}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      </div>

      {/* Другие способы начать. Все три ведут в то, что уже существует - и «Import» назван тем, чем
        * является: импорта скиллов в вебе нет, есть импорт .mmmacro, который станет ЗАПИСЬЮ и появится в
        * секции выше. Плитка, обещающая «skill file», обещала бы формат, которого у нас нет. */}
      {skills.length === 0 && (
        <div className="mb-4 grid gap-3 lg:grid-cols-[minmax(9rem,auto)_1fr_1fr_1fr]">
          <div className="min-w-0 self-center">
            <Typography variant="span" weight="semibold" className="block text-[0.88rem]">
              Other ways to start
            </Typography>
            <Typography variant="span" className="block text-[0.78rem] text-ink-inactive">
              Whichever source fits the job.
            </Typography>
          </div>

          {[
            {
              icon: <Wand2 className="size-4 text-brand-tertiary" />,
              title: 'Describe a skill',
              said: 'Say the outcome and have the agent work it out',
              go: () => { void navigate({ to: '/create' }); },
            },
            {
              icon: <Upload className="size-4 text-ink-secondary" />,
              title: 'Import a recording',
              said: 'A .mmmacro file becomes a recording above',
              go: () => { void navigate({ to: '/record' }); },
            },
            {
              icon: <Puzzle className="size-4 text-ink-secondary" />,
              title: bridge.paired ? 'Extension connected' : 'Sync the extension',
              said: bridge.paired ? 'Its skills appear here after its next sync' : 'Pull the skills made in your browser',
              go: () => { void connect(); },
            },
          ].map((tile) => (
            <button
              key={tile.title}
              type="button"
              onClick={tile.go}
              className={cn(
                'flex min-w-0 items-center gap-3 rounded-xl border-stroke border bg-surface-card px-3.5 py-3 text-left',
                'transition-colors duration-base hover:border-card-border-hover hover:bg-state-hover',
              )}
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-card2">
                {tile.icon}
              </span>
              <span className="min-w-0 flex-1">
                <Typography variant="span" weight="semibold" className="block truncate text-[0.86rem]">
                  {tile.title}
                </Typography>
                <Typography variant="span" className="block truncate text-[0.76rem] text-ink-inactive">
                  {tile.said}
                </Typography>
              </span>
              <ArrowRight className="size-4 shrink-0 text-ink-inactive" />
            </button>
          ))}
        </div>
      )}

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
        /* На всю ширину, а не колонкой слева.
         *
         * Это место, где на странице стоит ТАБЛИЦА, и текст, занимающий шестую часть той же строки, читается
         * как обрывок, а не как ответ на «где мои скиллы». Полоса во всю ширину занимает ровно то место,
         * которое займёт библиотека, когда первый скилл появится. */
        <div className="rounded-xl border-stroke border bg-surface-card px-4 py-3.5">
        <Typography variant="p" className="text-ink-inactive text-[0.88rem]">
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
        </div>
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

      {/* Подвал во всю ширину. Прижатый влево, он читался как недоверстанный абзац; черта сверху и полная
        * ширина говорят то, чем он является - примечание ко всей странице, а не к последней её колонке. */}
      <div className="mt-5 border-stroke/60 border-t pt-3">
        <Typography variant="p" className="text-ink-inactive text-xs">
          <Upload className="mb-0.5 inline size-3.5" /> A skill made in the extension appears here once it
          syncs; one made here appears there after the extension’s next sync. Publishing is always a
          separate, deliberate act.
        </Typography>
      </div>

      {wizardFor && (
        <SkillWizard
          rec={wizardFor}
          onClose={() => setWizardFor(null)}
          onSaved={(made) => {
            setWizardFor(null);
            void reload();
            setSaid({
              text: `"${made}" is a skill now — it asks for what it needs and types it. The recording is `
                + 'untouched.',
              kind: 'good',
            });
          }}
        />
      )}
    </div>
  );
};
