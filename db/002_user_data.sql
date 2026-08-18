-- Everything a user's MouseFlow does, in one place.
--
-- Separate from gallery_skill on purpose. A recording carries the shape of someone's real work, and
-- a goal usually carries an address and the text of a message; those are private by default and
-- publishing is a deliberate, separate act. Same database, different access rule: nothing here is
-- ever served without a session or a device token that identifies the owner.
--
-- The user id comes from Neon Auth (neon_auth."user"). As in gallery_skill it is not a foreign key:
-- that schema is managed by Neon, and a hard constraint into someone else's migrations is a good way
-- to have a deploy fail at an awkward moment.

-- ---------------------------------------------------------------- pairing the extension
--
-- The extension has no session of its own. Signing in inside an extension would mean an OAuth client
-- tied to its id, and an unpacked extension's id is derived from its folder path - different on every
-- machine. So the web app mints a token, the user pastes it into the extension once, and the
-- extension uses it thereafter. The same shape a CLI uses, for the same reason.
--
-- Only a hash is stored. A token is a credential: if this table leaks, what leaks should not be
-- usable. The plaintext is shown once, at creation, and never again.
create table if not exists device_token (
  id            text primary key,
  user_id       uuid        not null,
  token_hash    text        not null unique,
  label         text        not null default '',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

create index if not exists device_token_user on device_token (user_id, created_at desc);

-- ------------------------------------------------------------------------ flows
--
-- A flow as the extension holds it: a recording's events, or a created skill's goal and parameters.
-- Keyed by the id the extension already uses locally, so syncing the same flow twice updates it
-- rather than accumulating copies - the client owns identity here, because the client is where a
-- flow is made and renamed.
create table if not exists user_flow (
  user_id      uuid        not null,
  client_id    text        not null,
  kind         text        not null check (kind in ('recorded', 'created')),
  name         text        not null default '',
  description  text        not null default '',
  -- The whole thing, in the versioned format extension/skills.js owns. Mouse input lives in here:
  -- for a recorded flow the payload's events ARE the pointer path, clicks and scrolls.
  payload      jsonb       not null,
  origins      text[]      not null default '{}',
  created_at   timestamptz,
  updated_at   timestamptz not null default now(),
  -- Tombstoned rather than removed, so a delete on one machine can propagate instead of the flow
  -- reappearing from the next machine that syncs.
  deleted_at   timestamptz,
  primary key (user_id, client_id)
);

create index if not exists user_flow_recent on user_flow (user_id, updated_at desc)
  where deleted_at is null;

-- ------------------------------------------------------------------------- runs
--
-- One row per execution, of either kind. This is the "logs" half: what was asked for, what the model
-- said back, every step and where it landed, and how it ended.
create table if not exists user_run (
  id           bigserial   primary key,
  user_id      uuid        not null,
  -- The client's own id for the run, so a retried sync is idempotent.
  client_id    text        not null,
  kind         text        not null check (kind in ('agent', 'replay')),

  -- For an agent run: the goal as typed, and the model that served it. Null for a replay, which has
  -- no prompt - it repeats a recording.
  goal         text,
  model        text,
  flow_id      text,       -- which user_flow it ran, when it ran one

  outcome      text        not null check (outcome in ('ok', 'failed', 'stopped', 'running')),
  summary      text,       -- what the run said it did
  error        text,

  -- The step trace: per step the tool, the page it acted on, where it ended up, the outcome and the
  -- timing. For a replay, the per-event log. Kept as sent rather than shredded into columns - the
  -- shape belongs to the extension and re-deriving it here would give two definitions that can
  -- disagree.
  steps        jsonb       not null default '[]',
  -- Anything the model said in words: its running commentary and its closing summary.
  said         jsonb       not null default '[]',

  extension    text,       -- which build produced it, for reading old runs honestly
  started_at   timestamptz,
  finished_at  timestamptz,
  synced_at    timestamptz not null default now(),

  unique (user_id, client_id)
);

create index if not exists user_run_recent on user_run (user_id, started_at desc);
create index if not exists user_run_flow on user_run (user_id, flow_id, started_at desc);
