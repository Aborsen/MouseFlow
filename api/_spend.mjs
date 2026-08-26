/* The ceiling on what a person can make this deployment pay for.
 *
 * ONE DEFINITION, AND IT COUNTS ACROSS INSTANCES. Six routes each kept a `Map` in module scope, each with a
 * comment saying the route spends the deployment's own key, and each of those comments also admitted the
 * counter is per warm instance. That is not a ceiling: on a serverless runtime the number of instances is
 * decided by traffic, so the effective limit multiplied by however many were awake - rising exactly when it
 * mattered most. And two routes had no counter at all, one of them the expensive one (/api/mcp ?worker=step
 * drives up to 240 vision calls per run at 8000 tokens each).
 *
 * The precedent is already in this repo: api/team.js limits invitations by counting rows in `team_invite`.
 * The same shape, against a table that exists for it.
 *
 * WHAT IT IS NOT. Not a quota, not billing, not a record of what anybody did. `model_call` holds a user id,
 * a route name and a timestamp; it is swept as it is written, so it stays about as large as one window of
 * traffic. Nothing joins it to a person's work and nothing reads it except the count below.
 *
 * FAILING OPEN, deliberately. If the count itself fails - the table is missing because a deploy landed
 * before its migration, the database is briefly unreachable - the call is allowed. A limiter that turns a
 * database hiccup into "your account is rate limited" has converted a small outage into a wrong answer
 * about the person, and this is a ceiling, not a lock: the thing it guards against is a loop, and a loop
 * will still be caught by the next successful count seconds later.
 */

/** What each route may spend, and over how long. Named here so the numbers can be compared side by side. */
export const LIMITS = {
  /* The decision loop, on both driven paths. A turn takes roughly eight seconds, so fifteen a minute is
   * about twice the pace a real run can manage - fast enough never to be felt, slow enough that a runaway
   * stops costing money within a minute. */
  step: { max: 15, windowMs: 60_000 },
  /* The browser's own loop, which is the same work asked for from the page. */
  claude: { max: 30, windowMs: 60_000 },
  /* Conversations are the most expensive single call and the least automatable. */
  chat: { max: 12, windowMs: 300_000 },
  insights: { max: 30, windowMs: 60_000 },
  transcript: { max: 20, windowMs: 60_000 },
  compose: { max: 20, windowMs: 300_000 },
  params: { max: 20, windowMs: 300_000 },
  /* A file somebody downloads once per skill. */
  'skill-md': { max: 20, windowMs: 300_000 },
  plan: { max: 20, windowMs: 300_000 },
};

/* Долго ли держать строки. Больше самого длинного окна с запасом, и всё: таблица существует, чтобы
 * посчитать последние минуты, а не чтобы помнить. */
const KEEP_MS = 900_000;

/* Подметание - на том же пути, что и запись, и не каждый раз. Отдельного расписания у этого проекта нет, а
 * заводить его ради таблицы, которая и так мала, значило бы завести вторую вещь, которая может сломаться. */
let sweptAt = 0;
const SWEEP_EVERY_MS = 120_000;

/**
 * Спросить и записать: можно ли этому человеку ещё один вызов на этом маршруте.
 *
 * Считает ДО того, как записать себя, - иначе первый же вызов считался бы вторым. Записывает только
 * разрешённый: отказ ничего не стоил, и включать его в счёт значило бы наказывать за то, что уже отказано.
 *
 * @returns {Promise<{ok: true} | {ok: false, retryInMs: number, max: number}>}
 */
export async function overSpend(sql, userId, route) {
  const limit = LIMITS[route];
  if (!limit || !userId) return { ok: true };
  const since = new Date(Date.now() - limit.windowMs).toISOString();
  try {
    const [{ n }] = await sql`
      select count(*)::int as n from model_call
      where user_id = ${userId} and route = ${route} and at > ${since}
    `;
    if (n >= limit.max) {
      /* Когда освободится место: самая старая строка окна плюс окно. Ответ «попробуйте позже» без числа -
       * это приглашение попробовать сразу же. */
      const [oldest] = await sql`
        select at from model_call
        where user_id = ${userId} and route = ${route} and at > ${since}
        order by at limit 1
      `;
      const freeAt = oldest ? new Date(oldest.at).getTime() + limit.windowMs : Date.now() + limit.windowMs;
      return { ok: false, retryInMs: Math.max(1000, freeAt - Date.now()), max: limit.max };
    }
    await sql`insert into model_call (user_id, route) values (${userId}, ${route})`;

    const now = Date.now();
    if (now - sweptAt > SWEEP_EVERY_MS) {
      sweptAt = now;
      /* Не ждём: подметание никого не задерживает, и его неудача ничего не значит. */
      void sql`delete from model_call where at < ${new Date(now - KEEP_MS).toISOString()}`.catch(() => {});
    }
    return { ok: true };
  } catch (_) {
    /* См. заголовок: считать не смогли - пропускаем. Потолок против цикла, а цикл поймает следующий
     * успешный подсчёт через секунды. */
    return { ok: true };
  }
}

/** Одна фраза для отказа, чтобы восемь маршрутов не сочинили восемь. */
export const spentWhy = (verdict, what) =>
  `That is ${verdict.max} ${what} in a short window, which is the limit on this deployment's shared key. `
  + `Try again in about ${Math.max(1, Math.round(verdict.retryInMs / 1000))}s`
  + (what === 'runs' ? ', or add your own Anthropic key.' : '.');
