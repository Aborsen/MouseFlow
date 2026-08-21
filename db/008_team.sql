-- Teams: who may see whose work, and nothing more than that.
--
-- Three roles, fixed, checked in the queries that need them. Deliberately not a permission table: a role
-- system earns its keep when somebody needs "this person sees the dashboard but not the transcripts", and
-- until that request exists it is a second product to keep correct. The migration out of this - three fixed
-- roles into a permissions table - is linear; the migration back is not, which is why this is the direction
-- to start in.
--
--   owner   made it. Renames it, deletes it, moves anybody's role including another owner's.
--   admin   adds and removes members, sees the whole team's activity.
--   member  sees the team's SHARED skills, and their own activity.
--
-- WHAT A TEAM DOES NOT DO, and this is the important half. Joining one does not hand over anything already
-- recorded. Activity - that a person made a recording, when, and how a run ended - becomes visible to the
-- team's owners and admins, because a team that cannot see whether it is working is not a team. CONTENT -
-- the events, the transcript, the chat - stays private until it is shared, one thing at a time, which is
-- the same rule the gallery has always had. A membership that retroactively opened everything somebody
-- recorded before they joined would be a surprise, and a surprise about other people's screens.
create table if not exists team (
  id          text        primary key,
  name        text        not null,
  created_by  uuid        not null,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table if not exists team_member (
  team_id     text        not null,
  user_id     uuid        not null,
  role        text        not null default 'member',
  joined_at   timestamptz not null default now(),
  invited_by  uuid,
  primary key (team_id, user_id)
);

-- "Which teams am I in" is asked on every team read; the primary key answers the other direction only.
create index if not exists team_member_user on team_member (user_id);

-- Somebody added by an address that has no account yet.
--
-- Kept as a row rather than as an email, because there is no sender in this product's control and an invite
-- that depends on a message arriving is an invite that silently does not happen. The person signs up however
-- they were going to, opens the team screen, and the invite is claimed by the address they signed up with.
-- Claimed on READ rather than on every request: joining a team matters the moment somebody looks at one.
create table if not exists team_invite (
  team_id     text        not null,
  email       text        not null,
  role        text        not null default 'member',
  invited_by  uuid        not null,
  created_at  timestamptz not null default now(),
  primary key (team_id, email)
);

create index if not exists team_invite_email on team_invite (lower(email));

-- One skill or recording, deliberately shown to one team.
--
-- The owner travels with the row, and not for convenience: a share means "this person let the team see
-- this", so when they leave the team the share leaves with them. Keyed on the flow's client id, the same
-- id user_flow is keyed on, and NOT a foreign key - a deleted flow should make the share meaningless, not
-- make the delete fail.
create table if not exists team_share (
  team_id    text        not null,
  user_id    uuid        not null,
  flow_id    text        not null,
  shared_at  timestamptz not null default now(),
  primary key (team_id, user_id, flow_id)
);

create index if not exists team_share_flow on team_share (user_id, flow_id);
