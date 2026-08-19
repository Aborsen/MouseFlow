/* `npm run dev:mock` — the dev server with the mock account API on.
 *
 * A script rather than `MOCK_API=1 vite`, because PowerShell has no inline env-var prefix and the same
 * command has to work from both shells. Vite's programmatic API rather than its bin, which Vite 7 no longer
 * exports as a subpath.
 */
process.env.MOCK_API = '1';

const { createServer } = await import('vite');
const server = await createServer();
await server.listen();
server.printUrls();
