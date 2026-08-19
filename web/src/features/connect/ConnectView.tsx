/* Connections: the first-run guide for the local agent.
 *
 * Not in the sidebar - it is setup, not a place you work - and reached three ways, each the moment somebody
 * needs it: the account panel, the status pill, and pressing Record with no agent running.
 *
 * The steps are the ones that actually go wrong, in the order they go wrong in. The browser permission has
 * a step of its own because no response header can grant it: reaching 127.0.0.1 from an https page needs
 * the user's Local Network Access permission in Chrome 142+, and that is granted in the browser.
 */
import { useNavigate } from '@tanstack/react-router';
import { Check, Copy, Download, Loader2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Button } from '@/ui/components/Button';
import { Typography } from '@/ui/components/Typography';
import { cn } from '@/ui/lib/utils';
import { AGENT_WANTS, autostartEnable, localFileCommand, olderThan, startCommand } from '@/lib/agent';
import { refreshAgent, useAgent, useConsole } from '@/lib/store';

export const ConnectView = () => {
  const [state, update] = useConsole();
  const { health, failures } = useAgent();
  const navigate = useNavigate();
  const [said, setSaid] = useState<{ text: string; kind: 'good' | 'bad' } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showLocal, setShowLocal] = useState(false);

  const stale = olderThan(health?.version);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setSaid({ text: 'Copied — paste it into PowerShell and press Enter.', kind: 'good' });
    } catch (_) {
      setSaid({ text: 'The clipboard was blocked. Select the command and copy it.', kind: 'bad' });
    }
  }, []);

  const steps = [
    {
      title: 'Copy the start command',
      done: copied,
      note: 'One line. It fetches the agent and starts it in one go — nothing to install, nothing to unblock.',
      body: (
        <div>
          <div className="flex items-center gap-2 rounded-md border-stroke border bg-surface-card2 p-1.5">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-1 font-mono text-[0.78rem] text-ink-primary">
              {startCommand(state.port)}
            </code>
            <Button size="sm" leftSlot={<Copy className="size-4" />} onClick={() => void copy(startCommand(state.port))}>
              Copy
            </Button>
          </div>

          <button
            type="button"
            onClick={() => setShowLocal((v) => !v)}
            className="mt-2 text-ink-secondary text-[0.82rem] hover:text-ink-primary"
          >
            {showLocal ? '▾' : '▸'} Or run a copy you have downloaded
          </button>

          {showLocal && (
            <div className="mt-2">
              <Typography variant="p" className="mb-2 max-w-[56ch] text-ink-inactive text-[0.82rem]">
                Same agent, read first. The command assumes your Downloads folder. Autostart needs this
                route: a piped command leaves no file for the launcher to point at.
              </Typography>
              <div className="flex items-center gap-2 rounded-md border-stroke border bg-surface-card2 p-1.5">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-1 font-mono text-[0.78rem]">
                  {localFileCommand(state.port)}
                </code>
                <Button variant="ghost" size="sm" onClick={() => void copy(localFileCommand(state.port))}>
                  Copy
                </Button>
              </div>
              <Button variant="tertiary" size="sm" className="mt-2" leftSlot={<Download className="size-4" />} asChild>
                <a href="/agent/mouseflow-agent.ps1" download="mouseflow-agent.ps1">Download the agent</a>
              </Button>
            </div>
          )}
        </div>
      ),
    },
    {
      title: 'Paste it into PowerShell and press Enter',
      done: !!health,
      note: 'Press Win+X then I for a PowerShell window. Leave it open afterwards — closing it is how you stop the agent, and there is no other off switch.',
      body: !health ? (
        <div className="flex items-center gap-2 text-[0.85rem] text-ink-secondary">
          <Loader2 className="size-4 animate-spin" />
          Watching 127.0.0.1:{state.port} for the agent…
          {failures > 6 && (
            <span className="text-ink-inactive">
              Nothing yet. If your browser asked about local network access, choose Allow.
            </span>
          )}
        </div>
      ) : null,
    },
    {
      title: stale ? `Update it to ${AGENT_WANTS}` : 'It is current',
      done: !!health && !stale,
      note: stale
        ? `Version ${health?.version} is running, and this app expects ${AGENT_WANTS}. Close that PowerShell window first — otherwise the old one keeps answering on the port — then paste the command again.`
        : 'The version answering is the one this app was built against.',
      body: null,
    },
    {
      title: 'Keep it running after you log in',
      done: false,
      note: health?.canAutostart
        ? 'Drops a launcher in your Startup folder. Only available when the agent was started from a downloaded file with a pinned origin — a piped start leaves nothing for the launcher to point at.'
        : 'Available once the agent has been started from a downloaded file with a pinned origin: a piped start leaves nothing for the launcher to point at.',
      body: health?.canAutostart ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            try {
              await autostartEnable(state.port);
              refreshAgent();
              setSaid({ text: 'It will start automatically when you log in.', kind: 'good' });
            } catch (err) {
              setSaid({ text: err instanceof Error ? err.message : 'could not enable it', kind: 'bad' });
            }
          }}
        >
          Enable autostart
        </Button>
      ) : null,
    },
  ];

  return (
    <div className="max-w-[820px] p-5">
      <section className="rounded-xl border-stroke border bg-surface-card p-4">
        <Typography variant="h2" weight="semibold" className="text-[1.05rem]">
          {health ? (stale ? 'The agent needs updating' : 'Connected') : 'Connect the agent'}
        </Typography>
        <Typography variant="p" className="mt-1 max-w-[68ch] text-ink-secondary text-[0.88rem]">
          A browser tab cannot see mouse events outside its own window or inject real clicks, so one small
          helper runs on your machine — it talks to this page over loopback only, and has no outbound network
          code of its own.
        </Typography>

        <ol className="mt-4 flex flex-col gap-3">
          {steps.map((step, i) => (
            <li key={step.title} className="flex gap-3">
              <span
                className={cn(
                  'mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border text-[0.75rem] tabular-nums',
                  step.done
                    ? 'border-fb-green/50 bg-fb-green/15 text-fb-green'
                    : 'border-stroke text-ink-inactive',
                )}
              >
                {step.done ? <Check className="size-3.5" /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <Typography
                  variant="h3"
                  weight="semibold"
                  className={cn('text-[0.92rem]', step.done && 'text-ink-secondary')}
                >
                  {step.title}
                </Typography>
                <Typography variant="p" className="mt-0.5 max-w-[66ch] text-ink-inactive text-[0.83rem]">
                  {step.note}
                </Typography>
                {step.body && <div className="mt-2">{step.body}</div>}
              </div>
            </li>
          ))}
        </ol>

        {said && (
          <Typography
            variant="p"
            className={cn('mt-4 text-[0.86rem]', said.kind === 'bad' ? 'text-fb-red-text' : 'text-fb-green')}
          >
            {said.text}
          </Typography>
        )}

        <details className="mt-5">
          <summary className="cursor-pointer text-ink-secondary text-[0.85rem]">Advanced</summary>
          <label className="mt-2 flex items-center gap-2 text-[0.85rem] text-ink-body">
            Agent port
            <input
              type="number"
              min={1}
              max={65535}
              value={state.port}
              onChange={(ev) => {
                const v = parseInt(ev.target.value, 10);
                if (Number.isFinite(v) && v > 0 && v < 65536) {
                  update({ port: v });
                  refreshAgent();
                }
              }}
              className="w-24 rounded-md border-stroke border bg-surface-card2 px-2 py-1.5 text-ink-primary tabular-nums"
            />
          </label>
          <Typography variant="p" className="mt-2 max-w-[68ch] text-ink-inactive text-xs">
            The agent installs a low-level mouse hook while it runs. Events are only stored between Start and
            Stop, nothing is written to disk, and <code>-AllowOrigin</code> is pinned to this page’s origin so
            other sites cannot reach it.
          </Typography>
        </details>

        {health && !stale && (
          <Button className="mt-5" onClick={() => void navigate({ to: '/record' })}>
            Start recording
          </Button>
        )}
      </section>
    </div>
  );
};
