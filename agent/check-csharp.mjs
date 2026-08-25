/* A compiler proxy, because there is no compiler here.
 *
 * The Windows agent is 3,000 lines of C# inside a PowerShell here-string, and it is written on machines
 * that have neither Windows nor a C# toolchain. That is not going to change, so the question is which
 * mistakes can be caught anyway. This catches the two that have actually stopped the agent starting:
     1. a property or field defined twice in one class   (exactly what the error said)
     2. a Class.Member call with no such member
   Members sit at EXACTLY eight spaces; anything deeper is a local inside a method body, and matching those
   was what made the first version of this useless. Method overloads are legal, so only properties and
   fields are checked for duplication. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* Relative to this file, and through fileURLToPath rather than by hand: this directory has a space in its
 * path, and a URL pathname percent-encodes it. */
/* Newlines normalised on the way in, and that is not tidiness: every pattern below is anchored on a bare
   newline - the here-string fence, the eight-space member indent, the split. On a WINDOWS checkout git hands
   this file back with CRLF, so the fence stops matching and the whole check dies reading [1] of null. A
   compiler proxy that cannot run on the one platform it exists to protect is worse than no check at all. */
const src = readFileSync(fileURLToPath(new URL('mouseflow-agent.ps1', import.meta.url)), 'utf8')
  .replace(/\r\n/g, '\n');
const cs = /-TypeDefinition @'\n([\s\S]*?)\n'@/.exec(src)[1];
const code = cs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const classes = {};
let current = null;
for (const line of code.split('\n')) {
  /* Any class at four spaces, not only the static ones: Step and Flow are plain classes, and treating
     them as part of whichever class came before made their identical `Repeat` field look like one class
     declaring it twice. */
  const open = /^    (?:public\s+|internal\s+)?(?:static\s+|sealed\s+|abstract\s+)?(?:class|struct)\s+(\w+)/.exec(line);
  if (open) { current = open[1]; classes[current] = []; continue; }
  if (current) classes[current].push(line);
}

const MODS = '(?:public|private|internal|protected)\\s+(?:static\\s+)?(?:readonly\\s+|const\\s+|extern\\s+)*';
const AT8  = '^ {8}(?! )';
const PROP  = new RegExp(AT8 + MODS + '[\\w<>,\\[\\]\\.]+\\s+(\\w+)\\s*\\{');
const FIELD = new RegExp(AT8 + MODS + '[\\w<>,\\[\\]\\.]+\\s+(\\w+)\\s*(?:=|;)');
const METH  = new RegExp(AT8 + MODS + '[\\w<>,\\[\\]\\.]+\\s+(\\w+)\\s*\\(');

let bad = 0;
const fail = (m) => { bad++; console.log('  FAIL ' + m); };
const members = {};

for (const [name, lines] of Object.entries(classes)) {
  members[name] = new Set();
  const fields = new Map();
  for (const l of lines) {
    const meth = METH.exec(l);
    if (meth) { members[name].add(meth[1]); continue; }
    const m = PROP.exec(l) || FIELD.exec(l);
    if (!m) continue;
    members[name].add(m[1]);
    fields.set(m[1], (fields.get(m[1]) || 0) + 1);
  }
  for (const [member, n] of fields) if (n > 1) fail(`${name}.${member} — property/field defined ${n} times`);
}

for (const l of code.split('\n')) {
  for (const [, cls, member] of l.matchAll(/\b(Agent|Account|Json|Tray|Courier)\.(\w+)\b/g)) {
    if (!members[cls]) { fail(`class ${cls} not found`); continue; }
    if (!members[cls].has(member)) fail(`${cls}.${member} called, but ${cls} defines no such member`);
  }
}

console.log(bad ? `\n${bad} problem(s)` : '\nclean: no duplicate property/field, and every Class.Member call resolves');
process.exit(bad ? 1 : 0);
