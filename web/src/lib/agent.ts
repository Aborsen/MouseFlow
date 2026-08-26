/* The local agent, as a typed client.
 *
 * A browser tab cannot see mouse events outside its own window or inject real clicks, so a small helper
 * runs on the user's machine and this talks to it over loopback. Everything the desktop half does goes
 * through here: health, recording, replay, and - for "Create the flow" - the screen and the input.
 *
 * Ported from app.js, with the lessons it learned kept intact:
 *
 *   - every call has a deadline, because loopback is fast or it is broken, and a request that never
 *     settles used to leave the console saying "Running" over a machine doing nothing
 *   - a failure to reach the agent is TAGGED as such, so a caller can tell "not running" from "answered
 *     with an error", which need different sentences
 *   - reaching 127.0.0.1 from an https page needs the user's Local Network Access permission in Chrome
 *     142+; no response header can grant it, so a first failure is not necessarily a missing agent
 */

export interface AgentHealth {
  ok: true;
  version: string;
  screen: { w: number; h: number };
  recording: boolean;
  playing: boolean;
  canSee?: boolean;
  canWindows?: boolean;
  /** Whether it resolves what a click landed on - the application, window and control name. Absent on any
   * build before 0.6.0, and absent is the answer: those recordings carry coordinates and nothing else. */
  canName?: boolean;
  /** Whether typing is recorded as an EVENT - that a key was pressed and when, never which key. False when
   * the keyboard hook failed to install, absent before 0.7.0; either way a transcript then cannot tell
   * "typed nothing" from "was not watching", which is why the flag exists rather than being inferred. */
  canKeys?: boolean;
  /* Whether a recording can outlast one response - /record/drain, from 0.8.0. Without it the only way
   * events leave the agent is /record/stop, so a session is bounded by what fits in memory and in one
   * string, and the app has to offer a short recording rather than a day-long one it cannot take delivery
   * of. Absent on every older agent, which is the answer. */
  canDrain?: boolean;
  /* Which implementation answered. Absent on any agent older than the macOS one, and only ever used to
   * decide which install command to show - never to decide what the agent can do, which is what the can*
   * flags are for. */
  platform?: 'windows' | 'macos';
  /* Whether this machine is attached to an account, and whether it is taking work from it. Two facts, not
   * one: attached and not taking is the ordinary resting state, and treating them as one would offer to
   * pair a machine that is already paired. Absent on any agent that cannot do it at all, which is the
   * answer for those - "cannot" rather than "off". */
  linked?: boolean;
  taking?: boolean;
  /* macOS only, and the reason the Connections screen can be useful rather than apologetic.
   *
   * On Windows both of these are unconditionally true and there is nothing to report. On macOS they are
   * granted by the user, per-binary, in System Settings, and cannot be granted by any code - so the agent
   * says which one is missing and the screen turns that into an instruction with a button. Without this the
   * failure is a working agent, a black screenshot and no explanation. */
  permissions?: { accessibility: boolean; screenRecording: boolean };
  /* Whether it is set to start at login, as opposed to whether it COULD be. Both agents have always sent
   * this and the type never declared it, so the Connections screen could offer "Enable autostart" to
   * somebody who had already enabled it - the third field this session found declared differently from the
   * way it is sent. */
  autostart?: boolean;
  canAutostart?: boolean;
  originPinned?: boolean;
}

export interface AgentWindow {
  title: string;
  process: string;
  active: boolean;
  minimized: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Shot {
  ok: true;
  png: string;
  format?: string;
  bytes?: number;
  w: number;
  h: number;
  scale: number;
  originX: number;
  originY: number;
  error?: string;
}

export class AgentError extends Error {
  /** True when nothing answered at all, as opposed to answering with a refusal. */
  offline: boolean;
  status?: number;

