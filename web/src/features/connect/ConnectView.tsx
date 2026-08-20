/* Connections: the first-run guide for the local agent.
 *
 * Not in the sidebar - it is setup, not a place you work - and reached three ways, each the moment somebody
 * needs it: the account panel, the status pill, and pressing Record with no agent running.
 *
 * The steps are the ones that actually go wrong, in the order they go wrong in. The browser permission has
 * a step of its own because no response header can grant it: reaching 127.0.0.1 from an https page needs
 * the user's Local Network Access permission in Chrome 142+, and that is granted in the browser.
 *
 * TWO PLATFORMS, AND THEY DO NOT HAVE THE SAME SHAPE OF FIRST RUN
 *
 * Windows fetches the agent and runs it in memory: nothing installed, nothing to unblock, one line. macOS
 * has no equivalent - a prebuilt binary without an Apple Developer certificate arrives quarantined and
 * Gatekeeper refuses it - so the installer fetches the source and compiles it on the machine, which is never
 * quarantined. That is one extra requirement (Xcode Command Line Tools) and two permissions that only the
 * user can grant, in two different panes of System Settings.
 *
 * So the steps differ, and the difference is not hidden: the third macOS step reports each permission
 * separately and live, from the agent's own /health. Nothing else on this screen can tell somebody why a
 * working agent is returning a black screenshot.
 */
