-- =======================================================================
-- OneIsland — Supabase schema
-- -----------------------------------------------------------------------
-- The "residents" table and its policies below are general — they'd work
-- for any island community. The zone check constraint and the seed data
-- (section 3) are this hackathon demo's Vanuatu configuration; swap them
-- for another region's islands/households without touching anything else.
--
-- If you already ran an earlier version of this file, running this one
-- again UPGRADES your existing table in place: a household can now have
-- MORE THAN ONE property (e.g. a primary home on Efate plus a vacation
-- home on Tanna) — each is its own row with its own resource profile, so
-- "zone" goes back to being a single value per row (a user_id is no
-- longer required to be unique), and the old "zones" array column is
-- migrated into that. Any real sign-up rows are preserved (matched by
-- user_id, never deleted).
--
-- Run this ONCE in the Supabase dashboard: Project > SQL Editor > New
-- query > paste this whole file > Run.
-- =======================================================================

-- 1. Table (fresh install) -------------------------------------------------
create table if not exists public.residents (
  id              uuid primary key default gen_random_uuid(),
  -- No longer unique: a household can have several properties, so a user
  -- may own multiple rows (one per island they have a home on).
  user_id         uuid references auth.users(id) on delete cascade,
  name            text not null,
  zone            text not null default 'efate'
                    check (zone in ('efate','espiritu-santo','tanna','malekula','pentecost')),
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
  critical_resource text default 'power'
                    check (critical_resource is null or critical_resource in ('power','water','food')),
  photo_url       text,
  created_at      timestamptz not null default now()
);

-- 1b. Migration (upgrading an existing install) -----------------------------
alter table public.residents add column if not exists zone text;
-- Backfill from the old "zones" array (Postgres arrays are 1-indexed), only if
-- that column still exists — a fresh-enough install never had it.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'residents' and column_name = 'zones'
  ) then
    execute '
      update public.residents
        set zone = zones[1]
        where zone is null and zones is not null and array_length(zones, 1) > 0
    ';
  end if;
end $$;
alter table public.residents alter column zone set default 'efate';
update public.residents set zone = 'efate' where zone is null;
alter table public.residents alter column zone set not null;
alter table public.residents drop column if exists zones;

alter table public.residents drop constraint if exists residents_zones_check;
alter table public.residents drop constraint if exists residents_zone_check;
alter table public.residents add constraint residents_zone_check
  check (zone in ('efate','espiritu-santo','tanna','malekula','pentecost'));

-- A household can now own more than one property row.
alter table public.residents drop constraint if exists residents_user_id_key;

alter table public.residents add column if not exists household_size int not null default 1;
alter table public.residents add column if not exists ages int[] not null default '{}'::int[];

-- A critical need can depend on power, water, or food — not just power.
alter table public.residents add column if not exists critical_resource text default 'power';
update public.residents set critical_resource = 'power' where is_critical and critical_resource is null;
alter table public.residents drop constraint if exists residents_critical_resource_check;
alter table public.residents add constraint residents_critical_resource_check
  check (critical_resource is null or critical_resource in ('power','water','food'));

-- 2. Row Level Security ----------------------------------------------------
alter table public.residents enable row level security;

drop policy if exists "residents_read_all" on public.residents;
drop policy if exists "residents_insert_own" on public.residents;
drop policy if exists "residents_update_own" on public.residents;
drop policy if exists "residents_delete_own" on public.residents;

-- Anyone (including anonymous visitors) can read every property — the
-- matching engine needs the full picture across islands to find surpluses.
create policy "residents_read_all"
  on public.residents for select
  using (true);

-- A signed-in user may only create rows for themselves.
create policy "residents_insert_own"
  on public.residents for insert
  with check (auth.uid() = user_id);

-- A signed-in user may only edit their own rows.
create policy "residents_update_own"
  on public.residents for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- A signed-in user may only delete their own rows.
