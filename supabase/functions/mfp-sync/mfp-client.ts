// ============================================================
//  MyFitnessPal unofficial client  (ISOLATED / FRAGILE MODULE)
// ------------------------------------------------------------
//  MyFitnessPal has NO public API. Since 2025 they use NextAuth +
//  Cloudflare, so headless password login is dead. The working method
//  (verified against a live account) is:
//
//    1. User pastes their browser session cookie
//       (__Secure-next-auth.session-token) from myfitnesspal.com.
//    2. GET https://www.myfitnesspal.com/user/auth_token?refresh=true
//       with that cookie -> { user_id, access_token }.
//    3. GET https://api.myfitnesspal.com/v2/diary?entry_date=YYYY-MM-DD
//       with Authorization: Bearer <token> + mfp-client-id/mfp-user-id
//       -> diary_meal items whose nutritional_contents we sum per day.
//
//  Endpoint shapes follow python-myfitnesspal and the archived MFP v2
//  docs. This is against MFP's ToS and can break anytime; cookies expire
//  (~30 days) so the user re-pastes occasionally. Keep ALL MFP-specific
//  logic here so breakage is contained.
//
//  Public surface (unchanged, so index.ts needs no edits):
//    cookieHeaderFor(token)          -> Cookie header string
//    validateSession(cookie)         -> throws if the cookie can't mint a token
//    fetchDiaryTotals(cookie,from,to)-> DiaryDay[]
// ============================================================

const WEB = "https://www.myfitnesspal.com";
const API = "https://api.myfitnesspal.com";
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
interface AuthData {
  userId: string;
  accessToken: string;
}

/** Build a Cookie header from a pasted token. Accepts the bare value or a
 *  full "name=value" pair (or several cookies) the user copied. */
export function cookieHeaderFor(pasted: string): string {
  const v = pasted.trim();
  if (v.includes("=")) return v;
  return `${SESSION_COOKIE}=${v}`;
}

function looksLikeCloudflare(body: string): boolean {
  return /Just a moment|cf-chl|challenge-platform|Attention Required|_cf_chl/i.test(body);
}

/** Exchange the session cookie for an API access token. */
async function getAccessToken(cookie: string): Promise<AuthData> {
  const res = await fetch(`${WEB}/user/auth_token?refresh=true`, {
    headers: {
      "User-Agent": UA,
      "Cookie": cookie,
      "Accept": "application/json",
      "mfp-client-id": "mfp-main-js",
      "Referer": `${WEB}/`,
    },
    redirect: "manual",
  });
  const body = await res.text().catch(() => "");
  if (res.status === 403 || looksLikeCloudflare(body)) {
    throw new Error("Blocked by Cloudflare from the server (cookie may be valid, but MFP refused this IP).");
  }
  if (res.status === 302 || res.status === 401 || res.status === 403) {
    throw new Error("MyFitnessPal session expired or cookie invalid — log in again and paste a fresh session token.");
  }
  if (!res.ok) throw new Error(`MyFitnessPal auth_token request failed (HTTP ${res.status}).`);
  let json: { user_id?: string; access_token?: string };
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error("MyFitnessPal returned an unexpected auth response (cookie may be invalid or the login flow changed).");
  }
  if (!json.access_token || !json.user_id) {
    throw new Error("MyFitnessPal auth response was missing the access token — paste a fresh session cookie.");
  }
  return { userId: json.user_id, accessToken: json.access_token };
}

const apiHeaders = (auth: AuthData) => ({
  "User-Agent": UA,
  "Accept": "application/json",
  "Authorization": `Bearer ${auth.accessToken}`,
  "mfp-client-id": "mfp-main-js",
  "mfp-user-id": auth.userId,
});

interface NutritionalContents {
  energy?: { unit?: string; value?: number };
  carbohydrates?: number;
  protein?: number;
  fat?: number;
}
interface DiaryItem {
  type?: string;
  nutritional_contents?: NutritionalContents;
}

const kcal = (e?: { unit?: string; value?: number }): number | null => {
  if (!e || e.value == null) return null;
  // Energy may come back in kilojoules depending on the account's unit setting.
  return /kilojoule|kj/i.test(e.unit ?? "") ? e.value / 4.184 : e.value;
};
const round = (n: number | null): number | null => (n == null ? null : Math.round(n * 10) / 10);

/** Fetch and sum one day's diary_meal nutrition. */
async function fetchDiaryDay(auth: AuthData, date: string): Promise<DiaryDay> {
  const qs = `entry_date=${date}&types=diary_meal&fields[]=nutritional_contents`;
  const res = await fetch(`${API}/v2/diary?${qs}`, { headers: apiHeaders(auth) });
  if (res.status === 401) throw new Error("MyFitnessPal token rejected — paste a fresh session cookie.");
  if (res.status === 403) throw new Error("Blocked by Cloudflare from the server on the diary API.");
  if (!res.ok) throw new Error(`MyFitnessPal diary API failed (HTTP ${res.status}).`);
  const data = await res.json().catch(() => ({} as { items?: DiaryItem[] }));
  const items: DiaryItem[] = Array.isArray(data.items) ? data.items : [];
  let cal = 0, pro = 0, carb = 0, fat = 0, any = false;
  for (const it of items) {
    if (it.type && it.type !== "diary_meal") continue;
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

/** Confirm the cookie can mint an access token. Throws a clear error otherwise. */
export async function validateSession(cookie: string): Promise<void> {
  await getAccessToken(cookie);
}

/** Fetch diary totals for an inclusive date range. One API call per day. */
export async function fetchDiaryTotals(
  cookie: string,
  from: string,
  to: string,
): Promise<DiaryDay[]> {
  const auth = await getAccessToken(cookie);
  const out: DiaryDay[] = [];
  for (const date of dateRange(from, to)) {
    const day = await fetchDiaryDay(auth, date);
    // Only keep days that actually have logged nutrition.
    if (day.calories != null || day.protein != null || day.carbs != null || day.fat != null) {
      out.push(day);
    }
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
