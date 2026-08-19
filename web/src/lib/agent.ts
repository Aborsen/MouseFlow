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

export const recordStart = (port: number) =>
  agentCall<{ ok: true }>(port, '/record/start', { method: 'POST' });
export const recordStatus = (port: number) =>
  agentCall<{ recording: boolean; count: number; elapsedMs: number }>(port, '/record/status');
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
/* 0.6.0 is the build that resolves what a click landed on. An older one records the same coordinates and
 * no context at all, so its transcripts read as a list of positions - which is a real difference in what
 * the product does, not an internal one, and worth telling the user to close that PowerShell window for. */
export const AGENT_WANTS = '0.6.0';

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
