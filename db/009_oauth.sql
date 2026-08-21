-- Signing in to an MCP client with the account you already have.
--
-- A device token works and has one shape of problem: it is a per-person secret that somebody has to carry to
-- wherever the AI runs. Fine for one person and one terminal; wrong for a connector an organisation installs
-- once, because then everyone shares one credential and therefore one account. That is not multi-tenancy, it
-- is one tenant with many users.
--
-- OAuth fixes exactly that: the client is registered once, and each PERSON authorises it with the login they
-- already have - Google, or their email and password - in a browser, against the session this app already
-- issues. What comes back identifies them, not the installation.
--
-- WHY THIS IS OUR OWN AUTHORISATION SERVER rather than the auth service's. The hosted Better Auth instance
-- behind /api/auth is not ours to add plugins to, so an OIDC provider cannot be turned on there. What IS
-- ours is the session it gives us: /api/oauth?do=authorize is a page behind the ordinary sign-in wall, and
-- once somebody is through it, saying "yes, this client may act as me" is a row. The authentication is still
-- entirely theirs; only the consent and the token are ours.
--
-- Tokens are stored HASHED, like device tokens, and for the same reason: what leaks from a table should not
-- be usable.

-- Registered by a client, dynamically (RFC 7591). Claude registers itself the first time somebody adds the
-- connector, which is why there is no admin screen for this.
create table if not exists oauth_client (
  id            text        primary key,
  name          text        not null default '',
  redirect_uris jsonb       not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);

-- One authorisation code. Short-lived, single-use, and bound to the PKCE challenge the client sent, so a
-- code intercepted on its way back is worthless without the verifier that never left the client.
create table if not exists oauth_code (
  code_hash      text        primary key,
  client_id      text        not null,
  user_id        uuid        not null,
  redirect_uri   text        not null,
  code_challenge text        not null,
  resource       text,
  scope          text        not null default 'mcp',
  expires_at     timestamptz not null,
  used_at        timestamptz
);

-- Access and refresh tokens. `kind` rather than two tables: they differ by lifetime and by what they may be
-- exchanged for, not by shape, and one table means one place that revokes.
create table if not exists oauth_token (
  token_hash  text        primary key,
  kind        text        not null default 'access',
  client_id   text        not null,
  user_id     uuid        not null,
  scope       text        not null default 'mcp',
  resource    text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz,
  revoked_at  timestamptz,
  last_used_at timestamptz
);

-- "Everything this person has authorised", for the screen that lets them take it back.
create index if not exists oauth_token_user on oauth_token (user_id, created_at desc);
