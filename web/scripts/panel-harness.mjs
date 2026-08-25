/* The side panel, served as an ordinary page, at whatever width the browser window is, with the mock
 * account behind it. `npm run dev:panel`, then open /sidepanel.html and drag the window narrow.
 *
 * WHY IT EXISTS. Chrome's side panel is 400px by default and can be dragged to 320, and everything wrong
 * with it is wrong at a width no other surface has. Loading the unpacked extension to look is a build, a
 * reload and a click each time; this is a dev server with HMR, and it renders the same components from the
 * same sources.
 *
 * WHY NOT `vite --config vite.extension.config.ts`. That is a BUILD config: no server block, no mock API
 * middleware. A panel with no account in it shows six empty states, and an empty state is exactly the case
 * that does NOT overflow. So this takes the extension config's aliases - the router shim first, which is
 * what lets the app's own screens mount outside a router - and the dev config's mock API, in one server.
 *
 * WHAT IT CANNOT SHOW: anything that needs the extension's service worker - recording a page, the fetch
 * bridge, pairing. `inExtension` is false here, so the panel treats itself as signed in and talks to the
 * mock. Layout, which is what this is for, is identical.
 */
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

process.env.MOCK_API = '1';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const at = (p) => fileURLToPath(new URL('../' + p, import.meta.url));
const ui = (p) => at('vendor/insightis-ui/' + p);

/* Tailwind v3 resolves its `content` globs against the CWD, not against tailwind.config.ts. Started from
 * the repository root the globs match nothing, the page renders with preflight and no utilities at all -
 * no min-widths, no flex, nothing - and it looks like a layout with no width problems whatsoever. Which is
 * the exact opposite of what this server is for, and it does not announce itself. */
process.chdir(WEB);

const server = await createServer({
  configFile: false,
  root: WEB,
  plugins: [
    react(),
    {
      name: 'panel-mock-api',
      configureServer(s) {
        /* Through Vite's own module runner: mock-api is TypeScript and this file is not. */
        s.middlewares.use(async (req, res, next) => {
          const mod = await s.ssrLoadModule('/src/dev/mock-api.ts').catch(() => null);
          if (!mod?.mockApi) return next();
          return mod.mockApi(req, res, next);
        });
      },
    },
  ],
  resolve: {
    /* The extension config's list, in its order - the router shim BEFORE '@', because order decides. */
    alias: [
      { find: '@insightis/ui/cn', replacement: ui('src/lib/utils.ts') },
      { find: '@insightis/ui/use-mobile', replacement: ui('src/hooks/use-mobile.tsx') },
      { find: '@insightis/ui/globals.css', replacement: ui('src/globals.css') },
      { find: /^@insightis\/ui\/(.+)$/, replacement: ui('src/components/$1/index.tsx') },
      { find: /^@\/hooks\/(.+)$/, replacement: ui('src/hooks/$1') },
      { find: '@tanstack/react-router', replacement: at('src/extension/router-shim.tsx') },
      { find: '@', replacement: at('src') },
    ],
  },
  server: { port: 4455, fs: { allow: ['..', '../..'] } },
});
await server.listen();
server.printUrls();
console.log('\n  [33m→[39m  the panel is at /sidepanel.html — Chrome gives it 400px, and 320 when dragged in\n');
