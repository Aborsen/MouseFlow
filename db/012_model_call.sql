-- Every call this deployment pays for, so the ceiling on them can be a real one.
--
-- WHY A TABLE AND NOT A MAP. Six routes each kept their own limiter in a `Map` in module scope, and each
-- carried a comment saying the route spends the deployment's own key. On a serverless runtime that Map lives
-- in ONE warm instance: two instances mean twice the ceiling, ten mean ten times, and the number of them is
-- decided by traffic - which is to say the limit rose exactly when it was most needed. Every one of those
-- files says out loud that the counter is per-instance; none of them could do anything about it alone.
--
-- Two routes had no limiter at all, and one of those - /api/mcp ?worker=step - is the expensive one: a run
-- is up to 240 vision calls at 8000 tokens each, back to back, and nothing counted them.
--
-- WHAT IT COSTS. One insert and one count per model call. A model call takes seconds; two index lookups do
-- not, and the alternative is a ceiling that is not one.
--
-- KEPT SHORT. Rows are evidence for a window measured in minutes, not history: `sweep` below is called on
-- the same path that writes, so the table stays about as large as the traffic in one window. Nothing reads
-- it for anything but counting, and nothing anywhere joins it to a person's work.
create table if not exists model_call (
  user_id  uuid        not null,
  -- Which ceiling this counts against. Per route, because the routes are not alike: a chat turn is worth
  -- more than a filename and both should not share one budget.
  route    text        not null,
  at       timestamptz not null default now()
);

-- The only query there is: how many for this person, on this route, since a moment.
create index if not exists model_call_window on model_call (user_id, route, at desc);

-- And the only other one: what is old enough to drop.
create index if not exists model_call_old on model_call (at);
