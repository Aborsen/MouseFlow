-- Work asked for in one place and done in another.
--
-- The MCP server was a process on the user's own machine, which is why it could run anything: the local
-- agent listens on loopback and only something on that machine can reach it. Over HTTPS the decider moves
-- into the cloud - Claude on a phone, in a browser, in someone else's terminal - and the machine is no
-- longer where the request arrives. Nothing in the design bridges that: the agent does not poll, and
-- nothing should be able to reach into a desktop from the internet without the desktop asking.
--
-- So the desktop asks. A call becomes a ROW here, a worker on the user's own machine claims it, runs it
-- through the agent it can already reach, and writes the outcome back. The direction of the connection
-- never reverses, which is the whole security property: no inbound path to anybody's computer exists, and
-- a machine with no worker running simply never claims anything.
--
-- WHY NOT user_run. That table is the LOG - what happened, for the dashboard and the assistant to read.
-- This is a QUEUE - what has been asked for and has not happened yet. Putting both in one table would mean
-- every reader of the log filtering out work that may never occur, and the first reader to forget would
-- report a request as an action. A queued row that runs writes user_run like any other run.
create table if not exists run_queue (
  id           text        primary key,
  user_id      uuid        not null,
  -- The skill, by the client id user_flow is keyed on. Not a foreign key: a skill deleted between the ask
  -- and the claim should fail the job with a reason, not fail the delete.
  flow_id      text        not null,
  tool_name    text        not null default '',
  args         jsonb       not null default '{}'::jsonb,
  -- queued -> claimed -> done | failed. Nothing goes back: a job a worker took and lost is expired by the
  -- claim age, not returned to the pool, because a run that may be half-done must not be repeated blind.
  state        text        not null default 'queued',
  claimed_by   text,
  claimed_at   timestamptz,
  finished_at  timestamptz,
  ok           boolean,
  -- What the worker has to say, in the words the tool result will use.
  said         text,
  created_at   timestamptz not null default now()
);

-- The two reads this table has. A worker asks "anything for me, oldest first"; the endpoint that is
-- waiting asks for one job by id.
create index if not exists run_queue_waiting on run_queue (user_id, state, created_at);
