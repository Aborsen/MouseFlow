/* Adds a trusted origin to Neon Auth.
 *
 * Neon Auth is Better Auth behind a Neon endpoint, and it will only issue a sign-in redirect for a
 * callback URL whose origin it trusts. A fresh resource trusts nothing, so `/sign-in/social` answers
 * INVALID_CALLBACKURL for every origin and sign-in cannot work until one is added.
 *
 * The setting lives in neon_auth.project_config in this project's own database, which is also where
 * the Neon Console writes it. Doing it here rather than by hand is not a shortcut around the console
 * - it is the same row - but it is repeatable, it is reviewable, and it does not depend on finding a
 * panel that has moved.
 *
 *   node scripts/auth-origin.mjs                       show what is trusted
 *   node scripts/auth-origin.mjs https://example.com   trust that origin too
 *   node scripts/auth-origin.mjs --remove https://…    stop trusting it
 *
 * Additive and idempotent: adding an origin twice changes nothing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

function connectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const local = readFileSync(join(here, '..', '.env.local'), 'utf8');
    const found = local.match(/^DATABASE_URL="?([^"\n]+)"?$/m);
    if (found) return found[1];
  } catch (_) {
    // fall through
  }
  throw new Error('No DATABASE_URL. Run `vercel env pull .env.local` first.');
}

// An origin is scheme + host + optional port, and nothing else. A path here would silently never
// match, since Better Auth compares origins.
function normalise(value) {
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new Error('"' + value + '" is not a URL. Give something like https://example.com');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http and https origins make sense here.');
  if (url.pathname !== '/' || url.search || url.hash) {
    console.log('note: trimming "' + value + '" to its origin, which is what is compared');
  }
  return url.origin;
}

const client = new pg.Client({
  connectionString: connectionString(),
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const args = process.argv.slice(2);
  const removing = args.includes('--remove');
  const target = args.find((a) => !a.startsWith('--'));

  await client.connect();
  const { rows } = await client.query(
    'select id, name, trusted_origins, allow_localhost, social_providers from neon_auth.project_config'
  );
  if (!rows.length) throw new Error('No Neon Auth config found - is auth enabled on this resource?');
  const config = rows[0];
  const current = Array.isArray(config.trusted_origins) ? config.trusted_origins : [];

  const show = () => {
    console.log('project        ' + config.name);
    console.log('providers      ' +
      (config.social_providers || []).map((p) => p.id + (p.isShared ? ' (shared keys)' : '')).join(', '));
    console.log('localhost      ' + (config.allow_localhost ? 'allowed' : 'not allowed'));
    console.log('trusted        ' + (current.length ? current.join('\n               ') : '(nothing)'));
  };

  if (!target) {
    show();
    console.log('\nPass an origin to trust it, e.g. node scripts/auth-origin.mjs https://mouse-agent.vercel.app');
    await client.end();
    return;
  }

  const origin = normalise(target);
  const next = removing
    ? current.filter((o) => o !== origin)
    : current.includes(origin) ? current : current.concat(origin);

  if (next.length === current.length && !removing) {
    console.log(origin + ' is already trusted. Nothing to do.');
    await client.end();
    return;
  }

  await client.query(
    'update neon_auth.project_config set trusted_origins = $1::jsonb, updated_at = now() where id = $2',
    [JSON.stringify(next), config.id]
  );
  console.log((removing ? 'Removed ' : 'Added ') + origin);
  config.trusted_origins = next;
  current.length = 0;
  current.push(...next);
  show();
  await client.end();
}

main().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});
