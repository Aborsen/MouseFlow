/* Ask about your own work.
 *
 * The point of this screen is not that a model answers - anything can do that. It is that the answer came
 * from THIS account's runs, and that you can see which ones. So the grounding is part of the answer, not a
 * disclosure underneath it: every reply shows the tools the server actually ran and the runs it cited, side
 * by side with the words. A citation is a button, and pressing it prints the run's own id, goal, outcome and
 * timing - read out of the runs this page already holds, so what you are shown is the row, not a retelling
 * of it.
 *
 * The corollary, and the reason the warning below is written the way it is: when the server cites nothing,
 * this screen says the answer is general. A confident sentence with no run behind it is the one failure that
 * would make everything else on this page worthless.
 *
 * Three things are deliberately NOT here:
 *
 *   markdown          the reply is rendered as plain pre-wrapped text. No renderer is vendored and no new
 *                     dependency is allowed, and a half-hearted regex one turns **bold** into noise.
 *   what a run said   user_run.said is empty on most rows and its contents are never handed to the model
 *                     even where they are not, so no citation can quote a run's commentary - see the
 *                     matching note in api/chat.js, which counts rather than claims. Goal, outcome and
 *                     timing are what a citation shows.
 *   a router link     /insights is registered in main.tsx, which belongs to the other half of this change.
 *                     A plain <a> keeps this file from depending on the typed route table existing yet.
 */
import { Ban, Eraser, ExternalLink, Quote, Send, Sparkles, TriangleAlert, Wrench } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@insightis/ui/Badge';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { type Run } from '@/lib/api';
import { useAccount } from '@/shell/AccountProvider';

/* What GET /api/chat actually answers, which is NOT a list of models: it reports the allowlist
 * api/_provider.js owns, keyed by provider, and separately which providers this deployment holds a key
 * for. Both halves are needed before one model can be offered, so they are joined into ModelChoice below.
 * Read as `{ models: ModelChoice[] }` first - a shape the route has never sent - and the picker then
 * listed nothing at all while blaming the deployment for having no keys.
 *
 * There is no `reason` field on it either, and one is not invented here: with the allowlist fixed in
 * api/_provider.js, the only thing `available: false` can mean is a missing key (see keyFor there).
 *
 * `default` is the route's own first choice, honoured when nothing is remembered so that the page and the
 * route agree about which model answers when nobody has chosen one. */
interface Probe {
  configured?: Record<string, boolean>;
  models?: Record<string, string[]>;
  default?: string;
}

/** One row of the picker: a model, whose it is, and whether this deployment can serve it. */
interface ModelChoice {
  id: string;
  provider: string;
  available: boolean;
}

/* One lookup the server ran, in api/chat.js's own shape - an object, not a name. It carries the arguments
 * the lookup was given and whether it worked, and a FAILED lookup is listed too: an answer written after a
 * lookup failed is precisely what this panel exists to expose. Fields are `unknown` because the route
 * builds them from a model's tool call, so the tool name is only as trustworthy as that. */
interface UsedTool {
  tool?: unknown;
  input?: unknown;
  ok?: unknown;
  note?: unknown;
}

/** The same lookup, once it has been made safe to render. */
interface Lookup {
  tool: string;
  ok: boolean;
  /** The arguments, or the failure - whichever the route reported. Shown as the badge's tooltip. */
  detail: string | null;
}

interface Reply {
  ok?: boolean;
  answer?: string;
  /* Run IDS, and nothing else. api/chat.js sends `citations: string[]`, deliberately: a label from the
   * route would be its second opinion about a row this page already holds from /api/sync. So the wording
   * is read out of memory here - see labelOf - and falls back to the bare id. */
  citations?: string[];
  used?: UsedTool[];
  /** The route also sends `rounds` and `tools`; only the token counts are shown. */
  usage?: { input?: number; output?: number };
  provider?: string;
}

interface Turn {
  /** Local and monotonic. Used for React keys and to scope which citation is open. */
  n: number;
  role: 'you' | 'model';
  text: string;
  /** Run ids, in the order the route cited them. */
  citations: string[];
  used: Lookup[];
  usage: { input?: number; output?: number } | null;
  provider: string | null;
}

