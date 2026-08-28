/* События записи - откуда бы они ни лежали.
 *
 * ЗАЧЕМ ЭТО ЕСТЬ. Когда консоль не помещается в localStorage, события самых больших записей, у которых есть
 * вторая копия на аккаунте, выкладываются из слота - см. `eventsOnAccount` в store.ts. До этого файла у них
 * не было ДОРОГИ НАЗАД: поле только ставилось и никогда не снималось, и ничто нигде события не возвращало.
 * При этом два места обещали, что вернёт: «opening one fetches it back» на экране записи и «Open it to
 * fetch it back first» в отказе сборщика payload. Обещание, которого код не выполняет, хуже отсутствующей
 * функции: по нему принимают решения.
 *
 * ПОЧЕМУ НЕ ЗАПИСЫВАТЬ ОБРАТНО В КОНСОЛЬ. Самый очевидный вид этой функции - «забрать и положить на место» -
 * воспроизводит ровно ту аварию, которую всё это чинит: положить 5850КБ обратно значит снова не поместиться,
 * снова запустить лестницу освобождения, снова всё выложить. Круг. Поэтому события забираются НА ОДИН ВЫЗОВ
 * и живут ровно столько, сколько нужно тому, кто их попросил.
 *
 * Кэш - в fetchPayload: второе нажатие Play подряд не ходит в сеть.
 */
import { fetchPayload } from '@/lib/api';
import type { RecordedEvent, Recording } from '@/lib/store';

/** Есть ли у этой записи события прямо здесь, без сети. */
export const eventsAreHere = (rec: Pick<Recording, 'events' | 'eventsOnAccount'>): boolean =>
  !rec.eventsOnAccount || rec.events.length > 0;

/**
 * События записи. Лежат здесь - отдаются сразу; выложены на аккаунт - забираются оттуда.
 *
 * Бросает, если забрать не удалось: вызывающий показывает это человеку. Молча вернуть пустой массив значило
 * бы проиграть пустой повтор и отчитаться об успехе - то есть соврать тем же способом, которым здесь уже
 * один раз соврали.
 */
export async function eventsFor(rec: Recording): Promise<RecordedEvent[]> {
  if (rec.events.length > 0 || !rec.eventsOnAccount) return rec.events;

  const payload = await fetchPayload(rec.id).catch(() => {
    throw new Error(
      `"${rec.name}" is kept on your account because there was no room in this browser, and it could not be `
      + 'fetched back just now. Check the connection and try again.',
    );
  });
  const events = (payload as { events?: RecordedEvent[] } | null)?.events;
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error(
      `"${rec.name}" is kept on your account, and the account returned nothing for it. Nothing has been `
      + 'played or written.',
    );
  }
  return events;
}
