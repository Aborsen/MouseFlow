/* How long a step actually takes, read off real runs.
 *
 * WHY THIS EXISTS. "It sends a screenshot every four seconds and it looks slow" was a report about a loop
 * that has no timer in it: the agent answers /shot in tens of milliseconds and the next picture is taken
 * the moment the last decision arrives. So the pace is the decision - which was established by subtracting
 * one measurement from another, and the next question (shrink the picture? batch the actions? a lighter
 * model on simple skills?) is exactly the kind that must not be answered from a subtraction.
 *
 * TWO SOURCES, and they answer different halves:
 *
 *   WALL CLOCK, available for every run ever recorded: finished_at - started_at over the number of steps.
 *   It cannot say where the time went, only how much there was. It is the honest baseline and it needs no
 *   instrumentation, so it works on the whole history.
 *
 *   THE SPLIT, from `steps[].ms`, written by both drivers since the pace was instrumented. This is the one
 *   that decides what to buy. Absent on every older run, and reported as absent rather than as zero.
 *
 * READ ONLY. Select statements, aggregates, and nothing that would put somebody's goal text on a terminal:
 * what a run was FOR is not what this is measuring, and printing it would be collecting something else
 * under the name of collecting this.
 *
 *   node scripts/pace.mjs            the last 30 days
 *   node scripts/pace.mjs 90         the last 90
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

function connectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const local = readFileSync(join(here, '..', '.env.local'), 'utf8');
  const found = local.match(/^DATABASE_URL="?([^"\n]+)"?$/m);
  if (!found) throw new Error('No DATABASE_URL. Run `vercel env pull .env.local` first.');
  return found[1];
}

const days = Number(process.argv[2]) || 30;

/* A percentile over a sorted list, nearest-rank. Not a mean: one 75-second timeout drags a mean somewhere
 * no step ever was, and the number people act on is the typical one. */
const at = (sorted, p) => (sorted.length
  ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
  : null);

const secs = (ms) => (ms == null ? '  —  ' : (ms / 1000).toFixed(1).padStart(5) + 's');

const client = new pg.Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } });
await client.connect();

const { rows } = await client.query(`
  select id, kind, outcome, extension, steps,
         extract(epoch from (finished_at - started_at)) as wall
  from user_run
  where started_at > now() - ($1 || ' days')::interval
  order by started_at desc`, [String(days)]);

console.log(`\n${rows.length} runs in the last ${days} days\n`);

const byOutcome = new Map();
for (const r of rows) byOutcome.set(r.outcome, (byOutcome.get(r.outcome) || 0) + 1);
console.log('outcome     ' + [...byOutcome].map(([k, n]) => `${k} ${n}`).join('   '));

/* Agent runs only. A replay performs recorded events at recorded speed and has no decision in it at all -
 * averaging the two together would answer a question nobody asked. */
const agentRuns = rows.filter((r) => r.kind === 'agent' && Array.isArray(r.steps) && r.steps.length);
console.log(`agent runs with a step trace: ${agentRuns.length}\n`);

// ---------------------------------------------------------------- wall clock, the whole history
const perStep = [];
for (const r of agentRuns) {
  const n = r.steps.length;
  const wall = Number(r.wall);
  if (!Number.isFinite(wall) || wall <= 0 || !n) continue;
  perStep.push((wall * 1000) / n);
}
perStep.sort((a, b) => a - b);
console.log('WALL CLOCK PER STEP        (every run, no instrumentation needed)');
console.log(`  runs measured   ${perStep.length}`);
console.log(`  median          ${secs(at(perStep, 50))}`);
console.log(`  p90             ${secs(at(perStep, 90))}`);
console.log(`  fastest         ${secs(perStep[0])}`);
console.log(`  slowest         ${secs(perStep[perStep.length - 1])}\n`);

// ---------------------------------------------------------------- the split, going forward
const model = [];
const shot = [];
const act = [];
const perTool = new Map();
let timedSteps = 0;
let timedRuns = 0;

for (const r of agentRuns) {
  let any = false;
  for (const step of r.steps) {
    const ms = step && step.ms;
    if (!ms || typeof ms.model !== 'number') continue;
    any = true;
    timedSteps++;
    model.push(ms.model);
    if (typeof ms.shot === 'number' && ms.shot > 0) shot.push(ms.shot);
    if (typeof ms.act === 'number' && ms.act > 0) act.push(ms.act);
    const tool = String(step.tool || '?');
    if (!perTool.has(tool)) perTool.set(tool, []);
    perTool.get(tool).push(ms.model);
  }
  if (any) timedRuns++;
}

if (!timedSteps) {
  console.log('THE SPLIT                  not yet — no run has been recorded since the pace was instrumented.');
  console.log('  Every number above is wall clock, which cannot say where the time went. Run a few goals');
  console.log('  and this half fills in on its own.\n');
} else {
  for (const list of [model, shot, act]) list.sort((a, b) => a - b);
  console.log(`THE SPLIT                  (${timedSteps} steps across ${timedRuns} runs)`);
  console.log(`  decision   median ${secs(at(model, 50))}   p90 ${secs(at(model, 90))}`);
  console.log(`  picture    median ${secs(at(shot, 50))}   p90 ${secs(at(shot, 90))}`);
  console.log(`  action     median ${secs(at(act, 50))}   p90 ${secs(at(act, 90))}`);
  const total = (at(model, 50) || 0) + (at(shot, 50) || 0) + (at(act, 50) || 0);
  if (total) {
    console.log(`  the decision is ${Math.round(((at(model, 50) || 0) / total) * 100)}% of a typical step\n`);
  }

  console.log('BY TOOL                    which decisions are the expensive ones');
  const ranked = [...perTool].map(([tool, list]) => {
    list.sort((a, b) => a - b);
    return { tool, n: list.length, median: at(list, 50) };
  }).sort((a, b) => b.median - a.median);
  for (const t of ranked) {
    console.log(`  ${t.tool.padEnd(20)} ${String(t.n).padStart(4)} steps   median ${secs(t.median)}`);
  }
  console.log('');
}

/* HOW MANY ACTIONS A TURN RETURNED, which is the whole case for batching. One decision paid for, several
 * actions carried out - so a run where every turn returned one action is a run where batching would buy
 * exactly nothing, and a run full of pairs is one where it would halve the wall clock.
 *
 * Derived from the timings rather than from a counter: every step of one turn carries the SAME model time,
 * because they were decided together. Identical adjacent values are one turn. */
if (timedSteps) {
  const sizes = [];
  for (const r of agentRuns) {
    let run = 0;
    let last = null;
    for (const step of r.steps) {
      const ms = step && step.ms && step.ms.model;
      if (typeof ms !== 'number') continue;
      if (last !== null && ms === last) { run++; continue; }
      if (run) sizes.push(run);
      run = 1;
      last = ms;
    }
    if (run) sizes.push(run);
  }
  const batched = sizes.filter((n) => n > 1).length;
  console.log('ACTIONS PER DECISION       the case for batching, or against it');
  console.log(`  turns            ${sizes.length}`);
  console.log(`  returned one     ${sizes.length - batched}`);
  console.log(`  returned several ${batched}`);
  console.log(`  largest          ${sizes.length ? Math.max(...sizes) : 0}\n`);
}

await client.end();
