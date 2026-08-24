/* The typing classifier, as the app sees it.
 *
 * Same arrangement as flow-for.ts: the implementation lives in `api/_typing.mjs` so that the Node suite can
 * run it against real recordings, and this is the app's window onto it. A classifier tested by regex over a
 * .tsx would be a classifier nobody has actually run.
 */
export { classifyTyping, splitTyping } from '../../../../api/_typing.mjs';
export type { TypingVerdict, TypingLike } from '../../../../api/_typing.mjs';
