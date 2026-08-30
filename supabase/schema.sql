-- =======================================================================
-- OneIsland — Supabase schema
-- -----------------------------------------------------------------------
-- Run this ONCE in the Supabase dashboard: Project > SQL Editor > New
-- query > paste this whole file > Run.
--
-- It creates the "residents" table, its Row Level Security policies,
-- 8 demo/seed residents so the app looks alive before anyone signs up,
-- and the "resource-photos" storage bucket with its own policies.
-- =======================================================================

-- 1. Table ---------------------------------------------------------------
create table if not exists public.residents (
  id           uuid primary key default gen_random_uuid(),
  -- One row per signed-up user. Null for the seed/demo rows below, which
  -- keeps them un-editable by anyone (see the update/delete policies).
  user_id      uuid unique references auth.users(id) on delete cascade,
  name         text not null,
  zone         text not null default 'harbor-point'
                 check (zone in ('harbor-point','marina-row','fishermans-wharf','old-town','highlands')),
  water        numeric not null default 24,
  food         numeric not null default 24,
  solar_power  numeric not null default 0,
  batteries    numeric not null default 0,
  shelter      text not null default 'moderate'
                 check (shelter in ('sturdy','moderate','weak')),
  is_critical  boolean not null default false,
  device_type  text,
  photo_url    text,
  created_at   timestamptz not null default now()
);

-- 2. Row Level Security ----------------------------------------------------
alter table public.residents enable row level security;

drop policy if exists "residents_read_all" on public.residents;
drop policy if exists "residents_insert_own" on public.residents;
drop policy if exists "residents_update_own" on public.residents;
drop policy if exists "residents_delete_own" on public.residents;

-- Anyone (including anonymous visitors) can read every resident — the
-- matching engine needs the full island picture to find surpluses.
create policy "residents_read_all"
  on public.residents for select
  using (true);

-- A signed-in user may only create a row for themselves.
create policy "residents_insert_own"
  on public.residents for insert
  with check (auth.uid() = user_id);

-- A signed-in user may only edit their own row.
create policy "residents_update_own"
  on public.residents for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- A signed-in user may only delete their own row.
create policy "residents_delete_own"
  on public.residents for delete
  using (auth.uid() = user_id);

-- 3. Seed data -------------------------------------------------------------
-- Guarded by name so this is safe to run more than once.
insert into public.residents (name, zone, water, food, solar_power, batteries, shelter, is_critical, device_type)
select v.name, v.zone, v.water, v.food, v.solar_power, v.batteries, v.shelter, v.is_critical, v.device_type
from (values
  ('Sione Kavana',      'harbor-point',     30::numeric, 50::numeric,  0::numeric,  0::numeric, 'sturdy',   true,  'Oxygen concentrator'),
  ('Tavita Household',  'harbor-point',     40,          60,           0,           0,          'moderate', false, null),
  ('Fale Family',       'harbor-point',     90,          40,          35,          15,          'sturdy',   false, null),
  ('Captain Ioane',     'marina-row',       20,          15,           0,          70,          'moderate', false, null),
  ('Litia Ma''afu',     'marina-row',       10,          45,           0,           0,          'weak',     false, null),
  ('Vika Faleolo',      'fishermans-wharf', 12,          10,          10,           5,          'weak',     true,  'Insulin refrigeration'),
  ('Kealoha Homestead', 'highlands',       150,          70,          60,          20,          'sturdy',   false, null),
  ('Old Town Bakery',   'old-town',         50,         120,           0,          40,          'sturdy',   false, null)
) as v(name, zone, water, food, solar_power, batteries, shelter, is_critical, device_type)
where not exists (select 1 from public.residents r where r.name = v.name);

-- 4. Storage bucket for resident photos -------------------------------------
insert into storage.buckets (id, name, public)
values ('resource-photos', 'resource-photos', true)
on conflict (id) do nothing;

drop policy if exists "resource_photos_read_all" on storage.objects;
drop policy if exists "resource_photos_insert_authenticated" on storage.objects;
drop policy if exists "resource_photos_update_own" on storage.objects;
drop policy if exists "resource_photos_delete_own" on storage.objects;

-- Public read (so a plain <img src="..."> works with no auth header).
create policy "resource_photos_read_all"
  on storage.objects for select
  using (bucket_id = 'resource-photos');

-- Any signed-in user can upload into the bucket.
create policy "resource_photos_insert_authenticated"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'resource-photos');

-- A signed-in user can only replace/delete files they themselves uploaded.
create policy "resource_photos_update_own"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'resource-photos' and owner = auth.uid());

create policy "resource_photos_delete_own"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'resource-photos' and owner = auth.uid());
