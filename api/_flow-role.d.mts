/* Types for _flow-role.mjs. `flow` is typed structurally rather than as web/src/lib/api.ts's Flow: a
 * declaration beside the API cannot reach into the web app's source, and the real Flow is assignable to
 * this. */
export type FlowRole = 'recording' | 'skill';

export interface RoleFlowLike {
  id: string;
  payload?: unknown;
}

export declare function roleOf(flow: RoleFlowLike): FlowRole | null;
export declare const RECORDING_ROLE: FlowRole;
export declare const SKILL_ROLE: FlowRole;
export declare function listedInSkills(flow: RoleFlowLike, localRecordingIds: Set<string>): boolean;
