/* A desktop skill, from Skills or the gallery, into the console ready to play.
 *
 * Written straight into the console's store rather than passed through the router: the Record view reads
 * that store, so by the time the navigation lands the recording is already there. Adopting the same one
 * twice is a no-op rather than a second copy - the id is derived from the flow's, which is what makes that
 * check possible at all.
 */
import type { Flow } from '@/lib/api';
import { consoleState, type RecordedEvent, useConsole } from '@/lib/store';

let queued: Flow | null = null;

export function adoptRecording(flow: Flow) {
  queued = flow;
  // Applied by the hook below the moment a component that owns the store is mounted.
  apply();
}

let update: ReturnType<typeof useConsole>[1] | null = null;

/** Called by the Record view so adoption has somewhere to write. */
export function registerAdopter(fn: ReturnType<typeof useConsole>[1]) {
  update = fn;
  apply();
  return () => { update = null; };
}

function apply() {
  if (!queued || !update) return;
  const flow = queued;
  const events = flow.payload.events as RecordedEvent[] | undefined;
  if (!Array.isArray(events) || events.length === 0) {
    queued = null;
    return;
  }

  const id = `from_${flow.id}`;
  if (consoleState().recordings.some((r) => r.id === id)) {
    queued = null;
    return;
  }

  update((prev) => ({
    recordings: [
      ...prev.recordings,
      {
        id,
        name: flow.name || 'From a skill',
        created: new Date().toISOString(),
        events,
        windows: flow.payload.windows ?? [],
      },
    ],
  }));
  queued = null;
}
