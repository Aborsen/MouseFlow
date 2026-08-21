/* Connections: the local agent, what it is doing, and the one command that changes it.
 *
 * This is where the connection guide went - in the menu, next to everything else that is settings. The
 * first-run walkthrough stays on its own page; what belongs here is the part anybody opening settings
 * actually wants: is it running, is it current, and what do I paste.
 *
 * And "what do I paste" depends on the machine. This panel said PowerShell to everybody for a while after
 * the macOS agent existed, because the platform switch was built on the /connect page and this is the
 * surface people actually open - one bug, two places, only one of them fixed. The shared half now lives in
 * features/connect/platform.tsx so a third surface cannot be half-right either.
 */
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { restartTour } from '../OnboardingTour';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import {
  AGENT_WANTS, MAC_STOP_COMMAND, MAC_TOOLS_COMMAND, localFileCommand, macInstallCommand, macRestartCommand,
  startCommand,
} from '@/lib/agent';
import { useAgent, useConsole } from '@/lib/store';
import {
  Command, DownloadLink, PlatformPicker, needsRestart, usePlatform,
} from '@/features/connect/platform';
import { Row, type Say } from '../SettingsDialog';

export const ConnectionsScreen = ({ say, onClose }: { say: Say; onClose: () => void }) => {
  const { health, stale } = useAgent();
  const [console_] = useConsole();
  const navigate = useNavigate();
  const [showLocal, setShowLocal] = useState(false);
  const platform = usePlatform(health ?? null);
  const { mac, terminal } = platform;

  const restart = needsRestart(health ?? null);
  const permissions = health?.permissions;

  const state = stale
    ? mac
      ? `Running ${health?.version}, which is older than this app expects (${AGENT_WANTS}). Run the install command again — it stops the old one, rebuilds and starts the new one.`
      : `Running ${health?.version}, which is older than this app expects (${AGENT_WANTS}). The command below fetches the current one — close the old PowerShell window first.`
    : health
      ? mac
        ? `Running on this computer and answering, version ${health.version}. It is a login item, so it starts on its own and there is no window to close.`
        : `Running on this computer and answering, version ${health.version}. To stop it, close its ${terminal} window.`
      : 'Not running. Nothing on this page can start it for you, which is deliberate — paste the command below.';

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      say({ text: `Copied — paste it into ${terminal}.`, kind: 'good' });
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
        note={mac
          ? 'It fetches the agent, builds it on your machine and starts it in the background — building locally is what keeps Gatekeeper out of the way, and running as an app rather than a loose binary is what lets it hold a permission of its own.'
          : 'Nothing is installed: it fetches the agent and runs it in one go. Leave the window open — closing it is how you stop the agent.'}
      >
        {/* The switch sits on the command, which is the thing it changes. Guessed from the browser and
          * corrected by a running agent, but always switchable - and on this panel that matters more than on
          * the guide, because this is the surface people open when something is already wrong. */}
        <PlatformPicker platform={platform} onPick={() => setShowLocal(false)} />
      </Row>

      <Command text={mac ? macInstallCommand(console_.port) : startCommand(console_.port)} onCopy={copy} />

      {mac && (
        <div className="mt-3">
          <Typography variant="p" className="mb-1.5 max-w-[58ch] text-ink-inactive text-[0.82rem]">
            If it answers <em>“The Swift compiler is not installed”</em>: run this, accept the dialog, then
            run the install command again.
          </Typography>
          <Command text={MAC_TOOLS_COMMAND} onCopy={copy} />
        </div>
      )}

      {/* macOS permissions, in the compact form. The guide explains them; a settings panel only has to say
        * which one is missing, because that is the answer to "it is running and nothing works". */}
      {mac && permissions && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.82rem]">
          {([
            { label: 'Accessibility', ok: permissions.accessibility, pane: 'Privacy & Security → Accessibility' },
            { label: 'Screen Recording', ok: permissions.screenRecording, pane: 'Privacy & Security → Screen Recording' },
          ]).map((row) => (
            <span key={row.label} className={row.ok ? 'text-fb-green' : 'text-fb-attention'}>
              {row.ok ? '✓' : '!'} {row.label}
              {row.ok ? '' : ` — ${row.pane}`}
            </span>
          ))}
        </div>
      )}

      {mac && !restart && health && (
        <div className="mt-3">
          <Typography variant="p" className="mb-1.5 max-w-[58ch] text-ink-inactive text-[0.82rem]">
            {/* Сказано здесь, потому что окна нет и убить процесс недостаточно: это login item, launchd
              * поднимает его снова. */}
            To stop it — it is a login item, so killing the process is not enough:
          </Typography>
          <Command text={MAC_STOP_COMMAND} onCopy={copy} />
        </div>
      )}

      {mac && restart && (
        <div className="mt-3 rounded-lg border-fb-attention/40 border bg-fb-attention/[0.08] p-3">
          <Typography variant="p" className="mb-2 max-w-[60ch] text-ink-inactive text-[0.82rem]">
            <strong className="text-ink-primary">Granted, but this agent started before you granted it.</strong>{' '}
            It installs its event tap when it starts. Press Record and it will pick the permission up; this
            command is only for when that does not take.
          </Typography>
          <Command text={macRestartCommand(console_.port)} onCopy={copy} />
        </div>
      )}

      {/* Folded, always. The command above is what almost everybody wants; this is for reading the script
          first, and on Windows for autostart, which needs a file for the launcher to point at. */}
      <button
        type="button"
        onClick={() => setShowLocal((v) => !v)}
        className="mt-3 text-ink-secondary text-[0.82rem] hover:text-ink-primary"
      >
        {showLocal ? '▾' : '▸'} {mac ? 'Or read it before you run it' : 'Or run a copy you have downloaded'}
      </button>

      {showLocal && (
        <div className="mt-2">
          {mac ? (
            <>
              <Typography variant="p" className="mb-2 max-w-[54ch] text-ink-inactive text-[0.82rem]">
                Both files, unchanged — the installer and the agent it compiles. Piping a script into a shell
                is worth reading first.
              </Typography>
              <div className="flex flex-wrap gap-2">
                <DownloadLink href="/agent/install-mac.sh" name="install-mac.sh">
                  install-mac.sh
                </DownloadLink>
                <DownloadLink href="/agent/mouseflow-agent.swift" name="mouseflow-agent.swift">
                  mouseflow-agent.swift
                </DownloadLink>
              </div>
            </>
          ) : (
            <>
              <Typography variant="p" className="mb-2 max-w-[52ch] text-ink-inactive text-[0.82rem]">
                Same agent, read first. The command assumes your Downloads folder. Autostart needs this
                route: a piped command leaves no file for the launcher to point at.
              </Typography>
              <Command text={localFileCommand(console_.port)} onCopy={copy} />
              <div className="mt-2">
                <DownloadLink href="/agent/mouseflow-agent.ps1" name="mouseflow-agent.ps1">
                  Download the agent
                </DownloadLink>
              </div>
            </>
          )}
        </div>
      )}

      <Row
        label="The tour"
        note="The five-step walk through what each part of the app is for. It runs once by itself; this is
              how to see it again."
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { onClose(); restartTour(); }}
        >
          Show it again
        </Button>
      </Row>

      <Row
        label="First time here?"
        note={mac
          ? 'The full walkthrough: opening Terminal, the compiler Apple ships, both permissions one at a time, and how to keep it running after you log in.'
          : 'The full walkthrough, with the browser permission it needs and how to keep it running after you log in.'}
      >
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