  constructor(message: string, offline = false, status?: number) {
    super(message);
    this.name = 'AgentError';
    this.offline = offline;
    this.status = status;
  }
}

/* Chrome 142 replaced Private Network Access with Local Network Access, a user permission, and a request
 * from a public origin to 127.0.0.1 is refused until it is granted. Declaring the address space is the
 * opt-in the spec asks for, and it doubles as the mixed-content exemption for an https page reaching
 * http://127.0.0.1.
 *
 * It is NOT a way round the permission - measured, not assumed: from the deployed origin, with the agent
 * answering curl on the same machine, a fetch with this option fails exactly like one without until the
 * permission is granted. It is declared because the spec asks callers to declare it, not because it buys
 * anything on its own.
 *
 * The option is unknown to browsers that do not implement it, and an unknown key in RequestInit is
 * ignored rather than rejected - so this is safe to send everywhere and there is nothing to feature-detect.
 */
interface LoopbackInit extends RequestInit {
  targetAddressSpace?: 'loopback' | 'local' | 'public';
}

/** Why a loopback call did not happen. `blocked` is the browser refusing; `silent` is nothing listening. */
export type LoopbackTrouble = 'blocked' | 'ungranted' | 'silent' | 'unknown';

/* Which of those it was.
 *
 * A refused request and a dead process are the SAME TypeError with the same message - "Failed to fetch" -
 * so the failure itself cannot tell them apart, and treating both as "agent offline" is what sent people
 * to reinstall an agent that was already running. The permission is the one thing that can distinguish
 * them, so it is asked afterwards, on the way to explaining a failure that already happened.
 *
 * Read as an EXPLANATION, never as a gate. The state is `denied` before anyone has been asked, and it is
 * `denied` on a loopback page where the requests demonstrably work - so gating on it would refuse to try
 * on exactly the machines where trying succeeds. Asking only after a failure sidesteps both.
 */
export async function loopbackTrouble(): Promise<LoopbackTrouble> {
  const anyNav = navigator as Navigator & {
    permissions?: { query(d: { name: string }): Promise<{ state: string }> };
  };
  if (!anyNav.permissions?.query) return 'unknown';
  try {
    const { state } = await anyNav.permissions.query({ name: 'local-network-access' });
    if (state === 'granted') return 'silent';
    return state === 'denied' ? 'blocked' : 'ungranted';
  } catch (_) {
    /* A browser with no such permission to query has no Local Network Access to refuse either. */
    return 'silent';
  }
}

/** Per-endpoint deadlines. /do can legitimately take a while: it types character by character. */
const DEADLINE: Record<string, number> = {
  '/health': 4000,
  '/shot': 12000,
  '/pulse': 5000,
  '/windows': 5000,
  '/do': 20000,
  '/record/start': 5000,
  '/record/status': 2500,
  '/record/stop': 15000,
  '/replay': 5000,
  '/replay/status': 2500,
  '/replay/abort': 4000,
  '/autostart/enable': 8000,
  '/account': 5000,
};

export const agentBase = (port: number) => `http://127.0.0.1:${port}`;

interface CallOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: string;
  contentType?: string;
  /** Answers that are text rather than JSON - /record/stop returns a .mmmacro. */
  text?: boolean;
}

export async function agentCall<T>(port: number, path: string, options: CallOptions = {}): Promise<T> {
  const key = Object.keys(DEADLINE).find((p) => path.startsWith(p));
  const cutoff = new AbortController();
  const timer = setTimeout(() => cutoff.abort(), (key && DEADLINE[key]) || 8000);

  let res: Response;
  try {
    res = await fetch(agentBase(port) + path, {
      method: options.method ?? 'GET',
      mode: 'cors',
      targetAddressSpace: 'loopback',
      signal: cutoff.signal,
      headers: options.contentType ? { 'content-type': options.contentType } : undefined,
      body: options.body,
    } as LoopbackInit);
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    throw new AgentError(
      aborted ? 'the agent did not answer in time' : `nothing answered on 127.0.0.1:${port}`,
      true,
    );
  } finally {
    clearTimeout(timer);
  }

  if (options.text) {
    const body = await res.text();
    if (!res.ok) throw new AgentError(body || `the agent answered ${res.status}`, false, res.status);
    return body as unknown as T;
  }

  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) {
    throw new AgentError(body?.error ?? `the agent answered ${res.status}`, false, res.status);
  }
  return body as T;
}

export const health = (port: number) => agentCall<AgentHealth>(port, '/health');
export const windows = (port: number) =>
  agentCall<{ ok: true; windows: AgentWindow[] }>(port, '/windows');
export const shot = (port: number, width?: number) =>
  agentCall<Shot>(port, width ? `/shot?w=${width}` : '/shot');
export const pulse = (port: number) => agentCall<{ ok: true; grid: string }>(port, '/pulse');
export const doAction = (port: number, body: string) =>
  agentCall<{ ok: true }>(port, '/do', { method: 'POST', body, contentType: 'text/plain' });

