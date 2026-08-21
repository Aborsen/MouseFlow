-- Facts about the DEPLOYMENT rather than about any user.
--
-- The first tenants are the model choices: which model plans a flow, which one drives the desktop loop,
-- which one answers in the chat when nothing was picked. They used to be constants compiled into three
-- different artifacts - the web bundle, the extension source, and this repo's functions - which meant
-- changing a model was three edits and two deploys, and the run log lied in the meantime.
--
-- Same shape as user_pref and for the same reason: key/value, no structure to migrate per setting. Writes
-- go through the admin endpoint, which answers only to the addresses in ADMIN_EMAILS - the table
-- deliberately holds no notion of who may write it, because a role a database row can grant is a role a
-- database access can grant itself.
create table if not exists app_setting (
  key         text        not null primary key,
  value       text        not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
