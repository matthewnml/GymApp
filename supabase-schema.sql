-- ============================================================
--  Daily Tracker — Supabase schema + security
--  Run this once in Supabase → SQL Editor → New query → Run.
--  Safe to re-run (it drops/recreates policies).
-- ============================================================

-- ---------- tables ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz default now()
);

create table if not exists public.metrics (
  key text primary key,
  label text not null,
  unit text default '',
  type text not null default 'number' check (type in ('number','text')),
  chart boolean default true,
  builtin boolean default false,
  ord int default 0
);

create table if not exists public.entries (
  user_id uuid references auth.users(id) on delete cascade,
  date date not null,
  values jsonb not null default '{}'::jsonb,
  updated timestamptz default now(),
  primary key (user_id, date)
);
create index if not exists idx_entries_date on public.entries(date);

-- ---------- seed the built-in metrics ----------
insert into public.metrics (key,label,unit,type,chart,builtin,ord) values
  ('weight','Weight','kg','number',true,true,0),
  ('calories','Calories','kcal','number',true,true,1),
  ('protein','Protein','g','number',true,true,2),
  ('carbs','Carbs','g','number',true,true,3),
  ('fat','Fat','g','number',true,true,4),
  ('workout','Workout','','text',false,true,5),
  ('comments','Comments','','text',false,true,6)
on conflict (key) do nothing;

-- Nutrition metrics (protein/carbs/fat) are auto-filled by the MyFitnessPal
-- sync, but stay editable by hand like any other metric.

-- ---------- auto-create a profile on sign-up ----------
-- Uses the name typed at sign-up (stored in user metadata); falls back to email prefix.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'name',''), split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
--  Row-Level Security  (this is what keeps data safe in the cloud)
-- ============================================================
alter table public.profiles enable row level security;
alter table public.metrics  enable row level security;
alter table public.entries  enable row level security;

-- profiles: any signed-in user can read everyone's name; you edit only your own
drop policy if exists "read all profiles" on public.profiles;
drop policy if exists "insert own profile" on public.profiles;
drop policy if exists "update own profile" on public.profiles;
create policy "read all profiles" on public.profiles for select to authenticated using (true);
create policy "insert own profile" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "update own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- metrics: everyone signed-in can read + add; only NON-builtin can be deleted
drop policy if exists "read metrics" on public.metrics;
drop policy if exists "add metrics" on public.metrics;
drop policy if exists "delete custom metrics" on public.metrics;
create policy "read metrics" on public.metrics for select to authenticated using (true);
create policy "add metrics" on public.metrics for insert to authenticated with check (builtin = false);
create policy "delete custom metrics" on public.metrics for delete to authenticated using (builtin = false);

-- entries: everyone signed-in can READ all (shared board + see each other),
--          but can only WRITE their own rows
drop policy if exists "read all entries" on public.entries;
drop policy if exists "insert own entries" on public.entries;
drop policy if exists "update own entries" on public.entries;
drop policy if exists "delete own entries" on public.entries;
create policy "read all entries" on public.entries for select to authenticated using (true);
create policy "insert own entries" on public.entries for insert to authenticated with check (user_id = auth.uid());
create policy "update own entries" on public.entries for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "delete own entries" on public.entries for delete to authenticated using (user_id = auth.uid());

-- ============================================================
--  Realtime — powers live cross-user updates on the Today board
--  (if it says "already a member", that's fine — ignore it)
-- ============================================================
-- Idempotent: only add if not already a member (safe to re-run).
do $$ begin
  if not exists (select 1 from pg_publication_tables
                 where pubname='supabase_realtime' and schemaname='public' and tablename='entries')
  then alter publication supabase_realtime add table public.entries; end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname='supabase_realtime' and schemaname='public' and tablename='metrics')
  then alter publication supabase_realtime add table public.metrics; end if;
end $$;

-- ============================================================
--  STRENGTH — raw workout sets (imported from Hevy CSV export)
--  One row per set. Idempotent import via unique (user_id, external_id).
-- ============================================================
create table if not exists public.workout_sets (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  date          date not null,
  workout_title text default '',
  exercise      text not null,
  set_index     int  not null default 0,
  weight_kg     numeric,                       -- always normalised to kg on import
  reps          int,
  rpe           numeric,
  -- Epley estimated 1-rep-max; null for bodyweight/no-weight sets.
  est_1rm       numeric generated always as (
                  case when weight_kg is not null and reps is not null and reps > 0
                       then round((weight_kg * (1 + reps::numeric / 30))::numeric, 2)
                       else null end
                ) stored,
  source        text not null default 'hevy_csv',
  external_id   text not null,                 -- stable hash of the source row
  created_at    timestamptz default now(),
  unique (user_id, external_id)
);
create index if not exists idx_ws_user_ex_date on public.workout_sets(user_id, exercise, date);
create index if not exists idx_ws_date on public.workout_sets(date);

alter table public.workout_sets enable row level security;
-- Same social model as entries: everyone signed-in reads all, writes only own.
drop policy if exists "read all sets"   on public.workout_sets;
drop policy if exists "insert own sets" on public.workout_sets;
drop policy if exists "update own sets" on public.workout_sets;
drop policy if exists "delete own sets" on public.workout_sets;
create policy "read all sets"   on public.workout_sets for select to authenticated using (true);
create policy "insert own sets" on public.workout_sets for insert to authenticated with check (user_id = auth.uid());
create policy "update own sets" on public.workout_sets for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "delete own sets" on public.workout_sets for delete to authenticated using (user_id = auth.uid());

-- Per user / exercise / day rollup that the Strength charts read directly.
create or replace view public.strength_daily
with (security_invoker = true) as
  select user_id, exercise, date,
         max(est_1rm)                       as best_e1rm,
         max(weight_kg)                     as top_weight_kg,
         sum(coalesce(weight_kg,0) * coalesce(reps,0)) as volume_kg,
         count(*)                           as sets
  from public.workout_sets
  group by user_id, exercise, date;

do $$ begin
  if not exists (select 1 from pg_publication_tables
                 where pubname='supabase_realtime' and schemaname='public' and tablename='workout_sets')
  then alter publication supabase_realtime add table public.workout_sets; end if;
end $$;

-- ============================================================
--  INTEGRATION ACCOUNTS — MyFitnessPal credentials + sync state
--  SECURITY-CRITICAL: the `secret` column must NEVER be client-readable.
--  Only the mfp-sync Edge Function (service_role) touches this table.
--  Encrypt `secret` with Supabase Vault before storing (see README).
-- ============================================================
create table if not exists public.integration_accounts (
  user_id        uuid not null references auth.users(id) on delete cascade,
  provider       text not null default 'myfitnesspal',
  secret         text,                          -- encrypted credential blob
  status         text not null default 'pending',
  last_synced_at timestamptz,
  last_error     text,
  created_at     timestamptz default now(),
  primary key (user_id, provider)
);

alter table public.integration_accounts enable row level security;
-- No SELECT / INSERT / UPDATE / DELETE policies for authenticated users =>
-- RLS denies all client access by default. The Edge Function uses the
-- service_role key, which bypasses RLS, so only the server can read secrets.
-- Clients interact with this table ONLY through the mfp-sync function.
