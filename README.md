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

## Integrations: diet (MyFitnessPal) & strength (Hevy)

The app can track **diet progress** (calories + macros) from MyFitnessPal and
**strength progress** (per-exercise estimated-1RM, volume, PRs) from Hevy. Both
appear under the **Progress** tab (Trends / Diet / Strength).

### Strength — Hevy CSV import (no server, no Pro needed)
Hevy's official API is Pro-only, so GymApp uses Hevy's **free CSV export** instead:
1. In Hevy: **Profile → ⚙ Settings → Export & Import Data → Export Workouts**.
2. In GymApp: **More → Strength · Hevy import** and upload `workout_data.csv`.

Sets are parsed in the browser, normalised to kg, deduplicated, and stored in
`public.workout_sets`. Re-importing is safe (duplicates are skipped). Estimated
1RM is computed by the database (Epley) and charted per exercise. If you later
buy Hevy Pro, an official-API sync can be added behind the same UI.

### Diet — MyFitnessPal (unofficial, requires the Edge Function)
> ⚠️ MyFitnessPal has **no public API**. This integration logs in and scrapes the
> diary — it is **against MFP's Terms of Service** and can break when MFP changes
> their site. All MFP-specific code is isolated in
> [`supabase/functions/mfp-sync/mfp-client.ts`](supabase/functions/mfp-sync/mfp-client.ts)
> so it's the only file to fix if it breaks. Credentials are stored **encrypted**
> (AES-GCM) and only ever handled server-side.

**Deploy the sync function** (needs the [Supabase CLI](https://supabase.com/docs/guides/cli)):

```bash
# 1. Generate a 32-byte encryption key for stored credentials
openssl rand -base64 32          # copy the output

# 2. Set function secrets (SUPABASE_URL + SERVICE_ROLE_KEY are provided automatically)
supabase secrets set APP_ENC_KEY="<key from step 1>"
supabase secrets set CRON_KEY="<any long random string>"   # for scheduled sync

# 3. Deploy (verify_jwt is already disabled for it via supabase/config.toml)
supabase functions deploy mfp-sync
```

Then in GymApp: **More → Diet · MyFitnessPal**, save your MFP login, and press
**Sync now**. Totals are merged into your daily `entries` (manual fields like
weight and notes are preserved).

**Optional — daily auto-sync** via `pg_cron` + `pg_net` (run once in SQL Editor):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('mfp-daily','0 6 * * *', $$
  select net.http_post(
    url := 'https://<PROJECT-REF>.supabase.co/functions/v1/mfp-sync',
    headers := jsonb_build_object('x-cron-key','<CRON_KEY from above>'),
    body := '{}'::jsonb
  );
$$);
```

The schema in [`supabase-schema.sql`](supabase-schema.sql) creates `workout_sets`,
the `strength_daily` view, and the RLS-locked `integration_accounts` table (only
the Edge Function's service role can read stored secrets).
