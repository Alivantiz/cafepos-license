-- Обучаемое сопоставление названий товаров со словарём штрихкодов.
-- Проект: imag_monitoring (тот же Supabase, что mon_barcodes).
-- Запуск: Supabase → SQL Editor → вставить целиком → Run. Скрипт идемпотентен,
-- повторный запуск безопасен.
--
-- Схема работы (см. panel/README.md, раздел «Обучаемое сопоставление»):
--   строка накладной / ручной ввод
--     → mon_match_product(q): сперва точный алиас, иначе топ похожих (pg_trgm)
--     → человек или ИИ подтверждает выбор
--     → mon_learn_alias(raw_name, barcode): сопоставление запоминается,
--       в следующий раз та же строка матчится мгновенно и точно.

-- Триграммный нечёткий поиск (встроен в Supabase)
create extension if not exists pg_trgm;

-- Нормализация названия: нижний регистр, ё→е, только буквы/цифры,
-- схлопнутые пробелы. «Мол.,3.2% (1л)» и «мол 3 2 1л» становятся ближе.
create or replace function public.mon_norm_name(t text)
returns text
language sql immutable
as $$
  select trim(regexp_replace(replace(lower(coalesce(t, '')), 'ё', 'е'), '[^a-zа-я0-9]+', ' ', 'g'))
$$;

-- Выученные сопоставления «грязное название → штрихкод карточки»
create table if not exists public.mon_aliases (
  norm_name    text primary key,     -- нормализованное написание из накладной
  barcode      text not null,        -- на какую карточку mon_barcodes указывает
  source       text,                 -- 'invoice' | 'manual' | 'panel'
  confirmed_by text,                 -- venue_id кассы или 'panel-owner'
  created_at   timestamptz not null default now()
);
create index if not exists mon_aliases_barcode_idx on public.mon_aliases (barcode);

alter table public.mon_aliases enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'mon_aliases'
                   and policyname = 'aliases_read') then
    create policy aliases_read on public.mon_aliases
      for select to anon, authenticated using (true);
  end if;
end $$;
-- Запись в mon_aliases — только через mon_learn_alias (security definer),
-- прямых insert/update-политик для anon сознательно нет.

-- Индекс для нечёткого поиска по нормализованному названию карточек
create index if not exists mon_barcodes_name_trgm_idx
  on public.mon_barcodes using gin (public.mon_norm_name(name) gin_trgm_ops);

-- Подбор карточки по «грязному» названию.
-- Возвращает либо один точный алиас (score=1, match_kind='alias'),
-- либо топ похожих по триграммам (match_kind='fuzzy', score 0..1).
-- Вызов через PostgREST: POST /rest/v1/rpc/mon_match_product {"q":"мол 3.2 1л"}
create or replace function public.mon_match_product(q text, max_results int default 5)
returns table (
  barcode text, name text, category text, price numeric, unit text,
  match_kind text, score real
)
language plpgsql stable
as $$
declare
  nq text := public.mon_norm_name(q);
begin
  if nq = '' then
    return;
  end if;

  -- 1) выученный алиас — мгновенно и точно
  return query
    select b.barcode::text, b.name::text, b.category::text, b.price::numeric, b.unit::text,
           'alias'::text, 1.0::real
    from public.mon_aliases a
    join public.mon_barcodes b on b.barcode = a.barcode and b.status = 'approved'
    where a.norm_name = nq
    limit 1;
  if found then
    return;
  end if;

  -- 2) нечёткий поиск (порог похожести — стандартный 0.3 у pg_trgm)
  return query
    select t.barcode, t.name, t.category, t.price, t.unit, 'fuzzy'::text, t.score
    from (
      select distinct on (b.barcode)
        b.barcode::text as barcode, b.name::text as name, b.category::text as category,
        b.price::numeric as price, b.unit::text as unit,
        similarity(public.mon_norm_name(b.name), nq) as score
      from public.mon_barcodes b
      where b.status = 'approved'
        and public.mon_norm_name(b.name) % nq
      order by b.barcode, similarity(public.mon_norm_name(b.name), nq) desc
    ) t
    order by t.score desc
    limit greatest(1, least(coalesce(max_results, 5), 20));
end $$;

-- Обучение: запомнить подтверждённое сопоставление. Upsert по норм. названию —
-- повторное подтверждение перезаписывает старый вариант (данные уточняются).
-- security definer: пишет в mon_aliases мимо RLS, «сырых» прав на таблицу
-- у касс нет. Вызов: POST /rest/v1/rpc/mon_learn_alias
--   {"raw_name":"Мол. 3,2 1л", "p_barcode":"4870001234567",
--    "p_source":"invoice", "p_by":"venue-1"}
create or replace function public.mon_learn_alias(
  raw_name text, p_barcode text, p_source text default 'invoice', p_by text default null
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into mon_aliases (norm_name, barcode, source, confirmed_by)
  select mon_norm_name(raw_name), trim(p_barcode), coalesce(p_source, 'invoice'), p_by
  where mon_norm_name(raw_name) <> '' and coalesce(trim(p_barcode), '') <> ''
  on conflict (norm_name) do update
    set barcode = excluded.barcode,
        source = excluded.source,
        confirmed_by = excluded.confirmed_by,
        created_at = now();
$$;
