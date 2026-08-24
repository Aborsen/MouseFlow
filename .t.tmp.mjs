import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
const url = readFileSync('.env.local','utf8').match(/^DATABASE_URL="?([^"\n]+)"?$/m)[1];
const sql = neon(url);
const [q] = await sql`select state, ok, loop is null as tidied, loop->>'stepNo' as step from run_queue where id='q_mt7nrtk03f2tav'`;
console.log('QUEUE:', JSON.stringify(q));
const [r] = await sql`select outcome, model, extension, jsonb_array_length(steps) as steps,
                             extract(epoch from (finished_at - started_at)) as secs
                      from user_run where client_id='q_mt7nrtk03f2tav'`;
if (r) console.log(`RUN: ${r.outcome} | ${r.steps} steps in ${Math.round(r.secs)}s = ${(r.secs/r.steps).toFixed(1)}s per step | via ${r.extension}`);
else console.log('RUN: not finished yet');
