/* One recording, as a row on the account.
 *
 * Three callers now: the push on stop, the restore when a recording has been deleted from Skills - the same
 * row, since recordings and skills share a table - and the reconcile that sends up whatever the account has
 * never seen. They must build the identical payload or a restored or re-synced recording quietly stops
 * matching the one that was saved, so there is one of these rather than three literals that look alike. It
 * lives in its own file for exactly that reason: the third caller is not on the Record page.
 *
 * FOUR callers now, and the fourth is why this sits beside the API: /api/mcp builds this row when the agent
 * stops a recording with no browser open anywhere. A serverless function cannot import out of the web app's
 * source tree with any confidence about what the bundler traces, so the module moved and the app reaches it
 * through a shim. The reason for having one builder is unchanged - a restored or re-synced recording that
 * quietly stopped matching the saved one was a real bug.
 */
import { RECORDING_ROLE } from './_flow-role.mjs';
import { fmtMs, summarize } from './_macro.mjs';
export function flowFor(rec, health) {
  /* ПУСТУЮ ЗАПИСЬ НАВЕРХ НЕ ОТПРАВИТЬ, И ЭТО ОТКАЗ, А НЕ ПРОПУСК.
   *
   * Когда консоль не помещается в localStorage, события самых больших записей выкладываются из слота -
   * они на аккаунте, и это место их хранения, а не потеря (см. `eventsOnAccount` в web/src/lib/store.ts).
   * Но payload здесь собирается ИЗ `rec.events`, так что такая запись, отправленная наверх, записала бы
   * поверх хорошего payload пустой - то есть уничтожила бы единственную оставшуюся копию тем самым
   * действием, которое называется «сохранить».
   *
   * Отказ живёт ЗДЕСЬ, потому что здесь одно место, где строится строка, и четыре вызывающих: отправка на
   * остановке, «положить обратно», сверка и /api/mcp. Проверка у каждого из них - это четыре проверки, из
   * которых первая же забытая и есть та самая потеря.
   *
   * Бросается, а не возвращается null: вызывающие обрабатывают исключение и показывают человеку строку, а
   * молчаливый пропуск был бы «сохранено» про то, что не сохранено. */
  if (rec.eventsOnAccount && (!rec.events || rec.events.length === 0)) {
    throw new Error(
      `"${rec.name}" is held on your account rather than in this browser - there was no room for its events `
      + 'here. Sending it up from here would overwrite what the account holds with nothing, so it is '
      + 'refused. Open it to fetch it back first.',
    );
  }
  const s = summarize(rec.events);
  const where = rec.windows ?? [];
  return {
    id: rec.id,
    // `desktop`, which decides who can replay it: these are screen coordinates, not page elements.
    source: 'desktop',
    kind: 'recorded',
    name: rec.name.slice(0, 80),
    description: `${s.count} events · ${s.clicks} click${s.clicks === 1 ? '' : 's'} · ${fmtMs(s.durationMs)}`,
    origins: where.map((w) => w.title).filter(Boolean).slice(0, 12),
    created: rec.created,
    /* КОГДА ЭТА КОПИЯ В ПОСЛЕДНИЙ РАЗ СХОДИЛАСЬ С АККАУНТОМ.
     *
     * Сервер сравнивает это со своим updated_at и отказывается писать более старое поверх более нового -
     * иначе машина, не синхронизировавшаяся с тех пор, молча возвращала переименование и payload назад.
     *
     * `syncedAt` - честный ответ на «насколько эта копия свежая»: он ставится, когда аккаунт её принял.
     * Пусто у записи, которой аккаунт ещё не видел, и это правильно: ей нечего перезаписывать. */
    updated: rec.syncedAt ?? null,
    payload: {
      version: 1,
      kind: 'recorded',
      agent: 'desktop',
      /* What this row IS, so the Skills page can stop listing it. Recordings and skills share a table and
      * nothing used to say which a row was, so a recording appeared under Skills looking like a skill and
      * deleting that card deleted the recording - and the transcript with it. */
      role: RECORDING_ROLE,
      /* What the agent said about ITSELF, now, because later nothing can reconstruct it.
      *
      * "Nothing was typed" and "the keyboard was not being watched" produce an identical recording, and the
      * transcript was asserting the first without being able to tell - a 0.6.0 agent names every click it
      * lands on and hooks no keyboard at all, so the named clicks it was reasoning from proved nothing.
      * Read from /health at the moment of recording, which is the only moment the answer exists.
      *
      * On a RESTORE this is whatever the agent says now, which may differ from what recorded it. Better
      * than nothing and honest either way: the flags describe an agent, and the transcript only ever uses
      * them to decide whether "no typing" means none happened. */
      recorder: {
        version: health?.version ?? null,
        /* Null when no agent answered, never false: "the keyboard was not watched" and "nobody asked" are
        * different facts, and the transcript asserts the first out loud. Absent stays not-known. */
        canName: health ? health.canName === true : null,
        canKeys: health ? health.canKeys === true : null,
      },
      name: rec.name.slice(0, 80),
      events: rec.events,
      windows: rec.windows,
      created: rec.created,
      /* When it BEGAN. `created` above is the moment it stopped - that is when this row is built - and on a
       * long recording the two are an hour apart. The transcript can subtract the span it measured to reach
       * the start, and does when this is absent; carried here so it does not have to.
       *
       * Absent rather than invented: a recording made before this field existed has none, and an imported
       * .mmmacro has no honest answer at all. `?? null` and not `?? rec.created`, which would be the guess
       * this exists to avoid. */
      startedAt: rec.startedAt ?? null,
    },
  };
}
