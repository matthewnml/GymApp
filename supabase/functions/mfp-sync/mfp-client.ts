// ============================================================
//  MyFitnessPal unofficial client  (ISOLATED / FRAGILE MODULE)
// ------------------------------------------------------------
//  MyFitnessPal has NO public API — this logs in as the user and
//  scrapes their diary totals. It is against MFP's Terms of Service
//  and WILL break whenever MFP changes their site/markup. ALL
//  MFP-specific logic lives here so breakage is contained: if a sync
//  starts failing, this is the only file to fix (or swap out).
//
//  Public surface:
//    login(username, password)  -> cookieHeader (string)
//    fetchDiaryTotals(cookie, from, to) -> DiaryDay[]
// ============================================================

const BASE = "https://www.myfitnesspal.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface DiaryDay {
  date: string; // YYYY-MM-DD
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
}

/** Pull cookies from one or more Set-Cookie headers into a Cookie request header. */
function mergeCookies(prev: Record<string, string>, res: Response): Record<string, string> {
  const jar = { ...prev };
  // Deno exposes combined Set-Cookie via getSetCookie() when available.
  const raw = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);
  for (const line of raw) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return jar;
}
const cookieHeader = (jar: Record<string, string>) =>
  Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

function firstMatch(re: RegExp, s: string): string | null {
  const m = re.exec(s);
  return m ? m[1] : null;
}

/**
 * Log in with username + password. Returns a Cookie header string for
 * authenticated requests. Throws with a user-friendly message on failure.
 */
export async function login(username: string, password: string): Promise<string> {
  // 1) GET the login page for the CSRF/authenticity token + initial cookies.
  const loginPage = await fetch(`${BASE}/account/login`, {
    headers: { "User-Agent": UA },
    redirect: "manual",
  });
  let jar = mergeCookies({}, loginPage);
  const html = await loginPage.text();
  const token =
    firstMatch(/name="authenticity_token"[^>]*value="([^"]+)"/, html) ??
    firstMatch(/name="csrf-token"\s+content="([^"]+)"/, html);
  if (!token) {
    throw new Error("Could not start MyFitnessPal login (page layout changed).");
  }

  // 2) POST credentials.
  const form = new URLSearchParams({
    "utf8": "✓",
    "authenticity_token": token,
    "username": username,
    "password": password,
  });
  const res = await fetch(`${BASE}/account/login`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": cookieHeader(jar),
      "Referer": `${BASE}/account/login`,
    },
    body: form.toString(),
    redirect: "manual",
  });
  jar = mergeCookies(jar, res);

  // A successful login redirects (302) away from /login and sets a session cookie.
  const authed = Object.keys(jar).some((k) => /session|remember|_myfitnesspal/i.test(k));
  if (res.status >= 400 || !authed) {
    throw new Error("MyFitnessPal rejected the login (check username/password).");
  }
  return cookieHeader(jar);
}

/** Parse a numeric cell like "1,234" or "56g" -> number. */
function toNum(cell: string): number | null {
  const n = Number(cell.replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? null : n;
}

/**
 * Fetch diary totals for an inclusive date range using the printable diary,
 * which renders a "Totals" row per day. Returns one DiaryDay per day found.
 *
 * NOTE: markup parsing is intentionally defensive but still the fragile part.
 */
export async function fetchDiaryTotals(
  cookie: string,
  from: string,
  to: string,
): Promise<DiaryDay[]> {
  const url = `${BASE}/reports/printable_diary/?from=${from}&to=${to}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Cookie": cookie, "Accept": "text/html" },
    redirect: "manual",
  });
  if (res.status === 302 || res.status === 401) {
    throw new Error("MyFitnessPal session expired — re-save your login.");
  }
  if (!res.ok) throw new Error(`MyFitnessPal diary request failed (HTTP ${res.status}).`);
  const html = await res.text();

  const out: DiaryDay[] = [];
  // Each day block starts with a date heading, e.g. <h2>January 5, 2026</h2>,
  // followed by a table whose <tr class="total"> holds the day's totals in the
  // column order Calories, Carbs, Fat, Protein (MFP default).
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
    // cells[0] is the "Totals" label; nutrients follow in header order.
    const nums = cells.slice(1).map(toNum);
    out.push({
      date,
      calories: nums[0] ?? null,
      carbs: nums[1] ?? null,
      fat: nums[2] ?? null,
      protein: nums[3] ?? null,
    });
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
