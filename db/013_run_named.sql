-- A run you can name, and a run you can delete.
--
-- WHY A NAME RATHER THAN AN EDITABLE GOAL. `goal` is what was actually typed and actually ran; it is what
-- "Ask again" sends and what find_repeated matches on. Letting somebody edit it would rewrite the record of
-- what happened - press Ask again afterwards and a different sentence runs than the one the row claims. So
-- the name sits BESIDE the goal: the list shows the name when there is one, and the goal is untouched
-- underneath it, still the thing that ran.
alter table user_run add column if not exists name text;

-- WHY A TOMBSTONE RATHER THAN A DELETE, which is the opposite of what db/004 decided for chat.
--
-- user_flow is tombstoned because two machines sync it and a hard delete would let the next machine to sync
-- put it back. A run looks like it has no such problem - the client that ran it pushes it once and never
-- again - but it has one anyway, and it is worse: a run is written WHILE IT RUNS. api/mcp.js writes the row
-- at every turn of a queued run, and api/sync.js upserts it at the end. Delete a run that is still going and
-- the next turn's `on conflict do update` brings it straight back, with no trace that anybody deleted
-- anything. So the row stays and the upsert is taught to leave a tombstoned run alone.
--
-- What is NOT kept: nothing here is a second copy. The row is the only record of the run, and once it is
-- tombstoned the lists, the dashboard totals and the assistant all stop seeing it - which is what a person
-- deleting a run is asking for.
alter table user_run add column if not exists deleted_at timestamptz;

-- The list reads live runs only, newest first. The pre-existing user_run_recent index covers the same
-- columns without the filter; this one lets the planner skip the tombstones instead of reading past them.
create index if not exists user_run_alive on user_run (user_id, started_at desc) where deleted_at is null;
