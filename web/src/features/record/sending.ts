/* Какие записи прямо сейчас едут на аккаунт.
 *
 * ЗАЧЕМ ЭТО ЕСТЬ, И ЭТО ДВЕ РАЗНЫЕ ПРИЧИНЫ, у которых один ответ.
 *
 * ПЕРВАЯ. Каждая остановка записи отправляла payload ДВАЖДЫ. `end()` кладёт новую запись в общий стор, и
 * это происходит за двадцать строк до того, как разрешится её собственный push; сигнатура эффекта у
 * Reconciler'а построена по `local.recordings`, так что запись его будит; у новорождённой записи нет
 * `syncedAt` и на аккаунте её ещё нет, значит reconcile относит её к `push` - «существует только здесь»; и
 * те же байты уезжают вторым запросом, пока первый ещё в полёте. Оба несут `updated: null`, так что ни один
 * не отвергается, и побеждает тот, кто пришёл позже.
 *
 * Измерено на живом аккаунте, по метаданным: КАЖДАЯ строка `kind='recorded'` переписана через 1.0-5.5
 * секунды после создания, и разрыв растёт с размером - 697 КБ через 2.75 с, 5850 КБ через 3.4 с. Для
 * четырёхчасовой записи это 11.7 МБ трафика вместо 5.85, в худший для этого момент.
 *
 * ВТОРАЯ. Пока эти секунды идут, строка уже в таблице и подпись под ней говорит «54157 events captured» -
 * то есть «готово». Человек жмёт View, панель спрашивает у аккаунта строку, которой там ещё нет, и получает
 * «no recording with that id on this account». Окно длиной в секунды, и целиком невидимое.
 *
 * Один реестр отвечает на оба вопроса: reconcile не трогает то, что уже в полёте, а экран показывает
 * «отправляется» вместо «готово» и «ещё не доехало» вместо «нет такой записи».
 *
 * ПОЧЕМУ НЕ ОТЛОЖИТЬ ЗАПИСЬ В СТОР ДО КОНЦА ЗАГРУЗКИ - самый очевидный способ и неверный: строка в таблице
 * это то, что показывает человеку только что сделанную им запись, и неудачная загрузка не должна вдобавок
 * означать пустую таблицу.
 */
import { useCallback, useSyncExternalStore } from 'react';

const inFlight = new Set<string>();
const listeners = new Set<() => void>();

/* Версия, а не сам Set: Set мутируется на месте, и useSyncExternalStore, сравнивающий снимок сам с собой,
 * не перерисует ничего никогда. Число меняется на каждое изменение и сравнивается по значению. */
let version = 0;

function announce() {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Взять на себя. Возвращает то, что нужно отдать обратно - см. release. */
export function claim(ids: string[]): string[] {
  const taken = ids.filter(Boolean);
  if (!taken.length) return taken;
  for (const id of taken) inFlight.add(id);
  announce();
  return taken;
}

/** Отдать. Зовётся из `finally`, потому что незакрытая заявка - это запись, которая больше никогда не
 *  уедет: reconcile её пропустит, а второго шанса взяться ей никто не даст. */
export function release(ids: string[]): void {
  if (!ids.length) return;
  let changed = false;
  for (const id of ids) changed = inFlight.delete(id) || changed;
  if (changed) announce();
}

export const isSending = (id: string): boolean => inFlight.has(id);

/** Сколько сейчас в полёте. Для экранов, которые говорят про всё сразу. */
export const sendingCount = (): number => inFlight.size;

/* ОДНА ЗАПИСЬ, А НЕ ВЕСЬ РЕЕСТР - и это не микрооптимизация.
 *
 * Панель транскрипта смотрит на ОДНУ запись, а таблица - на все. Подписка на весь реестр перерисовывала бы
 * панель на каждую чужую загрузку, и на длинной сессии с частями это не редкость. Снимок здесь - булево,
 * так что React сравнивает его по значению и будит компонент только тогда, когда изменилось то, о чём он
 * спрашивал. */
export function useIsSending(id: string | null | undefined): boolean {
  const snapshot = useCallback(() => (id ? inFlight.has(id) : false), [id]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Предикат для списков: перерисовка на любое изменение реестра, потому что список смотрит на все строки. */
export function useSending(): (id: string) => boolean {
  useSyncExternalStore(subscribe, () => version, () => version);
  return isSending;
}
