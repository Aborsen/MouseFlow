/* Applies the SQL files in db/, in order, once each.
 *
 * A plain runner rather than a migration framework: there is one table, the project has no build
 * step, and a framework would be more machinery than the thing it manages. What it does have is the
 * part that matters - a record of what has already run, so applying twice is a no-op and a half
 * finished run can be resumed.
 *
 *   node scripts/migrate.mjs           apply anything outstanding
 *   node scripts/migrate.mjs --list    show what has run and what has not
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const dbDir = join(here, '..', 'db');

function connectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  // Vercel writes .env.local on `vercel env pull`; it is gitignored.
  try {
    const local = readFileSync(join(here, '..', '.env.local'), 'utf8');
    const found = local.match(/^DATABASE_URL="?([^"\n]+)"?$/m);
    if (found) return found[1];
  } catch (_) {
    // no local env; fall through to the error below
  }
  throw new Error('No DATABASE_URL. Run `vercel env pull .env.local` first.');
}

/* pg rather than the HTTP driver used by the functions: a migration is arbitrary SQL, and the HTTP
 * driver only takes tagged templates. pg's simple-query protocol also runs a whole file in one call,
 * which means a file can be applied inside a real transaction. */
const client = new pg.Client({
  connectionString: connectionString(),
  ssl: { rejectUnauthorized: false },
});

async function main() {
  await client.connect();
  await client.query(`
    create table if not exists schema_migration (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const applied = new Set((await client.query('select name from schema_migration')).rows.map((r) => r.name));
  const files = readdirSync(dbDir).filter((f) => f.endsWith('.sql')).sort();

  if (process.argv.includes('--list')) {
    for (const f of files) console.log((applied.has(f) ? '  applied  ' : '  pending  ') + f);
    await client.end();
    return;
  }

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const text = readFileSync(join(dbDir, file), 'utf8');
    process.stdout.write('applying ' + file + ' ... ');
    // All or nothing: a half-applied schema is worse than an unapplied one.
    await client.query('begin');
    try {
      await client.query(text);
      await client.query('insert into schema_migration (name) values ($1)', [file]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    }
    console.log('ok');
    ran++;
  }
  console.log(ran ? ran + ' migration(s) applied.' : 'Nothing to apply.');
  await client.end();
}

main().catch((err) => {
  console.error('migration failed:', err.message);
  process.exit(1);
});
