-- A test case: the skill that acts, plus what must be true when it is done.
--
-- WHY THIS IS NOT JUST A SKILL WITH A SCHEDULE. A skill answers "do this"; a case answers "is this still
-- true". The difference shows up in what you do with the answer: a skill that finished is done, a case that
-- finished has a VERDICT, and a row of verdicts over thirty nights is the only thing that tells somebody
-- their product still works. `user_flow` cannot carry that: it holds one current definition, its runs are
-- the account's whole journal, and a skill run by hand at noon has nothing to do with the regression.
--
-- WHY THE ASSERTIONS LIVE HERE AND NOT IN THE SCHEDULE'S ARGUMENTS. A schedule row could carry the expects
-- outright - it carries `args` already - and that was the first design. It is wrong for one reason: a case
-- edited in the morning would still be checked tonight by the copy taken when the schedule was made, and
-- nothing on any screen would say so. So the schedule carries `args.__case = { id }`, one pointer, and the
-- run reads the assertions from this table at the moment it starts. One definition, one place to edit it.
--
-- WHY expects IS JSONB AND NOT A TABLE OF ITS OWN. An assertion is never read alone, never listed across
-- cases, and never joined to anything - it is a field of the case, in the same sense a skill's parameters
-- are a field of the skill (`user_flow.payload`). A second table would buy ordering and buy nothing else.
create table if not exists user_case (
  id          text        primary key,
  user_id     uuid        not null,
  -- What a person calls it: "Outlook still sends", not the goal text. It is what a report is read by.
  name        text        not null,
  -- The skill that performs the steps - user_flow.client_id. Not a foreign key, like everything else here:
  -- the fence at the start of the run says "the skill was deleted between the ask and the run", which is a
  -- sentence somebody can act on, where a constraint violation is a 500 in a log.
  flow_id     text        not null,
  -- What the skill asks for, by its own parameter names. Exactly what mouseflow_run would take.
  args        jsonb       not null default '{}',
  -- [{ check, name, text?, process?, why }] - the same shape the `expect` tool takes, deliberately: a case
  -- is not a second language for assertions, it is the same assertions written down in advance. Evaluated
  -- at the END of the run in v1; per-step (bound to a plan's checkpoints) is v2.
  expects     jsonb       not null default '[]',
  -- The machine this case may run on, when there is a machine to name (roadmap item 7). Nothing reads it
  -- yet; it is here because the column is free today and a migration is not.
  machine     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- The list, as the page and the tool ask for it: one person's live cases, newest first.
create index if not exists user_case_owner on user_case (user_id, deleted_at, updated_at desc);

-- WHICH CASE A RUN WAS. The verdict is computed from the run's own outcome and checks - it is not stored,
-- for the same reason `checks` is a summary and not a duplicate of the steps: a stored verdict and a
-- changed rule for reading one is how a report starts disagreeing with itself. This column only says which
-- case to count the run under.
alter table user_run add column if not exists case_id text;
-- One case's history, newest first - the query behind every row of dots on the Tests page.
create index if not exists user_run_case on user_run (user_id, case_id, started_at desc);
