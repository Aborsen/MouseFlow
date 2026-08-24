/* Every /api call the app makes, routed through the worker.
 *
 * This is what makes the app's OWN screens run in the panel rather than panel-sized twins of them. The app
 * fetches relative paths with a session cookie; the panel is a chrome-extension:// page with no cookie and
 * no same origin. So the fetch it calls is not the browser's: it is this, which hands the request to the
 * service worker, where the device token lives, and rebuilds the answer as a Response the app cannot tell
 * from a real one.
 *
 * THE REPOSITORY HAS DONE THIS BEFORE, and it is the same argument: mcp/shared.mjs installs a fetch shim so
 * the MCP server can run the app's own modules instead of copying them. What was true for a node process is
 * true for a panel.
 *
 * WHY IT CATCHES EVERYTHING. Seventeen screens call `fetch('/api/…')` directly, past lib/api.ts's `call()`.
 * A shim on `globalThis.fetch` covers those and `call()` at once, which an adapter written at the api.ts
 * layer would not - and a screen that reached the network another way would be a screen that silently does
 * not work in here.
 *
 * THE TOKEN NEVER ARRIVES HERE. It stays in the worker. This sends a path and receives a body.
 *
 * WHAT IS ALLOWED, and this is a widening worth stating: the panel may ask the worker for any `/api/` path,
 * where the earlier screens could ask for three by name. It has to be - the panel is the app now, and the
 * app talks to its whole API. What bounds it instead: only the extension's own pages can send a runtime
 * message at all, the path must start with /api/, and no page in here ever executes what it renders.
 */
import { APP_URL, inExtension } from './worker';

interface Answered { ok: boolean; status?: number; text?: string; type?: string; error?: string }

/** Absolute urls are left alone - a data: url, a gallery image, the agent on 127.0.0.1. Only ours are ours. */
const ourPath = (input: RequestInfo | URL): string | null => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('/api/')) return url;
  if (url.startsWith(APP_URL + '/api/')) return url.slice(APP_URL.length);
  return null;
};

export function installApiBridge() {
  if (!inExtension) return;                      // opened as a page: the dev proxy answers, as it always did
  const real = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = ourPath(input);
    if (!path) return real(input, init);

    /* A Request object carries its own method and body, and the app builds one in places. Read here rather
     * than assumed, or a POST arrives at the worker as a GET. */
    const asRequest = input instanceof Request ? input : null;
    const method = (init?.method ?? asRequest?.method ?? 'GET').toUpperCase();
    const body = init?.body != null
      ? typeof init.body === 'string' ? init.body : await new Response(init.body as BodyInit).text()
      : asRequest
        ? await asRequest.clone().text()
        : null;

    const res = (await chrome.runtime!.sendMessage({
      mf: 'app/fetch',
      path,
      method,
      body,
      /* Only content-type travels. Authorization is the worker's to add and nothing else in here has any
       * business setting one. */
      contentType: (init?.headers as Record<string, string> | undefined)?.['content-type']
        ?? asRequest?.headers.get('content-type')
        ?? undefined,
    }).catch(() => null)) as Answered | null;

    if (!res) {
      /* The worker is gone - it was reloaded, or Chrome tore it down mid-request. Answered as a status the
       * app already knows how to render rather than as a rejected promise nobody catches. */
      return new Response(JSON.stringify({ error: { message: 'the extension worker is not answering' } }),
        { status: 503, headers: { 'content-type': 'application/json' } });
    }

    return new Response(res.text ?? '', {
      status: res.status ?? (res.ok ? 200 : 502),
      headers: { 'content-type': res.type ?? 'application/json' },
    });
  };
}