/* Questions this data can actually answer, which is a shorter list than it looks.
 *
 *   time last week   every run has started_at and finished_at, so a span is measured rather than guessed
 *   repeated flow    user_run.flow_id was NULL on every historical row and is only now being written, so
 *                    this finds recent runs only - the endpoint's answer should say so, and if it does not,
 *                    the citations will show how few runs it had to work with
 *   why it failed    outcome, error, and per-step ok/error on an extension run's steps[]
 */
const SUGGESTIONS = [
  'Where did my time go last week?',
  'Which flow do I repeat most?',
  'Why did my last run fail?',
];

/** Only the last few turns travel. The server caps its own history; this keeps a long afternoon from
 *  growing every request without bound, and the oldest turns are the least use to the answer. */
const HISTORY_TURNS = 12;

const MODEL_KEY = 'mouseflow.chat.model';

class ChatError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ChatError';
    this.status = status;
  }
}

/* The same manners as lib/api.ts's `call`, kept local because that file's ApiError is not exported and the
 * 503 here has to be told apart from every other failure. Errors arrive as { error: { message } }. */
async function callChat<T>(init?: RequestInit): Promise<T> {
  const res = await fetch('/api/chat', { credentials: 'same-origin', ...init });
  const body = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: { message?: string } }) | null;
  if (!res.ok) throw new ChatError(body?.error?.message ?? `HTTP ${res.status}`, res.status);
  /* A 200 that is not `ok: true` is still a failure. Rendering an error object as if it were an answer is
   * the mistake lib/api.ts records for GallerySkill - a blank screen with no clue on it. */
  if (body?.ok !== true) throw new ChatError(body?.error?.message ?? 'the endpoint answered but not with an answer', res.status);
  return body as T;
}

/** Human-readable span for a citation. Deliberately not lib/api.ts's hoursOf: that flattens a missing
 *  finish and an instant run to the same 0, and here "still running" and "took two seconds" must read
 *  differently. */
