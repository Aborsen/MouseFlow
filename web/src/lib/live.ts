/* Что машина делает сама - один опрос на всё приложение.
 *
 * ЗАЧЕМ ОБЩИЙ. Ответ `/api/mcp?live=1` нужен двум местам одновременно: странице Activity (там он рисуется) и
 * сайдбару (там из него считается число у пункта меню - «идёт или ждёт»). Два опроса по пять секунд каждый
 * это вдвое больше запросов к маршруту с общим потолком на аккаунт, и две картинки, которые на секунду
 * расходятся. Один опрос, сколько бы слушателей ни было; нет слушателей - нет опроса.
 *
 * Пять секунд - как у ленты на Create и по той же причине: агент сам спрашивает работу каждые три, а у
 * маршрута один потолок в минуту на аккаунт, и две открытые вкладки не должны его исчерпать.
 */
import { useSyncExternalStore } from 'react';
import { type LiveJob, liveJobs } from './api';

const EVERY_MS = 5000;

let jobs: LiveJob[] = [];
let stamp = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

const look = async () => {
  try {
    jobs = (await liveJobs()).jobs;
    stamp = Date.now();
    for (const fn of listeners) fn();
  } catch (_) {
    /* Сеть не ответила - остаётся прошлый ответ. «Не смогли спросить» это не «ничего не идёт». */
  }
};

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  if (!timer) {
    void look();
    timer = setInterval(() => { void look(); }, EVERY_MS);
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer) { clearInterval(timer); timer = null; }
  };
};

/** Снимок для useSyncExternalStore: одна и та же ссылка, пока ответ не обновился. */
const snapshot = () => jobs;

/** Идущее и ждущее прямо сейчас, и всё, что кончилось за последние три минуты. */
export const useLive = (): LiveJob[] => useSyncExternalStore(subscribe, snapshot, snapshot);

/** Перечитать сейчас, не дожидаясь такта - после отмены, чтобы строка исчезла под рукой. */
export const refreshLive = () => look();

/** Когда последний раз спросили - чтобы страница могла сказать «обновлено N с назад», а не молчать. */
export const liveStamp = () => stamp;
