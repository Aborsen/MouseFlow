-- The shape of a recording, so the Record screen can draw it without the events.
--
-- WHY. /api/sync deliberately stopped sending recordings' payloads - 28 recordings on the live account was
-- 3213 KB on every load of the app - so a recording pulled from the account arrives with no events at all.
-- The Signal column is drawn from events, so it had nothing to draw, and an empty events array produced
-- sixteen bars at the floor: the picture of a quiet recording, over a four-hour session. The column that
-- exists to show the shape of a recording was asserting the opposite of the truth.
--
-- Sixteen integers per recording is the whole fix. It is the same arithmetic web/src/components/Signal.tsx
-- does - cumulative delay, the span split into equal buckets, the count of events in each - moved to where
-- the events actually are. About 60 bytes a row against several hundred kilobytes of payload.
--
-- WHY NOT IN api/sync.js DIRECTLY. Because that would unroll every event of every recording on every load
-- of the application, which is the exact cost flow_digest exists to remove. Derived once, with the rest.
alter table flow_digest add column if not exists shape jsonb;

comment on column flow_digest.shape is
  'Sixteen counts: the recording span split into equal buckets, each holding how many events fell in it. '
  'Null when the recording has no timed events. Downsampled by the reader when it wants fewer bars.';
