/* A .docx from the Markdown a process document is stored as, with no dependency.
 *
 * WHY NOT A LIBRARY. A .docx IS a zip of a handful of XML files, and api/_zip.mjs already builds zips with
 * no dependency for exactly this kind of reason - see its own note about JSZip. The docx npm package is
 * several hundred kilobytes to produce five files whose entire content is decided by this file's six cases.
 * The same argument the dashboard makes about chart libraries and the docs page makes about Markdown
 * renderers: a dependency larger than the feature it serves.
 *
 * STORED, NOT DEFLATED. _zip.mjs writes method 0, and a .docx whose parts are stored is a valid .docx -
 * the format says nothing about which method, and Word, LibreOffice and Google Docs all open it. A process
 * document is a few kilobytes of text; compression would buy nothing and cost a deflate implementation.
 *
 * WHAT THIS IS NOT. Not a Markdown-to-Word converter. It handles the six shapes api/_docs.mjs asks the model
 * to write and web/src/features/docs/DocsView.tsx renders - a heading, a subheading, a numbered step, a
 * bullet, bold, and a paragraph - because those are what a process document is made of. A line it does not
 * recognise becomes a paragraph rather than being dropped, the same rule the screen follows and for the same
 * reason: this is somebody's text and losing a line of it silently is worse than rendering it plainly.
 */
import { zip } from './_zip.mjs';

/* Twips. 1440 to the inch, which is the unit every measurement in OOXML uses and the one number worth
 * knowing about the format. */
const PAGE = { w: 11906, h: 16838, margin: 1134 }; // A4, 2cm margins

/* XML escaping is not optional and not a nicety: a control name with an ampersand in it - which is most
 * "Save & Close" buttons - produces a file Word refuses to open at all rather than one that looks wrong. */
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/* A run of text, bold or not. `xml:space="preserve"` on every one of them, because a step ends in a space
 * before its citation more often than not and Word collapses it away otherwise - which closes up
 * "the button [step 4]" into "the button[step 4]". */
const run = (text, bold) =>
  '<w:r>' + (bold ? '<w:rPr><w:b/></w:rPr>' : '')
  + '<w:t xml:space="preserve">' + esc(text) + '</w:t></w:r>';

/* **bold** inside a line, and nothing else. The prompt uses it in one place - the limitations section - and
 * supporting italics and code as well would be three more states in a parser that has one job.
 *
 * Split rather than replaced: building XML by substituting into a string is how an escaped ampersand comes
 * back out unescaped. */
const runs = (line) => String(line || '')
  .split(/(\*\*[^*]+\*\*)/g)
  .filter((piece) => piece !== '')
  .map((piece) => (piece.startsWith('**') && piece.endsWith('**')
    ? run(piece.slice(2, -2), true)
    : run(piece, false)))
  .join('');

const para = (line, style, indent) =>
  '<w:p><w:pPr>'
  + (style ? '<w:pStyle w:val="' + style + '"/>' : '')
  + (indent ? '<w:ind w:left="' + indent + '" w:hanging="360"/>' : '')
  + '</w:pPr>' + runs(line) + '</w:p>';

/* A real Word bullet list, which needs numbering.xml - thirty lines for a thing people will edit in Word,
 * where a literal glyph does not indent, does not continue and cannot be turned into a sub-point. */
const bullet = (line) =>
  '<w:p><w:pPr><w:pStyle w:val="ListParagraph"/>'
  + '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'
  + '</w:pPr>' + runs(line) + '</w:p>';

/* THE NUMBERED STEPS KEEP THEIR OWN NUMBERS, as text, and are NOT a Word numbered list. That is the one
 * decision in this file worth arguing about, so: the numbers in a process document are referenced - by the
 * [step N] citations beside them and by whoever is following the procedure while talking to somebody else -
 * and Word's automatic numbering would silently renumber them the moment anybody inserts a step. A
 * procedure whose step 7 becomes step 8 without anybody deciding is worse than one whose numbering has to
 * be corrected by hand. */
const step = (n, line) => para(n + '. ' + line, null, 360);

export function docxFromMarkdown(body, { title } = {}) {
  const blocks = [];
  let sawTitle = false;

  for (const raw of String(body || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { blocks.push('<w:p/>'); continue; }

    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) { blocks.push(para(h1[1], 'Title')); sawTitle = true; continue; }

    const h2 = line.match(/^###?\s+(.*)$/);
    if (h2) { blocks.push(para(h2[1], 'Heading2')); continue; }

    const num = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (num) { blocks.push(step(num[1], num[2])); continue; }

    const dash = line.match(/^\s*[-*+]\s+(.*)$/);
    if (dash) { blocks.push(bullet(dash[1])); continue; }

    blocks.push(para(line, null));
  }

  /* A title only if the body did not carry one. A document opened in Word with no heading at the top is a
   * wall of text, and the row has a title precisely so this case has an answer. */
  if (!sawTitle && title) blocks.unshift(para(title, 'Title'));

  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:body>' + blocks.join('')
    + '<w:sectPr><w:pgSz w:w="' + PAGE.w + '" w:h="' + PAGE.h + '"/>'
    + '<w:pgMar w:top="' + PAGE.margin + '" w:right="' + PAGE.margin + '" w:bottom="' + PAGE.margin
    + '" w:left="' + PAGE.margin + '" w:header="0" w:footer="0" w:gutter="0"/>'
    + '</w:sectPr></w:body></w:document>';

  /* Styles by hand, and only the four that are used. Word supplies defaults for everything it is not told
   * about, so a styles part that names Title, Heading2, ListParagraph and the document default is the whole
   * of what this needs - and every one of them is visible in the output rather than inherited from whatever
   * the reader's Normal.dotm happens to say. */
  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:docDefaults><w:rPrDefault><w:rPr>'
    + '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/>'
    + '</w:rPr></w:rPrDefault>'
    + '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>'
    + '</w:docDefaults>'
    + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/>'
    + '<w:pPr><w:spacing w:before="0" w:after="240"/></w:pPr>'
    + '<w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>'
    + '<w:pPr><w:keepNext/><w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr>'
    + '<w:rPr><w:b/><w:caps/><w:sz w:val="22"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/>'
    + '<w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>'
    + '</w:styles>';

  const numbering = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>'
    + '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/>'
    + '<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>'
    + '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl>'
    + '</w:abstractNum>'
    + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    + '</w:numbering>';

  /* The five parts, and the two relationship files that tie them together. Every one of them is required:
   * a .docx missing [Content_Types].xml, or whose document part is not the relationship target of the
   * package, is not a file Word will open - it is a zip with XML in it. */
  const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + '</Types>';

  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>';

  const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
    + '</Relationships>';

  /* [Content_Types].xml FIRST in the archive. The spec does not require it, and every unzipper finds it
   * wherever it is - but some consumers read the first entry expecting it, and putting it first costs
   * nothing. */
  return zip([
    { name: '[Content_Types].xml', text: types },
    { name: '_rels/.rels', text: rels },
    { name: 'word/document.xml', text: document },
    { name: 'word/_rels/document.xml.rels', text: docRels },
    { name: 'word/styles.xml', text: styles },
    { name: 'word/numbering.xml', text: numbering },
  ]);
}

/** A filename a person will recognise in their downloads folder, and one an OS will accept. */
export function docxName(title) {
  const clean = String(title || '').replace(/[^\w \-.]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return (clean || 'process') + '.docx';
}
