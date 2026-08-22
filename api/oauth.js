/* Signing in to an MCP client with the account you already have.
 *
 *   POST /api/oauth?do=register    RFC 7591 dynamic client registration
 *   GET  /api/oauth?do=authorize   the consent page, behind the ordinary sign-in wall
 *   POST /api/oauth?do=approve     "yes, this client may act as me" -> a code
 *   POST /api/oauth?do=token       code + verifier -> tokens; also the refresh grant
 *   POST /api/oauth?do=revoke      RFC 7009
 *
 * WHY THIS EXISTS. A device token works and has one shape of problem: somebody has to carry a per-person
 * secret to wherever the AI runs. Fine for one person at one terminal; wrong for a connector an organisation
 * installs once, because then everyone shares one credential and therefore one account - one tenant with many
 * users rather than many tenants. OAuth is what makes the connector identify the PERSON.
 *
 * WHY WE ARE THE AUTHORISATION SERVER. The hosted auth service behind /api/auth is not ours to add plugins
 * to, so an OIDC provider cannot be switched on there. What is ours is the session it issues: the authorize
 * page below is an ordinary page behind the ordinary sign-in wall, and once somebody is through it - by
 * Google or by email and password, whichever they already use - saying "this client may act as me" is a row.
 * The authentication stays entirely theirs. Only the consent and the token are ours.
 *
 * PKCE IS REQUIRED, S256 only. A public client cannot keep a secret - Claude is one - so the thing that
 * proves the token request came from whoever started the flow is the verifier, which never leaves the
 * client. Without it an intercepted code is a session.
 *
 * WHAT IS DELIBERATELY NOT HERE. No client secrets (nothing here can keep one). No implicit grant, which
 * OAuth 2.1 removes. No consent that can be given by a redirect: approving is a POST from a page a person
 * looked at, so a link cannot authorise anything on its own.
 */

import { neon } from '@neondatabase/serverless';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { whoIsCalling } from './_session.js';

const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const CLIENTS_MAX_URIS = 10;

export const hashToken = (value) => createHash('sha256').update(String(value)).digest('hex');
const secret = () => randomBytes(32).toString('base64url');

const originOf = (req) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'mouse-agent.vercel.app';
  return `https://${host}`;
};

const oops = (res, status, error, description) =>
  res.status(status).json({ error, error_description: description });

/* A redirect_uri is checked by EXACT string against what the client registered. Not by prefix and not by
 * host: a prefix match is how "https://good.example/cb" comes to accept "https://good.example/cb.evil.test",
 * and this is the single check standing between a code and whoever asked for it. */
const registered = (client, uri) => {
  const list = Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
  return list.some((known) => known === uri);
};

/* Constant-time, because comparing a hash with === leaks its prefix to anybody who can time it. Both sides
 * are hex of the same length, so a length mismatch is simply false rather than a throw. */
