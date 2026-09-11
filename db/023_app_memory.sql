-- A memory of applications, per key, with provenance (MEMORY-PLAN.md §4.11).
--
-- ПРИМЕНЕНА 2026-09-11, по явному разрешению владельца в чате ("сделай миграцию сам") - тем же порядком,
-- что и 022 (которая тоже ждала до этого дня). `npm run migrate -- --list` подтвердил все 23 файла
-- `applied`. Код, который читает эту таблицу (`memoryForOpen`, `api/_memory.mjs`), всё ещё работает и без
-- живых строк в ней - карта записей остаётся пустой везде, кроме `api/memory.js`, до тех пор, пока флаг
-- `MEMORY_LIVE` не переключат отдельным решением (§5, строки 5-6 MEMORY-PLAN.md).
--
-- ПЕРЕНУМЕРОВАНА С 022 НА 023 (2026-09-11). §4.11 держал 022 под эту таблицу; roadmap-пункт 7 занял его
-- раньше `run_queue.machine`. Два файла с одним номером - тот, что применится вторым, молча не
-- применится вовсе: `migrate.mjs` идёт по именам по порядку и помнит, что применил, по имени.
--
-- ГРАНИЦА 4.2, В СХЕМЕ. `key` - факт об ОДНОМ приложении (`win32:Outlook`, `web:mail.google.com`, из
-- `parseKey`/`webKeyFor`, api/_memory.mjs); фактов о платформе здесь нет и не будет - они в коде. `builtin`
-- в CHECK ниже - как в 4.4's precedence table, но по факту ни одна строка сюда с ним не попадёт:
-- `writeMemory` отказывает provenance='builtin' на входе (api/_memory.mjs), а сами builtin-строки читаются
-- из `builtinEntries()`, не из базы. Значение оставлено в CHECK, чтобы ledger мог когда-нибудь читать все
-- четыре провенанса одним запросом с одним и тем же ограничением, а не удивляться, почему четвёртое слово
-- не проходит constraint, который сам и должен был его пускать.
--
-- ПОЧЕМУ id, А НЕ bigserial. Запись пишется через redaction (writeMemory) ДО того, как у неё есть строка -
-- id даётся на сервере в момент вставки, тем же способом, что у остальных text-id в проекте (см.
-- docs/product/15-data-model.md, "Id conventions"). derived не хранится вовсе построчно навсегда: она
-- пересчитывается на чтении (4.4 - "recomputable: yes"), так что для неё эта таблица - кеш, который можно
-- стереть и заполнить заново без потери факта; для taught и learned - единственная копия.
--
-- SOFT DELETE, А НЕ УДАЛЕНИЕ. Тот же довод, что у user_flow.deleted_at: правка на одной машине должна
-- долетать до другой синхронизацией, а не воскресать оттуда, где её ещё не тронули. Ledger читает живые
-- (deleted_at is null), а не отсутствие строки.
create table if not exists app_memory (
  id          text        primary key,
  user_id     uuid        not null,
  key         text        not null,
  provenance  text        not null check (provenance in ('derived', 'taught', 'learned', 'builtin')),
  version     integer,                              -- только derived: версия формулы (4.4)
  run_id      text,                                  -- только learned: какой прогон это предложил
  body        text        not null,
  state       text        not null default 'live' check (state in ('pending', 'live', 'rejected')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- Единственный настоящий запрос: «живые записи этого аккаунта под этим ключом» - и на чтении блока
-- хода (memoryForOpen), и на ledger. По одной строке на (user, key, provenance) не гарантируется нарочно:
-- несколько learned-фактов под одним ключом - обычное дело, и вытеснение (fitBlock) решает, что показать.
create index if not exists app_memory_owner_key on app_memory (user_id, key) where deleted_at is null;
