// ============================================================
//  MyFitnessPal unofficial client  (ISOLATED / FRAGILE MODULE)
// ------------------------------------------------------------
//  MyFitnessPal has NO public API. Since 2025 they use NextAuth +
//  Cloudflare, so headless password login is dead AND the API access
//  token is sealed inside the encrypted NextAuth cookie (only MFP's
//  server can decrypt it). The working method (verified against a live
//  account) rides MFP's own same-origin BFF route, which authenticates
//  with just the pasted session cookie:
//
//    1. GET https://www.myfitnesspal.com/api/auth/session   -> user.name
//    2. GET https://www.myfitnesspal.com/api/services/diary/read_diary
//         ?username=<name>&date=YYYY-MM-DD                   -> meal items
//       Sum each item's nutritional_contents into the day's totals.
//
//  REQUIREMENT: the user's MFP "Diary Sharing" must be set to **Public**
//  (read_diary returns 403 "You are not the diary user" otherwise, since
//  the server can't tie our datacenter request to the diary owner).
//
//  This is against MFP's ToS and can break anytime; cookies expire
//  (~30 days) so the user re-pastes occasionally. Keep ALL MFP-specific
//  logic here so breakage is contained.
//
//  Public surface (unchanged, so index.ts needs no edits):
//    cookieHeaderFor(token)           -> Cookie header string
//    validateSession(cookie)          -> throws if the cookie is invalid
//    fetchDiaryTotals(cookie,from,to) -> DiaryDay[]
// ============================================================

const WEB = "https://www.myfitnesspal.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SESSION_COOKIE = "__Secure-next-auth.session-token";

export interface DiaryDay {
  date: string; // YYYY-MM-DD
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
}

/** Build a Cookie header from a pasted token. Accepts the bare value or a
 *  full "name=value" pair (or several cookies) the user copied. */
export function cookieHeaderFor(pasted: string): string {
  const v = pasted.trim();
  if (v.includes("=")) return v;
  return `${SESSION_COOKIE}=${v}`;
}

const baseHeaders = (cookie: string) => ({
  "User-Agent": UA,
  "Cookie": cookie,
  "Accept": "application/json",
  "Referer": `${WEB}/`,
});

function looksLikeCloudflare(body: string): boolean {
  return /Just a moment|cf-chl|challenge-platform|Attention Required|_cf_chl/i.test(body);
}

/** Resolve the account's username (needed by read_diary) from the session. */
async function getUsername(cookie: string): Promise<string> {
  const res = await fetch(`${WEB}/api/auth/session`, { headers: baseHeaders(cookie) });
  const body = await res.text().catch(() => "");
  if (res.status === 403 || looksLikeCloudflare(body)) {
    throw new Error("Blocked by Cloudflare from the server (cookie may be valid, but MFP refused this IP).");
  }
  let json: { user?: { name?: string }; username?: string } = {};
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error("MyFitnessPal session cookie invalid or expired — paste a fresh session token.");
  }
  const name = json.username || json.user?.name;
  if (!name) {
    throw new Error("MyFitnessPal session cookie invalid or expired — paste a fresh session token.");
  }
  return name;
}

interface NutritionalContents {
  energy?: { unit?: string; value?: number } | number;
  carbohydrates?: number;
  protein?: number;
  fat?: number;
}
interface DiaryItem {
  type?: string;
  date?: string;
  nutritional_contents?: NutritionalContents;
}

const kcal = (e: NutritionalContents["energy"]): number | null => {
  if (e == null) return null;
  if (typeof e === "number") return e;
  if (e.value == null) return null;
  // Energy may be reported in kilojoules depending on the account's unit setting.
  return /kilojoule|kj/i.test(e.unit ?? "") ? e.value / 4.184 : e.value;
};
const round = (n: number | null): number | null => (n == null ? null : Math.round(n * 10) / 10);

/** Fetch and sum one day's diary nutrition via the read_diary BFF route. */
async function fetchDiaryDay(cookie: string, username: string, date: string): Promise<DiaryDay> {
  // NOTE: the param is `entry_date`. A plain `date` param is silently ignored
  // and MFP returns TODAY's diary for every request — which duplicates one day
  // across the whole range. Do not "simplify" this back to `date`.
  const url = `${WEB}/api/services/diary/read_diary?username=${encodeURIComponent(username)}&entry_date=${date}`;
  const res = await fetch(url, { headers: baseHeaders(cookie) });
  const body = await res.text().catch(() => "");
  if (res.status === 403) {
    throw new Error('MyFitnessPal returned 403 — set your Diary Sharing to "Public" (Settings → Diary Settings), then sync again.');
  }
  if (res.status === 401) throw new Error("MyFitnessPal session expired — paste a fresh session cookie.");
  if (!res.ok) throw new Error(`MyFitnessPal diary request failed (HTTP ${res.status}).`);
  let items: DiaryItem[] = [];
  try {
    const parsed = JSON.parse(body);
    items = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
  } catch {
    throw new Error("MyFitnessPal returned an unexpected diary response (their format may have changed).");
  }
  let cal = 0, pro = 0, carb = 0, fat = 0, any = false;
  for (const it of items) {
    // Safety net: only count items actually dated to the requested day.
    if (it.date && it.date !== date) continue;
    const n = it.nutritional_contents;
    if (!n) continue;
    any = true;
    const c = kcal(n.energy);
    if (c != null) cal += c;
    if (n.protein != null) pro += n.protein;
    if (n.carbohydrates != null) carb += n.carbohydrates;
    if (n.fat != null) fat += n.fat;
  }
  return {
    date,
    calories: any ? round(cal) : null,
    protein: any ? round(pro) : null,
    carbs: any ? round(carb) : null,
    fat: any ? round(fat) : null,
  };
}

/** Confirm the cookie is a valid MFP session. Throws a clear error otherwise. */
export async function validateSession(cookie: string): Promise<void> {
  await getUsername(cookie);
}

/** Fetch diary totals for an inclusive date range. One request per day.
 *  Returns EVERY day in range (days with no diary come back all-null) so the
 *  caller can both write logged days and clean up previously-synced empty ones. */
export async function fetchDiaryTotals(
  cookie: string,
  from: string,
  to: string,
): Promise<DiaryDay[]> {
  const username = await getUsername(cookie);
  const out: DiaryDay[] = [];
  for (const date of dateRange(from, to)) {
    out.push(await fetchDiaryDay(cookie, username, date));
  }
  return out;
}

function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
