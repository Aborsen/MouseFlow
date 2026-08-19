import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
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

/* The same shape as insightis/apps/web: React plugin, an @ alias, and a dev proxy so the app talks to the
 * real /api functions while it is being worked on.
 *
 * The proxy target is the deployment rather than a local server, because these endpoints are Vercel
 * functions with a database and an OAuth issuer behind them - reproducing that locally would be a second
 * environment to keep in step, and the point of the dev server is the UI. */
export default defineConfig({
  plugins: [react(), mockPlugin()],
  resolve: {
    /* fileURLToPath rather than URL.pathname: on Windows the latter yields "/D:/AI%20Connecitivty/..." -
     * percent-encoded and with a leading slash - which rollup then resolves against the drive root. */
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 4400,
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
  },
});
