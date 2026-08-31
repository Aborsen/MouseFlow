/* The .docx builder, as the app sees it.
 *
 * Same arrangement as features/skills/zip.ts, which this is built on: the implementation lives beside the
 * API so the Node suite can unzip what it produced and parse every part, and this is the app's window onto
 * it. A file format verified only by the code that wrote it is a file nobody has opened.
 *
 * BUILT IN THE BROWSER, not by a route, and that follows the same precedent: the skill zip is built here
 * too. The page already holds the body, the output is a few kilobytes, and a route would add a binary
 * response path and a serverless round trip to produce something from data already on screen.
 */
export { docxFromMarkdown, docxName } from '../../../../api/_docx.mjs';
