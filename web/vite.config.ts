import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { type Plugin, defineConfig } from 'vite';
import { mockApi } from './src/dev/mock-api';

/* MOCK_API=1 npm run dev serves the account endpoints locally, so the UI can be worked on without a
 * session. Dev-server middleware only: it has no path into a build. */
const mockPlugin = (): Plugin => ({
  name: 'mouseflow-mock-api',
  apply: 'serve',
  configureServer(server) {
    if (process.env.MOCK_API !== '1') return;
    server.middlewares.use(mockApi);
    server.config.logger.info('  [33m➜[39m  mock API: on (MOCK_API=1)');
  },
});

/* Uploading source maps needs a Sentry AUTH TOKEN, which is a real secret and therefore lives only in the
 * deployment's environment — never in this repository and never in a checked-in .env. Absent, the whole
 * step is skipped: the build succeeds, the app reports errors exactly as before, and the only thing lost
 * is readable stack traces. A build that FAILED for want of a token would make every contributor without
 * one unable to build the app at all.
 *
 * IT IS DELIBERATELY ABSENT FROM PRODUCTION, and if you are here to put it back, read this first. With the
 * token set, a deployment built in three to five minutes. Without it, twenty-three seconds. Measured on the
 * same commit, and Build CPU Minutes are 87% of what this project costs - so the token is worth roughly
 * eight times the whole rest of the bill.
 *
 * The cost is NOT the upload and NOT the maps. The upload took 0.368s in the build log; generating the maps
 * costs nothing measurable (12.1s against 12.7s locally over four runs, and still 13s with the heap held to
 * 640MB). Nor was it a cold dependency cache, which the log says was restored, nor the public directory,
 * which is 504KB in eight files. What is left is sentryVitePlugin's own work over the output during the
 * bundle phase - it reported its step 4m06s after vite started and 29s before vite finished.
 *
 * So: readable stack traces are available, at four minutes a deploy. If they are wanted back, the thing to
 * try first is narrowing what the plugin looks at (`sourcemaps.assets` pointed at dist/assets/*.js rather
 * than the default sweep) and timing one deployment the same way - an empty commit is enough.
 *
 * SENTRY_ORG and SENTRY_PROJECT come from the same place, for the same reason they are not constants: they
 * name one organisation's project, and this file should not.
 */
const uploadingMaps = Boolean(
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT,
);

/* The same shape as insightis/apps/web: React plugin, an @ alias, and a dev proxy so the app talks to the
 * real /api functions while it is being worked on.
 *
 * The proxy target is the deployment rather than a local server, because these endpoints are Vercel
 * functions with a database and an OAuth issuer behind them - reproducing that locally would be a second
 * environment to keep in step, and the point of the dev server is the UI. */
/* fileURLToPath rather than URL.pathname: on Windows the latter yields "/D:/AI%20Connecitivty/..." -
 * percent-encoded and with a leading slash - which rollup then resolves against the drive root. */
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const ui = (p: string) => here('./vendor/insightis-ui/' + p);

/* The `exports` map from vendor/insightis-ui/package.json, restated as aliases.
 *
 * The vendored design system is a copy of a pnpm workspace package, not an installed one, so nothing
 * resolves `@insightis/ui/Button` for us. Rather than rewrite 227 files' imports on every sync - which is
 * how a copy stops being updatable - the app resolves the specifiers the package already uses. Read
 * alongside `exports` there; they say the same thing twice on purpose, and the suite checks they agree.
 *
 * Ordered, so the exact subpaths win over the component wildcard. `@/hooks/*` is theirs too: one component
 * reaches for the workspace's own `@` alias, which means the package's src, not ours.
 */
