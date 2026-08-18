-- The shared skill gallery.
--
-- Neon Auth owns the `neon_auth` schema and keeps the signed-in user there (neon_auth."user").
-- This is the application's own table and only references that user by id; it deliberately does
-- not join to it in a foreign key, because the auth schema is managed by Neon and a hard
-- constraint into someone else's migrations is a good way to have a deploy fail at an awkward
-- moment. The author's name and picture are denormalised for the same reason: a listing should
-- render from one table.

create table if not exists gallery_skill (
  id            text primary key,
  -- Who published it. Not a foreign key; see above.
  author_id     uuid        not null,
  author_name   text        not null default '',
  author_image  text,

  name          text        not null,
  description   text        not null default '',
  -- 'recorded' replays events literally; 'created' re-runs a goal through the agent.
  kind          text        not null check (kind in ('recorded', 'created')),

  -- The skill exactly as the extension exports it. Kept whole rather than shredded into columns:
  -- the format is versioned and owned by extension/skills.js, and re-deriving it from columns on
  -- the way out would give two definitions of the same thing that could disagree.
  payload       jsonb       not null,

  -- Cheap to sort and filter on without opening the payload.
  origins       text[]      not null default '{}',
  installs      integer     not null default 0,
  published_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Soft delete: an unpublished skill someone already installed should not become a broken link.
  withdrawn_at  timestamptz
);

-- The gallery's only real query: newest first, excluding withdrawn.
create index if not exists gallery_skill_recent
  on gallery_skill (published_at desc)
  where withdrawn_at is null;

-- "my skills", for the page a signed-in author sees.
create index if not exists gallery_skill_author
  on gallery_skill (author_id, published_at desc);

-- Search, kept simple: name and description only. The payload is not searchable on purpose - a
-- goal can contain an address or a document title, and a gallery is public.
create index if not exists gallery_skill_search
  on gallery_skill using gin (
    to_tsvector('english', name || ' ' || description)
  );
