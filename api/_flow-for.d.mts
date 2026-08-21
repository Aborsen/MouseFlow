/* Types for _flow-for.mjs. The recording and the health report are typed structurally rather than imported
 * from the web app's source, which a declaration beside the API cannot reach; the real ones are assignable. */
import type { MacroEvent } from './_macro.d.mts';

export interface FlowForRecording {
  id: string;
  name: string;
  created: string;
  events: MacroEvent[];
  windows?: { title: string; process: string }[];
}

export interface FlowForHealth {
  version?: string | null;
  canName?: boolean;
  canKeys?: boolean;
}

/** The row api/sync.js takes. Deliberately loose: every caller passes it straight on. */
export declare function flowFor(rec: FlowForRecording, health: FlowForHealth | null | undefined): {
  id: string;
  source: 'desktop';
  kind: 'recorded';
  name: string;
  description: string;
  origins: string[];
  created: string;
  payload: Record<string, unknown>;
};
