-- A written process, as an object rather than as a chat answer.
--
-- WHY IT IS A ROW AND NOT A MESSAGE. Documenting a process was asked for as the thing that makes automation
-- possible, and the two candidate shapes were "an option in the chatbot" and "a document you can keep". A
-- chat answer is read once and scrolled past; a process document is edited, disagreed with, corrected by
-- somebody who actually does the job, and read again next quarter. Only the second shape supports being
-- wrong and then fixed, which is the normal life of a written procedure.
--
-- WHAT IT IS MADE FROM. One or more recordings, by their client ids, and nothing else. The body is Markdown
-- written by a model from the transcript that api/_transcript.js derives - the same derivation the Record
-- panel shows, so a line in the document and a line in the panel cannot disagree about what happened.
--
-- EVERY CLAIM CITES ITS STEP. The generated body carries [step N] references, inline, because a procedure
-- whose steps cannot be traced back is a procedure nobody can check - and the one failure mode of writing
-- prose from data is filling a gap with something plausible. Inline rather than a separate table: the body
-- is edited by people afterwards, and a citation that lives elsewhere goes stale the moment a line moves.
create table if not exists user_doc (
  -- Server-chosen, unlike chat_thread.id: a document does not exist before it is written, and the thing
  -- that writes it is a tool call on the server.
  id          text        primary key,
  user_id     uuid        not null,

  title       text        not null default '',
  -- Markdown. Kept as one string rather than shredded into sections: the format is what a person edits and
  -- what an export renders, and re-assembling it from rows would give two definitions of one document.
  body        text        not null default '',

  -- The recordings this was written from, by user_flow.client_id. NOT a foreign key, for the reason
  -- run_queue.flow_id is not one either: a recording deleted after the document was written should leave
  -- the document readable and its citations unresolvable, not take the document with it.
  flow_ids    text[]      not null default '{}',

  -- Which model wrote the first draft, and at what reasoning effort. Stored because "who wrote this" is the
  -- first question anybody asks of a generated procedure, and because a document written by an older model
  -- reads differently from one written today.
  model       text,
  effort      text,

  -- Bumped on every save. The version rows below hold what each one said.
  revision    integer     not null default 1,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Soft delete, like gallery_skill.withdrawn_at: a document somebody has linked to should not become a
  -- broken link, and a delete made on one machine has to be able to propagate.
  deleted_at  timestamptz
);

-- "Mine, most recently touched first" is the one query the list makes.
create index if not exists user_doc_recent on user_doc (user_id, updated_at desc);

-- WHAT EACH VERSION SAID. A generated procedure is wrong somewhere - that is the normal case, not the
-- failure case - so the edit that corrects it must be reversible without trusting anybody's memory of what
-- was there before.
create table if not exists user_doc_version (
  doc_id      text        not null,
  revision    integer     not null,
  title       text        not null default '',
  body        text        not null default '',
  -- 'model' or 'person'. The distinction is the point: a reader needs to know whether the line they are
  -- following was written from a recording or typed by a colleague.
  written_by  text        not null default 'person',
  at          timestamptz not null default now(),
  primary key (doc_id, revision)
);
