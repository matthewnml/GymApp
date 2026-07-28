-- ============================================================
--  GymApp — access-request table
--  Run once in Supabase → SQL Editor. Safe to re-run.
--  A public "Request access" form writes here; you get notified
--  via Telegram (see SETUP below). No email is sent by Supabase.
-- ============================================================

create table if not exists public.signup_requests (
  id uuid primary key default gen_random_uuid(),
  name text,
  email text,
  note text,
  status text default 'pending',
  created_at timestamptz default now()
);

alter table public.signup_requests enable row level security;

-- Anyone (even not logged in) may SUBMIT a request...
drop policy if exists "anyone can request access" on public.signup_requests;
create policy "anyone can request access"
  on public.signup_requests for insert
  to anon, authenticated
  with check (true);

-- ...but nobody can READ them via the public API (you view them in the
-- Supabase dashboard, and the details arrive in your Telegram message).
-- (No SELECT policy = no anon/authenticated reads. Service role still can.)
