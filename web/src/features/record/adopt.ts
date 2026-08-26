/* A desktop skill, from Skills or the gallery, into the console ready to play.
 *
 * Written straight into the console's store rather than passed through the router: the Record view reads
 * that store, so by the time the navigation lands the recording is already there. Adopting the same one
 * twice is a no-op rather than a second copy - the id is derived from the flow's, which is what makes that
 * check possible at all.
 */
import { type Flow, payloadOf } from '@/lib/api';
import { consoleState, type RecordedEvent, useConsole } from '@/lib/store';

/* Флоу ВМЕСТЕ с его payload. Список приложения перестал везти события записей - он весил мегабайты на
 * каждую загрузку, - поэтому здесь они догружаются, и дальше по файлу payload уже есть наверняка. */
type Adopted = { flow: Flow; payload: NonNullable<Flow['payload']> };

let queued: Adopted | null = null;

/**
 * Взять флоу в консоль. Асинхронна с тех пор, как события догружаются: галерея отдаёт payload сразу, а
 * запись со своего аккаунта - по просьбе.
 *
 * Отказ проглатывается, потому что вызывающий - обработчик клика: сеть моргнула, ничего не взялось, и
 * человек нажмёт ещё раз. Молча положить ПУСТУЮ запись было бы хуже - она заняла бы id и следующая
 * попытка сочла бы, что всё уже здесь.
 */
export async function adoptRecording(flow: Flow) {
  let payload: Flow['payload'];
  try {
    payload = await payloadOf(flow);
  } catch (_) {
    return;
  }
  if (!payload) return;
  queued = { flow, payload };
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
  const { flow, payload } = queued;
  const events = payload.events as RecordedEvent[] | undefined;
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
        windows: payload.windows ?? [],
      },
    ],
  }));
  queued = null;
}
