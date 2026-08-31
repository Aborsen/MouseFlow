-- What a recording touched, by name, so it can be found by name.
--
-- WHY. `search_runs` searches what somebody TYPED AT AN AGENT - the goal, the summary, the error - which is
-- the only text this product has ever been able to search. The recordings themselves were unreachable: to
-- answer "which recording was I working with invoices in", the assistant had to read transcripts one at a
-- time, and there are 44 of them on the live account.
--
-- WHAT IS IN HERE, AND IT IS NOT flow_digest. That table deliberately holds no text from anybody's screen -
-- counts, durations and application names - and its own migration says so, because a table added for speed
-- that also held content would put the privacy rules in two places. This one holds text ON PURPOSE, which
-- is exactly why it is a second table: the rules about it live here, next to it, and cannot be reached by
-- somebody reading only the other one.
--
-- The text is the NAMES OF THINGS THAT WERE TOUCHED: window titles, control names, the container a control
-- sat in, application names, page origins. Every one of them is already shown in the transcript, in
-- list_recordings, and - for window titles - on the team dashboard. Nothing new becomes visible; what
-- changes is that it can be found.
--
-- AND IT CANNOT HOLD WHAT WAS TYPED, not because it is filtered but because it does not exist: the recorder
-- stores that a key was pressed and which key, never a word of what was written. A search here finds the name
-- of the field somebody typed into and can never find the sentence they typed.
create table if not exists flow_text (
  user_id     uuid        not null,
  client_id   text        not null,

  -- Which formula produced this row, same mechanism as flow_digest.version: bump it and every row is
  -- re-derived on the next read, with no migration and no backfill script.
  version     integer     not null,

  -- EVERY distinct phrase, lowercased, newline-separated. This is what a search scans, and it is a plain
  -- text blob rather than a tsvector for one measured reason: control names are UI labels in whatever
  -- language the application is in - "Снимок экрана" and "Prompt" sit in the same recording - and a
  -- stemming configuration has to pick a language. A substring match picks none, needs no extension, and
  -- finds "накладную" inside "накладные". The cost is a sequential scan, over a table that is a few hundred
  -- kilobytes where the payloads are 28 MB.
  words       text        not null default '',

  -- [{"t": "Prompt", "n": 412, "k": "control"}, ...] - the commonest phrases with their original spelling,
  -- so a result can say WHY it matched rather than only that it did. Capped; `words` is not, up to its own
  -- ceiling, so the cap never makes a recording unfindable.
  phrases     jsonb       not null default '[]'::jsonb,

  -- How many distinct phrases the recording actually had, before the cap on `words`. Reported, so a
  -- truncated index says it is truncated instead of quietly answering "no".
  distinct_n  integer     not null default 0,

  derived_at  timestamptz not null default now(),
  primary key (user_id, client_id)
);

-- Finding what needs re-deriving is the commonest read here, exactly as in flow_digest.
create index if not exists flow_text_stale on flow_text (user_id, version);
