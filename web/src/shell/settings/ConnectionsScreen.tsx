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
import { ExternalLink } from 'lucide-react';
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
import { agentKey, linkAccount, setAgentKey, unlinkAccount } from '@/lib/agent';
import { mintDeviceToken } from '@/lib/api';
import {
  Command, DownloadLink, PlatformPicker, needsRestart, usePlatform,
} from '@/features/connect/platform';
import { CONSENT_LINE, mcpUrl } from '@/features/mcp/facts';
import { Row, type Say } from '../SettingsDialog';

/* ОДНО ПОЛЕ, И ОНО НЕ СПРАШИВАЕТ ПОДТВЕРЖДЕНИЯ.
 *
 * Ключ либо подходит, либо нет, и узнать это можно только попробовав - поэтому здесь нет кнопки
 * «проверить»: следующий же запрос к агенту и есть проверка, а его отказ объяснён словами в agentCall.
 * Кнопка, отвечающая «сохранено», про ключ ничего не доказывала бы.
 *
 * type="password" - потому что это ключ от чужого рабочего стола, а экран настроек открывают при людях;
 * «Show» рядом, потому что вставленное надо иногда сверить глазами. */
function KeyField({ port }: { port: number }) {
  const [value, setValue] = useState(() => agentKey(port));
  const [shown, setShown] = useState(false);
  const [said, setSaid] = useState('');

  return (
    <span className="flex flex-wrap items-center gap-2">
      <input
        type={shown ? 'text' : 'password'}
        className="w-56 rounded-lg border border-stroke/60 bg-surface-card2 px-2 py-1 font-mono text-[0.78rem]"
        placeholder="paste the agent's key"
        value={value}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => { setValue(e.target.value); setSaid(''); }}
      />
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          setAgentKey(port, value);
          /* СКАЗАНО, ЧТО ИМЕННО СЛУЧИЛОСЬ, а не «сохранено»: пустое поле СТИРАЕТ ключ, и человек,
           * очистивший его случайно, должен это увидеть. */
          setSaid(value.trim() ? 'Saved for this browser.' : 'Removed.');
        }}
      >
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setShown((on) => !on)}>
        {shown ? 'Hide' : 'Show'}
      </Button>
      {said && <Typography variant="span" className="text-[0.76rem] text-ink-secondary">{said}</Typography>}
    </span>
  );
}

