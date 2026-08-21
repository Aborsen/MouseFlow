/* A skill as a tool definition — the app's window onto the one derivation.
 *
 * The implementation moved to `api/_skill-schema.mjs`. It has three readers now, not one: this panel, the
 * local MCP server, and /api/mcp, which serves these definitions to a client that may be a phone. A
 * serverless function cannot import out of the web app's source tree with any confidence about what the
 * bundler traces, so the module lives beside the API - where it is bundled for certain and where the MCP
 * server reads it as plain JavaScript with nothing to strip - and this file is how the app reaches it,
 * types intact. `api/_skill-schema.d.mts` is the contract.
 *
 * A copy per reader is the thing this arrangement exists to prevent. The first time one changed, the panel
 * and the model would describe different products, both looking authoritative.
 *
 * Reaching outside `web/` needs `server.fs.allow` in vite.config.ts, which says the same thing there.
 */
export type {
  JsonSchema,
  SkillParam,
  SkillStructure,
  WireFormat,
} from '../../../api/_skill-schema.mjs';

export {
  WIRE_FORMATS,
  WIRE_LABELS,
  everyWire,
  structureOf,
  toolNameFor,
  wireFor,
} from '../../../api/_skill-schema.mjs';
