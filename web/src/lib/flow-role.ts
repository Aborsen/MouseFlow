/* Is this row a recording, or a skill made from one? — the app's window onto the one answer.
 *
 * The implementation moved to `api/_flow-role.mjs`. `/api/mcp` writes a recording row when the agent stops a
 * recording with no browser open anywhere, and it has to stamp it with the same spelling every other writer
 * uses. "Kept in one place so the writers cannot disagree" only works if every writer can reach it, and a
 * serverless function cannot reach into the web app's source tree with any confidence about what the bundler
 * traces. `api/_flow-role.d.mts` is the contract.
 */
export type { FlowRole } from '../../../api/_flow-role.d.mts';

export {
  RECORDING_ROLE,
  SKILL_ROLE,
  listedInSkills,
  roleOf,
} from '../../../api/_flow-role.mjs';
