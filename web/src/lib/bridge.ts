/* The page's end of the extension bridge.
 *
 * extension/bridge.js is a content script that runs only on this origin. It announces itself, carries a
 * device token into the extension when this page mints one, and forwards a short list of commands so the
 * app can drive a browser run - which the page cannot do itself, since a page has no way to act inside
 * another page.
 *
 * Detection is two-way because either side may load first: both announce, and both ask.
 */
export interface Bridge {
  present: boolean;
  version: string | null;
  paired: boolean;
  who: { name?: string } | null;
}

type Watcher = (bridge: Bridge) => void;

const state: Bridge = { present: false, version: null, paired: false, who: null };
const watchers = new Set<Watcher>();
let listening = false;
let nextId = 1;

const ALLOWED = ['ping', 'page/run', 'page/status', 'page/abort'] as const;
const TIMEOUT_MS = 8000;
const PING_MS = 1200;

function listen() {
  if (listening) return;
  listening = true;

  addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data as { mf?: string; version?: string; paired?: boolean; who?: { name?: string } };
    if (!data || data.mf !== 'mouseflow:extension') return;
    state.present = true;
    state.version = data.version ?? null;
    state.paired = !!data.paired;
    state.who = data.who ?? null;
    for (const watcher of watchers) watcher({ ...state });
  });

  window.postMessage({ mf: 'mouseflow:hello?' }, location.origin);
}

export function watchBridge(watcher: Watcher) {
  listen();
  watchers.add(watcher);
  watcher({ ...state });
  return () => {
    watchers.delete(watcher);
  };
}

/** One request over postMessage, with a correlation id: a poll and an abort overlap the moment Stop is pressed. */
export function askExtension<T>(cmd: (typeof ALLOWED)[number], payload?: Record<string, unknown>): Promise<T | null> {
  if (!ALLOWED.includes(cmd)) return Promise.resolve(null);
  listen();
  const id = `c${nextId++}`;

  return new Promise((resolve) => {
    /* "Is it there?" gets a much shorter fuse than "start a run". Nothing answers a ping in more than a few
     * milliseconds, so a long timeout only means a longer wait before admitting the extension is absent -
     * during which the console looks ready and is not. */
    const timer = setTimeout(() => {
      removeEventListener('message', onReply);
      resolve(null);
    }, cmd === 'ping' ? PING_MS : TIMEOUT_MS);

    function onReply(event: MessageEvent) {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data as { mf?: string; id?: string; res?: T };
      if (!data || data.mf !== 'mouseflow:cmd-result' || data.id !== id) return;
      clearTimeout(timer);
      removeEventListener('message', onReply);
      resolve(data.res ?? null);
    }

    addEventListener('message', onReply);
    window.postMessage({ mf: 'mouseflow:cmd', id, cmd, payload: payload ?? {} }, location.origin);
  });
}

/** Hand a freshly minted device token across, and wait to hear whether the extension took it. */
export function handToExtension(token: string): Promise<{ ok: boolean; who?: { name?: string }; error?: string } | null> {
  listen();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      removeEventListener('message', onDone);
      resolve(null);
    }, 4000);

    function onDone(event: MessageEvent) {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data as { mf?: string; ok?: boolean; who?: { name?: string }; error?: string };
      if (!data || data.mf !== 'mouseflow:paired') return;
      clearTimeout(timer);
      removeEventListener('message', onDone);
      resolve({ ok: !!data.ok, who: data.who, error: data.error });
    }

    addEventListener('message', onDone);
    window.postMessage({ mf: 'mouseflow:pair', token }, location.origin);
  });
}
