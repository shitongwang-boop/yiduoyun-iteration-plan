create table if not exists public.iteration_plans (
  id text primary key,
  items jsonb not null default '[]'::jsonb,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

alter table public.iteration_plans enable row level security;

drop policy if exists "iteration plans are publicly readable" on public.iteration_plans;
create policy "iteration plans are publicly readable"
  on public.iteration_plans
  for select
  to anon, authenticated
  using (true);

revoke insert, update, delete on public.iteration_plans from anon, authenticated;
grant select on public.iteration_plans to anon, authenticated;

create or replace function public.save_iteration_plan(
  p_plan_id text,
  p_items jsonb,
  p_expected_revision bigint
)
returns table (
  id text,
  items jsonb,
  revision bigint,
  updated_at timestamptz,
  updated_by uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  saved public.iteration_plans%rowtype;
  item_count integer;
  unique_item_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_plan_id <> 'main' then
    raise exception 'Unknown plan id' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'Plan items must be a JSON array' using errcode = '22023';
  end if;

  item_count := jsonb_array_length(p_items);
  if item_count = 0 or item_count > 200 then
    raise exception 'Plan item count is outside the allowed range' using errcode = '22023';
  end if;

  select count(distinct entry->>'id')
    into unique_item_count
    from jsonb_array_elements(p_items) as entry;
  if unique_item_count <> item_count or exists (
    select 1
    from jsonb_array_elements(p_items) as entry
    where jsonb_typeof(entry) <> 'object'
      or coalesce(entry->>'id', '') = ''
      or coalesce(entry->>'start', '') !~ '^2026-[0-9]{2}-[0-9]{2}$'
      or coalesce(entry->>'end', '') !~ '^2026-[0-9]{2}-[0-9]{2}$'
      or (entry->>'start')::date < date '2026-08-07'
      or (entry->>'end')::date > date '2026-09-30'
      or (entry->>'start')::date > (entry->>'end')::date
  ) then
    raise exception 'Plan items contain invalid ids or date ranges' using errcode = '22023';
  end if;

  if p_expected_revision = 0 then
    insert into public.iteration_plans as plan (id, items, revision, updated_at, updated_by)
    values (p_plan_id, p_items, 1, now(), auth.uid())
    on conflict (id) do nothing
    returning plan.* into saved;
  else
    update public.iteration_plans as plan
       set items = p_items,
           revision = plan.revision + 1,
           updated_at = now(),
           updated_by = auth.uid()
     where plan.id = p_plan_id
       and plan.revision = p_expected_revision
    returning plan.* into saved;
  end if;

  if saved.id is not null then
    return query select saved.id, saved.items, saved.revision, saved.updated_at, saved.updated_by;
  end if;
end;
$$;

revoke all on function public.save_iteration_plan(text, jsonb, bigint) from public, anon;
grant execute on function public.save_iteration_plan(text, jsonb, bigint) to authenticated;

insert into public.iteration_plans as plan (id, items, revision)
values (
  'main',
  '[{"id":"fee-order","start":"2026-08-10","end":"2026-08-20"},{"id":"payment-flow","start":"2026-08-21","end":"2026-09-17"},{"id":"auto-payment","start":"2026-08-10","end":"2026-09-30"},{"id":"credit-sales","start":"2026-09-18","end":"2026-09-25"},{"id":"order-tags","start":"2026-08-10","end":"2026-08-21"},{"id":"hr-report","start":"2026-08-17","end":"2026-09-08"},{"id":"other-report","start":"2026-09-12","end":"2026-09-20"},{"id":"middle-office-report","start":"2026-09-12","end":"2026-09-20"},{"id":"logistics-report","start":"2026-09-12","end":"2026-09-20"},{"id":"finance-report","start":"2026-09-12","end":"2026-09-20"},{"id":"supply-report","start":"2026-09-12","end":"2026-09-20"},{"id":"spot-report","start":"2026-09-12","end":"2026-09-20"},{"id":"risk-report","start":"2026-09-12","end":"2026-09-20"},{"id":"customer-order","start":"2026-08-31","end":"2026-09-10"},{"id":"sourcing-order","start":"2026-08-31","end":"2026-09-10"},{"id":"order-editing","start":"2026-08-10","end":"2026-08-28"},{"id":"project-order","start":"2026-09-26","end":"2026-09-30"},{"id":"consignment","start":"2026-08-17","end":"2026-09-10"},{"id":"sensitive-procurement","start":"2026-08-24","end":"2026-09-10"},{"id":"customer-pickup","start":"2026-08-07","end":"2026-08-20"},{"id":"ownership","start":"2026-09-26","end":"2026-09-30"},{"id":"integrated-logistics","start":"2026-09-10","end":"2026-09-18"},{"id":"integrated-processing","start":"2026-09-12","end":"2026-09-20"},{"id":"overdue-pickup","start":"2026-08-15","end":"2026-08-23"},{"id":"contract-management","start":"2026-08-30","end":"2026-09-11"},{"id":"contract-template","start":"2026-08-30","end":"2026-09-11"},{"id":"after-sales","start":"2026-08-07","end":"2026-08-28"},{"id":"merchant-department","start":"2026-08-13","end":"2026-08-28"},{"id":"invoice-flow","start":"2026-08-17","end":"2026-09-11"},{"id":"b2-settlement","start":"2026-08-18","end":"2026-08-27"},{"id":"b1-settlement","start":"2026-08-07","end":"2026-08-26"},{"id":"system-performance","start":"2026-09-26","end":"2026-09-30"},{"id":"order-check","start":"2026-09-26","end":"2026-09-30"},{"id":"sales-order-log","start":"2026-09-26","end":"2026-09-30"},{"id":"sales-order-list","start":"2026-09-26","end":"2026-09-30"},{"id":"purchase-order-query","start":"2026-09-26","end":"2026-09-30"},{"id":"purchase-order-detail","start":"2026-09-26","end":"2026-09-30"},{"id":"purchase-order-list","start":"2026-09-26","end":"2026-09-30"},{"id":"warehouse-data","start":"2026-09-26","end":"2026-09-30"},{"id":"customer-data","start":"2026-09-26","end":"2026-09-30"},{"id":"product-data","start":"2026-09-26","end":"2026-09-30"},{"id":"employee-data","start":"2026-09-26","end":"2026-09-30"},{"id":"supplier-data","start":"2026-09-26","end":"2026-09-30"}]'::jsonb,
  1
)
on conflict (id) do update
set items = excluded.items,
    updated_at = now()
where jsonb_array_length(plan.items) = 0;

do $$
begin
  alter publication supabase_realtime add table public.iteration_plans;
exception
  when duplicate_object then null;
end;
$$;
