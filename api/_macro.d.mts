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
    /** The accessibility role of what was actually hit, and its subrole. Says "a button" where the
     *  application named nothing, and tells a row apart from a control inside it. */
    role?: string;
    subrole?: string;
    /** The container the named thing sits in - a list, a toolbar - and its own name, where it has one. */
    container?: string;
    containerName?: string;
    /** The page a click landed on: origin and path, cut in the agent. */
    url?: string;
    /** Modifiers held during the gesture: `Shift`, `Cmd+Shift`, `Alt`. Absent means none were
     *  held, or an agent too old to record them. A string, never a union of literal tokens:
     *  the format's rule is that an unknown value is data rather than an error. */
    modifiers?: string;
    /** How long a name was that was not recorded. Written by parseMacro since 0.13.0. */
    nameLength?: number;
    /** Where the window and the named element WERE, in screen pixels, at the moment of the click.
     *  Written by an agent that says `canAnchor`; absent on every older recording, and absent is the
     *  answer - a replay then plays the recorded point and says so. See api/_anchor.mjs. */
    anchor?: { win?: number[]; el?: number[] };
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
/** Drops what STOPPED the recording: the press on our own window and the travel to it. The agent trims
 *  its own tray menu the same way, where it knows the moment the menu opened. See _macro.mjs. */
export declare function dropOwnTail<T extends MacroEvent>(
  events: T[] | null | undefined,
  ownTitle: string,
): { events: T[]; dropped: number };

export declare function flowBody(
  flow: MacroStep[],
  recordings: MacroRecording[],
  opts: { startDelayMs: number; flowRepeat: number; flowForever: boolean },
): string;
export declare function exportMacro(rec: MacroRecording): string;
export declare function summarize(events: MacroEvent[]): Summary;
export declare const fmtMs: (ms: number) => string;
