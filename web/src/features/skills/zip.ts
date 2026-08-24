/* The zip builder, as the app sees it.
 *
 * Same arrangement as features/record/typing.ts: the implementation lives beside the API so the Node suite
 * can run it against a real `unzip`, and this is the app's window onto it. A zip writer verified only by
 * the code that wrote it is a zip writer nobody has opened.
 */
export { zip, crc32 } from '../../../../api/_zip.mjs';