import { useNavigate } from '@tanstack/react-router';
import { Check, Copy, Loader2 } from 'lucide-react';
import { type ReactNode, useCallback, useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import {
  AGENT_WANTS, MAC_TOOLS_COMMAND, autostartEnable, localFileCommand, macInstallCommand,
  macRestartCommand, olderThan, startCommand,
} from '@/lib/agent';
import { refreshAgent, useAgent, useConsole } from '@/lib/store';
/* Общее с панелью настроек: определение платформы, переключатель, строка с командой и ссылка на скачивание.
 * Вынесено туда после того, как выяснилось, что установочная команда живёт на ДВУХ экранах, а про macOS
 * узнал только один. */
import { Command, DownloadLink, PlatformPicker, needsRestart, usePlatform } from './platform';

interface Step {
  title: string;
  done: boolean;
  note: string;
  body?: ReactNode;
}


export const ConnectView = () => {
  const [state, update] = useConsole();
  const { health, failures } = useAgent();
  const navigate = useNavigate();
  const [said, setSaid] = useState<{ text: string; kind: 'good' | 'bad' } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showLocal, setShowLocal] = useState(false);

  /* Shared with the Connections panel in settings, which is the surface most people actually open. It used
   * to live here and only here, and that is precisely why that panel went on handing macOS users a
   * PowerShell one-liner. */
  const platform = usePlatform(health ?? null);
  const { mac, unknown, terminal } = platform;
  const stale = olderThan(health?.version);
  const command = mac ? macInstallCommand(state.port) : startCommand(state.port);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setSaid({ text: `Copied — paste it into ${terminal} and press Enter.`, kind: 'good' });
    } catch (_) {
      setSaid({ text: 'The clipboard was blocked. Select the command and copy it.', kind: 'bad' });
    }
  }, [terminal]);

  const commandStep: Step = {
    title: 'Copy the install command',
    done: copied,
    note: mac
      ? 'It fetches the agent and builds it on your machine. Building locally is what keeps Gatekeeper out of the way — a downloaded binary would arrive quarantined. It needs Xcode Command Line Tools, and tells you the one command to run if they are missing.'
      : 'One line. It fetches the agent and starts it in one go — nothing to install, nothing to unblock.',
    body: (
      <div>
        <div className="flex items-center gap-2 rounded-md border-stroke border bg-surface-card2 p-1.5">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-1 font-mono text-[0.78rem] text-ink-primary">
            {command}
          </code>
          <Button size="sm" leftSlot={<Copy className="size-4" />} onClick={() => void copy(command)}>
            Copy
          </Button>
        </div>

        {mac && (
          /* Named here rather than only in the terminal. The installer prints this command when swiftc is
            * missing - but somebody reading the screen finds out only after the install has already
            * failed, which is one wasted attempt for anyone who has never opened Xcode. */
          <div className="mt-2">
            <Typography variant="p" className="mb-1.5 max-w-[62ch] text-ink-inactive text-[0.8rem]">
              If it answers <em>“The Swift compiler is not installed”</em>: run this, accept the dialog, wait
              for it to finish, then run the install command again.
            </Typography>
            <Command text={MAC_TOOLS_COMMAND} onCopy={(t) => void copy(t)} />
          </div>
        )}

        <button
          type="button"
          onClick={() => setShowLocal((v) => !v)}
          className="mt-2 text-ink-secondary text-[0.82rem] hover:text-ink-primary"
        >
          {showLocal ? '▾' : '▸'} {mac ? 'Or read it before you run it' : 'Or run a copy you have downloaded'}
        </button>

        {showLocal && (
          <div className="mt-2">
            {mac ? (
              <>
                <Typography variant="p" className="mb-2 max-w-[62ch] text-ink-inactive text-[0.82rem]">
                  Both files, unchanged — the installer and the agent it compiles. Piping a script into a
                  shell is worth reading first, and this is the copy that would run.
                </Typography>
                <div className="flex flex-wrap gap-2">
                  <DownloadLink href="/agent/install-mac.sh" name="install-mac.sh">
                    install-mac.sh
                  </DownloadLink>
                  <DownloadLink href="/agent/mouseflow-agent.swift" name="mouseflow-agent.swift">
                    mouseflow-agent.swift
                  </DownloadLink>
                </div>
                <Typography variant="p" className="mt-2 max-w-[62ch] text-ink-inactive text-xs">
                  Then: <code className="font-mono">bash ~/Downloads/install-mac.sh --origin {location.origin}</code>
                </Typography>
              </>
            ) : (
              <>
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
                <div className="mt-2">
                  <DownloadLink href="/agent/mouseflow-agent.ps1" name="mouseflow-agent.ps1">
                    Download the agent
                  </DownloadLink>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    ),
  };

  const runStep: Step = {
    title: `Paste it into ${terminal} and press Enter`,
    done: !!health,
    note: mac
      ? 'Press ⌘ Space, type “Terminal”, press Enter. In that window press ⌘V to paste, then Enter. It prints a line or two, then sits quietly for ten to thirty seconds while it compiles — that silence is the compiler, not a hang. Leave the window open afterwards: closing it is how you stop the agent, and there is no other off switch.'
      : 'Press Win+X then I for a PowerShell window. Leave it open afterwards — closing it is how you stop the agent, and there is no other off switch.',
    body: !health ? (
      <div>
        <div className="flex flex-wrap items-center gap-2 text-[0.85rem] text-ink-secondary">
          <Loader2 className="size-4 animate-spin" />
          Watching 127.0.0.1:{state.port} for the agent…
        </div>
        {failures > 6 && (
          <Typography variant="p" className="mt-1.5 max-w-[66ch] text-ink-inactive text-[0.82rem]">
            Nothing yet. If your browser asked about local network access, choose Allow.
            {mac && ' If Terminal showed the compiler complaining, paste that output back — it names the line.'}
          </Typography>
        )}
      </div>
    ) : null,
  };

  /* The macOS-only step, and the reason this screen earns its place.
   *
   * Both permissions are granted by the user, per-binary, in System Settings, and no code here can grant
   * either. Reported separately and live, because they fail differently and the failures do not look like
   * failures: without Accessibility a recording is empty, and without Screen Recording a screenshot is
   * black and every window title is missing. */
  const permissions = health?.permissions;
  const restart = needsRestart(health ?? null);

  const permissionStep: Step = {
    title: 'Allow it to watch and to see, then restart it once',
    done: !!permissions && permissions.accessibility && permissions.screenRecording && !restart,
    note: 'macOS asks the first time the agent needs each one: a dialog saying it “would like to control this computer using accessibility features”. Click Open System Settings, find mouseflow-agent in the list, and switch it on. The switch only appears after the agent has asked once.',
    body: (
      <ul className="flex flex-col gap-1.5">
        {[
          {
            key: 'accessibility' as const,
            title: 'Accessibility',
            said: 'Records clicks and keystroke timing, reads what you clicked on, and clicks for you.',
            missing: 'Without it a recording comes back empty.',
            pane: 'Privacy & Security → Accessibility',
          },
          {
            key: 'screenRecording' as const,
            title: 'Screen Recording',
            said: 'Takes the screenshots the agent works from, and reads other applications’ window titles.',
            missing: 'Without it screenshots are black and window titles are missing.',
            pane: 'Privacy & Security → Screen Recording',
          },
        ].map((row) => {
          /* Three states, not two: granted, refused, and not-yet-answerable. An agent that is not running
           * cannot report a permission, and drawing that as "refused" would send somebody to System
           * Settings to fix something that is not broken. */
          const granted = permissions ? permissions[row.key] : null;
          return (
            <li
              key={row.key}
              className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-lg border-stroke/45 border bg-surface-card2 px-3 py-2"
            >
              <span
                className={cn(
                  'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border text-[0.7rem]',
                  granted === true
                    ? 'border-fb-green/50 bg-fb-green/15 text-fb-green'
                    : granted === false
                      ? 'border-fb-attention/50 bg-fb-attention/15 text-fb-attention'
                      : 'border-stroke text-ink-inactive',
                )}
              >
                {granted === true ? <Check className="size-3" /> : granted === false ? '!' : '·'}
              </span>
              <span className="min-w-0 flex-1">
                <Typography variant="span" weight="semibold" className="block text-[0.86rem]">
                  {row.title}
                </Typography>
                <Typography variant="span" className="block text-[0.8rem] text-ink-inactive">
                  {row.said}
                  {granted === false ? ` ${row.missing}` : ''}
                </Typography>
              </span>
              <span
                className={cn(
                  'shrink-0 text-[0.76rem]',
                  granted === false ? 'text-fb-attention' : 'text-ink-inactive',
                )}
              >
                {granted === true ? 'granted' : granted === false ? row.pane : 'waiting for the agent'}
              </span>
            </li>
          );
        })}

        {/* The step that was missing entirely, and the one somebody gets stuck on.
          *
          * The event tap is installed when the agent starts - before the switch was flipped - so granting
          * Accessibility does not reach the process that is already running. Without this the screen said
          * "granted" beside a permission and went on reporting no keyboard, and there was nothing on it to
          * suggest what to do.
          *
          * The BINARY, not the installer: re-running the installer rebuilds, and macOS ties a permission to
          * the exact build, so that restart would take away the permission it was made for. The installer
          * skips the rebuild when nothing changed, and this command skips it entirely. */}
        {restart && (
          <li className="rounded-lg border-fb-attention/40 border bg-fb-attention/[0.08] px-3 py-2">
            <Typography variant="span" weight="semibold" className="block text-[0.86rem]">
              Granted, but the running agent started before you granted it
            </Typography>
            <Typography variant="p" className="mt-0.5 mb-2 max-w-[64ch] text-ink-inactive text-[0.8rem]">
              It installs its event tap when it starts, so this one is still without it. In Terminal press
              Ctrl-C, then paste this — it starts the agent that is already built rather than building
              another one, which is what keeps the permission you just granted.
            </Typography>
            <Command text={macRestartCommand(state.port)} onCopy={(t) => void copy(t)} />
          </li>
        )}
      </ul>
    ),
  };

  const versionStep: Step = {
    title: stale ? `Update it to ${AGENT_WANTS}` : 'It is current',
    done: !!health && !stale,
    note: stale
      ? mac
        ? `Version ${health?.version} is running, and this app expects ${AGENT_WANTS}. Run the same install command again — it stops the running one, rebuilds, and starts the new one.`
        : `Version ${health?.version} is running, and this app expects ${AGENT_WANTS}. Close that PowerShell window first — otherwise the old one keeps answering on the port — then paste the command again.`
      : 'The version answering is the one this app was built against.',
  };

  const autostartStep: Step = {
    title: 'Keep it running after you log in',
    done: !!health?.autostart,
    note: mac
      ? 'Adds a launch agent under your own account. Always available here, unlike on Windows: the installer leaves a real file on disk, so there is something for the launcher to point at.'
      : health?.canAutostart
        ? 'Drops a launcher in your Startup folder. Only available when the agent was started from a downloaded file with a pinned origin — a piped start leaves nothing for the launcher to point at.'
        : 'Available once the agent has been started from a downloaded file with a pinned origin: a piped start leaves nothing for the launcher to point at.',
    body: health?.canAutostart && !health?.autostart ? (
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
  };

  /* The permission step only exists on macOS - on Windows there is nothing to grant and a step that is
   * permanently ticked is furniture. */
  const steps: Step[] = mac
    ? [commandStep, runStep, permissionStep, versionStep, autostartStep]
    : [commandStep, runStep, versionStep, autostartStep];

  return (
    <div className="max-w-[820px] p-5">
      <section className="rounded-xl border-stroke border bg-surface-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Typography variant="h2" weight="semibold" className="text-[1.05rem]">
              {health ? (stale ? 'The agent needs updating' : 'Connected') : 'Connect the agent'}
            </Typography>
            <Typography variant="p" className="mt-1 max-w-[68ch] text-ink-secondary text-[0.88rem]">
              A browser tab cannot see mouse events outside its own window or inject real clicks, so one
              small helper runs on your machine — it talks to this page over loopback only, and has no
              outbound network code of its own.
            </Typography>
          </div>

          {/* Both always reachable. Guessed from this browser, corrected by a running agent, and switchable
            * either way - reading the macOS steps out to somebody from a Windows machine is a real thing. */}
          <PlatformPicker
            platform={platform}
            onPick={() => { setCopied(false); setShowLocal(false); }}
          />
        </div>

        {unknown && (
          /* Neither guessed nor hidden. There is no agent for a platform that is not one of these two, and
           * the honest version of that is a sentence rather than a chooser with nothing lit in it. */
          <Typography variant="p" className="mt-3 max-w-[70ch] text-fb-attention text-[0.83rem]">
            This browser does not say which kind of machine it is on, so the Windows steps are showing —
            pick macOS above if that is where you are. The agent runs on Windows and macOS; there is no
            Linux build yet.
          </Typography>
        )}

        {/* Said once, where the difference is decided rather than in every step below it. */}
        {mac && (
          <Typography variant="p" className="mt-3 max-w-[70ch] rounded-lg border-stroke/60 border bg-surface-card2 px-3 py-2 text-ink-inactive text-[0.82rem]">
            The macOS agent is compiled on your machine rather than downloaded. That is what keeps Gatekeeper
            out of the way, and it means the first run needs Xcode Command Line Tools — one command, which
            the installer names if they are missing.
          </Typography>
        )}

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
            {mac
              ? 'The agent installs a listen-only event tap while it runs — listen-only because a tap that can alter events can drop them, and a recorder must not change what you are doing while it watches. Events are only stored between Start and Stop, nothing is written to disk, and the origin is pinned to this page.'
              : 'The agent installs a low-level mouse hook while it runs. Events are only stored between Start and Stop, nothing is written to disk, and the origin is pinned to this page’s origin so other sites cannot reach it.'}
          </Typography>
          {mac && (
            <div className="mt-2">
              <Typography variant="p" className="mb-1.5 max-w-[68ch] text-ink-inactive text-xs">
                To stop it: Ctrl-C in that Terminal window, or close it. To remove it completely — the launch
                agent and the installed files, leaving only the System Settings entries:
              </Typography>
              <Command
                text={`${macInstallCommand(state.port).split(' | ')[0]} | bash -s -- --uninstall`}
                onCopy={(t) => void copy(t)}
              />
            </div>
          )}
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
