-- The decision loop, kept in the row it belongs to.
--
-- A goal skill is a model deciding one action at a time from a screenshot. That loop used to run on the
-- user's own machine, in a node process they had to install - the worker - for one reason only: it talked to
-- the agent on 127.0.0.1. Nothing else about it was local; the model call always went out over the network.
--
-- Now the machine can be at the other end of a request instead (see api/_step.mjs), which means the loop
-- runs in a serverless function, one turn per request from the agent. A function has nowhere to keep
-- anything between two requests: the instance that decided step 4 may not be the one that decides step 5,
-- and an instance recycled mid-run would lose it. So the conversation lives here, in the row the job is
-- already in, and each turn reads it, adds one exchange and writes it back.
--
-- WHAT MUST NEVER BE IN HERE: a screenshot. 161KB per step, up to 240 steps, per run - the queue would
-- become a picture album. api/_step.mjs strips every image before returning the state, and there is nothing
-- to keep: the agent sends a fresh picture with every request.
--
-- The column is called `loop` and not `state` because `state` is already this table's queued/claimed/done.
alter table run_queue add column if not exists loop jsonb;

-- Which claimer is driving. A worker runs the loop itself and never writes here; an agent stepping through
-- the cloud does. Two of them on one machine would drive one mouse twice, so the queue records who has it.
alter table run_queue add column if not exists stepping boolean not null default false;
