/* Types for _gallery-skill.mjs. The flow row is typed structurally rather than imported from the web app's
 * source, which a declaration beside the API cannot reach; the real Flow is assignable. */

export declare const SKILL_FORMAT: 'mouseflow.skill/1';

export interface GalleryFlowRow {
  name?: string;
  description?: string;
  origins?: string[];
}

/** The payload POST /api/gallery accepts. Deliberately loose: the caller passes it straight on. */
export declare function skillForGallery(
  flow: GalleryFlowRow | null | undefined,
  payload: Record<string, unknown> | null | undefined,
): Record<string, unknown>;
