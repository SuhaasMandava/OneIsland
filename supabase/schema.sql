-- =======================================================================
-- OneIsland — Supabase schema (Vanuatu edition)
-- -----------------------------------------------------------------------
-- If you already ran an earlier version of this file, running this one
-- again UPGRADES your existing table in place: it adds the columns the
-- guided onboarding flow needs (zones, household_size, ages), drops the
-- old single "zone" column and its fictional-island values, and replaces
-- the seed data with real Vanuatu households. Any real sign-up rows are
-- preserved (matched by user_id, never deleted) but will have an empty
-- `zones` array until that person redoes onboarding once — the app
-- already treats "no zones selected yet" as "needs onboarding".
--
-- Run this ONCE in the Supabase dashboard: Project > SQL Editor > New
-- query > paste this whole file > Run.
-- =======================================================================

-- 1. Table (fresh install) -------------------------------------------------
create table if not exists public.residents (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid unique references auth.users(id) on delete cascade,
  name            text not null,
  zones           text[] not null default '{}'::text[],
  household_size  int not null default 1,
  ages            int[] not null default '{}'::int[],
  water           numeric not null default 24,  -- hours of water remaining
  food            numeric not null default 24,  -- hours of food remaining
  solar_power     numeric not null default 0,    -- solar system capacity, kWh
  batteries       numeric not null default 0,    -- battery storage capacity, kWh
  shelter         text not null default 'moderate'
                    check (shelter in ('sturdy','moderate','weak')),
  is_critical     boolean not null default false,
  device_type     text,
  photo_url       text,
  created_at      timestamptz not null default now()
);

-- 1b. Migration (upgrading an existing install from the previous schema) ---
alter table public.residents add column if not exists zones text[] not null default '{}'::text[];
alter table public.residents add column if not exists household_size int not null default 1;
alter table public.residents add column if not exists ages int[] not null default '{}'::int[];
alter table public.residents drop column if exists zone;

alter table public.residents drop constraint if exists residents_zones_check;
alter table public.residents add constraint residents_zones_check
  check (zones <@ array['efate','espiritu-santo','tanna','malekula','pentecost']::text[]);

-- 2. Row Level Security ----------------------------------------------------
alter table public.residents enable row level security;

drop policy if exists "residents_read_all" on public.residents;
drop policy if exists "residents_insert_own" on public.residents;
drop policy if exists "residents_update_own" on public.residents;
drop policy if exists "residents_delete_own" on public.residents;

-- Anyone (including anonymous visitors) can read every resident — the
-- matching engine needs the full picture across islands to find surpluses.
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

-- 3. Seed data (Vanuatu households) -----------------------------------------
-- Clears the old fictional-island demo rows (all seed rows have a null
-- user_id, so this never touches a real sign-up) and reseeds with real
-- Vanuatu locations so the Zone Network map looks populated everywhere.
delete from public.residents where user_id is null;

insert into public.residents
  (name, zones, household_size, ages, water, food, solar_power, batteries, shelter, is_critical, device_type)
select v.name, v.zones, v.household_size, v.ages, v.water, v.food, v.solar_power, v.batteries, v.shelter, v.is_critical, v.device_type
from (values
  ('Kalo Family',          array['efate']::text[],           3, array[42,39,68]::int[],  36::numeric,  48::numeric, 0::numeric,  0::numeric, 'sturdy',   true,  'Oxygen concentrator'),
  ('Vira Solar Homestead', array['efate']::text[],            4, array[35,33,10,8]::int[], 120,          72,          4,           6,          'sturdy',   false, null),
  ('Captain Melsul',       array['espiritu-santo']::text[],   2, array[55,52]::int[],      48,           24,          1,           8,          'moderate', false, null),
  ('Naomi Bong',           array['espiritu-santo']::text[],   2, array[24,1]::int[],       12,           9.6,         0,           0,          'weak',     false, null),
  ('Iarkei Family',        array['tanna']::text[],            3, array[45,44,16]::int[],   24,           24,          0.5,         0.5,        'weak',     true,  'Insulin refrigeration'),
  ('Yasur View Lodge',     array['tanna']::text[],             2, array[50,48]::int[],      144,          120,         3,           5,          'sturdy',   false, null),
  ('Namaru Bakery',        array['malekula']::text[],         3, array[40,38,15]::int[],   48,           192,         0,           10,         'sturdy',   false, null),
  ('Bunlap Community',     array['pentecost']::text[],        6, array[50,48,25,20,15,70]::int[], 24,    36,          0.5,         0.5,        'moderate', false, null)
) as v(name, zones, household_size, ages, water, food, solar_power, batteries, shelter, is_critical, device_type)
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
