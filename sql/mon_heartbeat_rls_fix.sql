-- Фикс 401/42501 на POST /rest/v1/mon_heartbeat: кассы шлют heartbeat каждые
-- 15 секунд, но RLS-политики на запись нет — две трети запросов проекта падали
-- (Success Rate ~37%, «new row violates row-level security policy»).
-- Запуск: Supabase (проект imag_monitoring) → SQL Editor → Run. Идемпотентен.
-- Если политики с такими именами уже созданы вручную — скрипт ничего не меняет.

do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'mon_heartbeat'
                   and policyname = 'heartbeat_insert') then
    create policy heartbeat_insert on public.mon_heartbeat
      for insert to anon, authenticated with check (true);
  end if;

  -- heartbeat идёт upsert-ом, поэтому нужна и update-политика
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'mon_heartbeat'
                   and policyname = 'heartbeat_update') then
    create policy heartbeat_update on public.mon_heartbeat
      for update to anon, authenticated using (true) with check (true);
  end if;
end $$;