/* ------------------------------------------------------------------ a machine, whichever one it is

 * The four things the decision loop does to a computer, as an interface rather than a port number.
 *
 * The loop never needed to be on the machine it drives - its model call already goes out over the network -
 * and the only reason it was is these four calls to 127.0.0.1. Named, they can be answered another way: by
 * an agent that asked the deployment for work and is holding a request open, waiting to be told what to do
 * next. The loop cannot tell the two apart, which is the whole point of writing it down like this. */
export interface Machine {
  windows(): Promise<{ ok: true; windows: AgentWindow[] }>;
  pulse(): Promise<{ ok: true; grid: string }>;
  shot(width?: number): Promise<Shot>;
  do(body: string): Promise<{ ok: true }>;
}

/** This computer, over loopback - exactly what every caller did before there was an interface. */
export function localMachine(port: number): Machine {
  return {
    windows: () => windows(port),
    pulse: () => pulse(port),
    shot: (width) => shot(port, width),
    do: (body) => doAction(port, body),
  };
}

/* `moveMs` thins the pointer path for a session meant to last hours - see features/record/long-session.ts
 * for the arithmetic. Omitted for an ordinary recording, and then the agent keeps the default it was started
 * with, so nothing about a short recording changes. */
export const recordStart = (port: number, moveMs?: number) =>
  agentCall<{ ok: true; moveMs?: number }>(
    port,
    `/record/start${moveMs ? `?moveMs=${Math.round(moveMs)}` : ''}`,
    { method: 'POST' },
  );
/* `count` is what is in the agent's buffer NOW, which after a drain is not what the session has recorded -
 * the caller adds up the chunks it was handed. `part` tells the two apart: 0 means nothing has been drained
 * and `count` is the whole recording. Both absent before 0.8.0. */
export const recordStatus = (port: number) =>
  agentCall<{ recording: boolean; count: number; elapsedMs: number; part?: number; moveMs?: number }>(
    port, '/record/status',
  );
/* Takes what has piled up and LEAVES THE RECORDING RUNNING. 409 when it is not running, which is a different
 * answer from an empty body - "nothing happened in the last half hour" and "there is no recording" have to be
 * distinguishable, or a chunker writes an empty part every half hour for as long as the tab stays open. */
export const recordDrain = (port: number) =>
  agentCall<string>(port, '/record/drain', { method: 'POST', text: true });
export const recordStop = (port: number) =>
  agentCall<string>(port, '/record/stop', { method: 'POST', text: true });

export const replay = (port: number, flowBody: string) =>
  agentCall<{ ok: true }>(port, '/replay', { method: 'POST', body: flowBody, contentType: 'text/plain' });
export const replayStatus = (port: number) =>
  agentCall<{
    playing: boolean; step: number; steps: number; pass: number; passes: number;
    index: number; total: number;
  }>(port, '/replay/status');
export const replayAbort = (port: number) =>
  agentCall<{ ok: true }>(port, '/replay/abort', { method: 'POST' });
/* Attach this machine to the account, so a chat that is not on it can ask it to do something.
 *
 * The token goes straight across loopback and is never shown: the app is signed in as the person, mints one,
 * and hands it over - the same pairing the extension gets across its bridge, for the same reason. A
 * credential somebody has to carry is a credential somebody mislays.
 *
 * `base` is where the agent will ask for work. Sent rather than assumed, so a deployment that is not the
 * default one still works and nothing here has to guess. */
export const linkAccount = (port: number, token: string, base: string) =>
  agentCall<{ ok: true; linked: true; taking: boolean }>(port, '/account', {
    method: 'POST',
    contentType: 'text/plain',
    body: `token=${token} base=${base}`,
  });

export const unlinkAccount = (port: number) =>
  agentCall<{ ok: true; linked: false }>(port, '/account', { method: 'DELETE' });

export const autostartEnable = (port: number) =>
  agentCall<{ ok: true }>(port, '/autostart/enable', { method: 'POST' });

/* ------------------------------------------------------------------ what the app expects of it */

