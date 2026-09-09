-- The screen at the moment something was proven, or at the moment a run gave up.
--
-- WHY A RUN NEEDS PICTURES AT ALL, when it already has steps in words. Because a failed check in words is a
-- claim about a screen nobody can look at any more. "Saved is not on the window" is exactly as trustworthy
-- as the parser that said it - which is the point of `expect` - but the person reading a red line at nine in
-- the morning wants to know WHY it was not there, and no amount of words gets them there. A regression suite
-- whose failures cannot be diagnosed produces one behaviour in the end: people stop reading it.
--
-- WHY NOT EVERY TURN. The loop already strips every screenshot from the conversation before the row is
-- written (`forgetOldPictures`), and for a good reason: a twenty-step run carries twenty pictures of about
-- 150KB, the queue row travels with every single step, and the whole thing would turn into a picture album
-- that has to be read and written thirty times a run. So this table holds the few frames that PROVE
-- something - the turns that made a check, and the endings that failed - and nothing else.
--
-- ONE PICTURE PER TURN, not per check, and that is the shape to keep. A turn can make five checks in one
-- batch; they were all decided from ONE screen, and five copies of it would be five times the storage for
-- the same evidence. So `step_no` names the first step the picture covers, and `said` carries what that turn
-- proved - all of it, in the words the person will read.
create table if not exists run_artifact (
  id          text        primary key,
  user_id     uuid        not null,
  -- user_run.client_id: `dr_…` for a run the page drove, the queue job id for one the machine did. NOT a
  -- foreign key, for the reason nothing here is one: a deleted run should not fail the delete, and an
  -- orphaned picture is pruned by age anyway.
  run_id      text        not null,
  step_no     integer     not null,
  -- 'check'  — a turn that asserted something and every assertion held
  -- 'failure' — a turn with a failed check in it, or the frame a run failed on
  -- 'final'  — the last screen of a run that made checks, so a green report has a picture too
  kind        text        not null,
  mime        text        not null,
  w           integer,
  h           integer,
  -- Base64, inline. A blob store would be the textbook answer and is the wrong first move here: it adds a
  -- second place where a person's screen lives, a second thing to delete when they erase their account, and
  -- a second failure mode - a row that survives while its picture does not. At 250KB a frame and twelve
  -- frames a run, held for thirty days, this fits where it is. If it stops fitting, this column becomes a
  -- URL and every reader above it changes not at all.
  bytes       text        not null,
  -- What this picture is evidence OF, in the words the run used. Without it a thumbnail is a mystery.
  said        text,
  created_at  timestamptz not null default now()
);

create index if not exists run_artifact_run on run_artifact (user_id, run_id, step_no);
-- The prune's own query: everything older than the window, for one person, on the way past.
create index if not exists run_artifact_old on run_artifact (user_id, created_at);
