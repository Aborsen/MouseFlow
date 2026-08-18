-- Where a flow came from, and therefore what can run it.
--
-- The two halves of MouseFlow record different things, and a flow from one is not runnable by the
-- other:
--
--   web      made in the extension. Steps point at ELEMENTS - a selector plus where inside the box
--            the click landed - so they survive a resize or a layout shift, and mean nothing outside
--            a browser. Only the extension can replay one.
--
--   desktop  made through the local agent. Steps are screen coordinates, so they can drive any
--            application on the machine and break the moment a window moves. Only the agent can
--            replay one.
--
-- Both belong to the same person and both should be visible in both places - being told "you have
-- eleven flows" and shown four is worse than useless. But the tag has to travel with them, because
-- offering Run on a flow this half cannot run is a broken button, and hiding it is a lie about what
-- the account contains.
--
-- Defaulting to 'web': everything that existed when this column was added came from the extension,
-- which was the only thing syncing.

alter table user_flow
  add column if not exists source text not null default 'web'
    check (source in ('web', 'desktop'));

-- Listing "my desktop flows" or "my web flows" is the query both clients make on load.
create index if not exists user_flow_source on user_flow (user_id, source, updated_at desc)
  where deleted_at is null;
