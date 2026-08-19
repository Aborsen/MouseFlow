/* Skills: the flows on your account, from both halves, and the way to connect the extension.
 *
 * Each flow carries the half that made it, because that decides what can run it: a `web` flow points at
 * page elements and only the extension can replay it; a `desktop` flow points at screen coordinates and
 * only the local agent can. Offering the wrong one is a button that does something meaningless.
 */
import { useNavigate } from '@tanstack/react-router';
import { Braces, Copy, Link2, Monitor, RefreshCw, Share2, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { type Flow, galleryPublish, mintDeviceToken, push } from '@/lib/api';
import { handToExtension, watchBridge } from '@/lib/bridge';
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
      await galleryPublish(flow.payload);
      setSaid({ text: 'Published. It is in the gallery under your name.', kind: 'good' });
    } catch (err) {
      setSaid({ text: err instanceof Error ? err.message : 'could not publish it', kind: 'bad' });
    }
  }, []);

  return (
    <div className="p-5">
      <section className="mb-4 max-w-[900px] rounded-xl border-stroke border bg-surface-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <Typography variant="span" weight="semibold" className="block text-[0.95rem]">
              Your flows, from both halves
            </Typography>
            <Typography variant="p" className="mt-0.5 max-w-[64ch] text-ink-inactive text-[0.85rem]">
              {bridge.present
                ? bridge.paired
                  ? `The extension in this browser is connected${bridge.version ? ` (v${bridge.version})` : ''}.`
                  : 'The extension is installed in this browser but not connected yet.'
                : 'A page and an extension cannot see each other’s storage — a browser guarantee, not an oversight — so an account is the only place the two halves meet.'}
            </Typography>
          </div>
          <Button
            leftSlot={<Link2 className="size-4" />}
            isLoading={busy}
            onClick={connect}
          >
            {bridge.present && !bridge.paired ? 'Connect this browser’s extension' : 'Connect an extension'}
          </Button>
          <Button variant="ghost" leftSlot={<RefreshCw className="size-4" />} onClick={() => void reload()}>
            Refresh
          </Button>
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

      {flows.length === 0 ? (
        <Typography variant="p" className="max-w-[60ch] text-ink-inactive">
          Nothing on your account yet. Record something and press <strong>Save as skill</strong>, or connect
          the extension above and press <strong>Sync now</strong> in it.
        </Typography>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {flows.map((flow) => (
            <li key={flow.id} className="flex flex-col rounded-xl border-stroke border bg-surface-card p-3.5">
              <div className="mb-1 flex items-start gap-2">
                <Typography variant="h3" weight="semibold" className="min-w-0 flex-1 text-[0.95rem]">
                  {flow.name || 'Untitled'}
                </Typography>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-[0.7rem] font-semibold',
                    flow.kind === 'created' ? 'bg-brand-tertiary/20 text-brand-tertiary' : 'bg-brand-primary/15 text-brand-primary',
                  )}
                >
                  {flow.kind}
                </span>
                <span
                  className="shrink-0 rounded-full bg-state-hover px-2 py-0.5 text-[0.7rem] text-ink-secondary"
                  title={flow.source === 'desktop'
                    ? 'Points at screen coordinates - run it from Record'
                    : 'Points at page elements - run it from the extension'}
                >
                  {flow.source}
                </span>
              </div>

              <Typography variant="p" className="flex-1 text-ink-secondary text-[0.85rem]">
                {flow.description || (flow.origins.length ? `In ${flow.origins.slice(0, 3).join(', ')}.` : '')}
              </Typography>

              <Structure skill={structureOf(flow)} wire={wire} onWire={setWire} />

              <div className="mt-3 flex flex-wrap gap-1.5">
                {flow.source === 'desktop' ? (
                  <Button
                    size="sm"
                    leftSlot={<Monitor className="size-4" />}
                    onClick={() => {
                      adoptRecording(flow);
                      void navigate({ to: '/record' });
                    }}
                  >
                    Open in Record
                  </Button>
                ) : (
                  <span className="self-center text-[0.78rem] text-ink-inactive" title="This one aims at page elements, so the extension is the half that can replay it">
                    Run it from the extension
                  </span>
                )}

                <Button
                  variant="ghost"
                  size="sm"
                  leftSlot={<Share2 className="size-4" />}
                  onClick={() => void publish(flow)}
                >
                  Publish
                </Button>

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
                  Copy
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
                  {armed === flow.id
                    ? 'Delete — press again'
                    : 'Delete'}
                </Button>
              </div>

              {/* Only when it is cocked, and only what is true: a published copy is a separate thing on a
                * separate table, and deleting this one does not withdraw it. Withdrawing is in the gallery. */}
              {armed === flow.id && (
                <Typography variant="p" className="mt-2 text-fb-attention text-[0.78rem]">
                  This removes it from your account and from every machine that syncs. If you published it,
                  the gallery listing stays until you withdraw it there.
                </Typography>
              )}
            </li>
          ))}
        </ul>
      )}

      <Typography variant="p" className="mt-5 max-w-[70ch] text-ink-inactive text-xs">
        <Upload className="mb-0.5 inline size-3.5" /> A skill made in the extension appears here once it
        syncs; one made here appears there after the extension’s next sync. Publishing is always a separate,
        deliberate act.
      </Typography>
    </div>
  );
};
