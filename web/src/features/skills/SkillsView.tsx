/* Skills: the flows on your account, from both halves, and the way to connect the extension.
 *
 * Each flow carries the half that made it, because that decides what can run it: a `web` flow points at
 * page elements and only the extension can replay it; a `desktop` flow points at screen coordinates and
 * only the local agent can. Offering the wrong one is a button that does something meaningless.
 */
import { useNavigate } from '@tanstack/react-router';
import { Copy, Link2, Monitor, RefreshCw, Share2, Upload } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/ui/components/Button';
import { Typography } from '@/ui/components/Typography';
import { cn } from '@/ui/lib/utils';
import { type Flow, galleryPublish, mintDeviceToken } from '@/lib/api';
import { handToExtension, watchBridge } from '@/lib/bridge';
import { useAccount } from '@/shell/AccountProvider';
import { adoptRecording } from '@/features/record/adopt';

export const SkillsView = () => {
  const { flows, reload } = useAccount();
  const navigate = useNavigate();
  const [bridge, setBridge] = useState({ present: false, paired: false, version: null as string | null });
  const [said, setSaid] = useState<{ text: string; kind: 'good' | 'bad' } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

              <Typography variant="p" className="mb-3 flex-1 text-ink-secondary text-[0.85rem]">
                {flow.description || (flow.origins.length ? `In ${flow.origins.slice(0, 3).join(', ')}.` : '')}
              </Typography>

              <div className="flex flex-wrap gap-1.5">
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
              </div>
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
