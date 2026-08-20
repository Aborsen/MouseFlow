/* Is this row a recording, or a skill made from one?
 *
 * They live in one table - `user_flow`, keyed by (user_id, client_id) - and that is the right design: both
 * are "a thing on your account with a payload", both sync the same way, both tombstone the same way. What
 * was missing is that nothing said which one a row IS, so the Skills page listed every flow, a recording
 * appeared there looking like a skill, and deleting that card deleted the recording. The transcript then
 * answered 404 on the Record page, which is where somebody noticed.
 *
 * So the writer stamps it. `payload.role` is set by whatever creates the row - the push on stop writes
 * `recording`, Save as skill and Create skill write `skill` - and each page lists only its own kind. A
 * delete button on the Skills page can then only ever be over a skill, which is a guarantee rather than a
 * warning about a mistake somebody is about to make.
 *
 * Rows written before the stamp existed have no role, and the default has to be chosen carefully: treating
 * them as recordings would empty the Skills page of every skill anybody already made. So an unstamped row
 * is a skill - today's behaviour, nothing disappears - EXCEPT when this browser is holding a recording under
 * the same id, which is exactly the dangerous case and the one case that can be known for certain. A
 * recording made on another machine still shows on this one; the warning on the delete covers that, and it
 * stops mattering as soon as a recording is made by a build that stamps.
 */
import type { Flow } from './api';

export type FlowRole = 'recording' | 'skill';

/** What the row says it is, or null if it was written before rows said. */
export function roleOf(flow: Flow): FlowRole | null {
  const payload = flow.payload as Record<string, unknown> | undefined;
  const said = payload && typeof payload.role === 'string' ? payload.role : null;
  return said === 'recording' || said === 'skill' ? said : null;
}

/** The stamp to write. Kept here so the three writers cannot disagree about the spelling. */
export const RECORDING_ROLE: FlowRole = 'recording';
export const SKILL_ROLE: FlowRole = 'skill';

/**
 * Whether the Skills page should list this flow.
 *
 * `localRecordingIds` is what this browser holds on the Record page. It is only consulted for rows with no
 * stamp - see the note at the top of this file - and it is what stops an unstamped recording from being
 * deletable as though it were a skill.
 */
export function listedInSkills(flow: Flow, localRecordingIds: Set<string>): boolean {
  const role = roleOf(flow);
  if (role) return role === 'skill';
  return !localRecordingIds.has(flow.id);
}
