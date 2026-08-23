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

export default defineConfig({
  plugins: [
    react(),
    mockPlugin(),
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
