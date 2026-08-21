-- Small facts about a person rather than about their work.
--
-- The first of them is whether the introduction has been seen, and it is here rather than in the browser
-- for one reason: localStorage is a fact about a BROWSER. The same person signing in on their phone, or
-- after clearing a cache, was shown a first-run tour they had already finished - and, worse, so was every
-- existing user the day the tour shipped, because no browser had the flag yet.
--
-- Key/value rather than a column per preference: these are UI facts with no relationships and no queries
-- beyond "what does this user have", and a migration per checkbox is a poor trade. Anything that grows
-- structure earns its own table.
--
-- The user id comes from Neon Auth, and as everywhere else here it is deliberately not a foreign key:
-- that schema is managed by Neon, and a hard constraint into someone else's migrations is a good way to
-- have a deploy fail at an awkward moment.
create table if not exists user_pref (
  user_id     uuid        not null,
  key         text        not null,
  value       text        not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, key)
);