create policy "residents_delete_own"
  on public.residents for delete
  using (auth.uid() = user_id);

-- 3. Seed data (Vanuatu households) -----------------------------------------
-- Clears the old demo rows (all seed rows have a null user_id, so this
-- never touches a real sign-up) and reseeds. "Kalo Family" has two rows —
-- a primary home on Efate and a vacation home on Pentecost — to
-- demonstrate the multi-property flow out of the box.
delete from public.residents where user_id is null;

insert into public.residents
  (name, zone, household_size, ages, water, food, solar_power, batteries, shelter, is_critical, device_type, critical_resource)
select v.name, v.zone, v.household_size, v.ages, v.water, v.food, v.solar_power, v.batteries, v.shelter, v.is_critical, v.device_type, v.critical_resource
from (values
  ('Kalo Family',          'efate',            3, array[42,39,68]::int[],  36::numeric,  48::numeric, 0::numeric,  0::numeric, 'sturdy',   true,  'Oxygen concentrator',      'power'),
  ('Kalo Family',          'pentecost',        3, array[42,39,68]::int[],  72,           48,          1,           1,          'moderate', false, null,                        null),
  ('Vira Solar Homestead', 'efate',            4, array[35,33,10,8]::int[], 120,          72,          4,           6,          'sturdy',   false, null,                        null),
  ('Captain Melsul',       'espiritu-santo',   2, array[55,52]::int[],      48,           24,          1,           8,          'moderate', false, null,                        null),
  ('Naomi Bong',           'espiritu-santo',   2, array[24,1]::int[],       12,           9.6,         0,           0,          'weak',     true,  'Infant formula',           'food'),
  ('Iarkei Family',        'tanna',            3, array[45,44,16]::int[],   24,           24,          0.5,         0.5,        'weak',     true,  'Dialysis machine',         'water'),
  ('Yasur View Lodge',     'tanna',            2, array[50,48]::int[],      144,          120,         3,           5,          'sturdy',   false, null,                        null),
  ('Namaru Bakery',        'malekula',         3, array[40,38,15]::int[],   48,           192,         0,           10,         'sturdy',   false, null,                        null),
  ('Bunlap Community',     'pentecost',        6, array[50,48,25,20,15,70]::int[], 24,    36,          0.5,         0.5,        'moderate', false, null,                        null)
) as v(name, zone, household_size, ages, water, food, solar_power, batteries, shelter, is_critical, device_type, critical_resource)
where not exists (select 1 from public.residents r where r.name = v.name and r.zone = v.zone);

-- 3b. Transfers (audit trail of confirmed resource shares) ------------------
-- Written once by app.js when a household confirms a recommended share
-- (see js/residents-store.js's recordTransfer()). Names are captured as a
-- snapshot at confirmation time — not just a foreign key — so the log stays
-- readable even if a resident row is later edited or removed.
create table if not exists public.transfers (
  id                    uuid primary key default gen_random_uuid(),
  giver_resident_id     uuid references public.residents(id) on delete set null,
  receiver_resident_id  uuid references public.residents(id) on delete set null,
  giver_name            text not null,
  receiver_name         text not null,
  resource_key          text not null check (resource_key in ('water','food','power')),
  amount_hours          numeric not null,
  severity              text not null check (severity in ('calm','watch','warning','severe')),
  created_at            timestamptz not null default now()
);

alter table public.transfers enable row level security;

drop policy if exists "transfers_read_all" on public.transfers;
drop policy if exists "transfers_insert_authenticated" on public.transfers;

-- Anyone can read the activity log — it's community-wide coordination
-- history, the same visibility as the residents table itself.
create policy "transfers_read_all"
  on public.transfers for select
  using (true);

-- Any signed-in user can log a confirmed share (there's no "own" resident
-- to check against: a share is between two OTHER households the matching
-- engine picked, not the confirming user's own property).
create policy "transfers_insert_authenticated"
  on public.transfers for insert
  to authenticated
  with check (true);

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
