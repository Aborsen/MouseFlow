import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
const url = readFileSync('.env.local','utf8').match(/^DATABASE_URL="?([^"\n]+)"?$/m)[1];
const sql = neon(url);
const q = await sql`select state, loop is null as loop_cleared from run_queue where id='q_mt7n68furqc7z6'`;
console.log('queue row:', JSON.stringify(q[0]));
const runs = await sql`select client_id, outcome, model, jsonb_array_length(steps) as steps,
                              left(coalesce(error, summary, ''), 90) as says, extension, started_at
                       from user_run order by started_at desc limit 3`;
for (const r of runs) console.log(JSON.stringify(r));
