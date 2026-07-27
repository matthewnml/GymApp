# GymApp — Shared Health Tracker

A small always-on web app (installable to your phone) for logging daily health
metrics — weight, calories, workouts, and your own custom fields — with a shared
"Today" board so a group can see each other's current-day entries, plus charts.

- **Frontend:** static HTML/JS in [`public/`](public/), deployed on Cloudflare Pages.
- **Backend:** [Supabase](https://supabase.com) — Postgres + Auth + Realtime.
- **Login:** email + password (invite-only; the owner invites people from the Supabase dashboard).

## Deploy (Cloudflare Pages)
1. Push this repo to GitHub (already at `matthewnml/GymApp`).
2. In Cloudflare Pages → **Create project → Connect to Git → GymApp**.
3. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - **Build output directory: `public`**
4. Deploy → you get a permanent `https://gymapp.pages.dev` link.

## Supabase setup
Run [`supabase-schema.sql`](supabase-schema.sql) once in the Supabase SQL Editor
(creates tables, seeds built-in metrics, enables Row-Level Security).

After the first deploy, in Supabase → **Authentication → URL Configuration**, set
the **Site URL** and add a **Redirect URL** to your Pages domain so invite / reset
emails point back to the app.

## Config
The Supabase project URL and **anon** (public) key live at the top of the
`<script>` in [`public/index.html`](public/index.html). The anon key is safe to
publish — data is protected by Row-Level Security policies, not by hiding the key.