export const ConnectionsScreen = ({ say, onClose }: { say: Say; onClose: () => void }) => {
  const { health, stale } = useAgent();
  const [console_] = useConsole();
  const navigate = useNavigate();
  const [showLocal, setShowLocal] = useState(false);
  const [linking, setLinking] = useState(false);
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

  /* The same clipboard, a different sentence. The address below is not pasted into a terminal, and being
   * told to paste a URL into PowerShell is the kind of small wrongness that makes somebody stop trusting
   * the instructions on a page. */
  const copyAddress = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      say({ text: 'Copied. Add it to your AI as a custom connector.', kind: 'good' });
    } catch (_) {
      say({ text: 'The clipboard was blocked. Select the address and copy it.', kind: 'bad' });
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

      {/* КЛЮЧ ЭТОЙ МАШИНЫ - и он стоит ВЫШЕ «пусть Claude водит этот компьютер» нарочно: без ключа та
        * кнопка и не сработает (привязка идёт через /account, а он за ключом), и человек, которому
        * отказали, должен найти причину выше кнопки, а не под ней.
        *
        * Показывается только там, где агент сказал, что ключ ТРЕБУЕТ. Не «умеет»: агент 0.29.0 умеет
        * всегда, и поле, висящее у каждого, кто ничего не включал, - это вопрос, на который девяти из
        * десяти отвечать не надо. Absent у старого агента, и absent значит «не требует».
        *
        * Ключ живёт в этом браузере, по порту, и никогда не уезжает на аккаунт - см. agentKey(). */}
      {health && health.keyRequired === true && (
        <Row
          label="Pairing key for this computer"
          note={agentKey(console_.port)
            ? 'A key is saved for this agent in this browser. If the agent has been restarted it has made '
              + 'a new one, and this one will be refused - paste the new key over it.'
            : 'This agent was started with -RequireKey, so everything except its health check needs the '
              + 'key. It prints the key when it starts and shows it in its tray menu. It is kept in this '
              + 'browser only, per port, and never sent to your account.'}
        >
          <KeyField port={console_.port} />
        </Row>
      )}

      {/* Letting a chat that is not on this computer ask it to do something.
        *
        * The whole ceremony is one button, and that is the point: the app is signed in as the person, so it
        * mints a token and hands it to the agent across loopback - the same pairing the extension gets. A
        * credential nobody sees is a credential nobody mislays, and the agent's own menu bar is where it is
        * switched off, which is where somebody would look.
        *
        * Shown only where the agent can do it: `linked` is absent on a build that has never heard of an
        * account, and absent means "cannot", not "off". */}
      {health && health.linked !== undefined && (
        <Row
          label="Let Claude drive this computer"
          /* Where the switch IS, in the words of the machine you are actually on.
           *
           * This said “Let My AI Act On This Mac”, in the menu bar, “the cursor icon at the top of the
           * screen” — on Windows, where there is no menu bar, no cursor icon at the top of the screen and
           * the item is worded differently. It was written when only a Mac could be attached at all, and
           * it survived the Windows agent gaining the same ability. `health.platform` is reported by the
           * agent itself, so it is a fact about the machine rather than a guess from a user-agent string. */
          note={health.linked
            ? (health.taking
              ? 'On. A connected AI can ask this computer to start or stop a recording, or to run one of '
                + 'your skills. ' + (health.platform === 'windows'
                  ? 'The switch is in the agent’s tray menu, in the notification area — or detach it here.'
                  : 'The switch is “Let My AI Act On This Mac” in the agent’s own menu — the cursor icon at '
                    + 'the top of the screen — or detach it here.')
              : 'Attached, but switched off. ' + (health.platform === 'windows'
                ? 'Turn it back on from the agent’s tray menu, in the notification area.'
                : 'Turn on “Let My AI Act On This Mac” in the agent’s menu, the cursor icon at the top of '
                  + 'the screen.'))
            : 'Nothing can reach this computer from outside; it asks. Attaching lets it ask your account for '
              + 'work, so an AI connected to MouseFlow can start a recording here or run a skill. Off until '
              + 'you say otherwise, and ' + (health.platform === 'windows'
                ? 'the agent’s tray menu is where you turn it off again.'
                : 'the agent’s menu bar is where you turn it off again.')}
        >
          <Button
            variant={health.linked ? 'ghost' : 'secondary'}
            size="sm"
            isLoading={linking}
            onClick={async () => {
              setLinking(true);
              try {
                if (health.linked) {
                  await unlinkAccount(console_.port);
                  say({ text: 'Detached. It will not ask for work again.', kind: 'good' });
                } else {
                  const made = await mintDeviceToken('This computer');
                  await linkAccount(console_.port, made.token, location.origin);
                  say({
                    text: 'Attached. It is taking work now — the agent’s menu bar is where you stop it.',
                    kind: 'good',
                  });
                }
              } catch (err) {
                say({
                  text: err instanceof Error ? err.message : 'that did not work',
                  kind: 'bad',
                });
              } finally {
                setLinking(false);
              }
            }}
          >
            {health.linked ? 'Detach' : 'Attach this computer'}
          </Button>
        </Row>
      )}

      {/* Connecting an AI to the ACCOUNT, which is the other half of the switch above.
        *
        * That switch says a chat may drive this computer; this is how a chat comes to have the account at
        * all. Both belong on this screen because both are answers to "connect MouseFlow to something", and
        * somebody who has just turned the switch on is exactly the person who now needs the address.
        *
        * The URL is shown rather than described. "Add MouseFlow to Claude" without the one line to paste is
        * an instruction that sends somebody to the documentation to find it, which is where the last three
        * of these went wrong. */}
      <Row
        label="Connect an AI"
        note={'Anything that speaks MCP — Claude on the web, in the desktop app or in a terminal — can read '
          + 'your recordings, transcripts and runs through this address, and with the switch above on it '
          + 'can start a recording here or run one of your skills. It signs in with the MouseFlow account '
          + 'you already have; there is no token to copy.'}
      >
        <Button
          variant="ghost"
          size="sm"
          rightSlot={<ExternalLink className="size-4" />}
          onClick={() => window.open('/mcp', '_blank', 'noopener,noreferrer')}
        >
          How to connect it
        </Button>
      </Row>

      <Command text={mcpUrl()} onCopy={copyAddress} />

      <Typography variant="p" className="mt-2 max-w-[62ch] text-ink-inactive text-[0.82rem]">
        {CONSENT_LINE}
      </Typography>

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
