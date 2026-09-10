/* Types for _skill-schema.mjs. The implementation is plain JavaScript because three readers need it - the
 * Skills panel, the local MCP server and /api/mcp - and only one of them compiles TypeScript. This file is
 * the contract, and web/src/lib/skill-schema.ts re-exports it so nothing in the app lost its types.
 *
 * `flow` is typed structurally rather than as web/src/lib/api.ts's Flow: a declaration beside the API cannot
 * reach into the web app's source, and the real Flow is assignable to this. That is the whole of what this
 * function needs from one. */
export interface SkillParam {
  name: string;
  type: string;
  example: string | null;
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, {
    type: string;
    format?: string;
    description?: string;
    enum?: (string | number)[];
    minimum?: number;
    maximum?: number;
    default?: number;
  }>;
  required: string[];
  additionalProperties: false;
}

export interface SkillStructure {
  /** The name a model would call. Slugged and suffixed - see toolNameFor. */
  toolName: string;
  kind: 'recorded' | 'created';
  /** Which half can actually run it. Not a detail: a desktop flow aims at screen positions. */
  runner: 'agent' | 'extension';
  /** How it runs, in one phrase. */
  runsHow: string;
  /** For a created skill: the sentence with its variable parts lifted out. */
  goalTemplate: string | null;
  params: SkillParam[];
  /** What one successful run did. Evidence beside a created skill, never the thing replayed. */
  steps: { name: string; input: string | null }[];
  /* ЧТО ЭТО ДЕЛАЕТ, СЛОВАМИ - уровень 1 формата mouseflow.skill/2.
   *
   * Пустые steps - честный ответ, а не пропуск: у `/1` процедуры нет и быть не может, и экран тогда
   * показывает счёт событий, как показывал всегда. `more` - сколько шагов не поместилось; числом,
   * потому что «и ещё» читается как «и ничего важного». */
  procedure: { whenToUse: string | null; steps: string[]; more: number };
  /** For a recorded skill: how many events it replays. */
  events: number;
  origins: string[];
  description: string;
  schema: JsonSchema;
}

export interface SkillFlowLike {
  id: string;
  name: string;
  kind?: string | null;
  source?: string | null;
  description?: string | null;
  payload?: unknown;
  origins?: string[] | null;
}

export type WireFormat = 'anthropic' | 'openai' | 'mcp';

export declare const WIRE_FORMATS: readonly WireFormat[];
export declare const WIRE_LABELS: Record<WireFormat, string>;
export declare function toolNameFor(name: string, id: string): string;
export declare function structureOf(flow: SkillFlowLike): SkillStructure;
export declare function wireFor(format: WireFormat, skill: SkillStructure): unknown;
export declare function everyWire(skill: SkillStructure): Record<WireFormat, unknown>;