/** The build this app needs on the other end. Compared with what answers; see olderThan. */
/* 0.9.6 is the build that says whether an action did anything.
 *
 * A watched run spent a minute renaming a spreadsheet - ten actions at six to nine seconds, none of which
 * landed, because the caret was never in the field. Nothing could tell it: `do` has no return value and the
 * only evidence was the next screenshot, which the model read and misread and tried again. This build takes
 * the 64x36 fingerprint either side of an action and reports the fact; the deployment turns it into the one
 * sentence both drivers say.
 *
 * The previous note, kept because the reason still holds. 0.9.5 is the build that notices where a page went.
 *
 * A recording knew when the work moved to a different APPLICATION and never when the same one changed what
 * it was showing - so a browser navigating from one page to the next left no trace, and a transcript could
 * say which link was clicked but never where it led. It marks a settled title now, which is what makes a
 * segment carry the page rather than the page it came from.
 *
 * The previous note, kept because the reason still holds. 0.9.4 is the build that knows the work ended by
 * pressing Send.
 *
 * Before it, every keystroke was anonymous - a key was pressed, never which - so a recording could not say
 * that anything was committed, and a skill made from one typed the message and never sent it. The keys
 * that cannot spell anything are named now: Return, Tab, Escape, the arrows, and chords held with Command
 * or Control. Letters stay anonymous, which is the promise that was never up for negotiation.
 *
 * This nudge is the only thing that tells somebody holding the older build to fetch the newer, and it went
 * out under 0.9.3 for a few hours because the fix landed after that number was already taken - the same
 * mistake this note was added to prevent, made twice in one day.
 *
 * The previous note, kept because the reason still holds. 0.9.3 is the build that can read the name of a
 * browser tab.
 *
 * Before it, a click on a tab strip came back as "clicked on something Google Chrome did not name", so a
 * recording of tab clicks produced a skill with no steps in it, and a replay went on clicking a coordinate
 * that had moved. Nothing on 0.9.2 says which 0.9.2 it is - the fix shipped under the same number for a few
 * hours - and this nudge is the only thing that tells somebody holding the older one to fetch the newer.
 *
 * The previous note, kept because the reason still holds. 0.9.2 is the build that no longer needs a second
 * program installed beside it.
 *
 * Before it, a goal skill - the kind the wizard makes - could only run on a machine that also had
 * mcp/worker.mjs running, because the decision loop talked to 127.0.0.1. From 0.9.0 the agent carries the
 * goal itself, one action per request against the deployment, and it reports its own crashes rather than
 * writing them to a log nobody opens. 0.9.2 notices a stop while it is waiting.
 *
 * That is why this moved: the nudge to update is the only way somebody on 0.8.x finds out that the install
 * step they were told about is no longer one. The previous note, kept because the reason still holds: 0.7.0
 * is the build that records what a recording is FOR - what each click landed on, plus that a key was
 * pressed and when - and an older one produces transcripts that read as a list of positions. */
export const AGENT_WANTS = '0.9.8';

/** Numeric, part by part: "0.10.0" is not behind "0.5.0", which a string comparison gets wrong. */
export function olderThan(running: string | null | undefined, wanted = AGENT_WANTS): boolean {
  if (!running) return false;
  const mine = running.split('.').map((part) => parseInt(part, 10) || 0);
  const want = wanted.split('.').map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(mine.length, want.length); i++) {
    if ((mine[i] ?? 0) < (want[i] ?? 0)) return true;
    if ((mine[i] ?? 0) > (want[i] ?? 0)) return false;
  }
  return false;
}

/** Piped straight into a scriptblock: nothing to download, unblock, or exempt from execution policy. */
/* Which machine this browser is on.
 *
 * Only ever used to pick which install command to show FIRST - both are always reachable, because somebody
 * on Windows reading this to a colleague on a Mac is a real thing that happens. A running agent's own
 * `platform` outranks this, since it is a fact rather than a guess about a user agent string. */
export type HostOS = 'windows' | 'macos' | 'other';

/* Client Hints first, then the string, then an honest shrug.
 *
 * `navigator.userAgentData.platform` says "macOS" or "Windows" outright, and it is the one answer the browser
 * promises not to spoil: Chrome froze the User-Agent string, which now reports a fixed Windows version
 * whatever the machine actually is. The string is the fallback because Safari and Firefox have no
 * userAgentData at all - and there, `navigator.platform` is still "MacIntel" or "Win32".
 *
 * 'other' is a real answer, not a failure to try. Linux has no agent to install, and guessing Windows for
 * somebody on Linux would hand them a command that cannot work while looking confident about it. */
