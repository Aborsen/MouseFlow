/* Дверь в очередь: положить одну работу и сказать честно, если положить её некуда.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ, если очередь - это одна вставка в run_queue. Потому что вставка - меньшая часть
 * дела. Перед ней стоят две проверки, и у обеих есть СЛОВА, которые человек читает вместо результата:
 *
 *   - на аккаунте никогда не было машины, берущей работу - значит запускать не на чем, и в ответе должно
 *     стоять, что именно нажать, чтобы стало;
 *   - машина занята другой работой - одна мышь, и вторая работа не встаёт в очередь за первой молча.
 *
 * Эти два ответа уже существовали в api/mcp.js (queueAndWait) и понадобились странице тестов: кейс
 * запускается кнопкой «Run now», и она обязана отвечать теми же словами. Две копии одного отказа - это
 * инструкция, которая в одном месте останется верной, а в другом устареет; ровно это здесь уже случилось
 * однажды, когда в отказе называли воркера и команду, которых больше нет.
 *
 * ЧТО ЗДЕСЬ НЕ ПРОИСХОДИТ: ожидания. Тул MCP ждёт машину до 25 секунд, потому что ему надо ответить
 * результатом; страница не ждёт вовсе - она смотрит на Activity. Ожидание осталось у того, кому оно нужно.
 */

/* Said in three different failures, so it is written once: an instruction that drifts between messages is
 * an instruction somebody follows to two different places. */
export const WHERE = 'open MouseFlow, click your avatar at the bottom of the sidebar, then Connections, then '
  + '"Let Claude drive this computer"';

export const jobId = () => `q_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Whether a machine has asked for work lately, and when. */
export async function workerSeen(sql, userId) {
  try {
    const rows = await sql`
      select value from user_pref where user_id = ${userId} and key = 'worker.seen'
    `;
    if (!rows.length) return null;
    const at = new Date(rows[0].value);
    return Number.isFinite(at.getTime()) ? at : null;
  } catch (_) {
    /* No table on this deployment yet. Absent is not false: it means nothing is known, and the caller is
     * told that rather than told there is no worker. */
    return undefined;
  }
}

/**
 * Положить одну работу в очередь, если её есть куда положить.
 *
 * @returns {Promise<{ id: string, unpinned?: string, why?: undefined }
 *   | { id?: undefined, why: string, kind: 'no-machine'|'busy' }>}
 *   `why` - готовый ответ человеку, а не код ошибки: у обоих отказов ровно один способ быть полезным.
 *   `unpinned` - работа поставлена, но привязать её к машине НЕ УДАЛОСЬ; вызывающий обязан сказать это
 *   вслух, см. ниже.
 */
export async function queueOne(
  sql, userId, { flowId, toolName, args, scheduleId = null, machine = null },
) {
  const seen = await workerSeen(sql, userId);
  if (seen === null) {
    return {
      kind: 'no-machine',
      why: 'This account has no computer listening, so there is nothing to run this on. To let one: '
        + WHERE + ". It takes one click - nothing to type, nothing to copy - and the agent's own menu bar is "
        + 'where you switch it off again. Nothing was queued.',
    };
  }

  const already = await sql`
    select id, tool_name from run_queue where user_id = ${userId} and state in ('queued', 'claimed') limit 1
  `;
  if (already.length) {
    return {
      kind: 'busy',
      why: `MouseFlow is already busy on that machine (${already[0].tool_name || already[0].id}). One `
        + 'thing at a time - there is one mouse. Wait for it, or call mouseflow_stop.',
    };
  }

  const id = jobId();
  await sql`
    insert into run_queue (id, user_id, flow_id, tool_name, args, schedule_id)
    values (${id}, ${userId}, ${flowId}, ${toolName}, ${JSON.stringify(args || {})}, ${scheduleId})
  `;

  /* ПРИВЯЗКА К МАШИНЕ - ВТОРЫМ ОПЕРАТОРОМ, И ЭТО ПРО НЕПРИМЕНЁННУЮ МИГРАЦИЮ.
   *
   * 022 (run_queue.machine) написана и НЕ применена - применяется только по явному разрешению владельца.
   * Назвать колонку во вставке выше значило бы, что до применения падает вся постановка в очередь, то
   * есть ломается всё, а не «не работает привязка». Отдельный UPDATE падает один и ничего за собой не
   * уносит: работа уже стоит.
   *
   * НО НЕ МОЛЧА. Кейс, привязанный к QA-VM и запущенный где угодно, - это ровно ложное зелёное: человек
   * думает, что проверял на той машине, а проверяли на этой. Поэтому неудача привязки ВОЗВРАЩАЕТСЯ, и
   * вызывающий обязан сказать её словами. Тихий catch тут был бы худшим из возможных решений. */
  if (!machine) return { id };
  try {
    await sql`update run_queue set machine = ${machine} where id = ${id} and user_id = ${userId}`;
    return { id };
  } catch (_) {
    return { id, unpinned: machine };
  }
}
