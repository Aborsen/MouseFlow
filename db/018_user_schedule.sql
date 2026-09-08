-- A run that happens without anybody being there to ask for it.
--
-- WHY IT IS A ROW AND NOT A CRON JOB. The obvious build is a cron on the deployment that fires at the
-- appointed minute. It is the wrong one here, and for a reason that is about this product rather than about
-- taste: a run drives a real mouse on somebody's machine, so it can only happen while that machine is awake
-- and taking work. A cloud timer that fires at 03:00 fires into nothing. What DOES know the machine is
-- awake is the machine itself - the agent's courier asks the account for work every three seconds - so the
-- schedule is checked on the way past that question. The agent's own poll is the clock, and there is no
-- second scheduler to break, no cron limits to fit inside, and no minute at which we pretend a sleeping
-- laptop ran something.
--
-- WHAT A SCHEDULE IS, EXACTLY. A deferred run_queue row: the same flow_id, tool_name and args, plus when.
-- Deliberately the same three columns rather than a shape of its own, so anything that can be queued can be
-- scheduled - a recorded skill, a goal skill, a `#record.start` command - and nothing has to learn a second
-- vocabulary. When a schedule comes due, the check inserts an ORDINARY queue row: from there on the run is
-- indistinguishable from one somebody asked for by hand, which is what keeps the claim path, the reporting,
-- the run history and the spend guards working without a single branch for "scheduled".
create table if not exists user_schedule (
  -- Server-chosen: a schedule does not exist before the account accepts it.
  id           text        primary key,
  user_id      uuid        not null,

  -- What to run, in run_queue's own words. NOT a foreign key, for the reason run_queue's flow_id is not
  -- one either: a skill deleted while a schedule points at it should fail the run with a sentence, not fail
  -- the delete - and the schedule then pauses itself rather than retrying an errand that cannot exist.
  flow_id      text        not null,
  tool_name    text        not null default '',
  args         jsonb       not null default '{}'::jsonb,

  -- What somebody called it. The skill's own name is the fallback, but a person with two schedules on one
  -- skill ("morning" and "after lunch") needs to tell them apart in a list.
  label        text        not null default '',

  -- WHEN, in the smallest vocabulary that covers what people ask for:
  --   'once'  - at next_at, then done. The instant is absolute; no rule to re-apply.
  --   'every' - every_minutes apart, from the last fire.
  --   'daily' - at_minutes past local midnight, on the days `days` names.
  -- A cron string was the alternative and is rejected on purpose: `0 * * * *` cannot be read by the person
  -- who has to trust it, and this product's whole argument is that a claim you cannot check is worthless.
  kind         text        not null,
  every_minutes integer,
  -- Minutes from local midnight. Local to `zone`, which is the whole reason this is not just a timestamp.
  at_minutes   integer,
  -- 'all' | 'weekdays'. Two values because those are the two people ask for; a bitmask of seven would be a
  -- schema for a screen nobody has drawn.
  days         text        not null default 'all',

  -- THE ZONE, CAPTURED WHEN THE SCHEDULE IS MADE, and this column is the one most likely to be doubted.
  -- Nothing else in this product stores a timezone: the browser knows its own, the server knows none, and
  -- "09:00" without a zone silently means 09:00 UTC - which for the user who asked is the middle of the
  -- night. So the zone travels with the schedule rather than being guessed at fire time, and a schedule
  -- made on a laptop that later moves country keeps meaning the 09:00 it was created to mean until somebody
  -- changes it.
  zone         text        not null default 'UTC',

  -- The next instant this is due, in UTC, computed from the rule. Everything about scheduling reduces to
  -- this one column: the due check is `next_at <= now()`, and advancing is the only write a fire makes.
  next_at      timestamptz,

  -- Paused by a person, or by three failures in a row (see api/_schedule.mjs). Separate from deleted_at
  -- because "stop doing this for now" and "forget this" are different intentions and the second is worse to
  -- guess at.
  paused       boolean     not null default false,
  paused_why   text,

  -- What happened last time it came due. Kept HERE rather than only in the run history because the most
  -- important outcome a schedule has - "the machine was asleep, so this did not run" - never becomes a run,
  -- and a schedule that silently does nothing is the failure this feature would otherwise ship with.
  last_at      timestamptz,
  last_said    text,
  runs         integer     not null default 0,
  misses       integer     not null default 0,
  fails        integer     not null default 0,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

-- The one query the due check makes, four times a minute per machine: "anything of this person's due now".
create index if not exists user_schedule_due on user_schedule (user_id, next_at)
  where paused = false and deleted_at is null;

-- ЧТО СВЯЗЫВАЕТ ПРОГОН С РАСПИСАНИЕМ, и почему это колонка в очереди, а не поле в args.
--
-- Прогон по расписанию обязан быть неотличим от ручного - на этом стоит вся конструкция, - но отчёт о его
-- исходе обязан вернуться К РАСПИСАНИЮ: три неудачи подряд останавливают его само, иначе оно будет каждый
-- час запускать то, что каждый час не работает, и платить за это. В args такое прятать нельзя: args - это
-- то, что человек передал скиллу, и служебное поле внутри однажды окажется у скилла в параметрах.
alter table run_queue add column if not exists schedule_id text;