const DESIGN_SYSTEM = [
  { find: '@insightis/ui/cn', replacement: ui('src/lib/utils.ts') },
  { find: '@insightis/ui/use-mobile', replacement: ui('src/hooks/use-mobile.tsx') },
  { find: '@insightis/ui/globals.css', replacement: ui('src/globals.css') },
  { find: /^@insightis\/ui\/(.+)$/, replacement: ui('src/components/$1/index.tsx') },
  { find: /^@\/hooks\/(.+)$/, replacement: ui('src/hooks/$1') },
];

/* The build stamp as a tiny file, because a running page cannot ask its own bundle what it is. Written at
 * build time and fetched with cache: 'no-store' - the service worker is network-first, so this reaches the
 * network like everything else. */
function buildStamp(): Plugin {
  return {
    name: 'mouseflow-build-stamp',
    apply: 'build',
    generateBundle(_options, bundle) {
      const build = (process.env.VERCEL_GIT_COMMIT_SHA || 'dev').slice(0, 7);
      // eslint-disable-next-line no-param-reassign
      bundle['build.json'] = {
        type: 'asset',
        fileName: 'build.json',
        name: undefined,
        needsCodeReference: false,
        originalFileName: null,
        source: JSON.stringify({ build }),
      } as never;
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    mockPlugin(),
    buildStamp(),
    /* Last, because it reads what the others produced. `filesToDeleteAfterUpload` is the half that keeps
     * the maps off the CDN: they are written, sent to Sentry, then removed from dist. */
    ...(uploadingMaps
      ? [sentryVitePlugin({
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        authToken: process.env.SENTRY_AUTH_TOKEN,
        sourcemaps: { filesToDeleteAfterUpload: ['dist/**/*.map'] },
        telemetry: false,
      })]
      : []),
  ],
  resolve: {
    alias: [...DESIGN_SYSTEM, { find: '@', replacement: here('./src') }],
  },
  server: {
    port: 4400,
    /* One file lives outside this directory on purpose: `api/_skill-schema.mjs`, the single derivation of a
     * skill's tool definition, read by this app, by the local MCP server and by /api/mcp. Vite's default
     * root is `web/`, so in DEV a module above it is served through /@fs and refused unless it is allowed;
     * the production build inlines it and never asks. See web/src/lib/skill-schema.ts. */
    fs: { allow: ['..'] },
    /* Either the deployment's API or the local mock, never both: Vite installs the proxy before plugin
     * middleware, so a mock behind a live proxy is a mock that never answers. */
    proxy: process.env.MOCK_API === '1'
      ? undefined
      : { '/api': { target: 'https://mouse-agent.vercel.app', changeOrigin: true, secure: true } },
  },
  /* WHICH BUILD THIS IS, baked in and also served as a file.
   *
   * An open tab never re-fetches its own JavaScript, so a deployment reaches nobody who already has the app
   * on screen - and every constant in it stays as it was, including AGENT_WANTS. Somebody sat looking at a
   * pill saying their agent was current while a newer one had been out for an hour, because the page
   * telling them was itself a version behind. The page could not know, because nothing in it said which
   * version it was.
   *
   * The commit is the stamp on Vercel and `dev` everywhere else, which makes the check inert in
   * development rather than noisy. */
  define: {
    __BUILD__: JSON.stringify((process.env.VERCEL_GIT_COMMIT_SHA || 'dev').slice(0, 7)),
  },
  build: {
    outDir: 'dist',
    // A screenshot-heavy vision loop and a design system make for a big-ish bundle; this is the point at
    // which it is worth looking rather than a hard limit.
    chunkSizeWarningLimit: 900,
    /* Built so Sentry can turn a stack trace back into this source. Without maps every frame reads
     * `index-CtwADd_G.js:1:48210`, which names nothing and cannot be acted on.
     *
     * `hidden` rather than `true`: the maps are emitted and uploaded, but no `//# sourceMappingURL=`
     * comment is left in the bundle, so a browser never fetches them and the source is not served to
     * visitors. The upload step below deletes them from the output directory afterwards, so they are not
     * on the CDN either. */
    sourcemap: uploadingMaps ? 'hidden' : false,
  },
});
