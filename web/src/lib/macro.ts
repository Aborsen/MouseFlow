/* The .mmmacro format — the app's window onto the one parser.
 *
 * The implementation moved to `api/_macro.mjs`. It has three readers now, not one: this app, the local MCP
 * server, and /api/mcp — which needs `parseMacro` because the agent can stop a recording with no browser
 * open anywhere, and the five-column body it hands back has to become a row somewhere. A serverless function
 * cannot import out of the web app's source tree with any confidence about what the bundler traces, so the
 * module lives beside the API and this is how the app reaches it, types intact. `api/_macro.d.mts` is the
 * contract, and it mirrors the shapes in ./store deliberately: TypeScript is structural, so an identical
 * shape is the same type to every caller here.
 *
 * A second parser for the same format is the thing this arrangement exists to prevent.
 */
export type { Summary } from '../../../api/_macro.d.mts';

export {
  dropOwnTail,
  exportMacro,
  flowBody,
  fmtMs,
  hasPlayable,
  parseMacro,
  summarize,
} from '../../../api/_macro.mjs';
