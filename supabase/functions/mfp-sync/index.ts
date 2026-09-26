// ============================================================
//  Edge Function: mfp-sync
//  Actions (POST JSON { action, ... }):
//    connect { cookie }              -> validate + store encrypted MFP session cookie
//    status  {}                      -> { connected, last_synced_at, last_error }
//    sync    { days }                -> pull last N days of diary totals into `entries`
//
//  Secrets required (supabase secrets set ...):
//    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_ENC_KEY (base64, 32 bytes)
//
//  The service role client bypasses RLS so it can read/write the
//  RLS-locked integration_accounts table. Credentials are encrypted
//  at rest with AES-GCM using APP_ENC_KEY; plaintext never persists.
// ============================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cookieHeaderFor, validateSession, fetchDiaryTotals } from "./mfp-client.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ENC_KEY_B64 = Deno.env.get("APP_ENC_KEY")!;
const PROVIDER = "myfitnesspal";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/* ---------- AES-GCM encryption for stored credentials ---------- */
function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function bytesToB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
async function encKey(): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", b64ToBytes(ENC_KEY_B64), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encrypt(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encKey();
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  const combined = new Uint8Array(iv.length + ct.length);
  combined.set(iv); combined.set(ct, iv.length);
  return bytesToB64(combined);
}
async function decrypt(blob: string): Promise<string> {
  const raw = b64ToBytes(blob);
  const iv = raw.slice(0, 12), ct = raw.slice(12);
  const key = await encKey();
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

/** Resolve the calling user's id from their JWT. */
async function currentUserId(req: Request): Promise<string> {
  const auth = req.headers.get("Authorization") ?? "";
  const jwt = auth.replace(/^Bearer\s+/i, "");
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data.user) throw new Error("Not authenticated.");
  return data.user.id;
}

const isoDaysAgo = (n: number) => {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

/** Sync one account's last `days` of diary into entries. Returns days written. */
async function syncAccount(userId: string, secretBlob: string, days: number): Promise<number> {
  const creds = JSON.parse(await decrypt(secretBlob));
  const from = isoDaysAgo(Math.min(Math.max(days || 30, 1), 180));
  const to = isoDaysAgo(0);
  const cookie = cookieHeaderFor(creds.cookie);
  const rows = await fetchDiaryTotals(cookie, from, to); // every day in range
  const MFP_KEYS = ["calories", "protein", "carbs", "fat"] as const;
  let synced = 0;
  for (const d of rows) {
    const patch: Record<string, number> = {};
    if (d.calories != null) patch.calories = d.calories;
    if (d.protein != null) patch.protein = d.protein;
    if (d.carbs != null) patch.carbs = d.carbs;
    if (d.fat != null) patch.fat = d.fat;
    const hasData = Object.keys(patch).length > 0;

    const { data: existing } = await admin.from("entries")
      .select("values").eq("user_id", userId).eq("date", d.date).maybeSingle();
    const current = { ...(existing?.values ?? {}) } as Record<string, unknown>;

    if (hasData) {
      // Merge MFP totals in, preserving manual fields (weight/notes/etc).
      const values = { ...current, ...patch };
      const { error } = await admin.from("entries").upsert(
        { user_id: userId, date: d.date, values, updated: new Date().toISOString() },
        { onConflict: "user_id,date" },
      );
      if (!error) synced++;
    } else if (existing) {
      // No MFP data for this day: strip any previously-synced MFP fields so a
      // bad earlier backfill gets cleaned up, but keep manual fields.
      const hadMfp = MFP_KEYS.some((k) => current[k] != null);
      if (!hadMfp) continue;
      for (const k of MFP_KEYS) delete current[k];
      if (Object.keys(current).length === 0) {
        await admin.from("entries").delete().eq("user_id", userId).eq("date", d.date);
      } else {
        await admin.from("entries").upsert(
          { user_id: userId, date: d.date, values: current, updated: new Date().toISOString() },
          { onConflict: "user_id,date" },
        );
      }
    }
  }
  await admin.from("integration_accounts").update({
    last_synced_at: new Date().toISOString(), last_error: null, status: "connected",
  }).eq("user_id", userId).eq("provider", PROVIDER);
  return synced;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // Scheduled path: pg_cron / external scheduler calls with a shared secret header
  // to sync every connected account. No user JWT involved.
  const cronKey = req.headers.get("x-cron-key");
  if (cronKey && cronKey === Deno.env.get("CRON_KEY")) {
    const { data: accts } = await admin.from("integration_accounts")
      .select("user_id,secret").eq("provider", PROVIDER).eq("status", "connected");
    let ok = 0, failed = 0;
    for (const a of accts ?? []) {
      try { await syncAccount(a.user_id, a.secret, 7); ok++; }
      catch (e) {
        failed++;
        await admin.from("integration_accounts")
          .update({ last_error: e instanceof Error ? e.message : "cron sync failed" })
          .eq("user_id", a.user_id).eq("provider", PROVIDER);
      }
    }
    return json({ ok: true, accounts: ok, failed });
  }

  try {
    const userId = await currentUserId(req);
    const { action, cookie, days } = await req.json().catch(() => ({}));

    if (action === "connect") {
      if (!cookie || String(cookie).trim().length < 20) {
        return json({ error: "Paste your MyFitnessPal session cookie." }, 400);
      }
      // Validate the cookie works before storing it, so the user gets immediate feedback.
      try {
        await validateSession(cookieHeaderFor(String(cookie)));
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "Could not validate cookie." }, 400);
      }
      const secret = await encrypt(JSON.stringify({ cookie: String(cookie).trim() }));
      const { error } = await admin.from("integration_accounts").upsert({
        user_id: userId, provider: PROVIDER, secret, status: "connected", last_error: null,
      }, { onConflict: "user_id,provider" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "status") {
      const { data } = await admin.from("integration_accounts")
        .select("last_synced_at,last_error,status")
        .eq("user_id", userId).eq("provider", PROVIDER).maybeSingle();
      if (!data) return json({ connected: false });
      return json({
        connected: data.status === "connected",
        last_synced_at: data.last_synced_at,
        last_error: data.last_error,
      });
    }

    if (action === "sync") {
      const { data: acct } = await admin.from("integration_accounts")
        .select("secret").eq("user_id", userId).eq("provider", PROVIDER).maybeSingle();
      if (!acct?.secret) return json({ error: "Connect MyFitnessPal first." }, 400);

      try {
        const synced = await syncAccount(userId, acct.secret, Number(days) || 30);
        return json({ ok: true, days_synced: synced });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Sync failed.";
        await admin.from("integration_accounts").update({ last_error: msg })
          .eq("user_id", userId).eq("provider", PROVIDER);
        return json({ error: msg }, 502);
      }
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Server error.";
    return json({ error: msg }, msg === "Not authenticated." ? 401 : 500);
  }
});
