// ============================================================
//  MyFitnessPal unofficial client  (ISOLATED / FRAGILE MODULE)
// ------------------------------------------------------------
//  MyFitnessPal has NO public API. As of 2025+ they use NextAuth +
//  Cloudflare bot protection, so headless username/password login is
//  dead. The only method that works is COOKIE AUTH: the user logs in
//  at myfitnesspal.com in their own browser and pastes their session
//  token; we send it with each request.
//
//  CAVEAT: this runs server-side (Deno, datacenter IP, non-browser TLS
//  fingerprint) — Cloudflare may still block it. Errors below are made
//  diagnostic so we can tell login-expired vs Cloudflare-blocked vs
//  markup-changed. This is against MFP's ToS and can break anytime.
//  ALL MFP-specific logic lives here so breakage is contained.
//
//  Public surface:
//    cookieHeaderFor(token) -> Cookie header string
//    validateSession(cookie) -> throws if not usable
//    fetchDiaryTotals(cookie, from, to) -> DiaryDay[]
// ============================================================

const BASE = "https://www.myfitnesspal.com";
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

const browserHeaders = (cookie: string) => ({
  "User-Agent": UA,
  "Cookie": cookie,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Upgrade-Insecure-Requests": "1",
  "Referer": `${BASE}/`,
});

/** Build a Cookie header from a pasted token. Accepts either the bare token
 *  value or a full "name=value" pair the user copied. */
export function cookieHeaderFor(pasted: string): string {
  const v = pasted.trim();
  if (v.includes("=")) return v; // user pasted name=value (or several cookies)
  return `${SESSION_COOKIE}=${v}`;
}

function looksLikeCloudflare(html: string): boolean {
  return /Just a moment|cf-chl|challenge-platform|Attention Required|_cf_chl/i.test(html);
}
function looksLoggedOut(html: string): boolean {
  return /account\/login|Log In to MyFitnessPal|next-auth\.session/i.test(html) &&
    !/(printable|diary|Totals)/i.test(html);
}

/** Fetch the printable diary (server-rendered HTML with a Totals row per day). */
async function getDiaryHtml(cookie: string, from: string, to: string): Promise<string> {
  const url = `${BASE}/reports/printable_diary/?from=${from}&to=${to}`;
  const res = await fetch(url, { headers: browserHeaders(cookie), redirect: "manual" });
  const body = await res.text().catch(() => "");
  if (res.status === 403 || looksLikeCloudflare(body)) {
    throw new Error("Blocked by Cloudflare from the server (cookie may be valid, but MFP is refusing this IP).");
  }
  if (res.status === 302 || res.status === 401 || looksLoggedOut(body)) {
    throw new Error("MyFitnessPal session expired or cookie invalid — log in again and paste a fresh session token.");
  }
  if (!res.ok) throw new Error(`MyFitnessPal diary request failed (HTTP ${res.status}).`);
  return body;
}

/** Confirm the session cookie can reach an authed page. Throws a clear error otherwise. */
export async function validateSession(cookie: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await getDiaryHtml(cookie, today, today); // throws with a diagnostic message on failure
}

/** Parse a numeric cell like "1,234" or "56g" -> number. */
function toNum(cell: string): number | null {
  const n = Number(cell.replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? null : n;
}
function firstMatch(re: RegExp, s: string): string | null {
  const m = re.exec(s);
  return m ? m[1] : null;
}

/** Fetch diary totals for an inclusive date range. Returns one DiaryDay per day. */
export async function fetchDiaryTotals(
  cookie: string,
  from: string,
  to: string,
): Promise<DiaryDay[]> {
  const html = await getDiaryHtml(cookie, from, to);
  const out: DiaryDay[] = [];
  // Each day is a <h2>Month D, YYYY</h2> heading followed by a table whose
  // <tr class="total"> holds totals in column order Calories, Carbs, Fat, Protein.
  const blocks = html.split(/<h2[^>]*>/i).slice(1);
  for (const block of blocks) {
    const heading = block.slice(0, block.indexOf("</h2>"));
    const date = parseHeadingDate(heading);
    if (!date || date < from || date > to) continue;
    const totalRow = firstMatch(/<tr class="(?:total|total_row)"[^>]*>([\s\S]*?)<\/tr>/i, block);
    if (!totalRow) continue;
    const cells = [...totalRow.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
      .filter((c) => c !== "");
    const nums = cells.slice(1).map(toNum); // cells[0] is the "Totals" label
    out.push({
      date,
      calories: nums[0] ?? null,
      carbs: nums[1] ?? null,
      fat: nums[2] ?? null,
      protein: nums[3] ?? null,
    });
  }
  if (!out.length && !/Totals/i.test(html)) {
    throw new Error("Reached MyFitnessPal but found no diary totals (page layout may have changed).");
  }
  return out;
}

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};
function parseHeadingDate(h: string): string | null {
  const m = /([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/.exec(h);
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${mon}-${m[2].padStart(2, "0")}`;
}
