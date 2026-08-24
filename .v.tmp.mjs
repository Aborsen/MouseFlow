import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
const url = readFileSync('.env.local','utf8').match(/^DATABASE_URL="?([^"\n]+)"?$/m)[1];
const sql = neon(url);
const [q] = await sql`select state, loop is null as tidied, loop->>'stepNo' as step from run_queue where id='q_mt7o6zoollwxro'`;
console.log('QUEUE:', JSON.stringify(q));
const [r] = await sql`select outcome, jsonb_array_length(steps) as steps,
                             round(extract(epoch from (finished_at - started_at))::numeric, 1) as secs, extension
                      from user_run where client_id='q_mt7o6zoollwxro'`;
console.log(r ? `RUN: ${r.outcome} | ${r.steps} steps | ${r.secs}s = ${(r.secs/r.steps).toFixed(1)}s per step | via ${r.extension}` : 'RUN: NOT LOGGED');
