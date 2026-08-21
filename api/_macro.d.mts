/* Types for _macro.mjs. The implementation is plain JavaScript because three readers need it - the Record
 * screen, the local MCP server and /api/mcp - and only one of them compiles TypeScript.
 *
 * The shapes here mirror web/src/lib/store.ts exactly rather than importing it: a declaration beside the API
 * cannot reach into the web app's source, and TypeScript is structural, so an identical shape IS the same
 * type to every caller. If store.ts changes one of these, this has to change with it - which is the cost of
 * the module living here, and cheaper than a second parser for the same format. */
export interface MacroEvent {
  x: number;
  y: number;
  delayMs: number;
  action: string;
  context?: {
    app?: string;
    window?: string;
    control?: string;
    type?: string;
  };
}

export interface MacroStep {
  recordingId: string;
  repeat: number;
  speed: number;
  delayAfterMs: number;
}

/** Only the parts of a recording this module reads. The app's own Recording is assignable to it. */
export interface MacroRecording {
  id: string;
  name: string;
  events: MacroEvent[];
  windows?: { title: string; process: string }[];
}

export interface Summary {
  count: number;
  clicks: number;
  moves: number;
  durationMs: number;
}

export declare function parseMacro(text: string): { events: MacroEvent[]; problems: string[] };
export declare function flowBody(
  flow: MacroStep[],
  recordings: MacroRecording[],
  opts: { startDelayMs: number; flowRepeat: number; flowForever: boolean },
): string;
export declare function exportMacro(rec: MacroRecording): string;
export declare function summarize(events: MacroEvent[]): Summary;
export declare const fmtMs: (ms: number) => string;
