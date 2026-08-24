import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
const url = readFileSync('.env.local','utf8').match(/^DATABASE_URL="?([^"\n]+)"?$/m)[1];
const sql = neon(url);
const [r] = await sql`select state, stepping, ok, loop->>'wave' as wave, loop->>'turn' as turn,
                             loop->>'stepNo' as step_no, length(loop::text) as loop_bytes,
                             (loop::text like '%"type":"image"%') as holds_a_picture, said
                      from run_queue where id = 'q_mt7n68furqc7z6'`;
console.log(JSON.stringify(r, null, 2));