export function hostOS(): HostOS {
  const hinted = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform;
  if (hinted) {
    if (/mac/i.test(hinted)) return 'macos';
    if (/win/i.test(hinted)) return 'windows';
    /* A hint that says something else - "Linux", "Android", "Chrome OS" - is believed. Falling through to
     * the string here would find "Linux x86_64" and answer 'other' anyway, but by accident. */
    return 'other';
  }

  const said = `${navigator.userAgent} ${(navigator as { platform?: string }).platform ?? ''}`;
  /* Mac before Windows: a Mac user agent contains neither "Win" nor anything Windows-like, but the reverse
   * is not true of every string, and an iPad in desktop mode reports "MacIntel". */
  if (/mac|iphone|ipad|ipod/i.test(said)) return 'macos';
  if (/win/i.test(said)) return 'windows';
  return 'other';
}

/* The macOS install, which compiles rather than downloading a binary.
 *
 * Not a shorter one-liner because there is no shorter honest one. Windows fetches the agent and runs it in
 * memory; macOS has no equivalent, and a prebuilt binary without an Apple Developer certificate arrives
 * quarantined and is refused by Gatekeeper - so the source is fetched and built on the machine, which is
 * never quarantined. The cost is Xcode Command Line Tools, and the installer says so if they are missing. */
export function macInstallCommand(port: number): string {
  const origin = location.origin;
  const portArg = port !== 8787 ? ` --port ${port}` : '';
  return `curl -fsSL ${origin}/agent/install-mac.sh | bash -s -- --origin ${origin}${portArg}`;
}

/* The label the installer registers with launchd. Stopping and starting go through it rather than through
 * the process, because the installer makes the agent a login item with KeepAlive: `pkill` does not stop it,
 * it makes launchd start it again a second later - so a "stop" command that killed the process would be a
 * switch that does nothing. */
const MAC_LABEL = 'gui/$(id -u)/com.mouseflow.agent';

/** Stopping it. There is no window to close, and killing the process is not enough - see MAC_LABEL. */
export const MAC_STOP_COMMAND = `launchctl bootout ${MAC_LABEL}`;

/* Restarting what is already built, rather than building it again.
 *
 * Needed for the step nobody can skip: the event tap goes in when the agent starts, which is before anybody
 * has flipped the switch in System Settings, so granting Accessibility means restarting it once. Re-running
 * the installer would rebuild, and macOS ties a permission to the exact binary - checksum included - so that
 * restart would take away the permission it was made for.
 *
 * Through `open` and the bundle, never the binary inside it directly: a bare executable launched from a
 * terminal is not its own subject as far as permissions go - macOS blames the responsible process, which is
 * the terminal - so it would get no prompt and no switch of its own. That is the entire reason the installer
 * builds an .app. */
export function macRestartCommand(_port: number): string {
  /* One command, and it takes its arguments from the login item rather than repeating them: the port and the
   * origin are already in the plist the installer wrote, and a restart that passed its own would quietly
   * disagree with what starts at login. `kickstart -k` stops it and starts it again in one go, which also
   * avoids the second copy that `open` next to a live launchd job would produce. */
  return `launchctl kickstart -k ${MAC_LABEL}`;
}

/** What to run when the installer says the Swift compiler is missing. Apple's own installer, one dialog. */
export const MAC_TOOLS_COMMAND = 'xcode-select --install';

export function startCommand(port: number): string {
  const origin = location.origin;
  const portArg = port !== 8787 ? ` -Port ${port}` : '';
  return `& ([scriptblock]::Create((irm ${origin}/agent/mouseflow-agent.ps1)))${portArg} -AllowOrigin ${origin}`;
}

/* Runs a downloaded copy WITHOUT -File.
 *
 * -File is what you would expect to use, and it fails on any machine whose execution policy comes from
 * Group Policy: the MachinePolicy scope outranks -ExecutionPolicy Bypass, so an AllSigned estate refuses
 * an unsigned .ps1 outright. Handing the script text to a scriptblock never loads a file, so the policy
 * never engages. */
export function localFileCommand(port: number): string {
  const origin = location.origin;
  const portArg = port !== 8787 ? ` -Port ${port}` : '';
  return `& ([scriptblock]::Create((Get-Content "$env:USERPROFILE\\Downloads\\mouseflow-agent.ps1" -Raw)))${portArg} -AllowOrigin ${origin}`;
}
