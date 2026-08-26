/* Runs the reconciliation, once per change, wherever you happen to be in the app.
 *
 * Mounted in the shell rather than on the Record page, because the thing being fixed is what happens when you
 * SIGN IN on another machine - and you may well land on Create or the Dashboard. Waiting for somebody to
 * visit the right page before their recordings appear is the same bug in a longer form.
 *
 * It renders nothing. The rules are in reconcile.ts and are pure; this is the part that has to touch two
 * stores and the network, and is therefore the part worth keeping small.
 */
import { useEffect, useRef } from 'react';
import { fetchPayload, push } from '@/lib/api';
import { type Recording, storeHeldFor, useAgent, useConsole } from '@/lib/store';
import { useAccount } from '@/shell/AccountProvider';
import { flowFor } from './flow-for';
import { reconcile } from './reconcile';

export const Reconciler = () => {
  const { account, flows, loaded, reload } = useAccount();
  const [local, update] = useConsole();
  const { health } = useAgent();

  /* One at a time, and not again for the same pair of sides.
   *
   * Reconciling changes both sides, which changes what this effect depends on - so without a signature it
   * would run on its own output. An empty plan writes nothing, which is what makes the loop settle: the
   * second pass finds nothing to do and stops. */
  const busy = useRef(false);
  const done = useRef('');

  useEffect(() => {
    const signature = [
      flows.map((f) => f.id).sort().join(','),
      local.recordings.map((r) => `${r.id}${r.syncedAt ? '+' : '-'}`).sort().join(','),
    ].join('|');
    if (busy.current || done.current === signature) return;

    /* Until the account has answered, there is nothing to compare against - and comparing anyway is not a
     * harmless early start, it is data loss. An unanswered account looks exactly like an empty one, and an
     * empty one means "every recording you have was deleted somewhere else". Found in the browser, where the
     * rows came back a moment later and hid it. */
    if (!loaded) return;
    /* И ЧЬИ ЭТО ЗАПИСИ - тоже. `loaded` отвечает «аккаунт ответил», а этот вопрос другой: то, что лежит в
     * этом браузере, могло быть записано предыдущим человеком. Reconciler считает местную запись без штампа
     * работой того, кто сейчас вошёл, и отправляет её наверх - значит без этой проверки записи A уезжали на
     * аккаунт B. Достаточно было, чтобы одна не проштамповалась, а A вышел и B вошёл на том же ноутбуке.
     *
     * Сравнение с id, а не «не пусто»: claimStore выставляет его только тому, чей слот сейчас в памяти. */
    if (!account || storeHeldFor() !== account.id) return;
    if (!flows.length && !local.recordings.length) return;

    const plan = reconcile({ flows, local: local.recordings });
    const nothing = !plan.pull.length && !plan.push.length && !plan.forget.length && !plan.stamp.length;
    done.current = signature;
    if (nothing) return;

    busy.current = true;
    (async () => {
      let sent: string[] = [];
      /* Записи, которые аккаунт назвал удалёнными. Отдельно от `sent`: их не приняли, но и пробовать
       * снова незачем - см. ниже. */
      const buried = new Set<string>();
      try {
        if (plan.push.length) {
          /* Up first. If this fails, nothing else in the plan is wrong - but a recording that exists only
           * here is the one thing that can actually be lost, so it goes before any local change. */
          const saved = await push({ flows: plan.push.map((rec) => flowFor(rec, health)) });
          if (!saved.problems.length) sent = plan.push.map((rec) => rec.id);
          /* УДАЛЁННОЕ НА АККАУНТЕ - ЗАБЫВАЕТСЯ И ЗДЕСЬ.
           *
           * Сервер перестал воскрешать удалённые записи: расширение шлёт свою библиотеку целиком при
           * каждой синхронизации, и раньше удаление, сделанное в приложении, возвращалось следующим
           * нажатием Sync. Но отказ сам по себе оставляет эту запись здесь непроштампованной - то есть
           * следующий проход отправит её снова, и так навсегда.
           *
           * Имя в отказе - единственное, что связывает строку с записью: `problems` это строки для
           * человека, а не коды. Сопоставление по имени было бы догадкой, если бы имён могло совпасть
           * два; поэтому сверяется и имя, и то, что запись вообще отправлялась в этой пачке. */
          for (const line of saved.problems) {
            if (!/was deleted on this account/.test(line)) continue;
            for (const rec of plan.push) {
              if (line.includes(`"${rec.name}"`) || line.includes(`"${rec.id}"`)) buried.add(rec.id);
            }
          }
        }
      } catch (_) {
        /* Offline. The recordings stay here, unstamped, and the next reconcile tries again - which is the
         * whole reason the stamp is a fact about the account rather than a flag we set hopefully. */
      }

      const stamped = new Set([...plan.stamp, ...sent]);
      /* Забытое включает похороненное аккаунтом: удаление, сделанное на другой машине, доходит сюда именно
       * так - не тем, что запись пропала из списка, а тем, что аккаунт отказался её принимать. */
      const forget = new Set([...plan.forget, ...buried]);
      const now = new Date().toISOString();

      /* ВНИЗ - ПО ОДНОЙ, И ТОЛЬКО ТЕ, КОГО ЗАБИРАЕМ.
       *
       * Список перестал везти события: 28 записей на живом аккаунте это 3213КБ на каждую загрузку
       * приложения, а нужны они ровно тем, кого забирают в этот браузер - обычно никому, потому что
       * во второй раз всё уже здесь.
       *
       * Не Promise.all: это мегабайты, и десяток параллельных запросов на старте страницы - это та же
       * трата, от которой уходим, только сжатая во времени. Последовательно, и каждая неудача роняет
       * ОДНУ запись, а не весь план: следующий проход попробует её снова, потому что она так и осталась
       * не здесь. */
      const pulled: Recording[] = [];
      for (const want of plan.pull) {
        try {
          const payload = await fetchPayload(want.id) as {
            events?: Recording['events']; windows?: Recording['windows'];
          } | undefined;
          const events = payload?.events ?? [];
          /* Пустая запись не кладётся: она бы вытеснила ту, что лежит на аккаунте целой, и следующий
           * проход посчитал бы, что здесь уже всё есть. */
          if (!events.length) continue;
          pulled.push({
            id: want.id,
            name: want.name,
            created: want.created,
            events,
            windows: payload?.windows ?? [],
            /* Stamped on arrival: it came FROM the account, so the account has acknowledged it by
             * definition. Without this the next reconcile would try to push back what it just pulled. */
            syncedAt: now,
          });
        } catch (_) {
          /* Сеть моргнула. Запись осталась на аккаунте, и следующий проход придёт за ней снова. */
        }
      }

      if (pulled.length || stamped.size || forget.size) {
        update((prev) => ({
          recordings: [
            ...prev.recordings
              .filter((rec) => !forget.has(rec.id))
              .map((rec) => (stamped.has(rec.id) ? { ...rec, syncedAt: rec.syncedAt ?? now } : rec)),
            /* Appended, and the ids are the account's own, so a second pass finds them already here rather
             * than pulling a duplicate under a new name. */
            ...pulled.filter((rec) => !prev.recordings.some((had) => had.id === rec.id)),
          ],
          /* Said, not silent. Recordings appearing is welcome; recordings DISAPPEARING because another
           * machine deleted them is the kind of thing somebody needs to be told once. */
          lastSync: {
            at: now,
            /* Сколько ДОЕХАЛО, а не сколько собирались забрать: план - это намерение, а человеку
             * сообщают о состоявшемся. */
            pulled: pulled.length,
            pushed: sent.length,
            forgotten: plan.forget.length,
            left: plan.left.length,
          },
        }));
      }

      if (sent.length) await reload();
      busy.current = false;
    })();
  }, [account, flows, loaded, local.recordings, health, reload, update]);

  return null;
};