const sameSecret = (a, b) => {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* ------------------------------------------------------------------------------- registration */

async function register(req, res, sql) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.slice(0, CLIENTS_MAX_URIS) : [];
  const clean = uris
    .map((u) => String(u || '').trim())
    .filter((u) => {
      try {
        const parsed = new URL(u);
        /* https, or a loopback http - which is what a desktop client with a local callback uses and what
         * the spec carves out. Anything else is refused rather than stored. */
        return parsed.protocol === 'https:'
          || (parsed.protocol === 'http:' && /^(127\.0\.0\.1|\[::1\]|localhost)$/.test(parsed.hostname));
      } catch (_) {
        return false;
      }
    });
  if (!clean.length) {
    return oops(res, 400, 'invalid_redirect_uri', 'redirect_uris must hold at least one https or loopback URL');
  }

  const id = `mfc_${randomBytes(12).toString('hex')}`;
  const name = String(body.client_name || 'an MCP client').slice(0, 120);
  await sql`
    insert into oauth_client (id, name, redirect_uris)
    values (${id}, ${name}, ${JSON.stringify(clean)})
  `;
  return res.status(201).json({
    client_id: id,
    client_name: name,
    redirect_uris: clean,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
}

/* ------------------------------------------------------------------------------- the consent page */

/* Exported so it can be rendered outside a request - the documentation's screenshot of this page is taken
 * from this function rather than mocked up, which is the only way a picture of a consent screen stays true
 * to the consent screen. */
export function consentPage({ origin, client, params, who }) {
  const q = new URLSearchParams(params).toString();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ${escapeHtml(client.name)} — MouseFlow</title>
<style>
  :root { color-scheme: dark; --page:#0a1126; --card:#0f1734; --line:#192758; --ink:#f0f6ff;
          --dim:#aebacb; --accent:#bdff7a; --on:#0a1a13; }
  body { margin:0; min-height:100dvh; display:grid; place-items:center; background:var(--page);
         color:var(--ink); font:16px/1.5 "DM Sans", system-ui, sans-serif; padding:1.5rem; }
  main { width:min(30rem,100%); background:var(--card); border:1px solid var(--line);
         border-radius:14px; padding:1.5rem; }
  h1 { font-size:1.15rem; margin:0 0 .35rem; }
  p { color:var(--dim); font-size:.92rem; margin:.55rem 0; }
  ul { color:var(--dim); font-size:.9rem; padding-left:1.1rem; margin:.6rem 0; }
  li { margin:.25rem 0; }
  .who { color:var(--ink); }
  .row { display:flex; gap:.6rem; margin-top:1.2rem; }
  button { font:inherit; font-weight:600; border-radius:9px; padding:.6rem 1rem; cursor:pointer;
           border:1px solid var(--line); }
  .yes { background:var(--accent); color:var(--on); border-color:transparent; flex:1; }
  .no { background:transparent; color:var(--dim); }
  code { color:var(--ink); font-size:.85rem; word-break:break-all; }
</style></head>
<body><main>
  <h1>Connect ${escapeHtml(client.name)}?</h1>
  <p>It is asking to act as <span class="who">${escapeHtml(who.email || who.name || 'you')}</span> on MouseFlow.</p>
  <ul>
    <li>It will see <strong>your</strong> recordings, transcripts and runs, and nobody else's.</li>
    <li>It can ask a computer you have attached to start or stop a recording there, or to run one of your
        skills — which moves the real mouse and keyboard on it.</li>
    <li>It cannot read what you typed while recording. Nothing holds that.</li>
    <li>You can take this back at any time under Settings → My account.</li>
  </ul>
  <p>It will send you back to <code>${escapeHtml(params.redirect_uri)}</code>.</p>
  <form method="POST" action="${origin}/api/oauth?do=approve">
    ${Object.entries(params).map(([k, v]) =>
      `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('\n    ')}
    <div class="row">
      <button class="yes" type="submit" name="decision" value="allow">Allow</button>
      <button class="no" type="submit" name="decision" value="deny">No</button>
    </div>
  </form>
  <noscript><p>${escapeHtml(q ? '' : '')}</p></noscript>
</main></body></html>`;
}

async function authorize(req, res, sql, who) {
  const origin = originOf(req);
  const q = req.query || {};
  const clientId = String(q.client_id || '');
  const redirectUri = String(q.redirect_uri || '');
  const state = String(q.state || '');
  const challenge = String(q.code_challenge || '');
  const method = String(q.code_challenge_method || '');
  const resource = q.resource ? String(q.resource) : null;
  const scope = String(q.scope || 'mcp').slice(0, 200);

  const [client] = await sql`select id, name, redirect_uris from oauth_client where id = ${clientId}`;
  /* The two failures that must NOT redirect, because redirecting them would mean trusting the very
   * parameter that is wrong. Everything after this point can be reported to the client. */
  if (!client) return res.status(400).send('Unknown client. Register it first.');
  if (!registered(client, redirectUri)) {
    return res.status(400).send('That redirect_uri is not one this client registered.');
  }

  const back = (error, description) => {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error);
    if (description) url.searchParams.set('error_description', description);
    if (state) url.searchParams.set('state', state);
    res.writeHead(302, { location: url.toString() });
    res.end();
  };

  if (String(q.response_type || '') !== 'code') return back('unsupported_response_type');
  if (!challenge || method !== 'S256') {
    return back('invalid_request', 'PKCE with S256 is required');
  }

  if (!who) {
    /* Not signed in. Sent to the app's own front door with where to come back to - a path on this site and
     * nothing else, which is what stops this being a way to bounce somebody anywhere. */
    const here = `/api/oauth?${new URLSearchParams({
      do: 'authorize',
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: method,
      scope,
      ...(resource ? { resource } : {}),
    })}`;
    res.writeHead(302, { location: `${origin}/sign-in?next=${encodeURIComponent(here)}` });
    res.end();
    return;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(consentPage({
    origin,
    client,
    who,
    params: {
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: method,
      scope,
      ...(resource ? { resource } : {}),
    },
  }));
}

async function approve(req, res, sql, who) {
  if (!who) return res.status(401).send('Sign in first.');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const clientId = String(body.client_id || '');
  const redirectUri = String(body.redirect_uri || '');
  const state = String(body.state || '');

  const [client] = await sql`select id, redirect_uris from oauth_client where id = ${clientId}`;
  if (!client || !registered(client, redirectUri)) return res.status(400).send('Bad client or redirect.');

  const url = new URL(redirectUri);
  if (state) url.searchParams.set('state', state);

  if (body.decision !== 'allow') {
    url.searchParams.set('error', 'access_denied');
    res.writeHead(302, { location: url.toString() });
    res.end();
    return;
  }

  const code = secret();
  await sql`
    insert into oauth_code (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, scope, expires_at)
    values (${hashToken(code)}, ${clientId}, ${who.id}, ${redirectUri},
            ${String(body.code_challenge || '')}, ${body.resource ? String(body.resource) : null},
            ${String(body.scope || 'mcp').slice(0, 200)}, ${new Date(Date.now() + CODE_TTL_MS).toISOString()})
  `;
  url.searchParams.set('code', code);
  res.writeHead(302, { location: url.toString() });
  res.end();
}

/* ------------------------------------------------------------------------------- tokens */

async function issue(sql, { clientId, userId, scope, resource }) {
  const access = secret();
  const refresh = secret();
  const now = Date.now();
  await sql`
    insert into oauth_token (token_hash, kind, client_id, user_id, scope, resource, expires_at)
    values (${hashToken(access)}, 'access', ${clientId}, ${userId}, ${scope}, ${resource},
            ${new Date(now + ACCESS_TTL_MS).toISOString()})
  `;
  await sql`
    insert into oauth_token (token_hash, kind, client_id, user_id, scope, resource, expires_at)
    values (${hashToken(refresh)}, 'refresh', ${clientId}, ${userId}, ${scope}, ${resource},
            ${new Date(now + REFRESH_TTL_MS).toISOString()})
  `;
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: Math.round(ACCESS_TTL_MS / 1000),
    refresh_token: refresh,
    scope,
  };
}

async function token(req, res, sql) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const grant = String(body.grant_type || '');
  const clientId = String(body.client_id || '');

  if (grant === 'authorization_code') {
    const presented = String(body.code || '');
    const verifier = String(body.code_verifier || '');
    if (!presented || !verifier) return oops(res, 400, 'invalid_request', 'code and code_verifier');

    const [row] = await sql`
      select * from oauth_code where code_hash = ${hashToken(presented)}
    `;
    if (!row) return oops(res, 400, 'invalid_grant', 'no such code');
    /* Single use, and burnt BEFORE anything is checked against it. A code replayed while the first exchange
     * is still in flight would otherwise mint a second set of tokens. */
    const burnt = await sql`
      update oauth_code set used_at = now() where code_hash = ${row.code_hash} and used_at is null
      returning code_hash
    `;
    if (!burnt.length) return oops(res, 400, 'invalid_grant', 'that code has already been used');
    if (new Date(row.expires_at).getTime() < Date.now()) return oops(res, 400, 'invalid_grant', 'expired');
    if (row.client_id !== clientId) return oops(res, 400, 'invalid_grant', 'wrong client');
    if (row.redirect_uri !== String(body.redirect_uri || '')) {
      return oops(res, 400, 'invalid_grant', 'redirect_uri does not match');
    }
    const computed = createHash('sha256').update(verifier).digest('base64url');
    if (!sameSecret(computed, row.code_challenge)) {
      return oops(res, 400, 'invalid_grant', 'the verifier does not match the challenge');
    }
    return res.status(200).json(await issue(sql, {
      clientId, userId: row.user_id, scope: row.scope, resource: row.resource,
    }));
  }

  if (grant === 'refresh_token') {
    const presented = String(body.refresh_token || '');
    const [row] = await sql`
      select * from oauth_token
      where token_hash = ${hashToken(presented)} and kind = 'refresh' and revoked_at is null
    `;
    if (!row) return oops(res, 400, 'invalid_grant', 'no such refresh token');
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      return oops(res, 400, 'invalid_grant', 'expired');
    }
    if (row.client_id !== clientId) return oops(res, 400, 'invalid_grant', 'wrong client');
    /* Rotated: the old one dies as the new one is born, so a stolen refresh token is worth one use and its
     * theft shows up as the real client suddenly being refused. */
    await sql`update oauth_token set revoked_at = now() where token_hash = ${row.token_hash}`;
    return res.status(200).json(await issue(sql, {
      clientId, userId: row.user_id, scope: row.scope, resource: row.resource,
    }));
  }

  return oops(res, 400, 'unsupported_grant_type', grant || 'none given');
}

async function revoke(req, res, sql) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const presented = String(body.token || '');
  if (presented) {
    await sql`update oauth_token set revoked_at = now() where token_hash = ${hashToken(presented)}`;
  }
  /* RFC 7009: a token that was never valid is answered exactly like one that was, so this cannot be used to
   * find out which strings are tokens. */
  return res.status(200).json({});
}

/* ------------------------------------------------------------------------------- taking it back */

/* What this person has authorised, and the one control that matters.
 *
 * Promised on the consent page, so it has to exist: "you can take this back at any time" is a sentence that
 * is either true or a lie, and there is no third option. Grouped by client rather than by token, because
 * nobody thinks in access tokens - they think "that thing I connected". */
async function listGrants(res, sql, who) {
  const rows = await sql`
    select t.client_id, c.name,
           min(t.created_at) as first_at,
           max(t.last_used_at) as used_at,
           count(*) filter (where t.revoked_at is null)::int as live
    from oauth_token t
    left join oauth_client c on c.id = t.client_id
    where t.user_id = ${who.id} and t.revoked_at is null
    group by t.client_id, c.name
    order by min(t.created_at) desc
  `;
  return res.status(200).json({
    ok: true,
    grants: rows.map((r) => ({
      clientId: r.client_id,
      name: r.name || 'an MCP client',
      since: r.first_at,
      lastUsed: r.used_at,
      tokens: r.live,
    })),
  });
}

async function forget(req, res, sql, who) {
  const clientId = String((req.query && req.query.client) || '');
  if (!clientId) return oops(res, 400, 'invalid_request', 'which client?');
  /* Every token, access and refresh, in one statement. Revoking the access token alone would leave the
   * client able to mint another one within the minute, which is the same as not revoking anything. */
  const gone = await sql`
    update oauth_token set revoked_at = now()
    where user_id = ${who.id} and client_id = ${clientId} and revoked_at is null
    returning token_hash
  `;
  return res.status(200).json({ ok: true, revoked: gone.length });
}

/* ------------------------------------------------------------------------------- the route */

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
    res.status(204).end();
    return;
  }
  if (!process.env.DATABASE_URL) return oops(res, 503, 'server_error', 'no database configured');

  const sql = neon(process.env.DATABASE_URL);
  const what = String((req.query && req.query.do) || '');

  try {
    /* The token and registration endpoints are called by a machine with no session, and must be reachable
     * cross-origin; the two that involve a person are same-site by construction. */
    if (what === 'register' || what === 'token' || what === 'revoke') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.method !== 'POST') return oops(res, 405, 'invalid_request', 'POST');
      if (what === 'register') return await register(req, res, sql);
      if (what === 'token') return await token(req, res, sql);
      return await revoke(req, res, sql);
    }

    let who = null;
    try {
      who = await whoIsCalling(req, sql);
    } catch (_) {
      who = null;
    }
    /* A device token or an OAuth token is not a person sitting at a browser, and consent has to be given by
     * one. Only a SESSION may authorise. */
    if (who && who.via !== 'session') who = null;

    if (what === 'authorize') {
      if (req.method !== 'GET') return oops(res, 405, 'invalid_request', 'GET');
      return await authorize(req, res, sql, who);
    }
    if (what === 'approve') {
      if (req.method !== 'POST') return oops(res, 405, 'invalid_request', 'POST');
      return await approve(req, res, sql, who);
    }
    if (what === 'grants') {
      if (!who) return oops(res, 401, 'invalid_request', 'sign in first');
      if (req.method === 'GET') return await listGrants(res, sql, who);
      if (req.method === 'DELETE') return await forget(req, res, sql, who);
      return oops(res, 405, 'invalid_request', 'GET or DELETE');
    }
    return oops(res, 404, 'invalid_request', `no action "${what}"`);
  } catch (err) {
    return oops(res, 500, 'server_error', err.message);
  }
}
