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
  ('workout','Workout','','text',false,true,2),
  ('comments','Comments','','text',false,true,3)
on conflict (key) do nothing;

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
