/* Connections: the local agent, what it is doing, and the one command that changes it.
 *
 * This is where the connection guide went - in the menu, next to everything else that is settings. The
 * six-step first-run walkthrough stays on its own page; what belongs here is the part anybody opening
 * settings actually wants: is it running, is it current, and what do I paste.
 */
import { useNavigate } from '@tanstack/react-router';
import { Copy, Download } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/ui/components/Button';
import { Typography } from '@/ui/components/Typography';
import { cn } from '@/ui/lib/utils';
import { AGENT_WANTS, localFileCommand, startCommand } from '@/lib/agent';
import { useAgent, useConsole } from '@/lib/store';
import { Row, type Say } from '../SettingsDialog';

export const ConnectionsScreen = ({ say, onClose }: { say: Say; onClose: () => void }) => {
  const { health, stale } = useAgent();
  const [console_] = useConsole();
  const navigate = useNavigate();
  const [showLocal, setShowLocal] = useState(false);

  const state = stale
    ? `Running ${health?.version}, which is older than this app expects (${AGENT_WANTS}). The command below fetches the current one — close the old PowerShell window first.`
    : health
      ? `Running on this computer and answering, version ${health.version}. To stop it, close its PowerShell window.`
      : 'Not running. Nothing on this page can start it for you, which is deliberate — paste the command below.';

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      say({ text: 'Copied — paste it into PowerShell.', kind: 'good' });
    } catch (_) {
      say({ text: 'The clipboard was blocked. Select the command and copy it.', kind: 'bad' });
    }
  };

  return (
    <div>
      <Row label="Local agent" note={state}>
        <span
          className={cn(
            'inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[0.78rem]',
            health && !stale && 'border-fb-green/50 text-fb-green',
            stale && 'border-fb-attention/50 text-fb-attention',
            !health && 'border-fb-red/50 text-fb-red-text',
          )}
        >
          <span
            className={cn(
              'size-[7px] rounded-full',
              health && !stale && 'bg-fb-green',
              stale && 'bg-fb-attention',
              !health && 'bg-fb-red',
            )}
          />
          {health ? `Agent ${health.version}` : 'Agent offline'}
        </span>
      </Row>

      <Row
        label="Start command"
        note="Nothing is installed: it fetches the agent and runs it in one go. Leave the window open — closing it is how you stop the agent."
      />
      <div className="flex items-center gap-2 rounded-md border-stroke border bg-surface-card2 p-1.5">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-1 font-mono text-[0.78rem] text-ink-primary">
          {startCommand(console_.port)}
        </code>
        <Button size="sm" leftSlot={<Copy className="size-4" />} onClick={() => copy(startCommand(console_.port))}>
          Copy
        </Button>
      </div>

      {/* Folded, always. The piped command above is what almost everybody wants; this is for reading the
          script first, and for autostart, which needs a file for the launcher to point at. */}
      <button
        type="button"
        onClick={() => setShowLocal((v) => !v)}
        className="mt-3 text-ink-secondary text-[0.82rem] hover:text-ink-primary"
      >
        {showLocal ? '▾' : '▸'} Or run a copy you have downloaded
      </button>

      {showLocal && (
        <div className="mt-2">
          <Typography variant="p" className="mb-2 max-w-[52ch] text-ink-inactive text-[0.82rem]">
            Same agent, read first. The command assumes your Downloads folder. Autostart needs this route:
            a piped command leaves no file for the launcher to point at.
          </Typography>
          <div className="flex items-center gap-2 rounded-md border-stroke border bg-surface-card2 p-1.5">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-1 font-mono text-[0.78rem]">
              {localFileCommand(console_.port)}
            </code>
            <Button variant="ghost" size="sm" onClick={() => copy(localFileCommand(console_.port))}>
              Copy
            </Button>
          </div>
          <Button
            variant="tertiary"
            size="sm"
            className="mt-2"
            leftSlot={<Download className="size-4" />}
            asChild
          >
            <a href="/agent/mouseflow-agent.ps1" download="mouseflow-agent.ps1">
              Download the agent
            </a>
          </Button>
        </div>
      )}

      <Row label="First time here?" note="The full walkthrough, with the browser permission it needs and how to keep it running after you log in.">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onClose();
            void navigate({ to: '/connect' });
          }}
        >
          Open the guide
        </Button>
      </Row>
    </div>
  );
};
