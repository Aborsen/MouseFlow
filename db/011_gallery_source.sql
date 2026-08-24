-- Which half a published skill came from.
--
-- The gallery has always recorded `kind` - recorded or created - and never which HALF made it: the browser
-- extension, which points at page elements, or the desktop agent, which points at screen coordinates. Those
-- are not interchangeable. A desktop skill replayed in a browser has nothing to aim at, and the extension
-- cannot run it at all.
--
-- It did not matter while the gallery was only ever read in the app, which lists everything and lets a
-- person choose. It matters the moment the EXTENSION browses it, because there the only sensible listing is
-- the one it can actually install and run - and offering the other kind is a button that does nothing,
-- which is the failure this codebase names in web/src/features/skills/SkillsView.tsx's own header.
--
-- Nullable, and null means UNKNOWN rather than either value: every row published before this column existed
-- has no answer, and inventing one from `origins` would be a guess wearing a fact's clothes. A reader
-- decides what to do with unknown; this table does not decide for it.
alter table gallery_skill add column if not exists source text
  check (source in ('extension', 'desktop'));
