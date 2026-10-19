-- Счета на продление подписки iMag (оплата через Aitole → Kaspi).
-- Проект: тот же Supabase, что licenses/license_renewals.
-- Запуск: Supabase → SQL Editor → вставить целиком → Run. Идемпотентно.
--
-- Зачем таблица. Раньше продление в панели происходило СРАЗУ, а текст с
-- реквизитами уходил клиенту после — факт поступления денег нигде не
-- сверялся, сумма записывалась со слов. Теперь «выставлен счёт» и
-- «подписка продлена» — два разных факта, и второй наступает только после
-- подтверждения оплаты.
--
-- Жизнь строки: pending → processing → paid.
--   pending    — счёт выставлен, ждём оплату;
--   processing — оплата подтверждена, продление выполняется;
--   paid       — подписка продлена.
-- Строка, застрявшая в processing, означает «деньги пришли, продление
-- не выполнилось» — это надо разбирать руками, и именно поэтому статус
-- не схлопнут в булево «оплачено».

create table if not exists license_payments (
  id           bigserial primary key,
  license_id   text        not null,
  operation_id text        not null unique,   -- id операции в Aitole
  days         integer     not null,
  amount       integer     not null,          -- тенге, без копеек
  status       text        not null default 'pending'
               check (status in ('pending', 'processing', 'paid', 'cancelled')),
  created_at   timestamptz not null default now(),
  paid_at      timestamptz
);

-- Выборка «что ещё не оплачено» — самый частый запрос панели.
create index if not exists idx_license_payments_pending
  on license_payments (status, created_at desc);
create index if not exists idx_license_payments_license
  on license_payments (license_id, created_at desc);

-- Связь продления с платежом: раньше по записи в истории нельзя было
-- сказать, продлили вручную или по подтверждённой оплате.
alter table license_renewals add column if not exists payment_id text;

-- Таблицы панели читает только воркер по service-role ключу; anon-доступа
-- нет, поэтому RLS включаем без политик (как у остальных таблиц панели).
alter table license_payments enable row level security;
