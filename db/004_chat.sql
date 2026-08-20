-- Conversations with the assistant, kept.
--
-- Until now a thread lived in React state and a reload was the end of it, which makes the assistant a
-- calculator rather than something you can come back to: the question you asked last Tuesday, and what it
-- answered, is exactly the thing worth having.
--
-- DELETED MEANS DELETED HERE, unlike user_flow. A flow is tombstoned because two machines sync it and a
-- delete has to be able to propagate rather than have the flow reappear from the next machine that syncs. A
-- conversation has no such contract - it is written by one client, read by one person, and nothing anywhere
-- reconciles it - so `delete` removes the row and the messages go with it on cascade. Asking for a
-- conversation to be forgotten and keeping it with a flag set would be the wrong answer to a reasonable
-- request.
--
-- The user id comes from Neon Auth (neon_auth."user"), and as everywhere else in this schema it is not a
-- foreign key into it: that schema is managed by Neon, and a hard constraint into someone else's migrations
-- is a good way to have a deploy fail at an awkward moment.

create table if not exists chat_thread (
  -- Chosen by the client, like user_flow.client_id: a conversation exists in the page before it has ever
  -- been saved, and the first save must not have to round-trip for an id to attach the messages to.
  id          text        primary key,
  user_id     uuid        not null,
  -- The first question, trimmed. A conversation names itself; nothing asks anybody to title one.
  title       text        not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- The list is always "mine, most recent first", which is the one query the history panel makes.
create index if not exists chat_thread_recent on chat_thread (user_id, updated_at desc);

create table if not exists chat_message (
  thread_id   text        not null references chat_thread (id) on delete cascade,
  -- Position in the conversation, owned by the client for the same reason the thread id is. Part of the key,
  -- so re-saving a turn overwrites it rather than appending a second copy of it: the page saves after every
  -- reply, and a retried save must not double the thread.
  n           int         not null,
  user_id     uuid        not null,
  role        text        not null check (role in ('user', 'assistant')),
  text        text        not null default '',
  -- What the reply was grounded on: the tools that ran and the runs it cited, as the page renders them.
  -- Kept so a reopened conversation shows the same "based on" panel it showed when it was new - an answer
  -- without its evidence is a claim, and this app's whole position on the assistant is that it does not make
  -- claims it cannot show the source for.
  meta        jsonb,
  created_at  timestamptz not null default now(),
  primary key (thread_id, n)
);

create index if not exists chat_message_thread on chat_message (thread_id, n);