function spanOf(run: Run): string {
  if (!run.startedAt) return 'no start time recorded';
  if (!run.finishedAt) return run.outcome === 'running' ? 'still running' : 'no finish time recorded';
  const ms = +new Date(run.finishedAt) - +new Date(run.startedAt);
  // Negative or absurd means two machines' clocks disagreed. Said plainly rather than shown as a number.
  if (!(ms > 0)) return 'the clocks disagreed, so the span is not usable';
  if (ms > 12 * 3600 * 1000) return 'over twelve hours, which is more likely a clock than a run';
  if (ms < 90_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** What to call a cited run on its button.
 *
 * The route cites ids only, so the wording is read out of the runs this page already holds. A run older
 * than the sync window is not in memory at all, and its own id is then the only true thing that can be
 * said about it - which is better than a made-up description of a row nobody here has seen. */
function labelOf(runId: string, run: Run | undefined): string {
  if (!run) return runId;
  const said = (run.goal ?? run.summary ?? '').trim();
  if (said) return said.length > 90 ? `${said.slice(0, 90)}…` : said;
  // A replay has no goal by design; the flow it repeated is the closest thing to a name it has.
  if (run.kind === 'replay') return run.flowId ? `A replay of ${run.flowId}` : 'A replay';
  return runId;
}

/** api/chat.js's `used` entries, made safe to render: every field coerced, nothing trusted. */
function lookupsOf(used: Reply['used']): Lookup[] {
  if (!Array.isArray(used)) return [];
  return used
    .filter((entry): entry is UsedTool => !!entry && typeof entry === 'object')
    .map((entry) => {
      /* `note` is only present when the lookup failed, and `input` is an object - stringified rather than
       * rendered, because React throws on an object child. The GallerySkill mistake lib/api.ts records. */
      const note = typeof entry.note === 'string' ? entry.note : null;
      let args: string | null = null;
      if (entry.input && typeof entry.input === 'object' && Object.keys(entry.input).length) {
        try { args = JSON.stringify(entry.input).slice(0, 200); } catch (_) { args = null; }
      }
      return {
        tool: typeof entry.tool === 'string' && entry.tool ? entry.tool : 'an unnamed lookup',
        // Absent means it ran: the route only writes ok: false when something went wrong.
        ok: entry.ok !== false,
        detail: note ?? args,
      };
    });
}

function startedOf(run: Run): string {
  if (!run.startedAt) return 'no start time recorded';
  const at = new Date(run.startedAt);
  return Number.isNaN(+at) ? 'an unreadable start time' : at.toLocaleString();
}

const OUTCOME_TONE: Record<Run['outcome'], string> = {
  ok: 'bg-fb-green/15 text-fb-green',
  failed: 'bg-fb-red/15 text-fb-red-text',
  stopped: 'bg-fb-attention/15 text-fb-attention',
  running: 'bg-state-hover text-ink-secondary',
};

/* `embedded` is the same screen in a 26rem column beside the Insights dashboard - which is where it
 * actually lives now. The page form is kept because /chat still resolves for anyone who bookmarked it, and
 * because a panel is a bad place to read a long answer. */
export const ChatView = ({ embedded = false }: { embedded?: boolean } = {}) => {
  const { runs } = useAccount();

  const [models, setModels] = useState<ModelChoice[]>([]);
  const [modelsProblem, setModelsProblem] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<{ text: string; hint?: string } | null>(null);
  const [openCitation, setOpenCitation] = useState<string | null>(null);

  const nextN = useRef(1);
  const bottom = useRef<HTMLDivElement>(null);

  /* Which models this deployment can actually serve, asked rather than assumed. A hard-coded list is how a
   * picker comes to offer a model that answers 503 to everyone who chooses it. */
  useEffect(() => {
    (async () => {
      try {
        const body = await callChat<Probe>();
        /* Two facts joined into one row per model: the allowlist, and whether a key for its provider is
         * present. A model whose provider has no key is still listed - struck through in the picker rather
         * than hidden - because "not configured here" is a useful thing to be told. */
        const configured = body.configured ?? {};
        const list: ModelChoice[] = Object.entries(body.models ?? {}).flatMap(([provider, ids]) =>
          (Array.isArray(ids) ? ids : [])
            .filter((id): id is string => typeof id === 'string' && !!id)
            .map((id) => ({ id, provider, available: configured[provider] === true })),
        );
        setModels(list);
        /* Embedded, there is no picker and no memory of one: the panel is the deployment's own agent, so it
         * uses the model the route names as its default (OPENAI_MODEL, which is gpt-5.6-luna here). A choice
         * made on the /chat page must not leak into a panel that shows no choice. */
        let remembered = '';
        if (!embedded) {
          try { remembered = localStorage.getItem(MODEL_KEY) ?? ''; } catch (_) { /* private mode */ }
        }
        const usable = list.find((m) => m.id === remembered && m.available)
          ?? list.find((m) => m.id === body.default && m.available)
          ?? list.find((m) => m.available);
        setModel(usable ? usable.id : '');
        if (!list.length) setModelsProblem('The endpoint listed no models at all, so there is nothing to ask.');
        else if (!list.some((m) => m.available)) {
          setModelsProblem('None of the models this build knows about are available here - the deployment has no ' +
            'API key for either provider, so nothing can answer.');
        }
      } catch (err) {
        setModelsProblem(err instanceof Error ? err.message : 'the model list could not be read');
      }
    })();
  }, [embedded]);

  useEffect(() => {
    if (!model || embedded) return;
    try { localStorage.setItem(MODEL_KEY, model); } catch (_) { /* private mode */ }
  }, [model, embedded]);

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }); }, [turns, asking]);

  /* Grouped by provider, so "no OpenAI key" is said once rather than once per model. */
  const unavailable = useMemo(() => {
    const byProvider = new Map<string, string[]>();
    for (const m of models) {
      if (m.available) continue;
      byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m.id]);
    }
    return [...byProvider.entries()].map(([provider, ids]) => ({ provider, ids }));
  }, [models]);

  const providerOf = useCallback(
    (id: string) => models.find((m) => m.id === id)?.provider ?? null,
    [models],
  );

  const byId = useMemo(() => {
    const map = new Map<string, Run>();
    for (const run of runs) map.set(run.id, run);
    return map;
  }, [runs]);

  const ask = useCallback(async (text: string) => {
    const asked = text.trim();
    if (!asked || asking) return;
    if (!model) {
      setProblem({ text: 'Choose a model that this deployment can serve first.' });
      return;
    }

    setProblem(null);
    setQuestion('');
    const mine: Turn = {
      n: nextN.current++, role: 'you', text: asked, citations: [], used: [], usage: null, provider: null,
    };
    /* History is what was said BEFORE this question - the question travels in its own field, and putting it
     * in both would show the model the same sentence twice.
     *
     * Each entry is role and text, the shape api/_provider.js calls a Message. Tool calls and their results
     * are not replayed from here: this page never saw the tool_use ids that keyed them, and inventing ids
     * would break both providers' transcripts. */
    const recent = turns.slice(-HISTORY_TURNS);
    /* And a transcript may not OPEN on an assistant turn: Anthropic refuses one that does, where OpenAI
     * does not mind. This window can start on one - a failed ask leaves a question in the list with no
     * reply after it, which shifts the parity of every turn that follows - so it starts at the first
     * question inside it rather than wherever the count happened to land. */
    const opens = recent.findIndex((t) => t.role === 'you');
    const history = (opens < 0 ? [] : recent.slice(opens)).map((t) => ({
      role: t.role === 'you' ? 'user' : 'assistant',
      text: t.text,
    }));
    setTurns((prev) => [...prev, mine]);
    setAsking(true);

    try {
      const body = await callChat<Reply>({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: asked, model, history }),
      });
      setTurns((prev) => [...prev, {
        n: nextN.current++,
        role: 'model',
        text: String(body.answer ?? '').trim() || 'The model answered with nothing at all.',
        /* Ids, coerced rather than trusted - they are rendered as React children and used as map keys. */
        citations: (Array.isArray(body.citations) ? body.citations : [])
          .filter((id): id is string => typeof id === 'string' && !!id),
        used: lookupsOf(body.used),
        usage: body.usage ?? null,
        provider: body.provider ?? providerOf(model),
      }]);
    } catch (err) {
      const status = err instanceof ChatError ? err.status : 0;
      const said = err instanceof Error ? err.message : 'the request failed';
      if (status === 503) {
        /* The one failure that is not about the question. api/_provider.js answers 503 when there is no key
         * for the chosen model's provider, so the model is struck off the picker here too - offering it
         * again after it has said no is how a demo loses a minute. */
        const provider = providerOf(model);
        setModels((prev) => prev.map((m) => (m.provider === provider ? { ...m, available: false } : m)));
        const elsewhere = models.find((m) => m.available && m.provider !== provider);
        setModel(elsewhere ? elsewhere.id : '');
        setProblem({
          text: said,
          hint: elsewhere
            ? `This deployment has no ${provider ?? 'provider'} key, so ${provider ?? 'that provider'}'s models cannot answer. Switched to ${elsewhere.id}; ask again.`
            : `This deployment has no ${provider ?? 'provider'} key, and there is no other provider configured here.`,
        });
      } else {
        setProblem({ text: said });
      }
    } finally {
      setAsking(false);
    }
  }, [asking, model, models, providerOf, turns]);

  const clear = useCallback(() => {
    setTurns([]);
    setProblem(null);
    setOpenCitation(null);
    setQuestion('');
  }, []);

  return (
    <div className={cn('flex min-h-0 flex-col', embedded ? 'h-full' : 'p-5')}>
      <header className={cn(embedded ? 'border-stroke border-b px-3 py-2' : 'mb-4 max-w-[900px]')}>
        {!embedded && (
          <>
            <Typography variant="h2" weight="semibold" className="text-[1.05rem]">
              Ask about your own work
            </Typography>
            <Typography variant="p" className="mt-1 max-w-[70ch] text-ink-inactive text-[0.85rem]">
              Answers are built from the runs and flows on this account. Every reply shows what it was based
              on — the tools that ran and the runs cited — so you can check it rather than take it.
            </Typography>
          </>
        )}

        <div className={cn('flex flex-wrap items-center gap-2', !embedded && 'mt-3')}>
          {/* A name, not a model id. Which model answered is a fact about the deployment, not a decision to
              put in front of somebody asking where their week went - the panel uses whatever OPENAI_MODEL
              names and says nothing about it unless a request fails. The picker survives on the /chat page,
              where choosing is reasonable. */}
          <Typography variant="span" weight="semibold" className="text-[0.92rem]">
            Insightis agent
          </Typography>

          {!embedded && (
            <label className="flex items-center gap-1.5 text-[0.78rem] text-ink-secondary">
              Model
              <select
                value={model}
                aria-label="Model"
                disabled={!models.length}
                onChange={(ev) => setModel(ev.target.value)}
                className="rounded-md border-stroke border bg-surface-card px-1.5 py-1 text-ink-primary disabled:opacity-disabled"
              >
                {!model && <option value="">none available</option>}
                {[...new Set(models.map((m) => m.provider))].map((provider) => (
                  <optgroup key={provider} label={provider}>
                    {models.filter((m) => m.provider === provider).map((m) => (
                      <option key={m.id} value={m.id} disabled={!m.available}>
                        {m.available ? m.id : `${m.id} — no key on this deployment`}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          )}

          <Button
            variant="ghost"
            size="sm"
            className="ms-auto"
            leftSlot={<Eraser className="size-4" />}
            disabled={!turns.length || asking}
            onClick={clear}
          >
            Clear
          </Button>
        </div>

        {!embedded && unavailable.length > 0 && (
          <Typography variant="p" className="mt-1.5 text-ink-inactive text-xs">
            {unavailable.map(({ provider, ids }) => (
              <span key={provider} className="mr-3 inline-flex items-center gap-1">
                <Ban className="mb-0.5 inline size-3" />
                {ids.join(', ')} — this deployment has no {provider} key, so they are disabled.
              </span>
            ))}
          </Typography>
        )}

        {modelsProblem && (
          <Typography variant="p" className="mt-2 text-fb-red-text text-[0.85rem]">
            {modelsProblem}
          </Typography>
        )}
      </header>

      <div className={cn('flex-1', embedded ? 'min-h-0 overflow-y-auto px-3 py-3' : 'max-w-[900px]')}>
        {turns.length === 0 ? (
          <section className="rounded-xl border-stroke border bg-surface-card p-4">
            <Typography variant="span" weight="semibold" className="block text-[0.9rem]">
              <Sparkles className="mb-0.5 mr-1.5 inline size-4" />
              Somewhere to start
            </Typography>
            <Typography variant="p" className="mt-1 max-w-[64ch] text-ink-inactive text-[0.82rem]">
              These three are answerable from what is stored: every run carries a start and a finish, which
              flow it ran, and how it ended.
            </Typography>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <Button key={s} variant="outline" size="sm" disabled={!model || asking} onClick={() => void ask(s)}>
                  {s}
                </Button>
              ))}
            </div>
          </section>
        ) : (
          <ul className="flex flex-col gap-3">
            {turns.map((turn) => (
              <li
                key={turn.n}
                className={cn(
                  'rounded-xl border p-3.5',
                  turn.role === 'you'
                    ? 'ml-auto max-w-[80%] border-stroke bg-surface-card2'
                    : 'border-stroke bg-surface-card',
                )}
              >
                {turn.role === 'you' ? (
                  <Typography variant="p" className="whitespace-pre-wrap text-ink-primary text-[0.88rem]">
                    {turn.text}
                  </Typography>
                ) : (
                  <div className="grid gap-3 md:grid-cols-[1fr_minmax(200px,270px)]">
                    <div className="min-w-0">
                      {/* Pre-wrapped, not rendered: see the note at the top of this file. */}
                      <Typography variant="p" className="whitespace-pre-wrap text-ink-primary text-[0.88rem]">
                        {turn.text}
                      </Typography>
                      <Typography variant="p" className="mt-2 text-ink-inactive text-[0.7rem]">
                        {turn.provider ? `${turn.provider}` : 'provider not reported'}
                        {typeof turn.usage?.input === 'number' && typeof turn.usage?.output === 'number'
                          ? ` · ${turn.usage.input} in / ${turn.usage.output} out tokens`
                          : ''}
                      </Typography>
                    </div>

                    {/* Not a disclosure. What the answer rests on sits beside it, always open. */}
                    <aside className="rounded-lg border-stroke border bg-surface-card2 p-2.5">
                      <Typography variant="span" weight="semibold" className="block text-ink-secondary text-[0.72rem] uppercase tracking-wide">
                        Based on
                      </Typography>

                      <div className="mt-1.5">
                        <Typography variant="span" className="block text-ink-inactive text-[0.72rem]">
                          <Wrench className="mb-0.5 mr-1 inline size-3" />
                          {turn.used.length ? 'Tools the server ran' : 'No tools ran'}
                        </Typography>
                        {turn.used.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {/* One badge per lookup, in the order they ran - so the same tool called twice
                              * shows twice, which is the honest count. A lookup that FAILED is marked, not
                              * dropped: an answer written after a failed lookup is the thing worth seeing. */}
                            {turn.used.map((lookup, i) => (
                              <Badge
                                key={`${i}:${lookup.tool}`}
                                variant={lookup.ok ? 'secondary' : 'error'}
                                size="xs"
                                rounded="full"
                                className="font-mono"
                                title={lookup.detail ?? undefined}
                              >
                                {lookup.ok ? lookup.tool : `${lookup.tool} — failed`}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="mt-2.5">
                        <Typography variant="span" className="block text-ink-inactive text-[0.72rem]">
                          <Quote className="mb-0.5 mr-1 inline size-3" />
                          {turn.citations.length
                            ? `${turn.citations.length} run${turn.citations.length === 1 ? '' : 's'} cited`
                            : 'No runs cited'}
                        </Typography>

                        {turn.citations.length > 0 ? (
                          <ul className="mt-1 flex flex-col gap-1">
                            {turn.citations.map((runId) => {
                              const key = `${turn.n}:${runId}`;
                              const open = openCitation === key;
                              const run = byId.get(runId);
                              return (
                                <li key={key}>
                                  <button
                                    type="button"
                                    aria-expanded={open}
                                    onClick={() => setOpenCitation(open ? null : key)}
                                    className={cn(
                                      'w-full rounded-md border-stroke border px-2 py-1 text-left text-[0.75rem]',
                                      'hover:bg-state-hover focus:outline-none focus:ring-2 focus:ring-focus-ring-brand',
                                      open ? 'bg-state-hover text-ink-primary' : 'text-ink-secondary',
                                    )}
                                  >
                                    {labelOf(runId, run)}
                                  </button>

                                  {open && (
                                    <div className="mt-1 rounded-md border-stroke border bg-surface-card p-2">
                                      <div className="font-mono text-[0.7rem] text-ink-inactive break-all">
                                        {runId}
                                      </div>
                                      {run ? (
                                        <>
                                          <div className="mt-1 flex flex-wrap items-center gap-1">
                                            <span className={cn('rounded-full px-1.5 py-0.5 text-[0.65rem] font-semibold', OUTCOME_TONE[run.outcome])}>
                                              {run.outcome}
                                            </span>
                                            <span className="rounded-full bg-state-hover px-1.5 py-0.5 text-[0.65rem] text-ink-secondary">
                                              {run.kind}
                                            </span>
                                          </div>
                                          <Typography variant="p" className="mt-1 text-ink-primary text-[0.75rem]">
                                            {/* A replay has no goal by design - it repeats a recording, so there was
                                              * no prompt to store. Saying so beats printing "null". */}
                                            {run.goal
                                              ? run.goal
                                              : run.kind === 'replay'
                                                ? `A replay${run.flowId ? ` of ${run.flowId}` : ''} — a replay has no goal to store.`
                                                : 'No goal was stored for this run.'}
                                          </Typography>
                                          <Typography variant="p" className="mt-1 text-ink-inactive text-[0.7rem]">
                                            {startedOf(run)} · {spanOf(run)}
                                            {run.model ? ` · ${run.model}` : ''}
                                          </Typography>
                                          {run.error && (
                                            <Typography variant="p" className="mt-1 text-fb-red-text text-[0.7rem]">
                                              {run.error}
                                            </Typography>
                                          )}
                                        </>
                                      ) : (
                                        /* /api/sync returns the 60 most recent runs. A citation older than
                                         * that is real but not in memory here, and guessing at it would be
                                         * worse than saying so. */
                                        <Typography variant="p" className="mt-1 text-ink-inactive text-[0.72rem]">
                                          This run is not among the recent ones this page loaded, so its goal
                                          and timing cannot be shown here. Insights reads the full history.
                                        </Typography>
                                      )}
                                      {/* Plain /insights, with no run in the query string: that page counts a
                                        * whole window and has no per-run view to open, so a ?run= would be a
                                        * promise the other half of this change does not keep. */}
                                      <a
                                        href="/insights"
                                        className="mt-1.5 inline-flex items-center gap-1 text-brand-primary text-[0.72rem] hover:underline"
                                      >
                                        See the whole window in Insights
                                        <ExternalLink className="size-3" />
                                      </a>
                                    </div>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        ) : (
                          <Typography variant="p" className="mt-1 text-fb-attention text-[0.72rem]">
                            <TriangleAlert className="mb-0.5 mr-1 inline size-3" />
                            Nothing from your account was cited, so read this as general knowledge — it is not
                            grounded in your runs.
                          </Typography>
                        )}
                      </div>
                    </aside>
                  </div>
                )}
              </li>
            ))}
            {asking && (
              <li className="rounded-xl border-stroke border bg-surface-card p-3.5">
                <Typography variant="p" className="text-ink-inactive text-[0.85rem]">
                  Reading your runs…
                </Typography>
              </li>
            )}
          </ul>
        )}
        <div ref={bottom} />
      </div>

      {problem && (
        <div className={cn('mt-3 rounded-lg border-fb-red/40 border bg-surface-card p-3', !embedded && 'max-w-[900px]')}>
          <Typography variant="p" className="text-fb-red-text text-[0.85rem]">
            {/* The endpoint's own words first: it knows what went wrong and this page does not. */}
            {problem.text}
          </Typography>
          {problem.hint && (
            <Typography variant="p" className="mt-1 text-ink-secondary text-[0.8rem]">
              {problem.hint}
            </Typography>
          )}
        </div>
      )}

      {/* The send sits inside the field, which is where a chat puts it. The two paragraphs that used to
          follow this - what travels with a question, and what the data cannot tell you - are gone: the first
          was housekeeping, and the second is already answered on every reply, which shows the runs it read. */}
      <form
        className={cn('mt-3', embedded ? 'px-3 pb-3' : 'max-w-[900px]')}
        onSubmit={(ev) => { ev.preventDefault(); void ask(question); }}
      >
        <div
          className={cn(
            'flex items-end gap-2 rounded-2xl border border-stroke p-2',
            'bg-surface-card/[0.72] backdrop-blur-[10px]',
            'focus-within:border-input-focus [&:hover:not(:focus-within)]:border-stroke-field-hover',
          )}
        >
          <textarea
            value={question}
            onChange={(ev) => setQuestion(ev.target.value)}
            disabled={asking || !model}
            aria-label="Your question"
            rows={2}
            placeholder="where did my time go last week?"
            onKeyDown={(ev) => {
              // Enter sends, Shift+Enter starts a line. A chat box that needs a mouse to send is a worse one.
              if (ev.key === 'Enter' && !ev.shiftKey) {
                ev.preventDefault();
                void ask(question);
              }
            }}
            className={cn(
              'max-h-[9rem] min-h-[2.75rem] flex-1 resize-none bg-transparent px-1.5 py-1',
              'text-ink-primary placeholder:text-ink-inactive focus:outline-none disabled:opacity-disabled',
            )}
          />
          <Button
            type="submit"
            size="sm"
            aria-label={asking ? 'Asking' : 'Ask'}
            title={model ? `Ask the ${model} agent` : 'Nothing can answer until a model with a key is available'}
            isLoading={asking}
            disabled={asking || !model || !question.trim()}
            className="!size-9 shrink-0 !p-0"
          >
            {!asking && <Send className="size-4" />}
          </Button>
        </div>
      </form>
    </div>
  );
};
