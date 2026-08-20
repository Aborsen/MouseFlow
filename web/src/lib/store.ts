/* What this browser remembers, and how the app hears about the agent.
 *
 * Two small pieces of state, both of which used to be module-scoped variables in a 1000-line script:
 *
 *   the console   recordings, the flow being built, the agent port. Local to this browser, because a
 *                 recording is a draft until you keep it as a skill.
 *   the agent     whether it is answering, which version, how big the screen is. One poller, shared,
 *                 rather than every component asking - the old code had three polls at three cadences.
 *
 * Kept in hand-written hooks over a state library: two stores do not earn a dependency, and the shapes
 * here are the ones the old code already proved it needed.
 */
import { useCallback, useEffect, useState } from 'react';
import { type AgentHealth, health, olderThan } from './agent';

const KEY = 'mouseflow';

export interface RecordedEvent {
  x: number;
  y: number;
  delayMs: number;
  action: string;
  /* Where this happened, when the agent could resolve it - the application, the window, and the name and
   * kind of the control under the pointer, read from the accessibility tree at the moment of the click.
   *
   * Present on clicks only: a pointer move has no target worth naming and there are hundreds of them. Absent
   * means NOT KNOWN, never "nothing there" - an elevated window is invisible to the agent, an Electron
   * application often names nothing, and a build older than this one resolved nothing at all. */
  context?: {
    app?: string;
    window?: string;
    control?: string;
    type?: string;
  };
}

export interface Recording {
  id: string;
  name: string;
  created: string;
  events: RecordedEvent[];
  /** Which applications were in front while this was recorded, in first-touched order. */
  windows: { title: string; process: string }[];
  /* When the account last acknowledged this recording, or absent if it never has.
   *
   * The one fact that separates "this exists only here, send it up" from "this was deleted on another
   * machine, drop it" - and without it a two-way sync resurrects every delete, because api/sync.js clears
   * `deleted_at` on upsert. Absent on every recording made before this field existed; features/record/
   * reconcile.ts says what it does about that. */
  syncedAt?: string;
  /* How a replay of THIS recording should behave. On the recording rather than only on a flow step, so that
   * pressing Play on its row and adding it to a flow mean the same thing - which they did not when the row
   * had no answer to "how many times, how fast, does it loop". Optional because every recording made before
   * this existed has none, and the defaults are read through replayOf(). */
  replay?: { repeat: number; speed: number; loop: boolean };
}

export interface FlowStep {
  recordingId: string;
  repeat: number;
  speed: number;
  delayAfterMs: number;
}

/* A long session, as this browser remembers it: counts, never events.
 *
 * Sixteen half-hour parts is a few megabytes of events, and one origin gets about five for EVERY recording
 * together - so the events live on the account, which is where the transcript reads every recording from
 * anyway, and this is the receipt. The shape is defined in features/record/long-session.ts, next to the
 * arithmetic that explains why it exists; the store only has to persist it.
 *
 * `unknown[]` rather than the type: lib/ is below features/ here, and importing upward to name a field would
 * be the first such edge in this codebase. The one place that reads these casts once, on the way out. */
export interface Console {
  port: number;
  recordings: Recording[];
  /** Long recording sessions and their parts. See features/record/long-session.ts for the shape. */
  sessions: unknown[];
  /* What the last reconciliation with the account did.
   *
   * Kept because one of its outcomes has to be said out loud: recordings appearing is welcome, recordings
   * DISAPPEARING because another machine deleted them is something somebody needs told once. Null until a
   * reconciliation has run. */
  lastSync: {
    at: string;
    pulled: number;
    pushed: number;
    forgotten: number;
    left: number;
  } | null;
  flow: FlowStep[];
  startDelayMs: number;
  flowRepeat: number;
  flowForever: boolean;
}

const EMPTY: Console = {
  port: 8787,
  recordings: [],
  sessions: [],
  lastSync: null,
  flow: [],
  startDelayMs: 3000,
  flowRepeat: 1,
  flowForever: false,
};

function read(): Console {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const saved = JSON.parse(raw) as Partial<Console>;
    return {
      ...EMPTY,
      ...saved,
      // Trusted only as far as its shape: this is data an older build wrote.
      recordings: Array.isArray(saved.recordings) ? saved.recordings : [],
      sessions: Array.isArray(saved.sessions) ? saved.sessions : [],
      lastSync: saved.lastSync && typeof saved.lastSync === 'object' ? saved.lastSync : null,
      flow: Array.isArray(saved.flow) ? saved.flow : [],
      port: Number.isFinite(saved.port) ? (saved.port as number) : 8787,
    };
  } catch (_) {
    return EMPTY;
  }
}

/* One copy in memory, shared by every component that asks, so two lists of recordings can never disagree
 * about what is in them. */
let current = read();
const listeners = new Set<() => void>();

function commit(next: Console) {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch (_) {
    // Private mode, or a full quota. The session still works; only persistence is lost.
  }
  for (const listener of listeners) listener();
}

export function useConsole() {
  const [, bump] = useState(0);

  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const update = useCallback((patch: Partial<Console> | ((prev: Console) => Partial<Console>)) => {
    const next = typeof patch === 'function' ? patch(current) : patch;
    commit({ ...current, ...next });
  }, []);

  return [current, update] as const;
}

export const consoleState = () => current;

/* ------------------------------------------------------------------------- the agent, polled once */

export interface AgentStatus {
  health: AgentHealth | null;
  /** Running, but older than this app expects: it will fail in ways that look like bugs. */
  stale: boolean;
  /** How many polls in a row have failed - used to slow down rather than hammer a machine with no agent. */
  failures: number;
}

let status: AgentStatus = { health: null, stale: false, failures: 0 };
const watchers = new Set<() => void>();
let timer: number | null = null;

async function poll() {
  const port = current.port;
  try {
    const body = await health(port);
    status = { health: body, stale: olderThan(body.version), failures: 0 };
  } catch (_) {
    status = { health: null, stale: false, failures: status.failures + 1 };
  }
  for (const watcher of watchers) watcher();

  /* Eager while it matters - answering, or a run of failures short enough that someone is probably still
   * setting up - and slow otherwise, because a machine with no agent should not be polled every two
   * seconds forever. */
  const eager = status.health !== null || status.failures < 8;
  timer = window.setTimeout(poll, eager ? 2000 : 15000);
}

export function useAgent(): AgentStatus {
  const [, bump] = useState(0);

  useEffect(() => {
    const watcher = () => bump((n) => n + 1);
    watchers.add(watcher);
    if (timer === null) {
      timer = window.setTimeout(poll, 0);
    }
    return () => {
      watchers.delete(watcher);
      if (watchers.size === 0 && timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, []);

  return status;
}

/** Ask now rather than waiting for the next tick - after starting the agent, say. */
export function refreshAgent() {
  if (timer !== null) clearTimeout(timer);
  timer = window.setTimeout(poll, 0);
}

export const uid = () => 'r' + Math.random().toString(36).slice(2, 10);
