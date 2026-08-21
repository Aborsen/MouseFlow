/* One recording, as a row on the account — the app's window onto the one builder.
 *
 * The implementation moved to `api/_flow-for.mjs`. There are four callers now: the push on stop, the restore
 * from Skills, the reconcile, and `/api/mcp`, which builds this row when the agent stops a recording with no
 * browser open anywhere. They must build the identical payload or a restored or re-synced recording quietly
 * stops matching the one that was saved — that was a real bug, and it is why there is one of these rather
 * than four literals that look alike. A serverless function cannot import out of this source tree with any
 * confidence about what the bundler traces, so the builder lives beside the API and this reaches it.
 */
export { flowFor } from '../../../../api/_flow-for.mjs';
