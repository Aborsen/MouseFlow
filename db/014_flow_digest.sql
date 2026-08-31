-- What a recording amounts to, computed once instead of on every question.
--
-- WHY THIS TABLE EXISTS, and it is a measurement rather than a preference. /api/insights answers by
-- unnesting every event of every recording in the window: 44 recordings, 28.5 MB of payload and 421,883
-- events on the live account cost 2880 ms for the per-application query alone, and a second scan for the
-- behaviour block added 1700 ms. The cost is linear in recordings, so at 200 it is around thirteen
-- seconds. And the inputs change only when a recording is written - which is the textbook case for
-- deriving once and keeping the answer.
--
-- The first plan was to extend the existing SQL and materialise later "if the numbers say so". They said
-- so immediately, and this table is that decision rather than a guess about the future.
--
-- WHAT IT IS NOT. Not a cache that can be stale without anybody knowing: `version` and `derived_at` make
-- staleness a fact the reader can test, and a row whose recording was edited after it was derived is
-- recomputed rather than trusted. Not a second copy of the recording either - there is no event in here,
-- no window title, no control name. Counts, durations and one sequence of application names, which is
-- exactly what the dashboard already shows.
--
-- WHOSE ROWS. Keyed by (user_id, client_id), the same key user_flow uses, for the same reason: a client id
-- is generated on the machine that made the recording, so it is unique to a person and not to the table.
-- Two people's recordings sharing an id would collide on any key that left the account out.
create table if not exists flow_digest (
  user_id     uuid        not null,
  client_id   text        not null,

  -- WHICH FORMULA PRODUCED THIS ROW. The thresholds below are chosen, not discovered, and will be argued
  -- with - five seconds between "inside an action" and "between actions" most of all. Bumping this number
  -- re-derives every row on the next read, with no migration and no backfill script: the reader asks for
  -- rows at the current version and gets the stale ones recomputed. A cache without this needs a person to
  -- remember to clear it, which is the same as not having a way to change the formula.
  version     integer     not null,

  events      integer     not null default 0,

  -- Three parts of one measured time, and they add up to it by construction: every millisecond of every
  -- gap lands in exactly one of them, and time the pointer spent moving is activity by definition. Stored
  -- as numeric rather than integer because the source is a sum over hundreds of thousands of rows.
  active_ms   numeric     not null default 0,
  waiting_ms  numeric     not null default 0,
  away_ms     numeric     not null default 0,

  -- {"click": 5125, "key": 23493, "scroll": 18480, "move": 361241, ...}. Pointer movement is a key like
  -- any other here and is separated by the reader, not by the writer: 86% of events are movement, and a
  -- writer that dropped it would make `events` disagree with the sum of its own parts.
  by_kind     jsonb       not null default '{}'::jsonb,

  -- [{"action": "Key Backspace", "n": 3631}, ...], movement excluded, the longest tail cut. The kind says
  -- somebody pressed keys; the action says which, and "Backspace 3631 times" is the interesting half.
  top_actions jsonb       not null default '[]'::jsonb,

  -- [{"name": "chrome", "ms": 812000}, ...] - where the time went inside THIS recording. The dashboard's
  -- own per-application query stays as it is and keeps its own scan: it also attributes agent step time
  -- and handles the single-name-for-a-whole-recording case, and reproducing that here would be a second
  -- derivation of the same number. This column serves the assistant and the per-recording view.
  apps        jsonb       not null default '[]'::jsonb,

  -- 'chrome -> explorer -> chrome -> explorer -> powershell'. Consecutive repeats collapsed, capped at a
  -- few steps: the question this answers is whether one process was done several times, not what the
  -- recording contains. Null when nothing named where it happened.
  pattern     text,

  derived_at  timestamptz not null default now(),
  primary key (user_id, client_id)
);

-- Finding what needs recomputing is the commonest read here: rows behind the current formula version.
create index if not exists flow_digest_stale on flow_digest (user_id, version);
