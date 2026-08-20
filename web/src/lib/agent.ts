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
};

export const agentBase = (port: number) => `http://127.0.0.1:${port}`;

interface CallOptions {
  method?: 'GET' | 'POST';
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
      signal: cutoff.signal,
      headers: options.contentType ? { 'content-type': options.contentType } : undefined,
      body: options.body,
    });
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
export const autostartEnable = (port: number) =>
  agentCall<{ ok: true }>(port, '/autostart/enable', { method: 'POST' });

/* ------------------------------------------------------------------ what the app expects of it */

/** The build this app needs on the other end. Compared with what answers; see olderThan. */
/* 0.7.0 is the build that records what a recording is FOR: what each click landed on (0.6.0), plus that a
 * key was pressed and when, plus the foreground window changing. An older one records the same coordinates
 * and none of it, so its transcripts read as a list of positions - a real difference in what the product
 * does, not an internal one, and worth telling somebody to close that PowerShell window for. */
export const AGENT_WANTS = '0.8.0';

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
