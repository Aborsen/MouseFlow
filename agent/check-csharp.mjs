/* A compiler proxy, because there is no compiler here.
 *
 * The Windows agent is 3,000 lines of C# inside a PowerShell here-string, and it is written on machines
 * that have neither Windows nor a C# toolchain. That is not going to change, so the question is which
 * mistakes can be caught anyway. This catches the three that have actually stopped the agent starting:
     1. a property or field defined twice in one class   (exactly what the error said)
     2. a Class.Member call with no such member
     3. a receiver that was never declared in that method - `action.StartsWith(...)` where the variable
        is called `e`, which failed in somebody's PowerShell window at install time
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

/* 3. A RECEIVER THAT WAS NEVER DECLARED.
 *
 * The third mistake that has actually stopped the agent starting, and the one the two checks above sailed
 * past: `action.StartsWith("Key ")` inside a method whose variable is called `e`. It is a compile error on
 * Windows and completely invisible here - the install fails in somebody's PowerShell window, which is the
 * worst place to find out.
 *
 * Deliberately narrow. Only lowercase receivers are considered, because a capitalised one is a class and
 * the check above already covers those; and only within a method body, where the declarations are. That
 * misses plenty a compiler would catch. It catches the shape that keeps happening. */
const PRIMITIVES = new Set([
  'string', 'int', 'bool', 'long', 'double', 'float', 'decimal', 'object', 'char', 'byte', 'sbyte',
  'short', 'ushort', 'uint', 'ulong', 'var', 'this', 'base', 'value', 'nameof', 'typeof', 'default',
]);

/* Bodies split on the method header, not by matching braces: an approximation, but the declarations it
 * needs are all inside the same slice, and a brace matcher over a file with braces inside string literals
 * is a second thing to get wrong. */
/* Method headers for the SCOPE split, which is a different question from the member list above.
 *
 * METH requires an access modifier because a member without one is not part of a class's public surface.
 * Scope does not care: `static void Emit(Ev e)` has no modifier and is very much a method body. Reusing
 * METH here merged those bodies into their neighbours, so a variable declared in one method counted as
 * declared in the next - which is exactly why the first version of this check passed the bug it was
 * written for. */
const BODY_HEAD = new RegExp(AT8 + '(?:(?:public|private|internal|protected)\\s+)?(?:static\\s+)?'
  + '(?:async\\s+)?[\\w<>,\\[\\]\\.]+\\s+(\\w+)\\s*\\(');

const bodies = [];
{
  const lines = code.split('\n');
  let current = null;
  for (const line of lines) {
    if (BODY_HEAD.test(line)) {
      if (current) bodies.push(current);
      current = { head: line, text: line + '\n' };
    } else if (current) {
      current.text += line + '\n';
    }
  }
  if (current) bodies.push(current);
}

/* The array suffix belongs on the primitives too: `string[] headLines` and `byte[] payload` are
 * declarations, and without it they read as undeclared receivers. */
const TYPED = /\b(?:var|string|int|bool|long|double|float|decimal|object|char|byte|sbyte|short|ushort|uint|ulong|IntPtr|[A-Z]\w*(?:<[^>]*>)?(?:\[\])?)(?:\[\])?\s+(\w+)\b/g;
const LAMBDA = /(?:\(\s*([\w\s,]*?)\s*\)|(\w+))\s*=>/g;
/* A declaration naming several at once: `int x, y;`. Anchored on the semicolon so a method's parameter
 * list, which looks similar, is not mistaken for one. */
const MULTI = /\b(?:var|string|int|bool|long|double|float|decimal|object|char|byte|short|uint|ulong|IntPtr|[A-Z]\w*)\s+(\w+(?:\s*,\s*\w+)+)\s*;/g;

/* String literals go first, and that is not a detail: this agent's strings are full of English prose -
 * "captured.", "sent.", "it." - and every full stop in them reads as a member access. The first run of this
 * check reported seventy problems, all of them sentences. */
const noStrings = (text) => text
  .replace(/@"(?:[^"]|"")*"/g, '""')
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
  .replace(/'(?:[^'\\]|\\.)'/g, "''");

for (const body of bodies) {
  const text = noStrings(body.text);
  const declared = new Set();
  for (const [, name] of text.matchAll(TYPED)) declared.add(name);
  /* `int x, y;` declares two, and the pattern above sees only the first. */
  for (const [, names] of text.matchAll(MULTI)) {
    for (const part of names.split(',')) declared.add(part.trim());
  }
  for (const [, group, single] of text.matchAll(LAMBDA)) {
    if (single) declared.add(single);
    if (group) for (const part of group.split(',')) declared.add(part.trim());
  }
  const seen = new Set();
  /* Not preceded by a dot: in `inputs[0].mi.dx` the `mi` is a FIELD of the struct, not a variable, and
   * reading it as one reported six problems that were all correct code. */
  for (const [, receiver] of text.matchAll(/(?<![.\w])([a-z]\w*)\s*\./g)) {
    if (declared.has(receiver) || PRIMITIVES.has(receiver) || seen.has(receiver)) continue;
    seen.add(receiver);
    const where = /\s(\w+)\s*\(/.exec(body.head);
    fail(`${receiver}.… used in ${where ? where[1] : '?'}(), but ${receiver} is never declared there`);
  }
}

console.log(bad ? `\n${bad} problem(s)` : '\nclean: no duplicate member, every Class.Member resolves, and every receiver is declared');
process.exit(bad ? 1 : 0);
