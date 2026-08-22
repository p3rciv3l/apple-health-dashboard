const CAL_TARGET = 1950;
const PRO_TARGET = 135;
const COOKIE = "cbum_gate";
const COOKIE_P = "cbum_gate_p";
const CACHE_KEY = "rows_cache_v1";
const VERIF_KEY = "notion_verification_token";
const EVENT_KEY = "last_event";
const VER_KEY = "ver_v1";
const PAGE_KEY = "cbum:page:html";
const PAGE_TTL_MS = 60 * 1000;
const MISS_KEY = "webhook_misses";
const MAX_CACHE_AGE_MS = 60 * 1000;
// Tracker day pages. Clicking a day on the desktop chart opens that day's
// tracker row in Notion. Map lives in env.DAY_PAGES_JSON.
const DAY_PAGES = {};  // hydrated from env.DAY_PAGES_JSON (date -> Notion page URL)
const WORKOUT_CACHE_KEY = "workout_cache_v3"; // v3: sessions carry the raw cell text for the entry editor
const ITEMS_KEY = "items_cache_v2";
const SHORTS_KEY = "item_shortnames_v1";
// The tracker Log database: one row per meal item, what the blow-up reads.
let LOG_DB = "";  // env.NOTION_LOG_DB hydrates this (see hydrateIds below).
const ORDER_KEY = "col_order_v1";
const GOALS_KEY = "goals_v1";
// Example starting targets. The owner can change any of them at /goals;
// whatever is saved there wins over these defaults.
const DEFAULT_GOALS = { calories: 1950, protein: 135, carbs: 198, fat: 60, satfat: 15, sugar: 50, fiber: 30, sodium: 2300 };
const GOAL_FIELDS = [
  ["calories", "Calories", "kcal"], ["protein", "Protein", "g"], ["carbs", "Carbs", "g"], ["fat", "Fat", "g"],
  ["satfat", "Saturated fat", "g"], ["sugar", "Sugar", "g"], ["fiber", "Fiber", "g"], ["sodium", "Sodium", "mg"]
];
const ORDER_TTL_MS = 10 * 60 * 1000;
const WORKOUT_DBS = {
  Push: "", Pull: "", Legs: "",  // env WORKOUT_DB_PUSH/_PULL/_LEGS hydrate these.
};

// Personal identifiers live in Worker env vars on the Cloudflare side, never
// in this file: see worker/wrangler.toml.example for the full list. One-time
// per-isolate hydration at the top of fetch. Database-less operation just
// yields empty sections, so a template deploy cannot 500.
function hydrateIds(env) {
  if (!LOG_DB && env.NOTION_LOG_DB) LOG_DB = env.NOTION_LOG_DB;
  for (const [k, v] of [["Push", env.WORKOUT_DB_PUSH], ["Pull", env.WORKOUT_DB_PULL], ["Legs", env.WORKOUT_DB_LEGS]])
    if (v && !WORKOUT_DBS[k]) WORKOUT_DBS[k] = v;
  if (env.DAY_PAGES_JSON && !Object.keys(DAY_PAGES).length) {
    try { Object.assign(DAY_PAGES, JSON.parse(env.DAY_PAGES_JSON)); } catch (e) {}
  }
}
// Columns that are not exercises.
const SKIP_COLS = new Set(["Days", "Date", "Hold", "Notes", "Note"]);
const WT_SUFFIX = " (wt)";
const CHARTJS_KEY = "chartjs_umd_v441";
const EMBED_KEY = "embed_token_v1";
const CHARTJS_CDN = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";
let LAST_PENDING = [];

const enc = new TextEncoder();

async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function cookieValue(req, name) {
  const raw = req.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// A revocable capability token, distinct from the password. It lives only in
// the Notion embed URL so the chart renders inline where cookies are blocked.
async function embedToken(env) {
  if (MEM.emb && Date.now() - MEM.embAt < 60000) return MEM.emb;
  let t = await env.CHART_KV.get(EMBED_KEY);
  if (!t) {
    const b = new Uint8Array(24);
    crypto.getRandomValues(b);
    t = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
    await env.CHART_KV.put(EMBED_KEY, t);
  }
  MEM.emb = t; MEM.embAt = Date.now();
  return t;
}

async function sessionToken(env) {
  return hmacHex(env.GATE_PASSWORD, "cbum-chart-session-v1");
}

// Authorized only by the long-lived signed device cookie set after a correct
// password entry. The URL carries no authority.
async function authed(req, env, url) {
  if (!env.GATE_PASSWORD) return false;
  const want = await sessionToken(env);
  // Three ways a trusted device proves itself, all equivalent in strength:
  //  - the Lax cookie (top-level Safari/Chrome)
  //  - the partitioned SameSite=None cookie (inside an embed)
  //  - the X-Gate header, replayed from localStorage when a browser refuses cookies
  const lax = cookieValue(req, COOKIE);
  if (lax && safeEqual(lax, want)) return true;
  const part = cookieValue(req, COOKIE_P);
  if (part && safeEqual(part, want)) return true;
  const hdr = req.headers.get("X-Gate");
  if (hdr && safeEqual(hdr, want)) return true;
  // Embed capability token: the Notion iOS webview blocks all third-party
  // storage, so nothing can be remembered there. The token in the embed URL is
  // the only credential that survives that context. Rotatable, not the password.
  const k = url && url.searchParams ? url.searchParams.get("k") : null;
  if (k && safeEqual(k, await embedToken(env))) return true;
  return false;
}

// Full rendered page snapshot: the chart route must feel instant even on a cold
// isolate, so we serve the last built HTML while a fresh build runs behind it.
// Only the embed-token variant is cached: the authed-cookie variant embeds the
// session gate token and must never be shared.
async function buildChartPage(env, ctx, ekLive) {
  try { await seedRowsSig(env); } catch (e) {}
  const t0 = Date.now();
  // Owner 8/17 perf: the five reads are independent; run them together so the
  // sync build path (cookie sessions, cold rebuilds) costs the slowest read,
  // not the sum.
  const rowsP = getRows(env, ctx);
  const wkP = getWorkout(env, ctx).catch(e => ({ splits: {}, errors: { all: String(e) } }));
  const itemsP = getItems(env, ctx).catch(() => ({}));
  const shortP = env.CHART_KV.get(SHORTS_KEY).catch(() => null);
  const goalsP = getGoals(env).catch(() => null);
  const [rowsR, wk, items0, shortRaw, goals] = await Promise.all([rowsP, wkP, itemsP, shortP, goalsP]);
  const { rows, source } = rowsR;
  /* Owner 8/18 blow-up bug: rows and item lists refresh on independent 60s
     caches, so a page build could bake fresh day rollups (bar shows 240)
     with item rows from minutes earlier ("Nothing logged yet." on tap) -
     and a cached snapshot/webview keeps showing that mixed page long after.
     Rows must never be baked fresher than the items they expand into. */
  let items = items0;
  const itemsMissing = !Object.keys(items0 || {}).length && (rowsR.rows || []).length;
  if (rowsR.at && (rowsR.at > MEM.itemsAt || itemsMissing)) {
    try { items = await freshItems(env); } catch (e) {}
  }
  try { if (shortRaw) items.__short = JSON.parse(shortRaw); } catch (e) {}
  const token = ekLive ? "" : await sessionToken(env);
  const html = chartPage(rows, { source }, wk, token, ekLive, goals, items);
  try { console.log("page build", Date.now() - t0, "ms"); } catch (e) {}
  return html;
}

async function refreshPage(env, ctx, ekLive) {
  try {
    const html = await buildChartPage(env, ctx, ekLive);
    MEM.page = html; MEM.pageAt = Date.now();
    try { await env.CHART_KV.put(PAGE_KEY, html); } catch (e) {}
  } catch (e) {}
}

/* Owner 8/17 perf: the embed page is identical for everyone holding k, so it
   also lives in the Cloudflare edge cache (Cache API, in-colo) for 60s. A hit
   skips both KV round trips; the Notion webhook purges the two keys so fresh
   food/workout data is never edge-stale. The verification bypass param "_"
   skips the edge cache entirely. */
const edgePageKey = (origin, path, k) => new Request(origin + path + "?k=" + encodeURIComponent(k));
async function edgePagePurge(origin, env) {
  try {
    const k = await embedToken(env);
    await caches.default.delete(edgePageKey(origin, "/", k));
  } catch (e) {}
}

async function getPageHtml(env, ctx, ekLive, preP) {
  if (ekLive) {
    if (MEM.page) {
      if (Date.now() - MEM.pageAt >= PAGE_TTL_MS) bg(ctx, "page", () => refreshPage(env, ctx, ekLive));
      return MEM.page;
    }
    try {
      const snap = preP ? await preP : await env.CHART_KV.get(PAGE_KEY);
      if (snap) {
        MEM.page = snap; MEM.pageAt = Date.now();
        bg(ctx, "page", () => refreshPage(env, ctx, ekLive));
        return snap;
      }
    } catch (e) {}
  }
  const html = await buildChartPage(env, ctx, ekLive);
  if (ekLive) {
    MEM.page = html; MEM.pageAt = Date.now();
    try { await env.CHART_KV.put(PAGE_KEY, html); } catch (e) {}
  }
  return html;
}

async function deviceCookies(env) {
  const t = await sessionToken(env);
  return [
    // Plain first-party cookie. Safari can be picky about SameSite=None+Partitioned
    // on a top-level navigation, so this one carries the normal case.
    `${COOKIE}=${t}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`,
    // Partitioned cookie for the Notion embed (third-party context).
    `${COOKIE_P}=${t}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=None; Partitioned`,
  ];
}

function withCookies(headers, cookies) {
  const h = new Headers(headers);
  for (const c of cookies) h.append("Set-Cookie", c);
  return h;
}

async function notionRows(env) {
  const token = env.NOTION_TOKEN;
  const db = env.DATABASE_ID;
  let cursor, rows = [];
  do {
    const body = { page_size: 100, sorts: [{ property: "Date", direction: "ascending" }] };
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(`https://api.notion.com/v1/databases/${db}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`notion ${res.status}: ${await res.text()}`);
    const data = await res.json();
    for (const p of data.results) {
      const props = p.properties || {};
      const d = props.Date && props.Date.date && props.Date.date.start;
      if (!d) continue;
      const num = (name) => {
        const v = props[name];
        if (!v) return 0;
        if (v.type === "rollup") return v.rollup.number || 0;
        if (v.type === "number") return v.number || 0;
        if (v.type === "formula") return v.formula.number || 0;
        return 0;
      };
      rows.push({
        date: d.slice(0, 10),
        calories: num("Calories"), protein: num("Protein"), carbs: num("Carbs"), fat: num("Fat"),
        satfat: num("Saturated Fat"), sugar: num("Sugar"), fiber: num("Fiber"), sodium: num("Sodium"),
      });
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  return rows;
}

// Isolate-local memory is free; KV is not. Every request first tries memory,
// and KV is written only when the data actually changed.
const MEM = { rows: null, rowsAt: 0, rowsSig: "", wk: null, wkAt: 0, wkSig: "", order: null, orderAt: 0, orderSig: "", goals: null, goalsAt: 0, items: null, itemsAt: 0 , emb: null, embAt: 0, page: null, pageAt: 0 };

function sig(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return String(h >>> 0) + "." + str.length;
}

// Content-derived so every isolate computes the same value for the same data.
function version() {
  return (MEM.rowsSig || "-") + "|" + (MEM.wkSig || "-");
}

async function bumpVer(env) {
  try { await env.CHART_KV.put(VER_KEY, version()); } catch (e) {}
}

async function seedRowsSig(env) {
  if (MEM.rowsSig) return;
  try {
    const raw = await env.CHART_KV.get(CACHE_KEY);
    if (raw) { const c = JSON.parse(raw); MEM.rowsSig = sig(JSON.stringify(c.rows)); }
  } catch (e) {}
}

async function freshRows(env, ctx) {
  const rows = await notionRows(env);
  /* Owner 8/15 ("why is today on projected? we have added stuff to the log"):
     the daily totals come from the Days rollup DB, but a day only appears
     there once its day page exists - meal items land in the Log DB the
     moment they logs. For any day that has Log items but no Days row (today,
     before the day page exists), synthesize the row from the item sums so
     the chart renders REAL values immediately; the Days rollup replaces the
     synthesized row as soon as it exists (matching keys are skipped). */
  try {
    const items = await getItems(env, ctx || null);
    if (items) {
      const have = new Set(rows.map(r => r.date));
      for (const day of Object.keys(items)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || have.has(day)) continue;
        const list = items[day];
        if (!Array.isArray(list) || !list.length) continue;
        const t = { date: day, calories: 0, protein: 0, carbs: 0, fat: 0, satfat: 0, sugar: 0, fiber: 0, sodium: 0 };
        list.forEach(it => {
          t.calories += it[1] || 0; t.protein += it[2] || 0; t.carbs += it[3] || 0; t.fat += it[4] || 0;
          t.satfat += it[5] || 0; t.sugar += it[6] || 0; t.fiber += it[7] || 0; t.sodium += it[8] || 0;
        });
        ['protein', 'carbs', 'fat', 'satfat', 'sugar', 'fiber'].forEach(k => { t[k] = Math.round(t[k] * 10) / 10; });
        rows.push(t);
      }
      rows.sort((a, b) => (a.date < b.date ? -1 : 1));
    }
  } catch (e) { /* rollup-only fallback: keep the chart working if items fail */ }
  await seedRowsSig(env);
  const sg = sig(JSON.stringify(rows));
  const changed = sg !== MEM.rowsSig;
  MEM.rows = rows; MEM.rowsAt = Date.now(); MEM.rowsSig = sg;
  if (changed) {
    try { await env.CHART_KV.put(CACHE_KEY, JSON.stringify({ at: Date.now(), rows })); } catch (e) {}
    await bumpVer(env);
  }
  return rows;
}

// Stale-while-revalidate: a page load never waits on Notion when we already
// have data. Whatever is cached is served immediately and, if it's past its
// TTL, a background refresh runs after the response is sent.
const INFLIGHT = {};
const bg = (ctx, key, fn) => {
  if (INFLIGHT[key]) return;
  INFLIGHT[key] = true;
  const p = Promise.resolve().then(fn).catch(() => {}).then(() => { INFLIGHT[key] = false; });
  if (ctx && ctx.waitUntil) ctx.waitUntil(p); 
};

async function getRows(env, ctx) {
  if (MEM.rows) {
    const stale = Date.now() - MEM.rowsAt >= MAX_CACHE_AGE_MS;
    if (stale) bg(ctx, "rows", () => freshRows(env, ctx));
    return { rows: MEM.rows, at: MEM.rowsAt, source: stale ? "memory (refreshing)" : "memory" };
  }
  try {
    const raw = await env.CHART_KV.get(CACHE_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      MEM.rows = c.rows; MEM.rowsAt = c.at; MEM.rowsSig = sig(JSON.stringify(c.rows));
      const stale = Date.now() - c.at >= MAX_CACHE_AGE_MS;
      if (stale) bg(ctx, "rows", () => freshRows(env, ctx));
      return { rows: c.rows, at: c.at, source: stale ? "kv cache (refreshing)" : "kv cache" };
    }
  } catch (e) {}
  const rows = await freshRows(env);
  return { rows, at: MEM.rowsAt, source: "live read" };
}

// Per-meal rows from the tracker Log database, cached exactly like the daily
// rollups, so the click-to-blow-up panel ships inline and never waits on a
// fetch. Item tuple: [name, calories, protein, carbs, fat, satfat, sugar, fiber, sodium].
async function notionItems(env) {
  const token = env.NOTION_TOKEN;
  if (!LOG_DB) return {};
  let cursor, byDay = {};
  do {
    const body = { page_size: 100, sorts: [{ property: "Date", direction: "ascending" }] };
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(`https://api.notion.com/v1/databases/${LOG_DB}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`notion items ${res.status}`);
    const data = await res.json();
    for (const p of data.results) {
      const props = p.properties || {};
      const d = props.Date && props.Date.date && props.Date.date.start;
      if (!d) continue;
      const num = (name) => { const v = props[name]; return v && v.type === "number" ? (v.number || 0) : 0; };
      const title = props.Meal && props.Meal.title && props.Meal.title[0] ? props.Meal.title[0].plain_text : "item";
      const day = d.slice(0, 10);
      (byDay[day] = byDay[day] || []).push([title, num("Calories"), num("Protein"), num("Carbs"), num("Fat"), num("Saturated Fat"), num("Sugar"), num("Fiber"), num("Sodium"), "https://www.notion.so/" + String(p.id || "").replace(/-/g, "")]);
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return byDay;
}

async function freshItems(env) {
  const items = await notionItems(env);
  MEM.items = items; MEM.itemsAt = Date.now();
  // Items changed -> new data version, so open pages pick up fresh blow-up
  // rows within one poll instead of waiting on the baked 60s snapshot.
  const isg = sig(JSON.stringify(items));
  const ichg = isg !== MEM.itemsSig; MEM.itemsSig = isg;
  try { await env.CHART_KV.put(ITEMS_KEY, JSON.stringify({ at: Date.now(), items })); } catch (e) {}
  if (ichg) await bumpVer(env);
  return items;
}

async function getItems(env, ctx) {
  if (MEM.items) {
    if (Date.now() - MEM.itemsAt >= MAX_CACHE_AGE_MS) bg(ctx, "items", () => freshItems(env));
    return MEM.items;
  }
  try {
    const raw = await env.CHART_KV.get(ITEMS_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      MEM.items = c.items; MEM.itemsAt = c.at;
      if (Date.now() - c.at >= MAX_CACHE_AGE_MS) bg(ctx, "items", () => freshItems(env));
      return c.items;
    }
  } catch (e) {}
  return freshItems(env);
}

// Cells are free text: "165x6,175x6 (good reps)", "37.5x6,42.5x5+1c", "20,25+20", "70".
// Parenthetical notes carry decoy numbers ("try 175 next time", "50lbs"), so they go first.
// Returns [[weight, reps|null], ...]; an unreadable cell returns [] and becomes a gap, never a zero.
function parseSets(txt) {
  if (!txt) return [];
  // Parens (and brackets) mean "ignore this" - their rule. Strip innermost-first
  // so nested notes go too, then drop an unmatched opener through the end of
  // the cell, so a note they never closed can't leak a decoy number.
  let s = txt;
  for (let prev = null; prev !== s;) { prev = s; s = s.replace(/\([^()]*\)|\[[^\[\]]*\]/g, " "); }
  s = s.replace(/[([][\s\S]*$/, " ").replace(/\s+/g, " ");
  const sets = [];
  const re = /(\d+(?:\.\d+)?)\s*[xX\u00d7]\s*(\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(s))) sets.push([parseFloat(m[1]), parseFloat(m[2])]);
  if (!sets.length) {
    // Older sessions logged a bare weight, or a comma list of them.
    const bare = /(?:^|[^\d.xX\u00d7])(\d+(?:\.\d+)?)(?![\d.]*\s*[xX\u00d7])/g;
    while ((m = bare.exec(s))) sets.push([parseFloat(m[1]), null]);
  }
  return sets.filter(([w]) => w > 0 && w <= 1000);
}

// Owner's rule: take the ceiling weight of the session's sets, EXCEPT when there are
// two or more sets and the heaviest one was 2 reps or fewer - a double or single is
// not real progression, so fall back to the next heaviest qualifying set.
// 'top' is the shipped metric; 'e1rm' and 'volume' are here for a one-line swap.
const WORKOUT_METRIC = "top";

// Owner's per-exercise overrides. Pull Ups: take the minimum of the numbers in
// the cell, not the ceiling (their rule, Aug 12).
const EXERCISE_RULE = { "Pull Ups": "min" };

function pickWeight(sets, name) {
  if (name && EXERCISE_RULE[name] === "min") {
    if (!sets || !sets.length) return null;
    return Math.min.apply(null, sets.map(s => s[0]));
  }
  return pickWeightDefault(sets);
}

function pickWeightDefault(sets) {
  if (!sets || !sets.length) return null;
  if (WORKOUT_METRIC === "volume") {
    let v = 0, any = false;
    for (const s of sets) if (s[1]) { v += s[0] * s[1]; any = true; }
    return any ? v : null;
  }
  if (WORKOUT_METRIC === "e1rm") {
    return Math.max.apply(null, sets.map(s => (s[1] ? s[0] * (1 + s[1] / 30) : s[0])));
  }
  const sorted = sets.slice().sort((a, b) => b[0] - a[0]);
  if (sorted.length >= 2) {
    for (const s of sorted) {
      if (s[1] !== null && s[1] !== undefined && s[1] <= 2) continue;
      return s[0];
    }
    // Every set was a double or lighter-with-low-reps: fall back to the ceiling.
    return sorted[0][0];
  }
  return sorted[0][0];
}

async function notionWorkout(env) {
  const token = env.NOTION_TOKEN;
  const splits = {}, errors = {}, pending = [];
  for (const split of Object.keys(WORKOUT_DBS)) {
    const db = WORKOUT_DBS[split];
    if (!db) continue;
    try {
      let cursor, sessions = [];
      do {
        const body = { page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        const res = await fetch(`https://api.notion.com/v1/databases/${db}/query`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`notion ${res.status}`);
        const data = await res.json();
        for (const p of data.results) {
          const props = p.properties || {};
          const d = props.Date && props.Date.date && props.Date.date.start;
          if (!d) continue;
          const dayTitle = props.Days && props.Days.title ? props.Days.title.map(t => t.plain_text).join("") : "";
          const ex = {}, w = {}, upd = {}, raw = {};
          for (const name of Object.keys(props)) {
            const v = props[name];
            if (!v || v.type !== "rich_text" || SKIP_COLS.has(name) || name.endsWith(WT_SUFFIX)) continue;
            const txt = (v.rich_text || []).map(t => t.plain_text).join(" ");
            const sets = parseSets(txt);
            const parsed = sets.length ? pickWeight(sets, name) : null;
            if (sets.length) ex[name] = sets;
            const stored = props[name + WT_SUFFIX];
            const storedNum = stored && stored.type === "number" ? stored.number : null;
            const hasText = txt.trim().length > 0;
            if (hasText) raw[name] = txt;
            // The free-text cell is the source of truth in both directions. Clearing
            // or lowering the text has to clear or lower the derived number, or the
            // chart becomes a write-once record of whatever was first parsed.
            if (!hasText) {
              if (storedNum !== null && storedNum !== undefined) upd[name + WT_SUFFIX] = { number: null };
              // no w[name]: an empty cell is a gap in the line
            } else if (parsed !== null) {
              w[name] = parsed;
              if (storedNum !== parsed) upd[name + WT_SUFFIX] = { number: parsed };
            } else {
              // Text is present but unreadable. Never write a zero and never guess:
              // keep whatever number is already there and leave it for a human.
              if (storedNum !== null && storedNum !== undefined) w[name] = storedNum;
            }
          }
          if (Object.keys(upd).length) pending.push({ id: p.id, props: upd });
          sessions.push({ date: d.slice(0, 10), id: p.id, title: dayTitle, ex, w, raw });
        }
        cursor = data.has_more ? data.next_cursor : undefined;
      } while (cursor);
      sessions.sort((a, b) => (a.date < b.date ? -1 : 1));
      splits[split] = sessions;
    } catch (e) {
      errors[split] = String(e && e.message ? e.message : e);
    }
  }
  return { splits, errors, pending };
}

// Writes only the derived "<Exercise> (wt)" number columns. Never touches the
// free-text cells. Capped per invocation to stay inside the Workers subrequest limit.
async function writeWeights(env, pending, cap) {
  const token = env.NOTION_TOKEN;
  let done = 0;
  for (const item of pending.slice(0, cap || 30)) {
    try {
      const res = await fetch(`https://api.notion.com/v1/pages/${item.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
        body: JSON.stringify({ properties: item.props }),
      });
      if (res.ok) done++;
    } catch (e) {}
  }
  return done;
}

// The entry editor's write-back. One exercise cell of one workout row, written
// straight to Notion; the free-text cell stays the only source of truth, so the
// save path is: PATCH the rich_text, re-read the split exactly like a webhook
// refresh would, and let the normal pipeline re-derive the (wt) column. The
// response carries the re-parsed session so the page can repaint the point now.
async function updateWorkoutCell(env, ctx, split, pageId, exercise, text) {
  const token = env.NOTION_TOKEN;
  const db = WORKOUT_DBS[split];
  if (!db) return { ok: false, error: "unknown split" };  // env WORKOUT_DB_<SPLIT> unset
  if (typeof exercise !== "string" || !exercise.length || exercise.length > 100) return { ok: false, error: "bad exercise name" };
  if (SKIP_COLS.has(exercise) || exercise.endsWith(WT_SUFFIX)) return { ok: false, error: "not an exercise column" };
  text = typeof text === "string" ? text : "";
  if (text.length > 1900) text = text.slice(0, 1900); // Notion caps one rich_text block at 2000 chars
  if (!/^[0-9a-fA-F-]{32,36}$/.test(String(pageId || ""))) return { ok: false, error: "bad page id" };
  const h = { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };
  const gr = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers: h });
  if (!gr.ok) return { ok: false, error: `notion ${gr.status}` };
  const page = await gr.json();
  const parentDb = String(page.parent && page.parent.database_id || "").replace(/-/g, "");
  if (parentDb !== db.replace(/-/g, "")) return { ok: false, error: "entry is not in that split" };
  const prop = (page.properties || {})[exercise];
  if (!prop || prop.type !== "rich_text") return { ok: false, error: "column is not a text cell" };
  const body = { properties: {} };
  body.properties[exercise] = { rich_text: text.trim().length ? [{ type: "text", text: { content: text } }] : [] };
  const pr = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { method: "PATCH", headers: h, body: JSON.stringify(body) });
  if (!pr.ok) return { ok: false, error: `notion ${pr.status}` };
  MEM.wkAt = 0; // the cached split must re-read Notion now, not on the next stale tick
  let session = null;
  try {
    const fresh = await refreshWorkout(env);
    const list = (fresh.splits && fresh.splits[split]) || [];
    session = list.find(s => s.id === pageId) || null;
  } catch (e) {
    return { ok: true, session: null, warning: "saved, but the re-read failed: " + String(e && e.message ? e.message : e) };
  }
  // Re-sync every derived "<Exercise> (wt)" column the edit changed, same as
  // the webhook does. Integration-token edits fire no webhook, so this write
  // cannot loop back.
  if (ctx && LAST_PENDING.length) ctx.waitUntil(writeWeights(env, LAST_PENDING, 30));
  return { ok: true, session };
}

async function getWorkoutData(env, ctx) {
  if (MEM.wk) {
    const stale = Date.now() - MEM.wkAt >= MAX_CACHE_AGE_MS;
    if (stale) bg(ctx, "wk", () => refreshWorkout(env));
    return { splits: MEM.wk, errors: {}, source: stale ? "memory (refreshing)" : "memory" };
  }
  try {
    const raw = await env.CHART_KV.get(WORKOUT_CACHE_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      MEM.wk = c.splits; MEM.wkAt = c.at; MEM.wkSig = sig(JSON.stringify(c.splits));
      const stale = Date.now() - c.at >= MAX_CACHE_AGE_MS;
      if (stale) bg(ctx, "wk", () => refreshWorkout(env));
      return { splits: c.splits, errors: {}, source: stale ? "kv cache (refreshing)" : "kv cache" };
    }
  } catch (e) {}
  return refreshWorkout(env);
}

async function refreshWorkout(env) {
  const fresh = await notionWorkout(env);
  const got = Object.keys(fresh.splits).length;
  if (got) {
    LAST_PENDING = fresh.pending || [];
    const merged = MEM.wk ? Object.assign({}, MEM.wk, fresh.splits) : fresh.splits;
    if (!MEM.wkSig) {
      try {
        const raw = await env.CHART_KV.get(WORKOUT_CACHE_KEY);
        if (raw) { const c = JSON.parse(raw); MEM.wkSig = sig(JSON.stringify(c.splits)); }
      } catch (e) {}
    }
    const sg = sig(JSON.stringify(merged));
    const changed = sg !== MEM.wkSig;
    MEM.wk = merged; MEM.wkAt = Date.now(); MEM.wkSig = sg;
    if (changed) {
      try { await env.CHART_KV.put(WORKOUT_CACHE_KEY, JSON.stringify({ at: Date.now(), splits: merged })); } catch (e) {}
      await bumpVer(env);
    }
    return { splits: merged, errors: fresh.errors, source: "live read" };
  }
  if (MEM.wk) return { splits: MEM.wk, errors: fresh.errors, source: "stale cache" };
  return { splits: {}, errors: fresh.errors, source: "unavailable" };
}


// Legend order follows the column order of the table view Owner actually edits:
// left of the "Days" title column is the live workout order, right of it is
// retired. The Views API (2025-09-03) is the only place that order is exposed;
// the schema endpoint returns properties in an arbitrary order.
async function notionOrder(env) {
  const token = env.NOTION_TOKEN;
  const out = {};
  for (const split of Object.keys(WORKOUT_DBS)) {
    const db = WORKOUT_DBS[split];
    if (!db) continue;
    try {
      const h = { Authorization: `Bearer ${token}`, "Notion-Version": "2025-09-03" };
      const lr = await fetch(`https://api.notion.com/v1/views?database_id=${db}`, { headers: h });
      if (!lr.ok) continue;
      const list = await lr.json();
      const views = (list.results || []);
      const v = views.find(x => x.type === "table") || views[0];
      if (!v) continue;
      const vr = await fetch(`https://api.notion.com/v1/views/${v.id}`, { headers: h });
      if (!vr.ok) continue;
      const view = await vr.json();
      const cols = ((view.configuration || {}).properties || [])
        .filter(c => c.visible !== false && c.property_name)
        .map(c => c.property_name)
        .filter(n => !n.endsWith(WT_SUFFIX) && !SKIP_COLS.has(n));
      if (cols.length) out[split] = cols;
    } catch (e) {}
  }
  return out;
}

async function getOrder(env, ctx) {
  if (MEM.order) {
    if (Date.now() - MEM.orderAt >= ORDER_TTL_MS) bg(ctx, "order", () => refreshOrder(env));
    return MEM.order;
  }
  try {
    const raw = await env.CHART_KV.get(ORDER_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      MEM.order = c.order; MEM.orderAt = c.at; MEM.orderSig = sig(JSON.stringify(c.order));
      if (Date.now() - c.at >= ORDER_TTL_MS) bg(ctx, "order", () => refreshOrder(env));
      return MEM.order;
    }
  } catch (e) {}
  return refreshOrder(env);
}

async function refreshOrder(env) {
  const fresh = await notionOrder(env);
  if (Object.keys(fresh).length) {
    const sg = sig(JSON.stringify(fresh));
    const changed = sg !== MEM.orderSig;
    MEM.order = fresh; MEM.orderAt = Date.now(); MEM.orderSig = sg;
    if (changed) { try { await env.CHART_KV.put(ORDER_KEY, JSON.stringify({ at: Date.now(), order: fresh })); } catch (e) {} }
    return fresh;
  }
  return MEM.order || {};
}

async function getGoals(env) {
  if (MEM.goals && Date.now() - MEM.goalsAt < MAX_CACHE_AGE_MS) return MEM.goals;
  let saved = null;
  try { const raw = await env.CHART_KV.get(GOALS_KEY); if (raw) saved = JSON.parse(raw); } catch (e) {}
  const goals = Object.assign({}, DEFAULT_GOALS, saved || {});
  MEM.goals = goals; MEM.goalsAt = Date.now();
  return goals;
}

async function saveGoals(env, goals) {
  await env.CHART_KV.put(GOALS_KEY, JSON.stringify(goals));
  MEM.goals = goals; MEM.goalsAt = Date.now();
}

async function getWorkout(env, ctx) {
  const w = await getWorkoutData(env, ctx);
  try { w.order = await getOrder(env, ctx); } catch (e) { w.order = MEM.order || {}; }
  return w;
}

const CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  /* Fit whatever height the container gives us (Notion sets a fixed embed
     height and the phone app is not resizable), so both cards are visible
     without scrolling inside the frame. */
  body { display:flex; flex-direction:column; }
  .card { flex:1 1 0; min-height:0; display:flex; flex-direction:column; }
  /* While a blow-up is docked BELOW the chart (touch/narrow), the page must
     GROW and scroll instead of pinning cards to equal viewport shares - the
     fixed-height shell exists only so a Notion embed fits without scrolling,
     and an opening blow-up always trumps that. */
  body.blowing { height:auto; min-height:100%; }
  body.blowing .card { flex:0 0 auto; }
  body { margin:0; padding:14px 16px 16px; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         background:#fff; color:#1a1a1a; overflow-x:hidden; -webkit-font-smoothing:antialiased; -webkit-text-size-adjust:100%; }
  .head { display:flex; align-items:center; gap:12px; margin-bottom:0; }
  .title { font-size:15px; font-weight:600; letter-spacing:-0.01em; }
  .seg { margin-left:auto; display:inline-flex; border:1px solid #e4e4e4; border-radius:6px; overflow:hidden; }
  .seg button, .seg a { font:inherit; font-size:12px; line-height:1; padding:6px 11px; border:0; border-right:1px solid #e4e4e4;
                background:#fff; color:#797979; cursor:pointer; }
  .seg a { text-decoration:none; }
  .seg + .seg { margin-left:0; }
  .seg button:last-child, .seg a:last-child { border-right:0; }
  .seg button.on, .seg a.on { background:#f4f4f4; color:#1a1a1a; font-weight:600; }
  /* Owner 8/15: the Line/Opaque toggle sits centered in the gap between the
     split tabs and the date-range seg, not pinned to the far right. */
  .legend { display:flex; align-items:center; flex-wrap:wrap; gap:9px 22px; margin:14px 0 14px; }
  .legend .item { display:inline-flex; align-items:center; gap:8px; font-size:12px; line-height:1; color:#1a1a1a; }
  .legend .sw { width:9px; height:9px; border-radius:2px; flex:none; }
  .legend .item.tog { cursor:pointer; }
  .legend .item.off { opacity:0.4; }
  .legend .x { margin-left:2px; font-size:12px; line-height:1; color:#b0b0b0; }
  .legend .item.tog:hover .x { color:#797979; }
  /* All-split workout legend (Owner 8/15): everything smaller - swatch, font,
     X - so the merged legend holds ~2-3 rows without eating height. */
  .legend.allfit { gap:5px 12px; margin:10px 0 8px; }
  .legend.allfit .item { font-size:10.5px; gap:5px; }
  .legend.allfit .sw { width:7px; height:7px; }
  .legend.allfit .x { font-size:10.5px; margin-left:0; }
  .legend .item.off .x { color:#797979; }
  .cust { display:none; align-items:center; gap:6px; }
  .cust.on { display:inline-flex; }
  .cust input, .cust select { font:inherit; font-size:12px; line-height:1; color:#1a1a1a; background:#fff;
                              border:1px solid #e4e4e4; border-radius:6px; padding:6px 8px; }
  .cust input { width:56px; }
  /* Paint our own chevron: the native arrow floats far right of the text on
     some clients (Owner's stretched "year" select screenshot, 8/15). Content
     width + a fixed 7px-right chevron reads as a standard select everywhere. */
  .cust select { cursor:pointer; width:auto; max-width:100%; appearance:none; -webkit-appearance:none;
    padding-right:22px;
    background:#fff url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%23797979' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>") no-repeat right 7px center; }
  .wrap { position:relative; flex:1 1 0; height:auto; min-height:150px; max-height:430px; }
  .svghost { position:absolute; inset:0; touch-action:pan-y; }
  .svghost svg { position:absolute; inset:0; width:100%; height:100%; }
  .svgtip { position:absolute; left:0; top:0; display:none; pointer-events:auto; background:#fff; border:1px solid #e4e4e4; border-radius:6px; padding:10px; font:12px Inter; color:#3d3d3d; white-space:nowrap; z-index:5; will-change:transform; }
  .svgtip .t { font-weight:600; color:#1a1a1a; margin-bottom:6px; }
  .svgtip .r { display:flex; align-items:center; height:14.4px; }
  .svgtip .r + .r { margin-top:2px; }
  .svgtip .chip { width:12px; height:12px; display:inline-block; margin-right:14px; flex:0 0 auto; }
  /* Stacked-view day blow-up: full-bleed bands that cancel the panel padding */
  .daystack { margin:0 -6px 10px -10px; }
  .daystack .ds-band { display:flex; height:44px; }
  .daystack .ds-band > div { min-width:2px; border-right:1px solid rgba(255,255,255,0.85); }
  .daystack .ds-band > div:last-child { border-right:0; }
  .daystack .ds-sub { display:block; width:100%; height:10px; }
  .daystack .ds-leg { display:flex; gap:10px; margin-top:4px; padding:0 10px; font-size:11px; color:#797979; }
  .daystack .ds-leg .ds-dot { width:8px; height:8px; border-radius:50%; display:inline-block; vertical-align:middle; margin-right:4px; }
  /* Short viewports (a phone, or a fixed-height Notion embed) get both cards without scrolling. */
  /* Owner 8/15: divider between Macros and Workout removed; spacing tightened
     too, since the point was vertical room. */
  .card + .card { margin-top:14px; padding-top:6px; border-top:0; }
  .row2 { display:none; align-items:center; margin-top:10px; }
  .row2.on { display:flex; }
  .empty { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
           font-size:12px; color:#797979; text-align:center; padding:0 20px; }
  .err { font-size:13px; color:#b3261e; white-space:pre-wrap; }
  .foot { margin-top:16px; font-size:11.5px; }
  .foot a { color:#797979; text-decoration:none; border-bottom:1px solid #e4e4e4; }
  .foot a:hover { color:#1a1a1a; }
  /* The values are four digits at most, so the fields are sized to the digits.
     Vertical rhythm is unchanged. */
  .goals { max-width:200px; }
  .goals .grow { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:4px 0; }
  .goals label { font-size:13px; color:#1a1a1a; }
  .goals .u { font-size:11.5px; color:#797979; margin-left:6px; }
  .goals input { font:inherit; font-size:13px; width:62px; text-align:right; color:#1a1a1a; background:#fff;
                 border:1px solid #e4e4e4; border-radius:6px; padding:6px 8px; }
  /* No native stepper arrows; still a numeric field for keyboards and validation. */
  .goals input::-webkit-outer-spin-button,
  .goals input::-webkit-inner-spin-button { -webkit-appearance:none; appearance:none; margin:0; }
  .goals input[type=number] { -moz-appearance:textfield; appearance:textfield; }
  .goals button { font:inherit; font-size:13px; margin-top:14px; padding:8px 14px; border:1px solid #d8d8d8;
                  border-radius:6px; background:#f4f4f4; color:#1a1a1a; cursor:pointer; }
  .ok { font-size:12.5px; color:#3E7C4F; margin-top:10px; }
  /* The goals editor opens over the chart instead of navigating away: the
     values are already in the page, so there is nothing to fetch to show it. */
  .gpanel { position:fixed; inset:0; z-index:20; display:flex; align-items:center; justify-content:center;
            background:rgba(26,26,26,0.18); padding:12px;
            opacity:0; transition:opacity 0.3s ease; }
  .gpanel.show { opacity:1; }
  .gpanel.hiding { transition-duration:0.15s; }
  .gpanel[hidden] { display:none; }
  /* Bar blow-up overlay: a bar click fans the bar into its item stack on a
     side panel while the chart pans out from under it. */
  .card, .hcard { position:relative; }
  .wrap { overflow:hidden; }
  .legend { flex-wrap:wrap; row-gap:12px; }
  /* Bar/sleep blow-up: an unboxed sidebar laid out inside the card. The chart
     wrap shrinks to make room; the panel runs the full chart height with no
     boxed chrome, reading as an extension of the chart area. */
  .blow { position:absolute; z-index:16; background:transparent; padding:0 6px 0 10px; display:flex; flex-direction:column; box-sizing:border-box; }
  .blow-head { font-size:14px; font-weight:600; margin-bottom:10px; }
  .blow-body { display:flex; gap:10px; flex:1; min-height:0; position:relative; }
  .blow-bar { flex:none; width:34px; display:flex; flex-direction:column; border-radius:6px; overflow:hidden; background:#f4f4f4; }
  .blow-bar > div { min-height:3px; border-top:1px solid rgba(255,255,255,0.9); }
  .blow-bar > div:first-child { border-top:0; }
  /* Workout burn segment (Owner 8/19): hatched top of the Calories blow-up's
     stacked bar + matching hatched row dot - reads as "estimate", not food. */
  .bseg-wo { background:repeating-linear-gradient(135deg,#fafbfc 0px,#fafbfc 4px,#ced3da 4px,#ced3da 6px); }
  .blow-item .dot.wodot { background:repeating-linear-gradient(135deg,#fff 0px,#fff 2px,#d2d7de 2px,#d2d7de 4px); border:1px solid #ccd1d8; }
  /* Rows spread across the full sidebar height; the bar next to them fills it
     too, head to Total - nothing floats at the top with dead space below. */
  /* Rows are absolutely positioned against their bar segment's midpoint (see
     blowPanel's layout pass), so every row sits across from its own slice. */
  .blow-list { flex:1; min-width:0; overflow:hidden; font-size:12px; position:relative; }
  .blow-item { display:flex; align-items:center; gap:8px; padding:3px 4px; border-radius:4px; color:inherit; text-decoration:none; }
  .blow-item .dot { width:8px; height:8px; border-radius:50%; flex:none; }
  .blow-item .n { flex:1; min-width:0; }
  .blow-item .v { flex:none; }
  .blow-head a { color:inherit; text-decoration:none; }
  a.blow-item:hover .n, .blow-head a:hover { text-decoration:underline; }
  .blow-item .n { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .blow-item .v { color:#797979; flex:none; }
  /* In-app record sheet: the food item's record rendered locally so a row tap
     never pays Notion's load; data is embedded in this page already. */
  .rsheet-back { position:fixed; left:0; right:0; top:0; bottom:0; z-index:40; background:rgba(0,0,0,0.28);
                 display:flex; align-items:flex-start; justify-content:center; padding-top:15vh; box-sizing:border-box;
                 opacity:0; transition:opacity 0.3s ease; }
  /* Same fade in/out as the Edit Macro Goals panel (Owner 8/17). */
  .rsheet-back.show { opacity:1; }
  .rsheet-back.hiding { transition-duration:0.15s; }
  .rsheet { width:min(320px, calc(100% - 32px)); background:#fff; border-radius:12px; box-shadow:0 8px 30px rgba(0,0,0,0.16);
            padding:16px 16px 12px; font-size:12.5px; }
  .rsheet-head { font-size:14px; font-weight:600; margin-bottom:4px; }
  .rsheet-big { font-size:26px; font-weight:600; margin-bottom:10px; }
  .rsheet-big span { font-size:12px; color:#797979; font-weight:400; }
  .rsheet-row { display:flex; justify-content:space-between; padding:3px 0; }
  .rsheet-row .rsheet-k { color:#797979; }
  /* Narrow/touch: the blow-up docks as a plain block under the chart instead
     of an absolute side panel, so it never covers the plot. */
  /* Owner 8/17: fixed bottom-sheet dock reverted at their request ("Whatever auto
     scroll thing you fixed revert that") - back to the in-flow dock that
     stacks the pane below the chart. */
  .blow.narrow { position:static; width:auto; left:auto; top:auto; height:auto; margin-top:8px; padding:8px 2px 0; border-top:1px solid #ebebeb; }
  /* Owner 8/17: bottom sheet removed for good ("the blowup thing on mobile is
     broken... moved locations to the bottom or something"). position:fixed
     bottom:0 inside the tall Notion embed iframe docks at the IFRAME's bottom
     edge - below the visible screen - so the pane looked broken/moved. All
     narrow blow panes now use the plain in-flow dock below the chart. */
  /* The bar stays vertical on narrow too - same direction as desktop: the
     narrow-only horizontal rotation is removed, not accommodated (Owner). */
  .blow.narrow .blow-body { display:flex; flex:none; min-height:0; position:static; height:auto !important; }
  /* Same vertical extent as the desktop side panel: the stretch-filled bar
     runs flush from the list's top edge down to the Total row's BOTTOM edge.
     (The old 2px/8px margins were horizontal-rotation leftovers and parked
     the bar's end halfway up the Total row.) */
  .blow.narrow .blow-bar { margin:0; }
  .blow.narrow .blow-list { position:static; overflow:visible; font-size:12.5px; }
  .blow.narrow .blow-item { position:static !important; top:auto !important; left:auto !important; padding:6px 4px; }
  .blow.narrow .blow-total { position:static; margin-top:2px; }
  /* Stacked day blow-up: the full-bleed band is the graphic, so the body is a
     plain list - no inset bar, no leader lines, rows in normal flow. */
  .blow.dayblow .blow-bar, .blow.dayblow .blow-leaders { display:none; }
  /* Average numbers pane (Owner 8/18): docks like a blow-up - 100px squish-left
     panel on desktop, in-flow below the chart on mobile; rows are a series
     dot, a red triangle + % off goal (only beyond 5%), and the value. */
  .avgplist { padding:12px 16px; position:relative; }
  .blow.avgp:not(.narrow) .avgplist { height:100%; box-sizing:border-box; display:flex; flex-direction:column; justify-content:space-evenly; padding:0 16px; }
  .blow.avgp.narrow { position:relative; }
  .blow.avgp.narrow .avgplist { height:100%; box-sizing:border-box; display:flex; flex-direction:column; justify-content:space-evenly; }
  .avgprow .alead { flex:1; min-width:6px; height:1px; opacity:.6; }
  .blow.avgp.narrow .avgprow .aclus { margin-left:0; }
  .avgprow { display:flex; align-items:center; gap:6px; padding:7px 0; font-size:11px; white-space:nowrap; font-weight:500; color:#1a1a1a; }
  .avgprow .dot { width:8px; height:8px; border-radius:50%; flex:none; }
  .avgprow .agoal { color:#d64545; }
  .avgprow .aclus { margin-left:auto; display:flex; align-items:center; gap:4px; white-space:nowrap; }
  .avgprow .aval { min-width:32px; text-align:right; }
  .avgprow .dot + .aval { margin-left:auto; }
  .blow.dayblow .blow-list { position:static; overflow-y:auto; }
  .blow.dayblow .blow-item { position:static !important; top:auto !important; left:auto !important; padding:6px 4px; }
  .blow.dayblow .blow-total { position:static; margin-top:6px; }
  /* Strip-size embeds (a Notion embed block is ~150px tall and NOT resizable
     in the phone app): there is no room below the chart, so the blow-up
     overlays the strip itself with its own scroll instead. */
  .blow.compact { position:fixed; left:0; top:0; right:0; z-index:30; max-height:100%; overflow:auto;
                  background:#fff; box-shadow:0 2px 10px rgba(0,0,0,0.14); padding:6px 10px; border-top:0; margin-top:0; }
  .blow.compact .blow-head { margin-bottom:4px; }
  .blow-total { position:absolute; left:4px; right:4px; bottom:0; display:flex; justify-content:space-between; gap:8px; padding-top:3px; font-weight:600; border-top:1px solid #f2f2f2; white-space:nowrap; }
  .blow-empty { color:#797979; font-size:13px; padding:12px 2px; }
  .gpanel .card { flex:0 0 auto; background:#fff; border:1px solid #e4e4e4; border-radius:10px;
                  padding:14px 16px 16px; box-shadow:0 10px 30px rgba(0,0,0,0.14); max-height:100%; max-width:100%; overflow:auto; }
  .gpanel .head { gap:16px; margin-bottom:2px; }
  .gpanel .x2 { font:inherit; font-size:15px; line-height:1; color:#797979; background:none; border:0;
                padding:2px 4px; cursor:pointer; margin-left:auto; }
  .gpanel .x2:hover { color:#1a1a1a; }
  /* Very narrow embeds (a small Notion column) can't fit a joined pill row,
     so the segmented control becomes separate chips instead of clipping. */
  @media (max-width: 340px) {
    /* A one-per-row legend eats the whole card in a narrow embed, so pair them up. */
    .legend { display:grid; grid-template-columns:1fr 1fr; gap:5px 10px; margin:10px 0 8px; }
    .legend .item { font-size:10.5px; gap:5px; }
    .seg { border:0; border-radius:0; gap:6px; flex-wrap:wrap; overflow:visible; }
    .seg button, .seg a { border:1px solid #e4e4e4; border-radius:6px; }
    .seg button.on, .seg a.on { border-color:#d8d8d8; }
  }
  @media (max-height: 420px) {
    /* Tiny embed strips (Notion's non-resizable app embed): keep the whole
       dashboard legible instead of squashing two full cards into nothing. */
    body { padding:6px 10px 8px; }
    .title { font-size:13px; }
    .head { gap:8px; }
    .seg button, .seg a { font-size:10.5px; padding:4px 7px; }
    .legend { margin:5px 0; gap:4px 12px; }
    .legend .item { font-size:10.5px; gap:4px; }
    .legend .sw { width:8px; height:8px; }
    .wrap { min-height:60px; }
    .card + .card { margin-top:8px; padding-top:6px; }
    .row2 { margin-top:4px; }
    .foot { margin-top:4px; }
    .blow-head { font-size:12px; }
  }
  /* Workout table editor: a pixel-faithful copy of the split's Notion
     database view. Header row frozen (sticky), first (Days) column frozen,
     a 5-day row window underneath. Light theme values match Notion's app:
     text #37352f, secondary rgba(55,53,47,.65), borders #e9e9e7, hover #f7f6f3,
     selection accent #2383e2. */
  /* Rows are windowed (<=5) around the clicked day, so the scroller hugs its
     content instead of stretching to fill a tall panel: no vertical body
     scroll, no empty-row gap at data edges. Horizontal scroll stays - the
     full Notion column set is wider than the panel. */
  .nkt-scroller { flex:1 1 auto; min-height:0; overflow-x:auto; overflow-y:auto; margin:0 -10px; border-top:1px solid #e9e9e7;
                  scrollbar-width:none; -ms-overflow-style:none; }
  /* Owner 8/15: hide the scrollbar tracks entirely - scrolling still works,
     "the user knows they can move around". */
  .nkt-scroller::-webkit-scrollbar { display:none; }
  .blow.narrow .nkt-scroller { max-height:52vh; overflow-y:auto; }
  .nkt { border-collapse:separate; border-spacing:0; width:max-content; min-width:100%;
         font-family: ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  .nkt th, .nkt td { border-right:1px solid #e9e9e7; border-bottom:1px solid #e9e9e7;
                     background:#fff; text-align:left; vertical-align:top; white-space:pre-wrap; }
  .nkt th { position:sticky; top:0; z-index:3; font-size:12px; font-weight:500; color:rgba(55,53,47,0.65);
            padding:6px 8px; line-height:1.2; min-width:44px; }
  .nkt td { font-size:14px; font-weight:400; color:#37352f; padding:5px 8px; max-width:220px; }
  .nkt thead svg.nkpi { display:inline; vertical-align:-2px; margin-right:5px; }
  .nkt th:first-child, .nkt td:first-child { position:sticky; left:0; z-index:2; box-shadow:1px 0 0 #e9e9e7; min-width:48px; }
  .nkt th:first-child { z-index:4; }
  .nkt tr:hover td { background:#f7f6f3; }
  .nkt tr:focus-within td { background:#f7f6f3; }
  .nkt tr.focus td { background:#f7f6f3; }
  .nkt td.nkt-wt { color:rgba(55,53,47,0.65); min-width:52px; }
  .nkt th.nkt-wt { color:rgba(55,53,47,0.45); }
  .nkt-cell { min-width:80px; }
  .nkt-editor { outline:none; min-height:20px; min-width:56px; border-radius:4px; padding:1px 3px; cursor:text; }
  /* Owner 8/15: no hover fill either - the gray box over empty cells read as
     noise next to Notion's calm hover state. */
  /* Owner 8/15: no blue bounding boxes anywhere in the editor - focus reads
     via the row background wash only. */
  .nkt-editor:focus { background:#fff; }
  .nkt-editor.busy { opacity:0.55; }
  .nkt td.focus { position:relative; }
  .nkt-datecol, .nkt-daycol { color:#37352f; min-width:56px; }
  .nkt th.hlfocus { color:#37352f; }
  .nkt-daycol { font-weight:500; }
  .wkstatus { font-size:12px; color:#797979; padding-top:6px; min-height:16px; }
  .wkstatus.ok { color:#3E7C4F; }
  .wkstatus.err { color:#b3261e; }
  @media (max-width: 520px) {  @media (max-width: 520px) {
    body { padding:12px 12px 14px; }
    .title { font-size:14px; }
    .head { flex-wrap:wrap; gap:8px 10px; }
    .head .seg { margin-left:0; }
    .row2 { flex-wrap:wrap; gap:8px 10px; }
    .row2 .seg { margin-left:0; }
    .seg { max-width:100%; }
    .seg button, .seg a { padding:7px 9px; font-size:11px; white-space:nowrap; }
    .legend { gap:7px 14px; margin:12px 0 10px; }
    .legend .item { font-size:11px; gap:6px; }
    .legend .x { margin-left:0; padding:6px; margin:-6px -6px -6px 0; font-size:13px; }
    .cust input, .cust select { padding:7px 8px; }
    .cust select { padding-right:22px; }
    .card + .card { margin-top:18px; padding-top:16px; }
  }
  @media (max-width: 520px) and (min-height: 561px) {
    /* Real phone viewports (embed strips are far shorter): pinning both cards
       to equal shares of a short window is what squished the charts. The
       chart gets the desktop share's height (~320px) and the page scrolls. */
    body { height:auto; min-height:100%; }
    .card { flex:none; }
    .wrap { height:320px; min-height:320px; max-height:320px; }
  }
`;

function goalsPage(goals, ek, saved) {
  // Coming from the chart, "back" is a history pop: the browser restores the
  // page it already has instead of re-fetching it. After a save it has to be a
  // real load, so the new goal lines are in the page.
  const backScript = saved ? "" : `<script>
document.getElementById('back').addEventListener('click', e => {
  if (history.length > 1 && document.referrer && new URL(document.referrer).origin === location.origin) {
    e.preventDefault(); history.back();
  }
});
<\/script>`;
  const back = ek ? "/?k=" + encodeURIComponent(ek) : "/";
  const action = ek ? "/goals?k=" + encodeURIComponent(ek) : "/goals";
  const rows = GOAL_FIELDS.map(([key, label, unit]) =>
    `<div class="grow"><label for="${key}">${label}<span class="u">${unit}</span></label>` +
    `<input id="${key}" name="${key}" type="number" step="any" min="0" value="${goals[key]}"></div>`
  ).join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>macro goals</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="preload" as="style" onload="this.onload=null;this.rel='stylesheet'"><noscript><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet"></noscript>
<style>${CSS}</style></head>
<body>
<div class="card goals">
  <div class="head"><span class="title">Macro goals</span></div>
  <form method="post" action="${action}">
    ${rows}
    <button type="submit">Save</button>
  </form>
  ${saved ? '<p class="ok">Saved. The chart picks these up within a minute.</p>' : ""}
  <div class="foot"><a id="back" href="${back}">Back to the chart</a></div>
${backScript}
</div>
</body></html>`;
}



// The chart app body: static JS served external at /app.js so repeat loads use
// the immutable cache instead of re-parsing 200KB of inline script on every nav.
const APP_JS = `const GATE_TOKEN = window.__D.gateToken;
const EMBED_K = window.__D.embedK;
(function () {
  const a = document.getElementById('goalslink');
  if (a && EMBED_K) a.href = '/goals?k=' + encodeURIComponent(EMBED_K);
})();
try { if (GATE_TOKEN) localStorage.setItem('cbum_gate_token', GATE_TOKEN); } catch (e) {}
const gateFetch = (u, o) => {
  o = o || {};
  o.credentials = 'same-origin';
  if (EMBED_K) u = u + (u.indexOf('?') < 0 ? '?' : '&') + 'k=' + encodeURIComponent(EMBED_K);
  o.headers = Object.assign({}, o.headers || {}, GATE_TOKEN ? { 'X-Gate': GATE_TOKEN } : {});
  return fetch(u, o);
};
let ROWS = window.__D.rows;
// Day -> Notion tracker page, server-owned map above. Only days present here
// are clickable; on touch devices tapping a day does nothing.
const DAY_PAGES = window.__D.dayPages;
const isDesktop = () => matchMedia('(hover: hover) and (pointer: fine)').matches;
let META = window.__D.meta;
let WK = window.__D.wkSplits;
let WKERR = window.__D.wkErrors;
let ORDER = window.__D.wkOrder;
let ITEMS = window.__D.items;
// Short display names (LLM-curated, cached in KV). Notion stays the source of truth;
// anything without a short name falls back to the full name, minus its trailing parenthetical.
const SHORTS = ITEMS.__short || {}; delete ITEMS.__short;
// Item tuple: [name, calories, protein, carbs, fat, satfat, sugar, fiber, sodium]
const ITEM_KEYS = ['calories','protein','carbs','fat','satfat','sugar','fiber','sodium'];
const CAL_TARGET = window.__D.calTarget, PRO_TARGET = window.__D.proTarget;
const GREEN = '#3E7C4F', ORANGE = '#eb6e00', GRID = '#ececec', AXIS = '#c1c1c1', TICK = '#797979';
// Every macro the tracker rolls up. goal:null means no target has been set for
// it yet - that series gets bars and nothing else, no invented dotted line.
// Axis 'y' carries the big-number units (kcal, mg), 'y1' carries grams, so the
// single-digit macros aren't flattened against calories.
const GOALS = window.__D.goals;
const GOAL_FIELDS = window.__D.goalFields;
const MACROS = [
  { key: 'calories', label: 'Calories',      unit: 'kcal', color: GREEN,     axis: 'y',  goal: CAL_TARGET },
  { key: 'protein',  label: 'Protein (g)',   unit: 'g',    color: ORANGE,    axis: 'y1', goal: PRO_TARGET },
  { key: 'sodium',   label: 'Sodium (mg)',   unit: 'mg',   color: '#d1a400', axis: 'y',  goal: null },
  { key: 'carbs',    label: 'Carbs (g)',     unit: 'g',    color: '#3d7fd6', axis: 'y1', goal: null },
  { key: 'fat',      label: 'Fat (g)',       unit: 'g',    color: '#d64545', axis: 'y1', goal: null },
  { key: 'satfat',   label: 'Sat fat (g)',   unit: 'g',    color: '#8b5cd6', axis: 'y1', goal: null },
  { key: 'sugar',    label: 'Sugar (g)',     unit: 'g',    color: '#d64592', axis: 'y1', goal: null },
  { key: 'fiber',    label: 'Fiber (g)',     unit: 'g',    color: '#1fa39b', axis: 'y1', goal: null },
];
for (const m of MACROS) if (GOALS[m.key] !== undefined && GOALS[m.key] !== null) m.goal = GOALS[m.key];
// Core preset by default; detail macros start hidden.
const mHidden = { fat: true, satfat: true, sugar: true, fiber: true };
const shownMacros = () => MACROS.filter(m => !mHidden[m.key]);
// Legend order (MACROS above) and bar order are deliberately different: the
// legend reads calories/protein/sodium/carbs, the bars within a day read
// calories/sodium/carbs/protein.
const BAR_ORDER = ['calories', 'sodium', 'carbs', 'protein', 'fat', 'satfat', 'sugar', 'fiber'];
const plotOrder = list => list.slice().sort((a, b) => BAR_ORDER.indexOf(a.key) - BAR_ORDER.indexOf(b.key));

/* ---- shared look: both charts read from here, so one edit moves both ---- */
const THEME = {
  font: 'Inter, -apple-system, Segoe UI, Helvetica, Arial',
  tickSize: 11, labelSize: 12,
  grid: GRID, axis: AXIS, tick: TICK,
  // Macros keeps the Rows green/orange; the workout lines use a softer pastel set.
  series: [GREEN, ORANGE],
  pastel: ['#63bd93', '#f0a468', '#7ba6ee', '#ec8c8c', '#b193de', '#6cc4cc', '#dcbc63', '#ed94bf', '#98a7b8']
};
const tickCfg = () => ({ color: THEME.tick, font: { size: THEME.tickSize, family: THEME.font } });
if (typeof Chart !== "undefined") Chart.Interaction.modes.colAbove = function(chart, e, opts) {
  /* The tooltip zone is ONLY the space directly above the tallest bar of the
     hovered day: horizontally inside THAT stack's own span, vertically above
     its top (4px anti-flicker guard). A day holding side-by-side stacks
     (Detail mode) answers only above the tall one - the air above the short
     stack, on-bar, below the top, beside and between days: silence. */
  const els = Chart.Interaction.modes.index(chart, e, opts || {});
  if (!els.length) return els;
  // Group the column's bars by stack position and keep the tallest one.
  const stacks = new Map();
  for (const el of els) {
    const bar = chart.getDatasetMeta(el.datasetIndex).data[el.index];
    if (!bar || typeof bar.y !== 'number') continue;
    const key = Math.round(bar.x);
    let g = stacks.get(key);
    if (!g) stacks.set(key, g = { top: Infinity, minX: Infinity, maxX: -Infinity });
    if (bar.y < g.top) g.top = bar.y;
    const w = bar.width || 0;
    if (bar.x - w / 2 < g.minX) g.minX = bar.x - w / 2;
    if (bar.x + w / 2 > g.maxX) g.maxX = bar.x + w / 2;
  }
  let tall = null;
  for (const g of stacks.values()) if (!tall || g.top < tall.top) tall = g;
  if (!tall) return [];
  if (e.x >= tall.minX - 4 && e.x <= tall.maxX + 4 && e.y < tall.top + 4) return els;
  return [];
};
const tooltipCfg = () => ({
  // Hover has to land on the same frame: no fade-in, no position easing.
  animation: false, animations: false,
  position: 'groupCenter', xAlign: 'center', yAlign: 'bottom', caretSize: 0, caretPadding: 8,
  backgroundColor: '#fff', titleColor: '#1a1a1a', bodyColor: '#3d3d3d', borderColor: '#e4e4e4',
  borderWidth: 1, padding: 10, cornerRadius: 6, displayColors: true, usePointStyle: true,
  filter: it => it.parsed.y !== null && it.parsed.y !== undefined,
  titleFont: { size: THEME.labelSize, weight: '600', family: 'Inter' },
  bodyFont: { size: THEME.labelSize, family: 'Inter' }
});
const baseOptions = () => ({
  responsive: true, maintainAspectRatio: false, animation: false,
  devicePixelRatio: Math.max(2, window.devicePixelRatio || 1),
  layout: { padding: { top: 4, right: 2, bottom: 34, left: 0 } },
  interaction: { mode: 'colAbove', intersect: false },
  plugins: { legend: { display: false },
             tooltip: Object.assign(tooltipCfg(), { enabled: !(window.innerWidth <= 560 || (navigator.maxTouchPoints || 0) > 0) }) },
  scales: {}
});
/* Canvas crispness: chart.js rounds the backing store to integer device px
   while keeping the CSS size fractional; the browser then scales the canvas
   by a ~1.00x non-integer factor and text/bars go soft. Clamp the CSS size to
   integer pixels and rebuild the backing store to match 1:dpr exactly. */
/* ================= SVGCharts: pure-SVG renderer for the main page =================
   Replaces Chart.js canvas on the macros card. Scale math, tick generation,
   layout, bar/line geometry, tooltip geometry and the anchor x-axis are a
   1:1 port of Chart.js 4.4.1 (the exact version this Worker serves), so the
   SVG build renders pixel-equivalent to the canvas build. No library, no
   canvas, no rAF: renders are full synchronous rebuilds; hover and tooltip
   refreshes touch attributes only. */
const SVGCharts = (function () {
  'use strict';

  /* ---- numeric helpers (chart.js 4.4.1 helpers.segment.js) ---- */
  function almostEquals(x, y, e) { return Math.abs(x - y) < e; }
  function niceNum(range) {
    const roundedRange = Math.round(range);
    range = almostEquals(range, roundedRange, range / 1000) ? roundedRange : range;
    const niceRange = Math.pow(10, Math.floor(Math.log10(range)));
    const fraction = range / niceRange;
    const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
    return niceFraction * niceRange;
  }
  function decPlaces(x) {
    if (!isFinite(x)) return 0;
    let e = 1, p = 0;
    while (Math.round(x * e) / e !== x) { e *= 10; p++; if (p > 20) break; }
    return p;
  }
  // generateTicks$1: linear numeric with defaults (bounds 'ticks',
  // includeBounds true, no explicit min/max/step/precision/count).
  function genNumericTicks(rmin, rmax, maxTicks, maxDigits) {
    const MIN_SPACING = 1e-14;
    const unit = 1;
    const maxSpaces = maxTicks - 1;
    let spacing = niceNum((rmax - rmin) / maxSpaces / unit) * unit;
    let niceMin, niceMax, numSpaces;
    if (spacing < MIN_SPACING) return [{ value: rmin }, { value: rmax }];
    numSpaces = Math.ceil(rmax / spacing) - Math.floor(rmin / spacing);
    if (numSpaces > maxSpaces) spacing = niceNum(numSpaces * spacing / maxSpaces / unit) * unit;
    if (spacing < 1) spacing = 1; /* whole-integer ticks (Owner 8/15) */
    niceMin = Math.floor(rmin / spacing) * spacing;
    niceMax = Math.ceil(rmax / spacing) * spacing;
    numSpaces = (niceMax - niceMin) / spacing;
    if (almostEquals(numSpaces, Math.round(numSpaces), spacing / 1000)) numSpaces = Math.round(numSpaces);
    else numSpaces = Math.ceil(numSpaces);
    const factor = Math.pow(10, Math.max(decPlaces(spacing), decPlaces(niceMin)));
    niceMin = Math.round(niceMin * factor) / factor;
    niceMax = Math.round(niceMax * factor) / factor;
    const ticks = [];
    for (let j = 0; j < numSpaces; ++j) ticks.push({ value: Math.round((niceMin + j * spacing) * factor) / factor });
    ticks.push({ value: niceMax });
    return ticks;
  }
  function calcTickDelta(tickValue, ticks) {
    let delta = ticks.length > 3 ? ticks[2].value - ticks[1].value : ticks[1].value - ticks[0].value;
    if (Math.abs(delta) >= 1 && tickValue !== Math.floor(tickValue)) delta = tickValue - Math.floor(tickValue);
    return delta;
  }
  // Ticks.formatters.numeric
  function numericTickLabel(tickValue, index, ticks) {
    if (tickValue === 0) return '0';
    let delta = tickValue, sci = false;
    if (ticks.length > 1) {
      const maxTick = Math.max(Math.abs(ticks[0].value), Math.abs(ticks[ticks.length - 1].value));
      if (maxTick < 1e-4 || maxTick > 1e+15) sci = true;
      delta = calcTickDelta(tickValue, ticks);
    }
    const logDelta = Math.log10(Math.abs(delta));
    const numDecimal = 0; /* whole-integer chart labels only (Owner 8/15) */
    const o = { minimumFractionDigits: numDecimal, maximumFractionDigits: numDecimal };
    if (sci) o.notation = 'scientific';
    return new Intl.NumberFormat(undefined, o).format(tickValue);
  }

  /* ---- text measurement (labels sized like the canvas build) ---- */
  let mctx = null;
  let mcache = {};
  function measureText(text, fontString) {
    if (!mctx) mctx = document.createElement('canvas').getContext('2d');
    const key = fontString + '|' + text;
    let w = mcache[key];
    if (w === undefined) { mctx.font = fontString; w = mctx.measureText(text).width; mcache[key] = w; }
    return w;
  }

  // tick font strings + line height (chart.js toFont lineHeight = size*1.2)
  function tickFonts(theme) {
    return {
      f400: '400 ' + theme.tickSize + 'px Inter',
      f600: '600 ' + theme.tickSize + 'px Inter',
      lineH: Math.round(theme.tickSize * 1.2)
    };
  }

  function alignPixel(pixel, width, dpr) {
    const halfWidth = width !== 0 ? Math.max(width / 2, 0.5) : 0;
    return Math.round((pixel - halfWidth) * dpr) / dpr + halfWidth;
  }

  /* ---- linear y-scale (chart.js LinearScaleBase, beginAtZero) ----
     cfg: { position:'left'|'right', display:bool, values:[num|null],
            suggestedMax, suggestedMin, goals:[{value,color}],
            hostH (full canvas height, like the real pre-layout tick build) } */
  function makeLinearScale(cfg, theme, fonts) {
    const s = {
      id: cfg.id, position: cfg.position, display: !!cfg.display,
      horizontal: false, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0,
      paddingTop: 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0,
      weight: 1, fullSize: false, isScale: true
    };
    let dataMin = Infinity, dataMax = -Infinity;
    (cfg.values || []).forEach(v => {
      if (v === null || v === undefined || !isFinite(v)) return;
      if (v < dataMin) dataMin = v;
      if (v > dataMax) dataMax = v;
    });
    let min = Math.min(cfg.suggestedMin !== undefined ? cfg.suggestedMin : Infinity, dataMin);
    let max = Math.max(cfg.suggestedMax !== undefined ? cfg.suggestedMax : -Infinity, dataMax);
    if (cfg.hardMax !== undefined && cfg.hardMax !== null) max = cfg.hardMax; // Owner 8/17: avg Detail grams axis capped at 150
    if (!isFinite(min)) min = 0;
    if (!isFinite(max)) max = 1;
    // handleTickRangeOptions with beginAtZero true
    const minSign = min < 0 ? -1 : min > 0 ? 1 : 0;
    const maxSign = max < 0 ? -1 : max > 0 ? 1 : 0;
    if (minSign < 0 && maxSign < 0) max = 0;
    else if (minSign > 0 && maxSign > 0) min = 0;
    if (min === max) { const off = max === 0 ? 1 : Math.abs(max * 0.05); max += off; }
    s.min = min; s.max = max;
    // tick limit: linear computeTickLimit from pre-layout canvas height
    const length = cfg.hostH;
    const tickAuto = Math.ceil(length / Math.min(40, fonts.lineH));
    const maxTicks = Math.max(2, Math.min(11, tickAuto));
    const maxDigits = length / fonts.lineH;
    let ticks = genNumericTicks(s.min, s.max, maxTicks, maxDigits);
    s.min = ticks.length ? ticks[0].value : s.min;   // bounds 'ticks'
    s.max = ticks.length ? ticks[ticks.length - 1].value : s.max;
    // Owner 8/17: a hard cap (avg Detail grams axis at 150) also bounds the
    // auto-tick expansion - nice-number ticking would otherwise round the
    // axis out to 200 past the cap.
    if (cfg.hardMax !== undefined && cfg.hardMax !== null && s.max > cfg.hardMax) {
      ticks = ticks.filter(t => t.value <= cfg.hardMax);
      s.max = cfg.hardMax;
    }
    // afterBuildTicks withGoals: an auto tick within 40% of a step of a goal
    // gives way; goals land on the axis even if auto ticks skip them.
    const goals = cfg.goals || [];
    if (goals.length && s.display) {
      const step = ticks.length > 1 ? Math.abs(ticks[1].value - ticks[0].value) : 0;
      ticks = ticks.filter(t => !goals.some(g => t.value !== g.value && Math.abs(t.value - g.value) < step * 0.4));
      for (const g of goals) { if (cfg.hardMax != null && g.value > cfg.hardMax) continue; if (!ticks.some(t => t.value === g.value)) ticks.push({ value: g.value }); }
      ticks.sort((p, q) => p.value - q.value);
    }
    // tick labels + per-tick color/weight (goalTick cfg)
    s.ticks = ticks.map((t, i) => {
      const goal = goals.find(g => g.value === t.value);
      return {
        value: t.value,
        label: numericTickLabel(t.value, i, ticks),
        color: goal ? goal.color : theme.tick,
        weight: goal ? '600' : '400',
        width: 0, height: fonts.lineH
      };
    });
    s.ticks.forEach(t => { t.width = measureText(t.label, t.weight === '600' ? fonts.f600 : fonts.f400); });
    s.widest = s.ticks.reduce((a, t) => Math.max(a, t.width), 0);
    s.lineH = fonts.lineH;
    s.tickPadding = 3; // chart.js ticks.padding default
    // value -> css px inside the (later-placed) box
    s.pixelForValue = function (value) {
      if (value === null || value === undefined) return NaN;
      const dec = (value - this.min) / (this.max - this.min);
      // vertical scale, _reversePixels true
      return this.top + (1 - dec) * (this.bottom - this.top);
    };
    return s;
  }

  /* ---- layout: chart.js 4.4.1 core.layouts.update ported, specialized to
     {left?, right?, bottom} boxes with no stacks ---- */
  function layoutChart(W, H, scalesY, xN, padding) {
    // x category scale frame (no tick labels drawn: height 0)
    const x = { id: 'x', position: 'bottom', horizontal: true, display: true,
      width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0,
      n: xN, isScale: true };
    const boxes = [];
    scalesY.forEach(s => { if (s) boxes.push({ s: s, pos: s.position, horizontal: false }); });
    boxes.push({ s: x, pos: 'bottom', horizontal: true });

    const availW = Math.max(W - padding.l - padding.r, 0);
    const availH = Math.max(H - padding.t - padding.b, 0);
    const visibleVertical = Math.max(boxes.filter(b => !b.horizontal && b.s.display).length, 1);
    const vBoxMaxWidth = availW / 2 / visibleVertical;
    const hBoxMaxHeight = availH / 2;
    const maxPadding = { l: padding.l, t: padding.t, r: padding.r, b: padding.b };
    const chartArea = { left: padding.l, top: padding.t, right: padding.r, bottom: padding.b,
      w: availW, h: availH, x: padding.l, y: padding.t };

    function scaleUpdate(s, maxWidth, maxHeight, margins) {
      // reset scale-internal paddings each fit
      s.paddingTop = 0; s.paddingBottom = 0; s.paddingLeft = 0; s.paddingRight = 0;
      if (s.isScale && !s.horizontal) {
        if (s.display && s.ticks.length) {
          const labelWidth = s.widest;
          s.width = Math.min(maxWidth, 0 + labelWidth + s.tickPadding * 2);
          s.paddingTop = s.lineH / 2 + s.tickPadding;   // _calculatePadding vertical
          s.paddingBottom = s.lineH / 2 + s.tickPadding;
        } else {
          s.width = 0;
        }
        s._margins = margins;
        s._margins.top = Math.max(s.paddingTop, s._margins.top);
        s._margins.bottom = Math.max(s.paddingBottom, s._margins.bottom);
        s.height = maxHeight - s._margins.top - s._margins.bottom;
      } else if (s.isScale && s.horizontal) {
        s.width = maxWidth; s.height = 0;
        s._margins = margins;
      }
    }
    function getPaddingOf(s) {
      return { l: s.paddingLeft || 0, t: s.paddingTop || 0, r: s.paddingRight || 0, b: s.paddingBottom || 0 };
    }
    function updateDims(b, oldLayoutSize) {
      const pos = b.pos;
      if (b.size) chartArea[pos === 'left' ? 'left' : pos === 'right' ? 'right' : 'bottom'] -= b.size;
      b.size = b.horizontal ? b.s.height : b.s.width;
      chartArea[pos === 'left' ? 'left' : pos === 'right' ? 'right' : 'bottom'] += b.size;
      const p = getPaddingOf(b.s);
      maxPadding.t = Math.max(maxPadding.t, p.t); maxPadding.l = Math.max(maxPadding.l, p.l);
      maxPadding.b = Math.max(maxPadding.b, p.b); maxPadding.r = Math.max(maxPadding.r, p.r);
      const newWidth = Math.max(0, W - Math.max(maxPadding.l, chartArea.left) - Math.max(maxPadding.r, chartArea.right));
      const newHeight = Math.max(0, H - Math.max(maxPadding.t, chartArea.top) - Math.max(maxPadding.b, chartArea.bottom));
      const widthChanged = newWidth !== chartArea.w, heightChanged = newHeight !== chartArea.h;
      chartArea.w = newWidth; chartArea.h = newHeight;
      return b.horizontal ? { same: widthChanged, other: heightChanged } : { same: heightChanged, other: widthChanged };
    }
    function fitBoxes(list) {
      let refit = false, changed = false;
      const reFit = [];
      for (const b of list) {
        const margins = b.horizontal
          ? { l: Math.max(chartArea.left, maxPadding.l), r: Math.max(chartArea.right, maxPadding.r), t: 0, b: 0 }
          : { t: Math.max(chartArea.top, maxPadding.t), b: Math.max(chartArea.bottom, maxPadding.b), l: 0, r: 0 };
        const maxW = vBoxMaxWidth, maxH = b.horizontal ? hBoxMaxHeight : chartArea.h;
        if (b.horizontal) scaleUpdate(b.s, chartArea.w, maxH || chartArea.h, margins);
        else scaleUpdate(b.s, maxW, chartArea.h, margins);
        const res = updateDims(b);
        changed = changed || res.other;
        reFit.push(b);
      }
      return changed;
    }
    const verticalBoxes = boxes.filter(b => !b.horizontal && b.s.display || !b.horizontal); // keep hidden ones (0 size)
    const horizontalBoxes = boxes.filter(b => b.horizontal);
    fitBoxes(verticalBoxes.filter(b => b.pos === 'left'));
    fitBoxes(verticalBoxes.filter(b => b.pos === 'right'));
    if (fitBoxes(horizontalBoxes)) { fitBoxes(verticalBoxes.filter(b => b.pos === 'left')); fitBoxes(verticalBoxes.filter(b => b.pos === 'right')); }
    // handleMaxPadding (4.4.1 core.layouts): the maxPadding values WIN over the
    // stored padding coords (top label half-height 9.6 beats padding 4), and
    // BOTH the .y/.x walk coords and the final chartArea bounds take the bump -
    // without the chartArea[pos] updates the plot sat ~5.6px too high.
    function updatePos(pos, mp) { // engine maxPadding keys are shorthand t/l/r/b
      const change = Math.max(maxPadding[mp] - chartArea[pos], 0);
      chartArea[pos] += change;
      return change;
    }
    chartArea.y += updatePos('top', 't');
    chartArea.x += updatePos('left', 'l');
    updatePos('right', 'r');
    updatePos('bottom', 'b');
    // place: left boxes from chartArea.x, then right boxes, then bottom
    let cx = chartArea.x;
    verticalBoxes.filter(b => b.pos === 'left').forEach(b => {
      b.s.left = cx; b.s.top = chartArea.top; b.s.width = b.size; b.s.height = chartArea.h;
      b.s.right = b.s.left + b.size; b.s.bottom = b.s.top + chartArea.h;
      cx = b.s.right;
    });
    chartArea.x = cx;
    chartArea.x += chartArea.w; chartArea.y += chartArea.h;
    verticalBoxes.filter(b => b.pos === 'right').forEach(b => {
      b.s.left = chartArea.x; b.s.top = chartArea.top; b.s.width = b.size; b.s.height = chartArea.h;
      b.s.right = b.s.left + b.size; b.s.bottom = b.s.top + chartArea.h;
      chartArea.x = b.s.right;
    });
    let by = chartArea.y;
    horizontalBoxes.forEach(b => {
      b.s.left = chartArea.left; b.s.top = by; b.s.width = chartArea.w; b.s.height = b.size;
      b.s.right = b.s.left + chartArea.w; b.s.bottom = b.s.top + b.size;
      by = b.s.bottom;
    });
    const finalArea = { left: chartArea.left, top: chartArea.top,
      right: chartArea.left + chartArea.w, bottom: chartArea.top + chartArea.h,
      w: chartArea.w, h: chartArea.h };
    return { area: finalArea, x: x };
  }

  /* ---- anchor x-axis (SVG port of the retired canvas anchorDates plugin) ----
     Rotated -35deg date labels; EVERY label draws, no thinning (Owner 8/15).
     Per month the label nearest day 1/15/30 is stroked white. The 'uniform'
     style option swaps the old bold/dark anchors for identical-weight labels
     (workout-chart delta, sibling B). */
  /* Owner 8/15: in All-time windows (opts.monthOnly), strokes appear ONLY at
     the day CLOSEST to each month start - the 2/15/29 rule is
     window-only, too dense at all-time scale. Window [1,31] = nearest to
     the 1st = earliest logged day of the month when the 1st itself is a
     rest day. Same rule in calAxisSvg and the workout axis. */
  function anchorAxisSvg(labels, tickXs, axisBottom, theme, fonts, opts) {
    const MS2 = (opts && opts.monthOnly) ? [[1, 1, 31]] : [[2, 2, 4], [15, 12, 18], [29, 27, 29]];
    const n = labels.length;
    if (!n) return '';
    const uniform = !!(opts && opts.uniform);
    const flat = !!(opts && opts.flat);
    const theta = 35 * Math.PI / 180;
    const y = axisBottom + 9;
    /* Universal clamp (Owner 8/15): no axis text may pass outside the frame.
       A -35deg label's ink box is the rotated rect [0..tw]x[-hh..hh] around
       the anchor: left extent cos*tw+sin*hh, right extent sin*hh,
       bottom extent sin*tw+cos*hh. Shifting the anchor (never shrinking the
       font) keeps every label inside [1, W-1]x[1, H-1]. */
    const CSC = Math.cos(theta), SSN = Math.sin(theta);
    const xClamp = (t, weight, lx, ly) => {
      const hh = theme.tickSize / 2;
      const tw = measureText(String(t), weight === '600' ? fonts.f600 : fonts.f400);
      const Wf = opts && opts.W || 1e9, Hf = opts && opts.H || 1e9;
      lx = Math.min(Math.max(lx, 1 + CSC * tw + SSN * hh), Wf - 1 - SSN * hh);
      ly = Math.min(Math.max(ly, 1 + CSC * hh), Hf - 1 - SSN * tw - CSC * hh);
      return { lx: Math.round(lx * 100) / 100, ly: Math.round(ly * 100) / 100 };
    };
    const coords = tickXs.slice(0, n);
    const dayOf = t => { const m = /(\\d+)\\s*$/.exec(String(t)); return m ? +m[1] : null; };
    /* Owner's axis rule (8/15, emphatic): EVERY label draws, no thinning; the
       label nearest each month's 1st/15th/30th gets the white stroke. Month
       buckets key on year+month (YYYY-MM) from the caller's row dates when
       supplied, so a multi-year range never merges two years' "Aug" (E 8/15). */
    const keys = opts && opts.keys && opts.keys.length === n ? opts.keys : null;
    const byMonth = {};
    labels.forEach((t, i) => {
      let mo;
      if (keys) { mo = String(keys[i]); }
      else {
        const d = dayOf(t);
        mo = d === null ? String(t) : String(t).slice(0, String(t).length - String(d).length).trim();
      }
      (byMonth[mo] = byMonth[mo] || []).push(i);
    });
    /* Milestone windows (Owner 8/15): each anchor strokes the logged day
       CLOSEST to it inside its own window - 2nd looks forward (2-4), 15th
       centers (12-18), 29th looks back (27-29). Exact hits win; empty
       window = no stroke that month. */
    const stroked = new Set();
    Object.keys(byMonth).forEach(mo => {
      const idxs = byMonth[mo];
      MS2.forEach(([a, lo, hi]) => {
        let best = -1, bd = 1e9;
        idxs.forEach(i => { const d = dayOf(labels[i]); if (d === null || d < lo || d > hi) return; const dd = Math.abs(d - a); if (dd < bd) { bd = dd; best = i; } });
        if (best >= 0) stroked.add(best);
      });
    });
    // Stroked anchors paint last above their overlapping plain neighbors.
    let out = '', front = '';
    labels.forEach((t, i) => {
      const strong = stroked.has(i) && !flat;
      const fill = strong ? (uniform ? theme.tick : '#1a1a1a') : theme.tick;
      const weight = strong && !uniform ? '600' : '400';
      const stroke = strong ? ' stroke="#fff" stroke-width="4.5" stroke-linejoin="round" paint-order="stroke"' : '';
      const pp = flat ? { lx: coords[i], ly: y } : xClamp(t, weight, coords[i], y);
      const s = flat
        ? '<text x="' + coords[i] + '" y="' + y + '" text-anchor="middle" dominant-baseline="central"' +
          ' font-size="' + theme.tickSize + '" font-weight="' + weight + '" fill="' + fill + '">' + escXml(String(t)) + '</text>'
        : '<text x="' + pp.lx + '" y="' + pp.ly + '" transform="rotate(-35 ' + pp.lx + ' ' + pp.ly + ')"' +
          ' text-anchor="end" dominant-baseline="central"' +
          ' font-size="' + theme.tickSize + '" font-weight="' + weight + '" fill="' + fill + '"' + stroke + '>' + escXml(String(t)) + '</text>';
      if (strong) front += s; else out += s;
    });
    return out + front;
  }

  /* Every-calendar-date axis (Owner 8/15 "ditto dat formatting" for macros):
     MM/DD/YY at -35deg, one label per calendar day, the 2nd/29th carry the
     milestone style (bold #1a1a1a + 4.5px white stroke). */
  function calAxisSvg(dayDates, tickXs, axisBottom, theme, frameW, frameH, monthOnly) {
    const MS2 = monthOnly ? [[1, 1, 31]] : [[2, 2, 4], [15, 12, 18], [29, 27, 29]];
    const y0 = axisBottom + 9;
    const CSC0 = 0.8192, SSN0 = 0.5736, hh0 = theme.tickSize / 2;
    const calClamp = (label, weight, lx, ly) => {
      const tw = measureText(label, weight + ' ' + theme.tickSize + 'px ' + theme.font);
      const Wf = frameW || 1e9, Hf = frameH || 1e9;
      lx = Math.min(Math.max(lx, 1 + CSC0 * tw + SSN0 * hh0), Wf - 1 - SSN0 * hh0);
      ly = Math.min(Math.max(ly, 1 + CSC0 * hh0), Hf - 1 - SSN0 * tw - CSC0 * hh0);
      return { lx: rn2(lx), ly: rn2(ly) };
    };
    /* Logged dates ONLY (Owner 8/15 reversal): every date with a row draws, no
       rest-day labels; unlogged days still occupy horizontal space. 2nd/29th
       milestones are stroked + bold and paint LAST above plain neighbors. */
    /* Milestone windows (Owner 8/15): stroke the LOGGED day closest to the
       2nd (2-4), 15th (12-18) and 29th (27-29) each month; exact wins. */
    const strokeSet = new Set();
    const byMo = {};
    dayDates.forEach((dt, i) => { const k = String(dt).slice(0, 7); (byMo[k] = byMo[k] || []).push(i); });
    Object.keys(byMo).forEach(k => {
      MS2.forEach(([a, lo, hi]) => {
        let best = -1, bd = 1e9;
        byMo[k].forEach(i => { const d = +String(dayDates[i]).split('-')[2]; if (d < lo || d > hi) return; const dd = Math.abs(d - a); if (dd < bd) { bd = dd; best = i; } });
        if (best >= 0) strokeSet.add(best);
      });
    });
    /* All time latest-date bold (Owner 8/15, tightened after "dude thertr are
       two bolds now! I only wanted one!"): in monthOnly mode the 1st-of-month
       milestone stroke is DROPPED and ONLY the last slot - always today -
       carries the strong label, making today's date the single bold tick. */
    /* Today bold (Owner 8/17, "bold day label is frozen at 08/15"): the single
       strong tick always marks the calendar day the viewer is looking at,
       recomputed client-side on every render - never baked into the page -
       so a cached snapshot can never freeze it. Falls back to the 2nd/15th/
       29th milestone windows only when today isn't on the axis at all. */
    const _isoLocal = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const _today = _isoLocal(new Date());
    let _todayIdx = -1;
    dayDates.forEach((dt, i) => { if (String(dt) === _today) _todayIdx = i; });
    if (monthOnly) { strokeSet.clear(); if (dayDates.length) strokeSet.add(dayDates.length - 1); }
    else if (_todayIdx >= 0) { strokeSet.clear(); strokeSet.add(_todayIdx); }
    let plain = '', front = '';
    for (let i = 0; i < dayDates.length; i++) {
      const dd = String(dayDates[i]).split('-');
      const mo = +dd[1], dy = +dd[2], yr = dd[0].slice(2);
      const strong = strokeSet.has(i);
      const label = (mo < 10 ? '0' : '') + mo + '/' + (dy < 10 ? '0' : '') + dy + '/' + yr;
      const pc = calClamp(label, strong ? '600' : '400', tickXs[i], y0);
      const stroke = strong ? ' stroke="#fff" stroke-width="4.5" stroke-linejoin="round" paint-order="stroke"' : '';
      const s = '<text x="' + pc.lx + '" y="' + pc.ly + '" transform="rotate(-35 ' + pc.lx + ' ' + pc.ly + ')"' +
        ' text-anchor="end" dominant-baseline="central" font-size="' + theme.tickSize + '"' +
        ' font-weight="' + (strong ? '600' : '400') + '" fill="' + (strong ? '#1a1a1a' : theme.tick) + '"' + stroke + '>' +
        label + '</text>';
      if (strong) front += s; else plain += s;
    }
    return plain + front;
  }

  /* Smoothed series must never ride outside the plot frame (Owner 8/15, mobile
     screenshot: sodium line cut flat against the top border). Probe the exact
     per-segment cubic + exponential tail geometry in pixel space; if it would
     rise above the scale's top, return the scale max that fits it. */
  function smoothFitNeeds(scales, A, tickXs, model) {
    const need = { y: 0, y1: 0 };
    model.datasets.forEach(ds => {
      const sc = scales[ds.axis];
      if (!sc || !sc.display) return;
      const pts = [];
      for (let i = 0; i < tickXs.length; i++) {
        const v = ds.data[i];
        if (v === null || v === undefined || !isFinite(v)) continue;
        pts.push({ x: tickXs[i], y: sc.pixelForValue(v) });
      }
      if (!pts.length) return;
      if (pts.length > 1) {
        for (let i = 0; i < pts.length; i++) {
          const prev = i ? pts[i - 1] : pts[i];
          const next = i + 1 < pts.length ? pts[i + 1] : pts[i];
          const cp = splineCurve(prev, pts[i], next, 0.4);
          pts[i].cp1x = cp.cp1x; pts[i].cp1y = cp.cp1y; pts[i].cp2x = cp.cp2x; pts[i].cp2y = cp.cp2y;
        }
      }
      let pyTop = Infinity; // smallest y-pixel = highest value the path reaches
      for (let i = 1; i < pts.length; i++) {
        const q = pts[i - 1], pt = pts[i];
        for (let k = 0; k <= 24; k++) {
          const t = k / 24, u = 1 - t;
          const y = u * u * u * q.y + 3 * u * u * t * q.cp2y + 3 * u * t * t * pt.cp1y + t * t * t * pt.y;
          if (y < pyTop) pyTop = y;
        }
      }
      pts.forEach(pt2 => { if (pt2.y < pyTop) pyTop = pt2.y; });
      if (pts.length > 1) {
        const lp = pts[0], rp = pts[pts.length - 1];
        const mL = (lp.cp2y - lp.y) / Math.max(lp.cp2x - lp.x, 1e-6);
        const mR = (rp.y - rp.cp1y) / Math.max(rp.x - rp.cp1x, 1e-6);
        const decay = 1 - Math.exp(-1);
        const pyL = lp.y - mL * Math.abs(A.left - lp.x) * decay;
        const pyR = rp.y + mR * (A.right - rp.x) * decay;
        if (pyL < pyTop) pyTop = pyL;
        if (pyR < pyTop) pyTop = pyR;
      }
      if (!isFinite(pyTop) || A.bottom <= A.top) return;
      const span = A.bottom - A.top;
      const vAt = px => sc.min + (sc.bottom - px) / Math.max(sc.bottom - sc.top, 1e-6) * (sc.max - sc.min);
      const needed = vAt(sc.top + (pyTop - A.top));
      if (needed > sc.max + 1e-6) {
        const want = sc.max + (needed - sc.max) * 1.3;
        if (want > need[ds.axis]) need[ds.axis] = want;
      }
    });
    return need;
  }

  let uidSeq = 0;
  function escXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const rn2 = v => Math.round(v * 100) / 100;

  /* ---- smooth-mode splines (helpers.curves splineCurve + capBezierPoints) ---- */
  function splineCurve(prev, point, next, t) {
    const d01 = Math.hypot(point.x - prev.x, point.y - prev.y);
    const d12 = Math.hypot(next.x - point.x, next.y - point.y);
    let s01 = d01 / (d01 + d12), s12 = d12 / (d01 + d12);
    if (isNaN(s01)) s01 = 0;
    if (isNaN(s12)) s12 = 0;
    const fa = t * s01, fb = t * s12;
    return {
      cp1x: point.x - fa * (next.x - prev.x), cp1y: point.y - fa * (next.y - prev.y),
      cp2x: point.x + fb * (next.x - prev.x), cp2y: point.y + fb * (next.y - prev.y)
    };
  }
  function buildCurve(pts, tension, area) {
    // assign control points; clamps control handles into the chart area
    for (let i = 0; i < pts.length; i++) {
      const prev = i ? pts[i - 1] : pts[i];
      const next = i + 1 < pts.length ? pts[i + 1] : pts[i];
      const cp = splineCurve(prev, pts[i], next, tension);
      pts[i].cp1x = cp.cp1x; pts[i].cp1y = cp.cp1y; pts[i].cp2x = cp.cp2x; pts[i].cp2y = cp.cp2y;
    }
    capBezier(pts, area);
  }
  function capBezier(points, area) {
    for (const p of points) {
      p.cp1x = Math.min(Math.max(p.cp1x, area.left), area.right);
      p.cp1y = Math.min(Math.max(p.cp1y, area.top), area.bottom);
      p.cp2x = Math.min(Math.max(p.cp2x, area.left), area.right);
      p.cp2y = Math.min(Math.max(p.cp2y, area.top), area.bottom);
    }
  }
  function linePathD(pts) {
    let d = 'M' + rn2(pts[0].x) + ',' + rn2(pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i], q = pts[i - 1];
      d += 'C' + rn2(q.cp2x) + ',' + rn2(q.cp2y) + ' ' + rn2(p.cp1x) + ',' + rn2(p.cp1y) + ' ' + rn2(p.x) + ',' + rn2(p.y);
    }
    return d;
  }

  /* ================= engine instance ================= */
  function create(host) {
    const eng = {
      model: null, hooks: null, geom: null, bars: [], lineSel: [],
      hover: null, tipKey: null, focus: null, chartArea: null, lastW: -1, lastH: -1
    };
    const uid = 'sclip' + (++uidSeq);
    const tip = document.createElement('div');
    tip.className = 'svgtip';
    tip.style.display = 'none';
    host.appendChild(tip);
    // Page blow-up plumbing reads/writes this facade like a Chart instance.
    const facade = { data: { datasets: [] }, update: clearFocus };

    function modelScales(model, theme) {
      const fonts = tickFonts(theme);
      const mk = axis => {
        const so = model.scales[axis];
        const values = [];
        model.datasets.forEach(d => {
          if (d.axis !== axis) return;
          for (const v of d.data) values.push(v);
        });
        return makeLinearScale({
          id: axis, position: so.position, display: so.display, values: values,
          suggestedMax: so.suggestedMax, suggestedMin: so.suggestedMin, hardMax: so.hardMax,
          goals: so.display ? (so.goals || []) : [], hostH: host.clientHeight || 320
        }, theme, fonts);
      };
      return { y: mk('y'), y1: mk('y1'), x: { n: model.labels.length } };
    }

    function renderSVG(model) {
      const theme = model.theme;
      const fonts = tickFonts(theme);
      const W = Math.floor(host.clientWidth);
      const H = Math.floor(host.clientHeight);
      eng.lastW = W; eng.lastH = H;
      const dpr = Math.max(2, window.devicePixelRatio || 1);
      const PADX = { l: 6, t: 4, r: 2, b: 46 };
      const DAYMS = 86400000;
      const dMs = d => { const q = String(d).split('-'); return Date.UTC(+q[0], +q[1] - 1, +q[2]); };
      const n = model.labels.length;
      // Calendar-true x map (Owner 8/15 "ditto"): when the model carries per-row
      // dates, every calendar day in the window owns a slot and each row sits
      // at its date position (rest days take real horizontal space). Fallback:
      // category offset:true center per segment as before.
      const dayDates = (model.dayDates && model.dayDates.length === n) ? model.dayDates : null;
      let scales = modelScales(model, theme);
      let layout = layoutChart(W, H, [scales.y, scales.y1], scales.x.n, PADX);
      const mapX = () => {
        const xs2 = layout.x;
        let segW2 = n ? xs2.width / n : xs2.width;
        let tMin2 = 0, tMax2 = 0, nDays = n;
        if (dayDates && n) {
          tMin2 = Math.min.apply(null, dayDates.map(dMs));
          tMax2 = Math.max.apply(null, dayDates.map(dMs));
          nDays = Math.max(Math.round((tMax2 - tMin2) / DAYMS) + 1, 1);
          segW2 = xs2.width / nDays;
        }
        const tx2 = [];
        for (let i = 0; i < n; i++) tx2.push(dayDates && n ? xs2.left + ((dMs(dayDates[i]) - tMin2) / DAYMS + 0.5) * segW2 : xs2.left + (i + 0.5) * segW2);
        return { xs: xs2, segW: segW2, tickXs: tx2, tMin: tMin2, tMax: tMax2, nDays: nDays };
      };
      let xmap = mapX();
      // Fit the y-domain to the smoothed curves (<=3 passes: scale rebuild
      // shifts pixels, re-probe).
      for (let pass = 0; pass < 3 && model.mode === 'smooth'; pass++) {
        const need = smoothFitNeeds(scales, layout.area, xmap.tickXs, model);
        if (!need.y && !need.y1) break;
        if (need.y) model.scales.y.suggestedMax = Math.max(model.scales.y.suggestedMax || -Infinity, need.y);
        if (need.y1) model.scales.y1.suggestedMax = Math.max(model.scales.y1.suggestedMax || -Infinity, need.y1);
        scales = modelScales(model, theme);
        layout = layoutChart(W, H, [scales.y, scales.y1], scales.x.n, PADX);
        xmap = mapX();
      }
      const A = layout.area;
      eng.chartArea = A;
      const xs = layout.x;
      const segW = xmap.segW;
      const tickXs = xmap.tickXs;
      // bar slots: grouped across visible bar datasets (plot order)
      const barDs = [];
      model.datasets.forEach((d, di) => { if (model.mode !== 'smooth') barDs.push(di); });
      const barSlot = {}; barDs.forEach((di, k) => { barSlot[di] = k; });
      const stackCount = model.mode === 'smooth' ? 0 : barDs.length;
      const stepPx = segW;
      const catSlot = stepPx * 0.8;           // categoryPercentage
      const chunk = stackCount ? catSlot / stackCount : 0;
      const maxBar = model.maxBarThickness || 38;
      const barRatio = 0.9;                   // barPercentage

      eng.bars = []; eng.lineSel = [];
      eng.geom = { W, H, A, tickXs, n, scales, stepPx, chunk, stackCount, xs, barSlot, catSlot, maxBar };
      const parts = [];
      parts.push('<rect class="clipper" x="' + A.left + '" y="' + A.top + '" width="' + A.w + '" height="' + A.h + '" fill="none" pointer-events="none"/>');
      // grid lines (y scale only, chart area)
      let d = '';
      if (scales.y.display) {
        for (const t of scales.y.ticks) {
          const gy = alignPixel(scales.y.pixelForValue(t.value), 1, dpr);
          d += 'M' + alignPixel(A.left, 1, dpr) + ',' + gy + 'L' + A.right + ',' + gy;
        }
        if (d) parts.push('<path d="' + d + '" stroke="' + theme.grid + '" stroke-width="1" fill="none" pointer-events="none"/>');
      }
      // axis borders (scale border color AXIS)
      parts.push(axisBorder(scales.y, 'left', A, dpr, theme));
      parts.push(axisBorder(scales.y1, 'right', A, dpr, theme));
      parts.push(axisBorderX(xs, A, dpr, theme));
      // datasets, clipped to chart area
      // model.seriesOrder (opaque smoothed view): paint the largest series first
      // so its fill sits behind every higher-hierarchy layer.
      const dsPartsAt = parts.length; // ghost splice anchor (Owner 8/17 z-order)
      const drawIdxs = (model.mode === 'smooth' && model.seriesOrder) ? model.seriesOrder : model.datasets.map((dd, ii) => ii);
      if (model.avgBars && model.mode === 'smooth') {
        /* Average as a shape modifier (Owner 8/17): the smoothed shapes of the
           average are full-width bands from baseline to the aggregate -
           Opaque = solid silhouettes, biggest-behind; Clear = translucent
           with a series edge. Clear bands clip to the NEXT band's top
           (Owner 8/18): translucent regions never stack/mix - every stripe is
           exactly one series tint, matching opaque occlusion geometry.
           Goal deltas live in the docked numbers pane (Owner 8/18), not as
           in-canvas overlays here. */
        const bandTops = drawIdxs.map(di => {
          const ds2 = model.datasets[di], sc2 = scales[ds2.axis];
          if (!sc2.display) return null;
          const v2 = ds2.data[0];
          if (v2 === null || v2 === undefined || !isFinite(v2)) return null;
          return Math.max(sc2.pixelForValue(v2), A.top);
        });
        drawIdxs.forEach((di, qi) => {
          const ds = model.datasets[di];
          const sc = scales[ds.axis];
          if (!sc.display) return;
          const v = ds.data[0];
          if (v === null || v === undefined || !isFinite(v)) return;
          const y = Math.max(sc.pixelForValue(v), A.top);
          const y0 = sc.pixelForValue(0);
          let cb = y0;
          if (!model.smoothOpaque) for (let q = qi + 1; q < drawIdxs.length; q++) { if (bandTops[q] !== null) { cb = bandTops[q]; break; } }
          const hgt = Math.max(0, cb - y);
          const fill = model.smoothOpaque ? ds.color : rgba(ds.color, 0.18);
          parts.push('<rect x="' + A.left + '" y="' + rn2(y) + '" width="' + A.w + '" height="' + rn2(hgt) + '" fill="' + fill + '"' +
            (model.smoothOpaque ? '' : ' stroke="' + ds.color + '" stroke-width="1"') + ' pointer-events="none"/>');
          eng.lineSel[di] = [{ x: (A.left + A.right) / 2, y: y, i: 0 }];
        });
      } else drawIdxs.forEach(di => {
        const ds = model.datasets[di];
        const sc = scales[ds.axis];
        if (!sc.display) return;
        if (model.mode === 'smooth') { parts.push(smoothDS(ds, di, sc)); return; }
        parts.push(barDS(ds, di, sc));
      });
      /* Ghosts at today's empty slot (Owner 8/15, LOCKED; Owner 8/22 basis now
         fixed past-7-days): the average of each shown macro's logged days in
         the fixed past-7-day lookback, drawn at
         today's slot. Raw: translucent fill + dotted-dash edge, one bar per
         macro. Smooth modes (Owner 8/15 v3, "the ghost stacked chart is still a
         stacked chart"): NOT separate bars - each macro's band CONTINUES
         into today's slot with the same stack geometry as every other day:
         a spline from the band's last real point to its averaged ghost point,
         down to the shared baseline, no side-by-side bars. Opaque ghost =
         translucent fill + dotted edge; Clear ghost = dotted edge outline
         only. Edges always series color, dotted, so ghosts read as
         "projected" without breaking the chart language. Replaced by the
         real value once logged (render supplies ghosts only when today's
         slot is empty). */
      /* Clear masks (Owner 8/18): each translucent band's fill is clipped by
         the areas of all bands drawn in front (later in biggest-behind
         order), so every visible region carries exactly one series tint. */
      if (eng.smB && eng.smB.length) {
        const bands = eng.smB; eng.smB = null;
        let out = '';
        bands.forEach((b, q) => {
          out += '<g pointer-events="none" clip-path="url(#' + uid + ')">' +
            (b.op ? '' : '<mask id="' + uid + 'cm' + q + '"><rect x="' + A.left + '" y="' + A.top + '" width="' + A.w + '" height="' + A.h + '" fill="#fff"/>' + bands.slice(q + 1).map(f => '<path d="' + f.A + '" fill="#000"/>').join('') + '</mask>') +
            '<path d="' + b.A + '" fill="' + b.f + '" stroke="none"' + (b.op ? '' : ' mask="url(#' + uid + 'cm' + q + ')"') + '/>' +
            (b.op ? '' : '<path d="' + b.S + '" fill="none" stroke="' + b.c + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>') +
            '</g>';
        });
        parts.push(out);
      }
      const ghostPartsAt = parts.length;
      if (model.ghostAt != null && model.ghosts) {
        const g = eng.geom, gi = model.ghostAt;
        if (gi >= 0 && gi < g.n) {
          const gds = model.datasets.map((ds, di) => di).filter(di =>
            scales[model.datasets[di].axis].display && isFinite(model.ghosts[di]));
          if (gds.length) {
            if (model.mode === 'smooth') {
              /* Opaque paints biggest-behind (seriesOrder); the ghost wedges
                 follow the same paint order so the stacking reads exactly
                 like the real days. */
              const order = model.seriesOrder
                ? model.seriesOrder.filter(di => gds.indexOf(di) >= 0) : gds;
              let gh = '<g pointer-events="none" clip-path="url(#' + uid + ')">';
              let gdefs = '';
              order.forEach(di => {
                const ds = model.datasets[di], sc = scales[ds.axis];
                const v = model.ghosts[di];
                const pts = (eng.lineSel[di] || []);
                if (!pts.length) return;
                const lp = pts[pts.length - 1];
                const gx = g.tickXs[gi];
                const gy = Math.max(sc.pixelForValue(v), A.top);
                const y0 = Math.min(Math.max(sc.pixelForValue(0), A.top), A.bottom);
                /* Smooth-style ghost (Owner 8/15, "not in the same smooth
                   style"): curve the ghost edge through the last TWO real
                   points into the ghost point so the transition segment is
                   tangent-continuous with the band's body spline instead of
                   a straight two-point trapezoid. */
                /* Day-cell boundary start (Owner 8/15): the ghost begins at
                   the LEFT EDGE OF TODAY'S CELL (half step left of today's
                   tick), seeded with the value the real band tailed to at
                   the shared boundary - the real day owns its full cell and
                   the projection owns today's cell only. */
                /* Owner 8/17 (logged-today ghost shape): when today's slot
                   already carries real data, lp sits AT today's tick (lp.x ==
                   gx), so max(gx - step/2, lp.x) collapsed the entry to zero
                   width and the wedge degenerated into a vertical bar with a
                   flat top - "dashed bars" instead of the smoothed ghost
                   curve. In that case start the ghost at the LEFT EDGE of
                   today's cell like every other ghost, seeded with the value
                   midway between yesterday's point and today's real point,
                   so the entry splines up from the band into the goal point.
                   Unlogged-today behavior is unchanged (leadEnd seed). */
                const loggedToday = lp.x > g.tickXs[gi] - 1;
                const leadEnd = eng.ghostLead && eng.ghostLead[di];
                const prevPt = pts.length > 1 ? pts[pts.length - 2] : lp;
                const x0 = loggedToday
                  ? Math.max(g.tickXs[gi] - g.stepPx / 2, g.A.left)
                  : Math.max(g.tickXs[gi] - g.stepPx / 2, lp.x);
                const yS = loggedToday
                  ? (prevPt.y + lp.y) / 2
                  : (leadEnd ? leadEnd.y : lp.y);
                const P = [loggedToday ? prevPt : lp, { x: x0, y: yS }, { x: gx, y: gy }];
                buildCurve(P, 0.4, g.A);
                const q = P[2], a = P[1];
                /* Owner 8/15 ("still a weird 1-2px overlap between today's
                   projection and the previous day - kill the overlap"): NO
                   overlap - ghost fill starts at EXACTLY the shared boundary
                   x0 (same coordinate the real band's endX closes on, so
                   coverage sums to 1: neither a gap line nor an overlap
                   column). */
                const xFillL = x0;
                const topD = 'M' + rn2(xFillL) + ',' + rn2(a.y) +
                  ' C' + rn2(a.cp2x) + ',' + rn2(a.cp2y) + ' ' + rn2(q.cp1x) + ',' + rn2(q.cp1y) + ' ' + rn2(q.x) + ',' + rn2(q.y);
                /* Full-bleed past today (Owner 8/15, "have it run to the end of
                   the graph horizontally"): the ghost band keeps the same
                   exponential tail the real bands used to have - from the
                   ghost point, slope decaying to the plot's right edge, so
                   real+ghost spans the full frame with zero dead space.
                   Mirror of smoothDS's tail machinery (local helpers are
                   scoped inside smoothDS, so sample + spline inline). */
                /* 8/17 iOS crash fix: when the ghost point's entry handle is
                   (near-)coincident with the ghost point x-wise - happens when
                   today's slot is also the right window edge - the raw slope
                   blows up to ~1e8 and the emitted path drives a coordinate to
                   ~7.8e8. Desktop Chrome tolerates it; WKWebView's rasterizer
                   crashes and Notion's embed shows "Tap to load embed". Guard
                   the slope: finite AND magnitude-capped at 4 plot-heights/px,
                   else flat. Tail sample ys get clamped to the plot box too. */
                const mqRaw = (q.y - q.cp1y) / Math.max(q.x - q.cp1x, 1e-6); // bezier tangent at the ghost point
                const mqCap = (g.A.bottom - g.A.top) * 4;
                const mQ = (!isFinite(mqRaw) || (q.x - q.cp1x) < 3) ? 0
                  : Math.max(-mqCap, Math.min(mqCap, mqRaw));
                let tailD = '';
                {
                  const dx = g.A.right - gx;
                  if (dx >= 1 && isFinite(mQ)) {
                    const tau = dx, steps = 16;
                    const TP = [{ x: gx, y: gy }];
                    for (let kk = 1; kk <= steps; kk++) {
                      const t = (kk / steps) * dx;
                      TP.push({ x: gx + t, y: Math.min(Math.max(gy + mQ * tau * (1 - Math.exp(-t / tau)), g.A.top), g.A.bottom) });
                    }
                    buildCurve(TP, 0.4, g.A);
                    const dx1 = (TP[1].x - TP[0].x) / 3; // pin entry handle to mQ: C1 at the ghost point
                    TP[0].cp2x = TP[0].x + dx1; TP[0].cp2y = TP[0].y + mQ * dx1;
                    tailD = linePathD(TP).replace(/^M[^C]+/, '');
                  }
                }
                const edgX = tailD ? g.A.right : gx;
                const edgeD = topD + tailD + 'L' + rn2(edgX) + ',' + rn2(y0) + 'L' + rn2(xFillL) + ',' + rn2(y0) + 'Z';
                /* Owner 8/15 ("as in the dashes are straight dashes not curved
                   dashes"): the dotted TOP EDGE alone is drawn as straight
                   line segments between points - entry -> ghost point ->
                   straight-run along the exponential tail - while the filled
                   silhouette below keeps its smooth easing. */
                let straightD = 'M' + rn2(a.x) + ',' + rn2(a.y);
                /* Owner 8/15 ("I know there's some specific value you used and
                   just tighten it a bit"): denser anchors. The entry->ghost
                   span samples the SAME cubic easing the fill uses (same cp
                   handles), just as a 10-piece polyline, and the tail samples
                   24px apart - an 8-piece straight approximation no longer
                   drifts off the fill silhouette. Segments stay straight. */
                {
                  const ex1 = a.cp2x !== undefined ? a.cp2x : a.x, ey1 = a.cp2y !== undefined ? a.cp2y : a.y;
                  const ex2 = q.cp1x !== undefined ? q.cp1x : q.x, ey2 = q.cp1y !== undefined ? q.cp1y : q.y;
                  const NN = 10;
                  for (let kk0 = 1; kk0 <= NN; kk0++) {
                    const t0 = kk0 / NN, mt = 1 - t0;
                    const bx = mt*mt*mt*a.x + 3*mt*mt*t0*ex1 + 3*mt*t0*t0*ex2 + t0*t0*t0*q.x;
                    const by = mt*mt*mt*a.y + 3*mt*mt*t0*ey1 + 3*mt*t0*t0*ey2 + t0*t0*t0*q.y;
                    straightD += 'L' + rn2(bx) + ',' + rn2(by);
                  }
                }
                if (tailD && isFinite(mQ)) {
                  const dxs = g.A.right - gx, ts0 = Math.max(2, Math.round(dxs / 24));
                  for (let kk2 = 1; kk2 <= ts0; kk2++) {
                    const t2 = (kk2 / ts0) * dxs;
                    straightD += 'L' + rn2(gx + t2) + ',' + rn2(Math.min(Math.max(gy + mQ * dxs * (1 - Math.exp(-t2 / dxs)), g.A.top), g.A.bottom));
                  }
                }
                /* Owner 8/15 ("opaque ghost fills: a bit lighter AND a bit more
                   transparent"): tint each series hue ~25% toward white, then
                   drop alpha 0.35 -> 0.28 - airier but the same color family. */
                const tintHex = (() => {
                  const n = parseInt(ds.color.slice(1), 16);
                  const lift = v => Math.min(255, Math.round(v + (255 - v) * 0.25));
                  return '#' + ((1 << 24) + (lift((n >> 16) & 255) << 16) + (lift((n >> 8) & 255) << 8) + lift(n & 255)).toString(16).slice(1);
                })();
                /* Owner 8/15 ("no fade. Just revert back to the pre fade era."):
                   NO boundary fade - flat lightened ghost tint fill and flat
                   full-color dotted stroke; hard transition at the boundary. */
                const fill = model.smoothOpaque ? rgba(tintHex, 0.28) : 'none';
                const ghostStroke = ds.color;
                /* Owner 8/15 ("you don't need dotted lines on the left and
                   right"): stroke only the flow boundary - the dotted curve
                   runs along the top edge (and its tail). The wedge fill is
                   closed silently to the baseline; no vertical dotted
                   segments at entry or exit. */
                gh += '<path d="' + edgeD + '" fill="' + fill + '" stroke="none"/>' +
                  /* Thinner, longer dashes (Owner 8/15: "vertically thinner...
                     a bit longer"). */
                  '<path d="' + straightD + '" fill="none" stroke="' + ghostStroke +
                  '" stroke-width="1" stroke-dasharray="5 4" stroke-linejoin="miter"/>';
              });
              gh = gh.replace('>', '><defs>' + gdefs + '</defs>');
              parts.push(gh + '</g>');
            } else {
              const ghostFill = 0.25;              // Raw: translucent fill
              let gh = '<g pointer-events="none" clip-path="url(#' + uid + ')">';
              gds.forEach(di => {
                const k = g.barSlot[di] !== undefined ? g.barSlot[di] : gds.indexOf(di);
                const ds = model.datasets[di], sc = scales[ds.axis];
                const v = model.ghosts[di];
                const base = sc.pixelForValue(0), head = Math.max(sc.pixelForValue(v), A.top);
                const center = g.tickXs[gi] - g.catSlot / 2 + g.chunk * k + g.chunk / 2;
                const bw = Math.min(g.maxBar, g.chunk * 0.9);
                const x = center - bw / 2, top = Math.min(base, head), hgt = Math.abs(head - base);
                if (hgt < 1) return;
                gh += '<rect x="' + rn2(x) + '" y="' + rn2(top) + '" width="' + rn2(bw) + '" height="' + rn2(hgt) + '"' +
                  ' fill="' + rgba(ds.color, ghostFill) + '"' +
                  ' stroke="' + ds.color + '" stroke-width="1" stroke-dasharray="2 3" stroke-linejoin="round"/>';
              });
              parts.push(gh + '</g>');
            }
          }
        }
      }
      /* Owner 8/17 ("the ghost chart has the lowest hierarchy, meaning it goes
         behind"): ghost fill + dashed edges must paint UNDERNEATH the real
         series. The markup is generated after the datasets (it needs the
         smoothed point geometry smoothDS computes), so reorder the emitted
         parts: ghosts first, then the real data on top. */
      {
        const ghParts = parts.splice(ghostPartsAt);
        const dsParts = parts.splice(dsPartsAt);
        parts.push.apply(parts, ghParts.concat(dsParts));
      }
      // goal lines over datasets (boxAndRefs equivalent); the frame too
      parts.push('<rect x="' + (A.left + 0.5) + '" y="' + (A.top + 0.5) + '" width="' + (A.w - 1) + '" height="' + (A.h - 1) + '" fill="none" stroke="' + theme.grid + '" stroke-width="1" pointer-events="none"/>');
      /* Owner 8/15 (universal): goal LINES are gone in every view by default -
         the colored goal amount labels on the axis edges stay everywhere.
         Owner 8/17: TRIPLE-TAP on the macros chart toggles the original
         per-macro dashed goal lines back on/off for more visible goals. */
      if (model.goalLinesOn) (model.goalRefs || []).forEach(g => {
        const sc = scales[g.axis];
        if (!sc.display) return;
        const y = sc.pixelForValue(g.value);
        if (y < A.top || y > A.bottom) return;
        parts.push('<line x1="' + A.left + '" y1="' + y + '" x2="' + A.right + '" y2="' + y +
          '" stroke="' + g.color + '" stroke-width="1.5" stroke-dasharray="5 4" stroke-opacity="0.75" pointer-events="none"/>');
      });
      // tick labels
      parts.push(tickLabels(scales.y, 'left'));
      parts.push(tickLabels(scales.y1, 'right'));
      // x labels: every calendar date when per-row dates exist, else anchors
      if (dayDates) {
        parts.push(calAxisSvg(dayDates, tickXs, xs.bottom, theme, W, H, !!model.monthFirstOnly));
      } else {
        parts.push(anchorAxisSvg(model.avgDaysLabel ? [model.avgDaysLabel] : model.labels, tickXs, xs.bottom, theme, fonts, { uniform: !!model.uniformAnchors, keys: model.labelMonths, flat: !!model.avgDaysLabel, monthOnly: !!model.monthFirstOnly, W: W, H: H }));
      }

      const svgStr = '<svg class="svgchart" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H +
        '" style="display:block;overflow:visible;font-family:' + escXml(theme.font) + ';font-size:' + theme.tickSize + 'px">' +
        '<defs><clipPath id="' + uid + '"><rect x="' + A.left + '" y="' + A.top + '" width="' + A.w + '" height="' + A.h + '"/></clipPath>' +
        /* Owner 8/17 ("Idk if white is correct. Figure it out."): perceptual test on
     all 8 series fills (green/gold/blue/orange/red/purple/pink/teal) -
     white stripes read on every fill; deep crimson washed out on green,
     blue, teal and blended into red. UNIVERSAL over-goal stripe = white,
     over a faint red wash that keeps the over-goal = red cue. */
        '<pattern id="' + uid + 'ovh" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M-1.5,4.5 l3,3 M0,0 l6,6 M4.5,-1.5 l3,3" stroke="rgba(255,255,255,0.95)" stroke-width="1.7"/></pattern>' +
        '<pattern id="' + uid + 'ovhdrk" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M-1.5,4.5 l3,3 M0,0 l6,6 M4.5,-1.5 l3,3" stroke="rgba(110,10,25,0.95)" stroke-width="1.7"/></pattern></defs>' +
        parts.join('') + '</svg>';
      const oldTip = tip.parentNode ? null : null;
      host.innerHTML = '';
      host.appendChild(tip);
      host.insertAdjacentHTML('afterbegin', svgStr);
      eng.svg = host.querySelector('svg');
      // bar element references for hover shade + hit tests
      eng.barEls = eng.svg.querySelectorAll('rect.bar');
    }

    function axisBorder(s, pos, A, dpr, theme) {
      if (!s.display) return '';
      if (pos === 'left') {
        const bx = alignPixel(s.right, 1, dpr);
        return '<line x1="' + bx + '" y1="' + (alignPixel(s.top, 1, dpr) - 0.5) + '" x2="' + bx + '" y2="' + (alignPixel(s.bottom, 1, dpr) + 0.5) + '" stroke="' + theme.axis + '" stroke-width="1" pointer-events="none"/>';
      }
      const bx = alignPixel(s.left, 1, dpr);
      return '<line x1="' + bx + '" y1="' + (alignPixel(s.top, 1, dpr) - 0.5) + '" x2="' + bx + '" y2="' + (alignPixel(s.bottom, 1, dpr) + 0.5) + '" stroke="' + theme.axis + '" stroke-width="1" pointer-events="none"/>';
    }
    function axisBorderX(xs, A, dpr, theme) {
      const by = alignPixel(xs.top, 1, dpr);
      return '<line x1="' + (alignPixel(xs.left, 1, dpr) - 0.5) + '" y1="' + by + '" x2="' + (alignPixel(xs.right, 1, dpr) + 0.5) + '" y2="' + by + '" stroke="' + theme.axis + '" stroke-width="1" pointer-events="none"/>';
    }
    function tickLabels(s, pos) {
      if (!s.display) return '';
      /* Owner 8/15: goal labels share the axis with regular ticks, and on the
         opaque shared axis close goals collapse (protein 100 / carbs 198).
         Resolve vertical collisions by nudging labels apart, order preserved,
         clamped inside the scale box. One pass down, one clamp pass up. */
      const lineH = s.lineH || 11;
      const gap = lineH * 0.92 + 1;
      const items = s.ticks.map(t => ({ t: t, y: s.pixelForValue(t.value) }));
      items.sort((a, b) => a.y - b.y);
      for (let i = 1; i < items.length; i++) {
        if (items[i].y - items[i - 1].y < gap) items[i].y = items[i - 1].y + gap;
      }
      const lo = s.top + lineH / 2, hi = s.bottom - lineH / 2;
      for (let i = items.length - 1; i >= 0; i--) {
        const ceil = i + 1 < items.length ? items[i + 1].y - gap : hi;
        if (items[i].y > ceil) items[i].y = ceil;
        if (items[i].y < lo) items[i].y = lo;
      }
      let out = '';
      for (const it of items) {
        const t = it.t, y = it.y;
        if (pos === 'left') {
          out += '<text x="' + (s.right - 3) + '" y="' + y + '" text-anchor="end" dominant-baseline="central" font-weight="' + t.weight + '" fill="' + t.color + '">' + escXml(t.label) + '</text>';
        } else {
          out += '<text x="' + (s.left + 3) + '" y="' + y + '" text-anchor="start" dominant-baseline="central" font-weight="' + t.weight + '" fill="' + t.color + '">' + escXml(t.label) + '</text>';
        }
      }
      return out;
    }

    // One rect per bar (attribute-level hover shade needs per-bar elements).
    function barDS(ds, di, sc) {
      const g = eng.geom;
      const zeroPx = sc.pixelForValue(0);
      let html = '<g pointer-events="none" clip-path="url(#' + uid + ')">';
      const rectList = [];
      for (let i = 0; i < g.n; i++) {
        const v = ds.data[i];
        if (v === null || v === undefined || !isFinite(v)) { rectList.push(null); continue; }
        let base = zeroPx;
        let head = sc.pixelForValue(v);
        let size = head - base; // negative for positive values
        // chart.js nudges the zero-baseline in by half a grid line so bars
        // never sit on the axis stroke itself.
        const halfGrid = (size < 0 ? -1 : size > 0 ? 1 : 0) * 0.5;
        base += halfGrid; size -= halfGrid;
        const center = g.tickXs[i] - g.catSlot / 2 + g.chunk * g.barSlot[di] + g.chunk / 2;
        const bw = Math.min(g.maxBar, g.chunk * 0.9);
        const x = center - bw / 2;
        const top = Math.min(base, head), hgt = Math.abs(size);
        rectList.push({ x: x, y: top, w: bw, h: hgt, cx: center, base: base });
        html += '<rect class="bar" data-d="' + di + '" data-i="' + i + '" x="' + rn2(x) + '" y="' + rn2(top) + '" width="' + rn2(bw) + '" height="' + rn2(hgt) + '" fill="' + ds.color + '"/>';
      }
      eng.bars[di] = rectList;
      /* Average view goal overlay (Owner 8/17): each average bar vs its goal.
         Average UNDER goal: classic clear ghost stacked vertically on top of
         the bar up to the goal level - translucent series-color fill with
         dotted series-color edges. Average OVER goal: the inverse - a red
         hatched segment (downward diagonal stripes) rendered INSIDE the bar,
         spanning from the goal level up to the bar top. */
      if (eng.model && eng.model.avgBars && ds.goal !== null && ds.goal !== undefined && isFinite(ds.goal)) {
        rectList.forEach(rb => {
          if (!rb) return;
          /* Owner 8/17 tolerance rule: within 5% of the goal (either direction)
             is AT goal - draw NO overlay segment at all (no stripes, no
             cap). Only bars off by more than 5% get the striped treatment. */
          const av = ds.data[0];
          if (Math.abs(av - ds.goal) <= ds.goal * 0.05) return;
          const plotTop = eng.geom.A.top;
          const goalPx = Math.max(sc.pixelForValue(ds.goal), plotTop);
          const barTop = Math.max(sc.pixelForValue(av), plotTop);
          if (av < ds.goal) {
            /* Owner 8/17 (refined): under-goal = dotted outline + faint wash,
               NO stripes. Stripes are the over-goal signal only. */
            const hc = Math.max(0, rb.y - goalPx);
            html += '<rect x="' + rn2(rb.x) + '" y="' + rn2(goalPx) + '" width="' + rn2(rb.w) +
                    '" height="' + rn2(hc) + '"' +
                    ' fill="' + rgba(ds.color, 0.22) + '" stroke="' + ds.color +
                    '" stroke-width="1.5" stroke-dasharray="4 3"/>';
          } else if (ds.data[0] > ds.goal) {
            const hgt = Math.max(0, goalPx - barTop);
            if (hgt > 0) {
              /* Owner 8/17: contrast rule - on series fills close to the red
                 hatch (fat's red, sat-fat's purple, sugar's pink, sodium's
                 ochre) the over-goal stripes swap to a deep crimson so the
                 stripes actually read. */
              const pat = uid + 'ovh';
              html += '<rect x="' + rn2(rb.x) + '" y="' + rn2(barTop) + '" width="' + rn2(rb.w) +
                      '" height="' + rn2(hgt) + '" fill="rgba(214,69,69,0.18)"/>' +
                      '<rect x="' + rn2(rb.x) + '" y="' + rn2(barTop) + '" width="' + rn2(rb.w) +
                      '" height="' + rn2(hgt) + '" fill="url(#' + pat + ')"/>';
            }
          }
        });
      }
      return html + '</g>';
    }

    function smoothDS(ds, di, sc) {
      const g = eng.geom;
      const pts = [];
      for (let i = 0; i < g.n; i++) {
        const v = ds.data[i];
        if (v === null || v === undefined || !isFinite(v)) continue;
        pts.push({ x: g.tickXs[i], y: sc.pixelForValue(v), i: i });
      }
      eng.lineSel[di] = pts;
      if (!pts.length) return '';
      if (pts.length === 1) return ''; // one point draws no line and r=0 draws no dot
      buildCurve(pts, 0.4, g.A);
      const y0 = Math.min(Math.max(sc.pixelForValue(0), g.A.top), g.A.bottom);
      /* Stacked vibe is full-bleed, asymptotically: each line keeps its
         spline slope past the end data points and pulls TOWARD the plot
         edge with exponential slope decay - the tail visibly bends its
         whole length and is still moving (barely) as it arrives, instead
         of stopping where the data stops. */
      const lp = pts[0], rp = pts[pts.length - 1];
      /* Tangent slope dy/dx of the spline at the endpoint: the bezier's
         derivative vector there is 3*(P - cp), so the 3s CANCEL in dy/dx.
         (The old 3x factor made every tail start 3x steeper than the line -
         Owner's zoomed kink at the data->tail junction, 8/15.) */
      const mL = pts.length > 1 ? (lp.cp2y - lp.y) / Math.max(lp.cp2x - lp.x, 1e-6) : 0;
      const mR = pts.length > 1 ? (rp.y - rp.cp1y) / Math.max(rp.x - rp.cp1x, 1e-6) : 0;
      /* Exponential pull to the edge: the line keeps its incoming slope and
         the slope decays as e^(-run/tau), so the tail BENDS its whole
         length (no ruled-straight read) and is still moving - barely - as
         it arrives. tau = 75% of the runout keeps the knee of the curve
         inside the visible tail. Samples are SPLINED, not L-joined: the
         polyline joints between samples read as kinks at zoom (Owner 8/15),
         and the first/last bezier handle is pinned to the incoming spline
         slope so the data->tail junction stays tangent (C1). */
      const tailSamples = (fromX, fromY, slope, toX) => {
        const dx = toX - fromX;
        if (Math.abs(dx) < 1 || !isFinite(slope)) return null;
        const tau = Math.abs(dx), steps = 16; // full-runout decay keeps the pull visible at the gentler true slope
        const P = [{ x: fromX, y: fromY }];
        for (let k = 1; k <= steps; k++) {
          const t = (k / steps) * dx; // signed run from the data point
          P.push({ x: fromX + t, y: fromY + slope * Math.sign(t) * tau * (1 - Math.exp(-Math.abs(t) / tau)) });
        }
        return P;
      };
      const curveThrough = (P, pinStartSlope, pinEndSlope) => {
        const n = P.length;
        if (n < 2) return '';
        const cp1 = [], cp2 = [];
        for (let i = 0; i < n; i++) {
          const prev = i ? P[i - 1] : P[i], next = i + 1 < n ? P[i + 1] : P[i];
          const c = splineCurve(prev, P[i], next, 0.4);
          cp1[i] = [c.cp1x, c.cp1y]; cp2[i] = [c.cp2x, c.cp2y];
        }
        if (pinStartSlope != null) {
          const dx1 = (P[1].x - P[0].x) / 3;
          cp2[0] = [P[0].x + dx1, P[0].y + pinStartSlope * dx1];
        }
        if (pinEndSlope != null) {
          const dxl = (P[n - 1].x - P[n - 2].x) / 3;
          cp1[n - 1] = [P[n - 1].x - dxl, P[n - 1].y - pinEndSlope * dxl];
        }
        let d = 'M' + rn2(P[0].x) + ',' + rn2(P[0].y);
        for (let i = 1; i < n; i++) {
          d += 'C' + rn2(cp2[i - 1][0]) + ',' + rn2(cp2[i - 1][1]) + ' ' + rn2(cp1[i][0]) + ',' + rn2(cp1[i][1]) + ' ' + rn2(P[i].x) + ',' + rn2(P[i].y);
        }
        return d;
      };
      /* Owner 8/15 (ghost wholesale replace, "this still includes the fully
         opaque part"): when a ghost day is active the REAL band terminates
         at its last logged point - the asymptotic right tail past that point
         is what was keeping fully-opaque fill alive under the ghost slot.
         The translucent/dotted ghost wedge owns everything from the last
         real point through today; the area closes straight down from lp/rp.
         Left tail is untouched (bands still full-bleed to the left edge). */
      /* Owner 8/15 ("a day is a bit of space to the left of its label AND to
         the right"): when a ghost day is active the real band renders
         through the END of the last logged day's cell (tick + half step),
         with its asymptotic tail decaying to that boundary - the ghost
         wedge owns today's cell from that boundary to the frame edge. */
      const ghostEnd = eng.model && eng.model.ghostAt != null;
      const endX = ghostEnd ? Math.min(rp.x + g.stepPx / 2, g.A.right) : g.A.right;
      const ls = tailSamples(lp.x, lp.y, mL, g.A.left);
      const rs = ghostEnd ? tailSamples(rp.x, rp.y, mR, endX) : tailSamples(rp.x, rp.y, mR, g.A.right);
      if (ghostEnd) {
        eng.ghostLead = eng.ghostLead || {};
        eng.ghostLead[di] = { x: endX, y: rs && rs.length ? rs[rs.length - 1].y : rp.y };
      }
      const ltD = ls ? curveThrough(ls.slice().reverse(), null, mL) : ''; // edge -> lp, ends tangent at lp
      const rtD = rs ? curveThrough(rs, mR, null).replace(/^M[^C]+/, '') : ''; // rp -> edge, starts tangent at rp (drop M + first coords)
      // linePathD leads with M and the first point's coords: the left tail
      // (or an explicit M at lp) already owns that start, so drop both.
      const bodyD = linePathD(pts).replace(/^M[^C]+/, '');
      /* Owner 8/15 (left-cut veto, macros only): macro bands extend back to the
         window's left edge with the asymptotic tail - the no-backfill rule is
         per WORKOUT series ("only start things when they start" was about a
         single exercise band). */
      const lineD = (ltD || ('M' + rn2(lp.x) + ',' + rn2(lp.y))) + bodyD + rtD;
      const areaD = lineD + 'L' + rn2(endX) + ',' + rn2(y0) + 'L' + rn2(g.A.left) + ',' + rn2(y0) + 'Z';
      /* Clear = opaque geometry with translucent fill (Owner 8/18): bands
         collect here and emit in a pass AFTER all series are parsed, so a
         Clear band can be masked by the areas of every band in front of it.
         Opaque bands stay fills-only; Clear keeps the series edge. */
      const opaque = eng.model && eng.model.smoothOpaque;
      (eng.smB = eng.smB || []).push({ A: areaD, S: lineD, c: ds.color, f: ds.fill, op: opaque });
      return '';
    }

    /* ---- tooltip: canvas tooltipCfg parity (groupCenter, caretSize 0,
       caretPadding 8, card 10px padding, 6px radius, #e4e4e4 border) ---- */
    function buildTipContent(els) {
      // els: [{di, index, x, y}] - items follow dataset order, null y filtered
      const model = eng.model;
      const idx = els[0].index;
      const title = String(model.labels[idx]);
      /* Ghost slot: values come from model.ghosts (not ds.data), and the
         title carries a green Projected badge (Owner 8/15). */
      const proj = els.some(e => e.proj) && model.ghostAt != null && idx === model.ghostAt && model.ghosts;
      let rows = '';
      for (const e of els) {
        const dsm = model.datasets[e.di];
        const v = proj ? model.ghosts[e.di] : dsm.data[idx];
        if (v === null || v === undefined || !isFinite(v)) continue;
        rows += '<div class="r"><span class="chip" style="background:' + dsm.color + '"></span><span>' +
          escXml(dsm.label) + ': ' + escXml(new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Math.round(v))) + '</span></div>';
      }
      if (!rows) return null;
      return '<div class="t">' + escXml(title) +
        (proj ? ' <span style="color:#3E7C4F;font-weight:600">&middot; Projected</span>' : '') + '</div>' + rows;
    }
    /* Workout-chart tooltip feel for macros too (Owner 8/15, live prod: "not
       nearly as buttery"): ONE shared glide rule - the card follows the live
       cursor x continuously, y pinned to the chart-area middle, body draws
       LEFT of the 8px caret pad; content rebuilds ONLY on column change. No
       per-element teleporting, no vertical jumping with stack height. */
    function showTip(els) {
      const html = buildTipContent(els);
      if (!html) { hideTip(); return; }
      if (tip.innerHTML !== html) tip.innerHTML = html;
      atipShow();
      eng.tipW = tip.offsetWidth; eng.tipH = tip.offsetHeight; // once per key
      eng.tipIdx = els[0].index;
      eng.tipOn = true;
      if (eng.hooks && eng.hooks.hoverCursor && eng.hooks.onTipClick) tip.style.cursor = 'pointer';
    }
    function glideTip(px) {
      if (!eng.tipOn || !eng.tipW) return;
      const g = eng.geom;
      const my = (g.A.top + g.A.bottom) / 2;
      /* Average view (Owner 8/17 + screenshot): the card must sit exactly
         horizontally centered in the plot area, not anchored to the tap. */
      if (eng.model && eng.model.avgBars) {
        let acx = Math.round((g.A.left + g.A.right) / 2 - eng.tipW / 2);
        acx = Math.max(g.A.left - 8, Math.min(acx, g.A.right + 8 - eng.tipW));
        acx = Math.max(0, Math.min(acx, g.W - eng.tipW));
        let atop = my - eng.tipH / 2;
        if (atop < 0) atop = 0;
        if (atop + eng.tipH > g.H) atop = Math.max(0, g.H - eng.tipH);
        tip.style.transform = 'translate3d(' + acx + 'px,' + Math.round(atop) + 'px,0)';
        return;
      }
      let right = px - 8;
      if (right - eng.tipW < g.A.left) right = g.A.left + eng.tipW;
      if (right - eng.tipW < 0) right = eng.tipW;
      let top = my - eng.tipH / 2;
      if (top < 0) top = 0;
      if (top + eng.tipH > g.H) top = Math.max(0, g.H - eng.tipH);
      tip.style.transform = 'translate3d(' + Math.round(right - eng.tipW) + 'px,' + Math.round(top) + 'px,0)';
    }
    function atipShow() { tip.style.display = 'block'; }
    function hideTip() { tip.style.display = 'none'; eng.tipOn = false; eng.tipIdx = -1; eng.tipKey = null; tip.style.cursor = 'default'; }

    /* ---- colAbove hover zone (ported): tooltip reacts only in the column
       air above the tallest stack of the hovered day ---- */
    function colAboveEls(px, py) {
      const model = eng.model, g = eng.geom;
      if (!g || g.n === 0) return [];
      if (py < g.A.top - 1 || py > g.A.bottom + 1) return [];
      // nearest day index by x
      let best = 0, bd = Infinity;
      for (let i = 0; i < g.n; i++) { const dd = Math.abs(g.tickXs[i] - px); if (dd < bd) { bd = dd; best = i; } }
      const idx = best;
      const els = [];
      if (model.mode === 'smooth') {
        model.datasets.forEach((ds, di) => {
          const pt = (eng.lineSel[di] || []).find(p => p.i === idx);
          if (pt) els.push({ di: di, index: idx, x: pt.x, y: pt.y, w: 0 });
        });
      } else {
        model.datasets.forEach((ds, di) => {
          const b = (eng.bars[di] || [])[idx];
          if (b) els.push({ di: di, index: idx, x: b.cx, y: b.y, w: b.w, minX: b.x, maxX: b.x + b.w });
        });
      }
      /* Buttery glide parity with the workout chart (Owner 8/15): the workout
         tooltip never flickers - over a rest day it resolves the NEAREST
         SESSION and shows that session's values. Smoothed fills look identical
         across a gap (the carried curve covers it visually), so an unlogged
         slot resolves the nearest LOGGED slot instead of dropping the tip. */
      /* Ghost slot tooltip (Owner 8/15, "there should still be a tooltip, it
         should just say projected in green"): the unlogged today's column
         resolves PROJECTED ghost values like a real day, before the
         nearest-logged-day fallback redirects to yesterday. Applies in raw
         too (ghost bars at today's slot have no row either). */
      if (!els.length && model.ghostAt != null && idx === model.ghostAt && model.ghosts) {
        model.datasets.forEach((ds, di) => {
          if (!g.scales[ds.axis].display) return;
          const v = model.ghosts[di];
          if (v === null || v === undefined || !isFinite(v)) return;
          els.push({ di: di, index: idx, x: g.tickXs[idx], y: g.scales[ds.axis].pixelForValue(v), w: 0, proj: true });
        });
      }
      if (!els.length && model.mode === 'smooth') {
        findGap: for (let dlt = 1; dlt < g.n; dlt++) {
          for (const jj of [idx - dlt, idx + dlt]) {
            if (jj < 0 || jj >= g.n) continue;
            model.datasets.forEach((ds, di) => {
              const pt = (eng.lineSel[di] || []).find(p => p.i === jj);
              if (pt) els.push({ di: di, index: jj, x: pt.x, y: pt.y, w: 0 });
            });
            if (els.length) break findGap;
          }
        }
      }
      if (!els.length) return [];
      const stacks = new Map();
      for (const el of els) {
        const key = Math.round(el.x);
        let gg = stacks.get(key);
        if (!gg) stacks.set(key, gg = { top: Infinity, minX: Infinity, maxX: -Infinity });
        if (el.y < gg.top) gg.top = el.y;
        const w = el.w || 0;
        if (el.x - w / 2 < gg.minX) gg.minX = el.x - w / 2;
        if (el.x + w / 2 > gg.maxX) gg.maxX = el.x + w / 2;
      }
      let tall = null;
      for (const gg of stacks.values()) if (!tall || gg.top < tall.top) tall = gg;
      if (!tall) return [];
      // Average view (Owner 8/15): one category, four side-by-side bars - the
      // skinny per-bar column rule makes the tooltip nearly unhittable, so
      // anywhere in the plot shows it.
      // Smoothed fills (Opaque + Clear) share the workout chart's hover
      // rule: anywhere in the plot resolves the nearest column's tooltip. The
      // old "above the tallest bar" test can never fire inside an area fill.
      if (model.mode === 'smooth' || model.avgBars) return els;
      if (model.ghostAt != null && idx === model.ghostAt) return els;
      /* Raw (Owner 8/15, "tooltip for the raw chart is still broken... it needs
         to fire on hover over ANY bar"): the old test required py ABOVE the
         tallest stack's top, so hovering inside a bar - where the cursor
         actually lives - silently returned nothing. Fire when the pointer is
         inside any bar rect of the resolved column, or in the column air
         above the tallest stack (original zone, kept for gap hovers). */
      if (py <= tall.top + 4) return els;
      for (const el of els) {
        if (el.w && px >= el.minX && px <= el.maxX && py >= el.y - 4) return els;
      }
      if (px >= tall.minX - 4 && px <= tall.maxX + 4 && py < tall.top + 4) return els;
      return [];
    }

    function barHit(px, py) {
      // strict intersect over bars (raw/avg modes)
      if (!eng.geom || eng.model.mode === 'smooth') return null;
      for (let di = 0; di < eng.bars.length; di++) {
        const list = eng.bars[di];
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const b = list[i];
          if (!b) continue;
          if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.base) return { di: di, index: i, b: b };
        }
      }
      /* Owner 8/17 ("treat the area above like air rights"): the zone ABOVE a
         bar belongs to that bar alone - the bar's own x-extent, from its top
         edge up to the plot top. A tap there opens THAT bar's blow-up; an
         adjacent bar owns its own air and is never hit from here. */
      const g0 = eng.geom;
      if (py >= g0.A.top - 1 && py <= g0.A.bottom + 1) {
        for (let di = 0; di < eng.bars.length; di++) {
          const list = eng.bars[di];
          if (!list) continue;
          for (let i = 0; i < list.length; i++) {
            const b = list[i];
            if (!b || b.h <= 0) continue;
            if (px >= b.x && px <= b.x + b.w && py < b.y) return { di: di, index: i, b: b };
          }
        }
      }
      /* Owner 8/17: today's GHOST column is part of the day's tap target even
         though it carries no data ("the click up area to get the blowup
         should include the ghost graph"). The dashed rects are pointer-
         events:none, so extend the hit: the plot band over today's cell
         counts as a tap on today - resolved to the macro whose SLOT the tap
         sits in, so one ghost building's air never opens a neighbor's pane. */
      const m = eng.model;
      if (m.ghostAt != null && m.ghosts) {
        const g = eng.geom;
        const gds = Object.keys(m.ghosts).map(Number).filter(d => g.scales[m.datasets[d].axis].display && isFinite(m.ghosts[d]));
        if (gds.length) {
          const gi = m.ghostAt;
          const left = g.tickXs[gi] - g.catSlot / 2, right = left + g.catSlot;
          if (px >= left && px <= right && py >= g.A.top && py <= g.A.bottom) {
            /* Air-rights partition inside the ghost column too: resolve the
               macro whose bar slot owns this x (same chunk layout the ghost
               rects are drawn with), so a tap above ghost bar X opens X's
               pane, never a neighbor's. */
            let gdi = gds[0], gbd = Infinity;
            gds.forEach(di => {
              const k = g.barSlot[di] !== undefined ? g.barSlot[di] : gds.indexOf(di);
              const cx = left + g.chunk * k + g.chunk / 2;
              const dd = Math.abs(cx - px);
              if (dd < gbd) { gbd = dd; gdi = di; }
            });
            return { di: gdi, index: gi, b: null };
          }
        }
      }
      return null;
    }

    function clearHover() {
      if (eng.hover) {
        const el = eng.hoverEl;
        if (el) el.setAttribute('fill', eng.model.datasets[eng.hover.di].color);
        if (eng.focus && eng.focus.di === eng.hover.di && eng.focus.i === eng.hover.index) {
          // hovered focus bar keeps its segmented palette
          el.setAttribute('fill', eng.model.datasets[eng.hover.di].color);
        }
      }
      eng.hover = null; eng.hoverEl = null;
    }


    /* Shared tooltip tracker: resolve the column at (px,py), rebuild content
       only on column change, glide the card along x. Used by mouse hover
       AND by the touch drag gesture below. */
    function tipTrack(px, py) {
      /* Average view (Owner 8/17: "tooltip should not move around if I drag"):
         one aggregate column means one tip position forever - once shown, a
         finger/mouse drag leaves the card where it pinned. */
      if (eng.model && eng.model.avgBars && eng.tipOn) return;
      const els = colAboveEls(px, py);
      if (els.length) {
        const key = els[0].index + ':' + els.map(e => e.di).join('.');
        if (eng.tipKey !== key) { eng.tipKey = key; showTip(els); }
        glideTip(px);
      } else if (eng.tipOn) hideTip();
    }

    function onMove(e) {
      if (!eng.geom || !eng.model) return;
      const r = host.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const hooks = eng.hooks;
      // hover shade: only the bar actually under the cursor darkens
      const hb = barHit(px, py);
      if (hb && hooks.hoverBars && eng.model.mode !== 'smooth') {
        if (!eng.hover || eng.hover.di !== hb.di || eng.hover.index !== hb.index) {
          clearHover();
          eng.hover = { di: hb.di, index: hb.index };
          const el = eng.svg.querySelector('rect.bar[data-d="' + hb.di + '"][data-i="' + hb.index + '"]');
          eng.hoverEl = el;
          const covered = eng.focus && eng.focus.di === hb.di && eng.focus.i === hb.index;
          if (el && !covered) el.setAttribute('fill', eng.model.datasets[hb.di].hover);
        }
      } else if (eng.hover) clearHover();
      // tooltip
      if (hooks.tooltipEnabled) tipTrack(px, py);
      // cursor: pointer over bars, over the tooltip card, or (smoothed
      // Opaque/Clear) anywhere in the plot - those days are click-to-blow-up
      // (Owner 8/15: "the glove instead of the cursor icon")
      if (hooks.hoverCursor) {
        const g0 = eng.geom;
        const overTip = eng.tipOn && tip.style.display !== 'none' && tip.contains(e.target);
        const smoothPlot = eng.model.mode === 'smooth' && hooks.onDayClick && g0 &&
          py >= g0.A.top - 1 && py <= g0.A.bottom + 1 && px >= g0.A.left && px <= g0.A.right;
        host.style.cursor = (hb && hooks.hoverBars) || overTip || smoothPlot ? 'pointer' : 'default';
        tip.style.cursor = eng.tipIdx >= 0 ? 'pointer' : 'default';
      }
    }

    function onLeave() { clearHover(); hideTip(); if (eng.hooks && eng.hooks.hoverCursor) host.style.cursor = 'default'; }

    /* Color-aware stacked blow-up (Owner 8/15: "When I click on different
       colors different blowups should come man"): resolve WHICH band a plot
       click landed in - the last-painted (topmost) visible series whose
       smoothed top edge covers the click y at that x, interpolated between
       logged-day anchors so mid-gap fills hit the right color too. Returns
       the dataset index, or -1 when the click sits above every band (that
       keeps the plain day blow-up). */
    function smoothBandAt(g, px, py) {
      const model = eng.model;
      if (!g || !model || model.mode !== 'smooth') return -1;
      const ord = model.seriesOrder || model.datasets.map((dd, ii) => ii);
      let hit = -1, bestPos = -1;
      model.datasets.forEach((ds, di) => {
        const sc = g.scales[ds.axis];
        if (!sc || !sc.display) return;
        const pts = (eng.lineSel[di] || []).slice().sort((a, b) => a.x - b.x);
        if (!pts.length) return;
        let top;
        if (px <= pts[0].x) top = pts[0].y;
        else if (px >= pts[pts.length - 1].x) top = pts[pts.length - 1].y;
        else {
          for (let k = 1; k < pts.length; k++) {
            if (pts[k].x >= px) {
              const a = pts[k - 1], b = pts[k], t = (px - a.x) / Math.max(0.0001, b.x - a.x);
              top = a.y + (b.y - a.y) * t;
              break;
            }
          }
        }
        /* 4px of fat-finger slack above the edge; never below the baseline. */
        if (top !== undefined && py >= top - 4 && py <= g.A.bottom + 1) {
          const pos = ord.indexOf(di);
          if (pos > bestPos) { bestPos = pos; hit = di; }
        }
      });
      return hit;
    }

    function onClick(e) {
      if (window.suppressBlowClick) { window.suppressBlowClick = false; return; }
      if (!eng.geom || !eng.model || !eng.hooks) return;
      if (tip.contains(e.target)) return; // tip handles its own click
      const r = host.getBoundingClientRect();
      blowAt(e.clientX - r.left, e.clientY - r.top);
    }

    function blowAt(px, py) {
      if (!eng.geom || !eng.model || !eng.hooks) return;
      const hb = barHit(px, py);
      if (hb && eng.hooks.onBarClick) { eng.hooks.onBarClick(hb.di, hb.index); return; }
      /* Smooth/stacked mode has no bars - a click anywhere in the plot fans
         that day open. The hover tooltip has already resolved the nearest
         LOGGED day (O - its index is eng.tipIdx - so the click opens exactly
         the day the tooltip was showing (Owner 8/15: restore the Opaque/Clear
         blow-up pane, "make the clicking better"). Without a tooltip (touch),
         fall back to nearest tick, then nearest logged tick, so a gap click
         never silently no-ops under the carried fill. */
      if (eng.model.mode === 'smooth' && eng.hooks.onDayClick) {
        const g = eng.geom;
        if (py >= g.A.top - 1 && py <= g.A.bottom + 1 && px >= g.A.left && px <= g.A.right) {
          let best = eng.tipOn ? eng.tipIdx : -1;
          if (best < 0) {
            let bd = Infinity;
            best = 0;
            for (let i = 0; i < g.n; i++) { const dd = Math.abs(g.tickXs[i] - px); if (dd < bd) { bd = dd; best = i; } }
            const hasPt = ii => (eng.lineSel || []).some(arr => (arr || []).some(p => p.i === ii));
            if (!hasPt(best)) {
              findC: for (let dlt = 1; dlt < g.n; dlt++) {
                for (const jj of [best - dlt, best + dlt]) {
                  if (jj < 0 || jj >= g.n) continue;
                  if (hasPt(jj)) { best = jj; break findC; }
                }
              }
            }
          }
          eng.hooks.onDayClick(best, smoothBandAt(g, px, py));
        }
      }
    }

    function onTipClickEl(e) {
      if (window.suppressBlowClick) { window.suppressBlowClick = false; e.stopPropagation(); return; }
      e.stopPropagation();
      if (eng.hooks && eng.hooks.onTipClick && eng.tipIdx >= 0) eng.hooks.onTipClick(eng.tipIdx);
    }

    /* ---- focus repaint: the blown-up bar redraws as stacked item segments ---- */
    function focusBar(di, idx, segs) {
      clearFocus();
      const b = (eng.bars[di] || [])[idx];
      if (!b || !segs || !segs.length || b.h <= 0) return false;
      const el = eng.svg.querySelector('rect.bar[data-d="' + di + '"][data-i="' + idx + '"]');
      if (!el) return false;
      const tot = segs.reduce((a, s) => a + s.v, 0);
      if (!tot) return false;
      eng.focus = { di: di, i: idx, el: el, prevDisplay: el.style.display };
      facade.data.datasets[di] = facade.data.datasets[di] || {};
      el.setAttribute('display', 'none');
      const gg = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      gg.setAttribute('class', 'focus-stack');
      gg.setAttribute('pointer-events', 'none');
      let ycur = b.base; // stack upward, biggest segment at the bottom
      for (let k = segs.length - 1; k >= 0; k--) {
        const s = segs[k];
        const h = b.h * (s.v / tot);
        ycur -= h;
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', rn2(b.x)); rect.setAttribute('y', rn2(ycur));
        rect.setAttribute('width', rn2(b.w)); rect.setAttribute('height', rn2(Math.max(h, 0)));
        rect.setAttribute('fill', s.color);
        gg.appendChild(rect);
      }
      // keep the frame/goal lines above the repaint like the canvas build
      eng.svg.appendChild(gg);
      eng.focus.node = gg;
      return true;
    }
    function clearFocus() {
      if (!eng.focus) return;
      eng.focus.el.removeAttribute('display');
      if (eng.focus.node && eng.focus.node.parentNode) eng.focus.node.parentNode.removeChild(eng.focus.node);
      eng.focus = null;
    }

    host.__blowHitTest = e => {
      if (!eng.geom || !eng.model) return null;
      const r = host.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const b = barHit(px, py);
      if (b) return { di: b.di, i: b.index };
      if (eng.model.mode === 'smooth') {
        const g = eng.geom;
        if (py >= g.A.top - 1 && py <= g.A.bottom + 1 && px >= g.A.left && px <= g.A.right) {
          let best = 0, bd = Infinity;
          for (let i = 0; i < g.n; i++) { const dd = Math.abs(g.tickXs[i] - px); if (dd < bd) { bd = dd; best = i; } }
          return { di: smoothBandAt(g, px, py), i: best };
        }
      }
      return null;
    };

    host.addEventListener('mousemove', onMove);
    host.addEventListener('mouseleave', onLeave);
    host.addEventListener('click', onClick);
    /* Owner 8/16 touch gestures ("for mobile I want tooltip given drag but
       blowup given click - first fix blowup"): iOS/WKWebView taps on bare
       SVG reliably fail delegated click delivery, so a real blow-up never
       came up on the phone. Own the touch stream: a tap (no movement)
       hit-tests and opens the blow-up natively with the synthetic click
       suppressed; a horizontal drag inside the plot runs the same tooltip
       tracker the mouse hover uses ("tooltip given 'drag'"); a
       vertical-dominant gesture is released to the page scroll. */
    let tG = null; // {x, y, drag}
    host.addEventListener('touchstart', e => {
      const t = e.changedTouches[0];
      tG = { x: t.clientX, y: t.clientY, drag: false };
    }, { passive: true });
    host.addEventListener('touchmove', e => {
      if (!tG || !eng.geom || !eng.model) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - tG.x, dy = t.clientY - tG.y;
      if (!tG.drag) {
        if (Math.abs(dx) < 9 && Math.abs(dy) < 9) return;
        if (Math.abs(dy) > Math.abs(dx)) { tG = null; return; } // page scroll owns it
        tG.drag = true;
      }
      if (e.cancelable) e.preventDefault();
      const r = host.getBoundingClientRect();
      tipTrack(t.clientX - r.left, t.clientY - r.top);
    }, { passive: false });
    /* Owner 8/16: the drag-tooltip is the thing they taps ("the stuff in the
       popup") - keep the card up on finger lift so there is something to
       tap; tapping the card opens that day's Notion page (same action the
       desktop tooltip click takes) via hooks.onTipClick. */
    const tipTapOpen = (target) => {
      if (!eng.hooks || !eng.hooks.onTipClick || eng.tipIdx < 0) return false;
      eng.hooks.onTipClick(eng.tipIdx);
      return true;
    };
    host.addEventListener('touchend', e => {
      if (!tG) return;
      const t = e.changedTouches[0];
      if (tG.drag) { if (e.cancelable) e.preventDefault(); tG = null; return; }
      // tap: swallow the synthetic click (or desktop double-fires) and run
      // the blow-up hit-test natively
      window.suppressBlowClick = true;
      setTimeout(() => { window.suppressBlowClick = false; }, 700);
      if (e.cancelable) e.preventDefault();
      const panel = document.querySelector('.blow');
      if (tip.style.display !== 'none' && tip.contains(e.target)) { tipTapOpen(e.target); tG = null; return; }
      if (panel && !panel.contains(e.target)) {
        // a blow-up is already open: mirror the document close/retarget path
        const hit = host.__blowHitTest({ clientX: t.clientX, clientY: t.clientY });
        if (hit && host.__blowRetarget) {
          closeBlow();
          requestAnimationFrame(() => { host.__blowRetarget(hit.di, hit.i); });
        } else closeBlow();
      } else if (!panel) {
        if (!eng.geom || !eng.model || !eng.hooks) { tG = null; return; }
        if (tip.style.display !== 'none' && tip.contains(e.target)) {
          tipTapOpen(e.target); // tap the card: day page, desktop parity
        } else if (eng.model.avgBars) {
          /* Average-view tap (Owner 8/17: "tooltip for the average view is
             broken" on mobile): avg bars have no day blow-up, so the Raw-view
             tap->blowAt path silently no-oped. A tap pins the same tooltip
             the drag tracker shows, resolved at the tap point. */
          const r = host.getBoundingClientRect();
          tipTrack(t.clientX - r.left, t.clientY - r.top);
        } else {
          hideTip(); // a chart tap with a stale card opens the blow-up fresh
          const r = host.getBoundingClientRect();
          blowAt(t.clientX - r.left, t.clientY - r.top);
        }
      }
      tG = null;
    }, { passive: false });
    host.addEventListener('touchcancel', () => { if (tG && tG.drag) hideTip(); tG = null; }, { passive: true });
    tip.addEventListener('click', onTipClickEl);
    if (typeof ResizeObserver !== 'undefined') {
      eng.ro = new ResizeObserver(() => {
        const w = host.clientWidth, h = host.clientHeight;
        if (w !== eng.lastW || h !== eng.lastH) if (eng.model) renderSVG(eng.model);
      });
      eng.ro.observe(host);
    }

    return {
      render(model, hooks) {
        eng.model = model;
        eng.hooks = hooks;
        clearFocus(); clearHover(); hideTip(); eng.tipKey = null;
        renderSVG(model);
      },
      resize(force) {
        const w = host.clientWidth, h = host.clientHeight;
        if (force || w !== eng.lastW || h !== eng.lastH) if (eng.model) renderSVG(eng.model);
      },
      focusBar: focusBar,
      clearFocus: clearFocus,
      chartArea: () => eng.chartArea,
      fake: facade,
      host: host
    };
  }

  return { create: create, clearMeasureCache: function () { mcache = {}; },
    // Shared internals for sibling renderers (additive export only).
    lib: {
      measureText: measureText,
      genNumericTicks: genNumericTicks,
      numericTickLabel: numericTickLabel,
      decPlaces: decPlaces,
      tickFonts: tickFonts,
      alignPixel: alignPixel,
      splineCurve: splineCurve,
      buildCurve: buildCurve,
      capBezier: capBezier,
      linePathD: linePathD,
      rn2: rn2,
      escXml: escXml
    } };
})();


const crispCanvas = {
  id: 'crispCanvas',
  /* Canvas crispness: Chart.js 4 rounds the backing store with
     floor(size*dpr) while clamping the CSS size to floor(size); when the
     container size lands on a half pixel, the bitmap ends up one device
     pixel wider than what the CSS box displays (~1.002x scale) and bars/text
     go soft. On every resize, clamp the CSS size to whole pixels and rebuild
     the backing store to exactly size*dpr so bitmap:CSS is exactly dpr:1.
     (Hook name is "resize" in Chart.js 4 - notifyPlugins("resize", {size});
     "afterResize" is a Chart.js 3 name and silently never fires.) */
  resize(ch, args) {
    const size = (args && args.size) || { width: ch.width, height: ch.height };
    const dpr = ch.options.devicePixelRatio || Math.max(2, window.devicePixelRatio || 1);
    const w = Math.floor(size.width), h = Math.floor(size.height);
    ch.canvas.style.width = w + 'px';
    ch.canvas.style.height = h + 'px';
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (ch.canvas.width === bw && ch.canvas.height === bh) return;
    ch.canvas.width = bw;
    ch.canvas.height = bh;
    ch.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
};
const gridY = () => ({ color: THEME.grid, drawTicks: false });

function drawLegend(el, items, onToggle) {
  el.innerHTML = items.map((it, i) =>
    '<span class="item' + (onToggle ? ' tog' : '') + (it.off ? ' off' : '') + '" data-i="' + i + '">' +
      '<span class="sw" style="background:' + it.color + '"></span>' + it.label +
      (onToggle ? '<span class="x">\u00d7</span>' : '') +
    '</span>'
  ).join('');
  if (!onToggle) return;
  el.querySelectorAll('.item').forEach(node => {
    node.addEventListener('click', () => onToggle(items[Number(node.dataset.i)].label));
  });
}

if (typeof Chart !== "undefined") Chart.Tooltip.positioners.groupCenter = function(items) {
  if (!items.length) return false;
  let sx = 0, top = Infinity;
  for (const it of items) { sx += it.element.x; top = Math.min(top, it.element.y); }
  return { x: sx / items.length, y: top };
};

const boxAndRefs = {
  id: 'boxAndRefs',
  afterDatasetsDraw(chart) {
    const { ctx, chartArea: a, scales } = chart;
    ctx.save();
    ctx.strokeStyle = GRID; ctx.lineWidth = 1;
    ctx.strokeRect(a.left + 0.5, a.top + 0.5, a.right - a.left - 1, a.bottom - a.top - 1);
    // A goal line carries no floating label; the matching axis tick is colored
    // instead. Hiding a series takes its line and its colored tick with it.
    // Goal lines are fixed reference marks: they never react to hover.
    const ref = (scale, value, color) => {
      if (!scale) return;
      const y = scale.getPixelForValue(value);
      if (y < a.top || y > a.bottom) return;
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.globalAlpha = 0.75;
      ctx.beginPath(); ctx.moveTo(a.left, y); ctx.lineTo(a.right, y); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    };
    for (const m of shownMacros()) if (m.goal !== null) ref(scales[m.axis], m.goal, m.color);
    ctx.restore();
  }
};

function windowRows(w) {
  if (!w || !ROWS.length) return ROWS;
  const last = new Date(ROWS[ROWS.length - 1].date + 'T00:00:00');
  return ROWS.filter(r => (last - new Date(r.date + 'T00:00:00')) / 86400000 < w);
}
const fmt = d => { const [y, m, day] = d.split('-'); return new Date(y, m - 1, day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };

let chart, currentW = 7, mMode = 'raw', lastMode = 'raw', mOpaque = true; // Owner 8/15: smoothed view defaults to Opaque
/* Owner 8/17: Average moves out of the mode row into the date-range row as a
   MODIFIER - any shape mode (Raw/Opaque/Clear) can be averaged over the
   selected range. Average can never stand alone: a shape mode is always on. */
let avgOn = false;

// A day with no entry isn't a zero day, it's a day with no logs, and today is
// still in progress. Averaging over those would understate their intake, so the
// mean covers logged days only and skips today unless it's all there is.
const TODAY = new Date().toISOString().slice(0, 10);
function meanOf(rows, key) {
  let vals = rows.filter(r => r[key] !== null && r[key] !== undefined && r[key] > 0);
  const past = vals.filter(r => r.date !== TODAY);
  if (past.length) vals = past;
  if (!vals.length) return { avg: null, n: 0 };
  return { avg: vals.reduce((a, r) => a + r[key], 0) / vals.length, n: vals.length };
}
// A hovered bar just gets a touch darker; nothing else on the chart moves.
const shade = (hex, f) => {
  const n = parseInt(hex.slice(1), 16);
  const mix = v => Math.round(v * (1 - f));
  return 'rgb(' + mix((n >> 16) & 255) + ',' + mix((n >> 8) & 255) + ',' + mix(n & 255) + ')';
};
const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
};

// Per-item segment colors: one hue family per metric; saturation and
// lightness fan out deterministically by rank (t = index / (n-1), smallest
// slice t=0 -> biggest t=1): saturation 55% -> 100%, lightness 80% -> 40%.
// The neon mid-tones sit in the reachable range for any item count, and even
// two tiny adjacent slices never read as the same shade. Row chips reuse the
// same colors.
const segColors = (hex, n) => {
  const v = parseInt(hex.slice(1), 16);
  const r = (v >> 16) & 255, g = (v >> 8) & 255, b = (v & 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const d = (mx - mn) / 255;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = 60 * (((g - b) / 255 / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / 255 / d + 2);
    else h = 60 * ((r - g) / 255 / d + 4);
  }
  h = Math.round((h + 360) % 360);
  const green = h >= 90 && h <= 165; // muted-green family keeps saturation capped
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? (green ? 0 : 1) : i / (n - 1);
    let s, l;
    if (green) {
      /* Darker goes on the BOTTOM (Owner 8/15 flip): the largest slice - the
         bottom of the bar - carries the exact base color, washing lighter
         toward the smallest slice at the top. u = 1 - t since t=0 is the
         smallest/top slice. */
      const u = 1 - t;
      const l0 = (mx + mn) / 510 * 100;
      const s0 = d === 0 ? 0 : Math.min(100 * d / (1 - Math.abs(2 * (l0 / 100) - 1)), 65);
      s = s0 + (65 - s0) * u;
      l = l0 + (80 - l0) * u;
    } else {
      s = 55 + 45 * t;
      l = 80 - 40 * t;
    }
    out.push('hsl(' + h + ',' + Math.round(s) + '%,' + Math.round(l) + '%)');
  }
  if (green) out[n - 1] = hex; // the bottom (largest) slice is the exact bar color
  return out;
};
const round1 = v => Math.round(v * 10) / 10;

// Two presets over the same eight macros: the big daily numbers, and the
// breakdown underneath them. A preset only sets which macros are on - every
// legend toggle still works afterwards, and hand-toggling away from a preset
// just leaves none of them lit.
const GROUPS = {
  all: MACROS.map(m => m.key),
  core: ['calories', 'protein', 'carbs', 'sodium'],
  detail: ['fat', 'satfat', 'sugar', 'fiber']
};
function markGroup() {
  const on = MACROS.filter(m => !mHidden[m.key]).map(m => m.key).sort().join(',');
  document.querySelectorAll('#mgrp button').forEach(b => {
    b.classList.toggle('on', GROUPS[b.dataset.g].slice().sort().join(',') === on);
  });
}
function applyGroup(name) {
  const keep = GROUPS[name];
  for (const m of MACROS) mHidden[m.key] = keep.indexOf(m.key) < 0;
  render(currentW);
}
document.querySelectorAll('#mgrp button').forEach(b =>
  b.addEventListener('click', () => applyGroup(b.dataset.g)));

function macroLegend() {
  drawLegend(document.getElementById('mlegend'),
    MACROS.map(m => ({ label: m.label, color: m.color, off: !!mHidden[m.key] })),
    label => {
      const m = MACROS.find(x => x.label === label);
      if (!m) return;
      mHidden[m.key] = !mHidden[m.key];
      render(currentW);
      markGroup();
    });
}

/* ---- Bar blow-up: clicking a bar fans it out into its item stack on a side
   panel while the chart pans out from under it. Everything shown here is
   already in the page; nothing is fetched. ---- */
let blowState = null;
function closeBlow(root) {
  root = root || document;
  root.querySelectorAll('.blow').forEach(b => b.remove());
  document.body.classList.remove('blowing');
  if (blowState) {
    const st = blowState; blowState = null;
    if (st.focus) {
      const ds = st.focus.chart.data.datasets[st.focus.di];
      ds.backgroundColor = st.focus.color;
      ds.hoverBackgroundColor = st.focus.hover;
      st.focus.chart.update();
    }
    st.wrap.style.width = '';
    st.wrap.style.marginLeft = '';
    requestAnimationFrame(() => { const ch = st.cv && typeof Chart !== 'undefined' && Chart.getChart(st.cv); if (ch) ch.resize(); const eng = st.cv && st.cv.__svgChart; if (eng) eng.resize(); });
  }
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeBlow(); });
// Clicking another bar while a blow-up is open retargets the panel to that
// bar; clicking anything that is not a bar closes it. Either way the chart's
// own RAF-delayed onClick is swallowed (suppressBlowClick) so a stale
// coordinate lookup cannot fire after the panel's layout shift.
var suppressBlowClick = false;
// Any non-panel click closes the blow-up. Listening on click rather than
// pointerdown means the layout only shifts after hit-testing, so a click can
// never be mapped against a half-resized chart (that race used to open the
// wrong bar).
document.addEventListener('click', e => {
  const panel = document.querySelector('.blow');
  if (!panel || panel.contains(e.target)) return;
  /* Owner 8/17 ("go back to whatever was under the popup"): clicks on the record
     sheet or its dim dismiss the SHEET only - never the blow-up underneath.
     This runs in the capture phase, so the backdrop's own stopPropagation
     arrives too late; its clicks must be exempted here at the source. */
  if (e.target.closest && e.target.closest('.rsheet-back')) return;
  const svghost = e.target.closest && e.target.closest('.svghost');
  if (svghost) {
    // SVG build: same lifecycle as the canvas path - swallow the upcoming
    // proxied click, hit-test on pre-shift geometry, retarget via rAF.
    suppressBlowClick = true;
    setTimeout(() => { suppressBlowClick = false; }, 1500);
    const hit = svghost.__blowHitTest ? svghost.__blowHitTest(e) : null;
    if (hit && svghost.__blowRetarget) {
      closeBlow();
      requestAnimationFrame(() => { svghost.__blowRetarget(hit.di, hit.i); });
      return;
    }
    closeBlow();
    return;
  }
  if (e.target.tagName === 'CANVAS') {
    // Chart.js throttles its click proxy through requestAnimationFrame, so the
    // guard must outlive the next animation frame, not just this task. The
    // proxied onClick is always swallowed - its hit-test would run on stale
    // coordinates after the panel's layout shift, so the bar lookup happens
    // here instead, before anything moves.
    suppressBlowClick = true;
    // Consumed by whatever chart onClick the click reaches; the timeout is
    // only a fallback for clicks that never reach a chart handler.
    setTimeout(() => { suppressBlowClick = false; }, 1500);
    // Hit on a bar = retarget the panel (never close-then-reopen on the wrong
    // bar); a click off the bars still falls through to closeBlow().
    const chx = typeof Chart !== 'undefined' ? Chart.getChart(e.target) : null;
    if (chx && e.target.__blowRetarget) {
      const hits = chx.getElementsAtEventForMode(e, 'nearest', { intersect: true }, false);
      if (hits.length) {
        const cv = e.target, rdi = hits[0].datasetIndex, ridx = hits[0].index;
        closeBlow();
        requestAnimationFrame(() => { cv.__blowRetarget(rdi, ridx); });
        return;
      }
    }
  }
  closeBlow();
}, true);
const fmtVal = (v, u) => Math.round(v) + ' ' + u;
// segs order: smallest first, so the biggest contributor sits at the BOTTOM of
// the blown-up bar; the list reads top-to-bottom in the same order, so each row
// sits across from its own segment.
/* Shared side-dock width + squash (Owner 8/15: "the squishing mechanism is
   the same as the macros one... a shared item"). Every right-docked panel -
   macros blow-up and workout table alike - is 316px wide and squeezes the
   chart wrap through this one pass. */
const BLOW_PANEL_W = 316;
function squishWrapForPanel(wrap, panelW, resizer) {
  const fullW = wrap.clientWidth;
  wrap.style.width = (fullW - panelW) + 'px';
  /* Resize synchronously so the squash, the panel append and the chart's
     redraw commit in ONE paint - a deferred resize leaves one frame where
     the old wide canvas and the new panel co-exist (visible swap glitch). */
  if (resizer) resizer();
  return fullW;
}

/* Owner 8/16 ("it opens a new webpage... why can't it just navigate within
   notion"): same-tab links, and every destination normalized to the
   universal-link host (www.notion.so) so iOS hands the tap to the Notion
   app when installed; app.notion.com URLs are not universal-link eligible.
   No target=_blank anywhere: desktop replaces the current tab per Owner. */
const notionUrl = window.__notionUrl || (window.__notionUrl = u => (u || '').split('https://app.notion.com/').join('https://www.notion.so/').split('https://www.notion.com/').join('https://www.notion.so/').split('https://notion.so/').join('https://www.notion.so/'));
/* Owner 8/16 11pm: mobile taps still glitch. Root cause: inside Notion's own
   iOS-embed webview, https taps to notion.so stays trapped (universal-link
   upgrade never fires there); and even in Safari a plain anchor relies on
   the universal-link path. Course: on coarse-pointer devices route every
   Notion link through openNotion(), which tries the notion:// scheme first
   (the app claims it - works inside the embed AND from Safari), and falls
   back to the same-tab web URL only if nothing takes it. Desktop keeps the
   exact same-tab anchor behavior they confirmed "works perfectly". */
const openNotion = window.__openNotion || (window.__openNotion = function (webUrl) {
  webUrl = notionUrl(webUrl);
  /* Screen recording 8/16 11:26 PM: inside the Notion iOS app the chart is
     an embedded iframe; window.location/scheme navigation only moves the
     IFRAME, which goes blank forever (Notion refuses iframing / the app
     never routes it). The escape hatch: hand the navigation to the TOP
     frame - Notion's app owns that webview and its router opens the page
     natively in-app ("navigate to the page within the app"). Cross-origin
     iframes may WRITE top.location even though they cannot read it. */
  let inFrame = false;
  try { inFrame = window.self !== window.top; } catch (e) { inFrame = true; }
  /* v5 (8/16 11:41 PM retest): notion://www.notion.so/<bare-id> gets routed
     natively now but hangs in perpetual loading - the app's router can't
     resolve that marketing-host + bare-id form. The canonical app URL per
     the Notion API is https://app.notion.com/p/<slug>-<id>, so the scheme
     the native router actually ingests lives on app.notion.com/p/. */
  const scheme = 'notion://app.notion.com/p/' + webUrl.split('/').pop();
  if (inFrame) {
    /* Retest 8/16 11:37 PM: navigating the top frame to the https URL only
       opened Notion's IN-APP BROWSER (notion.so -> app.notion.com -> login
       wall). Owner: "it needs to all be in the app... like a button in
       notion". So in-frame taps fire the notion:// scheme AT THE TOP FRAME
       first - WKWebView in the Notion app hands custom schemes to the OS,
       the OS claims it for Notion, and Notion routes to the page natively.
       Web fallback (top frame) covers the no-app case. */
    let tid = setTimeout(function () {
      /* Absolute https only. Cross-origin top-nav resolves relative URLs
         against the CHILD origin (workers.dev), so a relative fallback
         would 404 the whole app webview - never do that here. */
      if (!document.hidden) { try { window.top.location.href = webUrl; } catch (e1) {} }
    }, 2500);
    document.addEventListener('visibilitychange', function onV() {
      if (document.hidden) { clearTimeout(tid); document.removeEventListener('visibilitychange', onV); }
    });
    window.addEventListener('pagehide', function () { clearTimeout(tid); }, { once: true });
    /* No window.open here: a sheet that loads notion:// inside the app's
       in-app browser is exactly the dead "opens as a link" screen Owner hates.
       Single authoritative write to the top frame with the tap's user
       activation; the https fallback above covers app-not-installed. */
    try { window.top.location.href = scheme; } catch (e2) { try { window.top.location.replace(scheme); } catch (e3) {} }
    return;
  }
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (!coarse) {
    /* Desktop. The universal-link host (www.notion.so) costs a soft-redirect
       hop (session_sync before the SPA boots); skip it and aim straight at
       the canonical app URL. If the Notion DESKTOP app is installed it claims
       the notion:// scheme and opens the page natively instead - blur (the OS
       stole focus for the app/dialog) cancels the https fallback; nothing
       claimed -> same-tab https to the canonical form. */
    const canon = 'https://app.notion.com/p/' + webUrl.split('/').pop();
    /* One-time cost: cache the probe outcome so repeat clicks skip the 700ms
       dead time the first click paid to learn it. */
    let probeKnown = '';
    try { probeKnown = localStorage.getItem('notionScheme') || ''; } catch (eProbe) {}
    if (probeKnown === 'web') { window.location.assign(canon); return; }
    const tid = setTimeout(function () {
      try { localStorage.setItem('notionScheme', 'web'); } catch (eSet1) {}
      window.location.assign(canon);
    }, 700);
    /* Browser "open this app?" dialogs blur the page too; if focus comes back
       (dialog dismissed, nothing claimed) the https fallback must still run. */
    const onBlur = function () {
      clearTimeout(tid);
      window.removeEventListener('blur', onBlur);
      try { localStorage.setItem('notionScheme', 'app'); } catch (eSet2) {}
      const blurredAt = Date.now();
      const onFocus = function () {
        window.removeEventListener('focus', onFocus);
        /* Focus back within ~30s = the OS dialog was dismissed without claiming
           the scheme - run the https fallback. Much later = the app actually
           opened and the user is returning; do not yank the tab to the web. */
        if (Date.now() - blurredAt < 30000 && !document.hidden) {
          try { localStorage.setItem('notionScheme', 'web'); } catch (eSet3) {}
          window.location.assign(canon);
        }
      };
      window.addEventListener('focus', onFocus);
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('pagehide', function () { clearTimeout(tid); window.removeEventListener('blur', onBlur); }, { once: true });
    try { window.location.href = scheme; } catch (e) { clearTimeout(tid); window.location.assign(canon); }
    return;
  }
  /* Standalone mobile Safari/Chrome: scheme first so the app opens it
     directly; 2.5s later, if the page is still visible (scheme went
     nowhere), same-tab web fallback. */
  let tid = setTimeout(function () {
    if (!document.hidden) window.location.assign(webUrl);
  }, 2500);
  document.addEventListener('visibilitychange', function onV() {
    if (document.hidden) { clearTimeout(tid); document.removeEventListener('visibilitychange', onV); }
  });
  window.addEventListener('pagehide', function () { clearTimeout(tid); }, { once: true });
  window.location.assign(scheme);
});
const isCoarsePtr = window.__isCoarsePtr || (window.__isCoarsePtr = function () {
  return (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window;
});
const isInFrame = window.__isInFrame || (window.__isInFrame = function () {
  let f = false; try { f = window.self !== window.top; } catch (e) { f = true; } return f;
});
/* Owner 8/17: a tap on a food row must not start a Notion SPA boot. Render the
   record in-app from data already embedded in this page - same frame, zero
   network. Steering ("Kill the open in notion and kill the paragraph"): the
   sheet is JUST the name, the kcal, and the macro rows - no Notion link, no
   provenance text. The day header link still navigates to Notion as before. */
const closeRecordSheet = window.__closeRecordSheet || (window.__closeRecordSheet = function () {
  const b = document.querySelector('.rsheet-back');
  if (!b || b.classList.contains('hiding')) return;
  /* Matches the goals panel close: .hiding shortens the fade to 0.15s. */
  b.classList.add('hiding');
  b.classList.remove('show');
  setTimeout(function () { b.remove(); }, 160);
});
const openRecordSheet = window.__openRecordSheet || (window.__openRecordSheet = function (seg) {
  const rec = seg.rec || [];
  closeRecordSheet();
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const nf = v => { v = Number(v) || 0; return (Math.abs(v % 1) > 0.001 ? Math.round(v * 10) / 10 : Math.round(v)) + ''; };
  /* Owner 8/17: "if the amount is 0g don't show it in the view" - zero rows out. */
  const macroRow = (label, v, unit) => (Number(v) || 0) <= 0 ? '' : '<div class="rsheet-row"><span class="rsheet-k">' + label + '</span><span>' + nf(v) + ' ' + unit + '</span></div>';
  const back = document.createElement('div');
  back.className = 'rsheet-back';
  back.innerHTML =
    '<div class="rsheet" role="dialog">' +
      '<div class="rsheet-head">' + esc(seg.name) + '</div>' +
      '<div class="rsheet-big">' + nf(rec[1]) + '<span> kcal</span></div>' +
      /* Owner 8/17 hierarchy: calories (the big number), then protein, sodium,
         carbs, fat, sat fat, sugar, fiber. Retraction: no Calories row - the
         big number covers it ("oh calories is in the main things, sry lol"). */
      macroRow('Protein', rec[2], 'g') + macroRow('Sodium', rec[8], 'mg') +
      macroRow('Carbs', rec[3], 'g') + macroRow('Fat', rec[4], 'g') + macroRow('Sat fat', rec[5], 'g') +
      macroRow('Sugar', rec[6], 'g') + macroRow('Fiber', rec[7], 'g') +
    '</div>';
  /* Tap-outside must dismiss ONLY the sheet - swallow the event so the
     blow-up under it stays open (Owner 8/17: "go back to whatever was under the
     popup", not to the base chart). */
  back.addEventListener('click', function (e) {
    e.stopPropagation();
    if (e.target === back) closeRecordSheet();
  });
  back.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
  document.body.appendChild(back);
  /* Fade in like the goals panel: double-rAF so the transition actually runs. */
  requestAnimationFrame(function () { requestAnimationFrame(function () { back.classList.add('show'); }); });
});
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeRecordSheet(); });
document.addEventListener('click', function (e) {
  const t = e.target, a = t && t.closest ? t.closest('a[data-nnotion]') : null;
  if (!a) return;
  if (e.metaKey || e.ctrlKey) return; // open-in-new-tab: plain anchor
  /* Food item rows carry a full inline record: open the instant in-app sheet
     instead of paying Notion's load. Anything without one navigates as before. */
  if (a.dataset && a.dataset.nseg != null) {
    const panel = a.closest('.blow');
    const seg = panel && panel.__segs && panel.__segs[Number(a.dataset.nseg)];
    if (seg && seg.rec) { e.preventDefault(); openRecordSheet(seg); return; }
  }
  if (isInFrame()) { e.preventDefault(); openNotion(a.getAttribute('href')); return; }
  e.preventDefault();
  openNotion(a.getAttribute('href'));
});
/* Warm the Notion handoff before it's needed: first hover on a Notion link
   prefetches the canonical record document. Desktop only; once per URL. */
const __notionPrefetched = {};
document.addEventListener('mouseover', function (e) {
  const a = e.target && e.target.closest ? e.target.closest('a[data-nnotion]') : null;
  if (!a) return;
  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return;
  const href = 'https://app.notion.com/p/' + String(a.getAttribute('href') || '').split('/').pop();
  if (__notionPrefetched[href]) return;
  __notionPrefetched[href] = 1;
  const l = document.createElement('link');
  l.rel = 'prefetch'; l.href = href;
  document.head.appendChild(l);
});
/* Average view numbers pane (Owner 8/18): when avgOn, the opaque/clear view
   docks this panel beside the chart. Rows = series dot, red triangle + % off
   goal (suppressed within 5%), series-colored value. Exec order: rows get
   absolutely positioned at their band's visible-region midpoint by avgAlign,
   after layout and again after fonts land. */
function avgAlign(pane, chartEl, segs) {
  const rows = Array.from(pane.querySelectorAll('.avgprow'));
  if (!rows.length) return;
  const svg = chartEl && chartEl.querySelector ? chartEl.querySelector('svg.svgchart') : null;
  if (!svg) return;
  const eng = chartEl.__svgChart, ca = eng && eng.chartArea ? eng.chartArea() : null;
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox ? svg.viewBox.baseVal : null;
  const scale = rect.height / (vb && vb.height ? vb.height : rect.height || 1);
  const shapes = Array.from(svg.querySelectorAll('rect,path'));
  const bandTops = segs.map(seg => {
    const c = (seg.color || '').toLowerCase();
    const hit = shapes.find(sh => {
      const f = (sh.getAttribute('fill') || '').toLowerCase(), st = (sh.getAttribute('stroke') || '').toLowerCase();
      return f === c || st === c;
    });
    return hit ? hit.getBBox().y : null;
  });
  /* The last band's visible-region bottom is the chartArea bottom (chartArea
     has no .height - ca.bottom directly), earlier bands end at the next band. */
  const lastBottom = ca && typeof ca.bottom === 'number' ? ca.bottom : (vb ? vb.height : rect.height / scale);
  const topOff = ca ? ca.top : 0;
  const rel = bandTops.map(y => y === null ? null : y - topOff);
  const mids = [];
  for (let i = 0; i < rel.length; i++) {
    if (rel[i] === null) { mids.push(null); continue; }
    const next = (i + 1 < rel.length && rel[i + 1] !== null) ? rel[i + 1] : lastBottom - topOff;
    mids.push((rel[i] + next) / 2);
  }
  // Dodge pass: 4px min gap, top-down, never above the pane's first slot.
  const hs = rows.map(r => r.offsetHeight || 16);
  pane.getBoundingClientRect();
  let bottom = 0;
  rows.forEach((r, i) => {
    let y = mids[i] === null ? bottom + 4 : mids[i] - hs[i] / 2;
    if (y < bottom) y = bottom;
    r.style.position = 'absolute';
    r.style.left = '0'; r.style.right = '0';
    r.style.top = Math.round(y * scale) + 'px';
    bottom = y + hs[i] + 4;
  });
}
function blowAvg(all, order) {
  const cv = document.getElementById('c');
  const wrap = cv && cv.closest('.wrap'), card = cv && cv.closest('.card, .hcard');
  if (!wrap || !card) return;
  closeBlow();
  const PANEL_W = 100, fullW = wrap.clientWidth, baseL = wrap.offsetLeft, baseT = wrap.offsetTop, baseH = wrap.offsetHeight;
  const narrow = window.innerWidth <= 560 || (navigator.maxTouchPoints || 0) > 0 || fullW <= 456;
  if (!narrow) squishWrapForPanel(wrap, PANEL_W, () => { const eng = cv.__svgChart; if (eng) eng.resize(); });
  const segs = (order || all.map((a, i) => i)).map(i => all[i]).filter(ds => {
    const v = ds.data ? ds.data[0] : null;
    return v != null && isFinite(v);
  });
  if (!segs.length) return;
  const panel = document.createElement('div');
  panel.className = 'blow avgp right';
  let inner = '<div class="avgplist">';
  segs.forEach(ds => {
    const v = ds.data[0], val = Math.round(v).toLocaleString('en-US');
    let dir = null, pct = null;
    if (ds.goal !== null && ds.goal !== undefined && isFinite(ds.goal)) {
      dir = Math.abs(v - ds.goal) <= 0.05 * ds.goal ? 'ok' : (v > ds.goal ? 'over' : 'under');
      if (dir !== 'ok') pct = Math.round(100 * Math.abs(v - ds.goal) / ds.goal) + '%';
    }
    inner += '<div class="avgprow"><span class="dot" style="background:' + ds.color + '"></span><span class="aclus">' +
      (pct ? '<span class="agoal"><svg width="10" height="9" viewBox="0 0 11 8" style="vertical-align:-1px;margin-right:3px"><path d="' +
        (dir === 'under' ? 'M5.5 0 L11 7.5 L0 7.5 Z' : 'M0 0.5 L11 0.5 L5.5 8 Z') + '" fill="#d64545"/></svg>' + pct + '</span>' : '') +
      '<span class="aval" style="color:' + ds.color + '">' + val + '</span></span></div>';
  });
  inner += '</div>';
  panel.innerHTML = inner;
  card.appendChild(panel);
  const eng = cv.__svgChart, caTop = eng && eng.chartArea() ? eng.chartArea().top : 0, caH = eng && eng.chartArea() ? eng.chartArea().height : 0;
  if (narrow) {
    panel.classList.add('narrow');
    document.body.classList.add('blowing');
    panel.style.height = (caH || 240) + 'px';
  } else {
    const top = Math.max(baseT + 2, baseT + caTop);
    panel.style.left = baseL + fullW - PANEL_W + 'px';
    panel.style.width = PANEL_W + 'px';
    panel.style.top = top + 'px';
    panel.style.height = Math.max(140, Math.min(baseT + baseH - 8 - top, caH || 1e5)) + 'px';
  }
  requestAnimationFrame(() => requestAnimationFrame(() => { if (panel.isConnected) avgAlign(panel, cv, segs); }));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (panel.isConnected) avgAlign(panel, cv, segs); });
  blowState = { wrap: wrap, cv: cv, focus: null };
}
function blowPanel(cv, title, segs, unit, total, onLeft, focus, dayUrl) {
  closeBlow();
  const wrap = cv.closest('.wrap');
  const card = cv.closest('.card, .hcard');
  if (!wrap || !card) return;
  const PANEL_W = BLOW_PANEL_W;
  const fullW = wrap.clientWidth, baseL = wrap.offsetLeft, baseT = wrap.offsetTop, baseH = wrap.offsetHeight;
  /* A phone in desktop-Safari mode (or a pinch-zoomed/narrow embed) keeps a
     wide innerWidth, so width alone misses touch devices. Any touch device
     docks the blow-up below the chart instead of panning the chart aside. */
  const narrow = window.innerWidth <= 560 || (navigator.maxTouchPoints || 0) > 0 ||
    (window.__BLOW_DEBUG && window.__BLOW_DEBUG.forceNarrow);
  /* A wide window whose wrap can't spare PANEL_W beside the chart used to
     abandon the blow-up outright (a 316-456px embed just did nothing on a
     bar click); dock it below the chart, same as the touch path. linksOn
     below stays keyed on narrow itself - the link-hostile client is a touch
     webview, not a skinny desktop embed, so links keep working there. */
  const dockNarrow = narrow || fullW <= PANEL_W + 140;
  closeBlow();
  if (!dockNarrow) {
    if (onLeft) wrap.style.marginLeft = PANEL_W + 'px';
    squishWrapForPanel(wrap, PANEL_W, () => {
      const engSquash = cv.__svgChart;
      if (engSquash) engSquash.resize();
      else if (typeof Chart !== 'undefined') { const chSquash = Chart.getChart ? Chart.getChart(cv) : null; if (chSquash) chSquash.resize(); }
    });
  }
  const panel = document.createElement('div');
  panel.className = 'blow ' + (onLeft ? 'left' : 'right');
  /* Links for everyone (Owner 8/16: "I click on the stuff in the popup and it
     doesn't work"): anchors are same-tab everywhere (8/16 pm), and on
     coarse-pointer devices a delegated click handler routes them through
     openNotion() - notion:// scheme first, same-tab web fallback - so taps
     work inside the Notion app embed webview too, not just Safari. */
  const linksOn = true;
  const headTxt = linksOn && dayUrl ? '<a data-nnotion="1" href="' + notionUrl(dayUrl) + '">' + title + '</a>' : title;
  let inner = '<div class="blow-head"><span>' + headTxt + '</span></div>';
  if (segs.length) {
    const tot = total != null ? total : segs.reduce((a, s) => a + s.v, 0);
    const bar = segs.map(s => s.wo ? '<div class="bseg-wo" style="flex:' + s.v + '" title="' + s.name + '"></div>' : '<div style="flex:' + s.v + ';background:' + s.color + '" title="' + s.name + '"></div>').join('');
    const list = segs.map((s, si) =>
      (linksOn && s.url ? '<a class="blow-item" data-nseg="' + si + '" data-nnotion="1" href="' + notionUrl(s.url) + '">' : '<span class="blow-item">') +
      (s.wo ? '<span class="dot wodot"></span>' : '<span class="dot" style="background:' + s.color + '"></span>') + '<span class="n">' + s.name + '</span><span class="v">' + (s.disp || fmtVal(s.v, unit)) + '</span></' + (linksOn && s.url ? 'a' : 'span') + '>').join('');
    inner += '<div class="blow-body"><div class="blow-bar">' + bar + '</div><div class="blow-list">' + list +
      (tot != null ? '<div class="blow-total"><span>' + (segs.some(x => x.wo) ? 'Net' : 'Total') + '</span><span>' + fmtVal(tot, unit) + '</span></div>' : '') + '</div></div>';
  } else {
    inner += '<div class="blow-empty">Nothing logged yet.</div>';
  }
  panel.innerHTML = inner;
  panel.__segs = segs;
  card.appendChild(panel);
  blowState = { wrap, cv, focus: focus || null };
  if (dockNarrow) document.body.classList.add('blowing');
  if ((window.innerHeight || document.documentElement.clientHeight || 1e5) <= 420) {
    // Strip-size embed (Notion): no room below the chart either - the blow-up
    // overlays the strip with its own scroll and an explicit close control.
    panel.classList.add('narrow', 'compact');
    const headSpan = panel.querySelector('.blow-head span');
    if (headSpan) headSpan.insertAdjacentHTML('afterend', '<button class="bx" onclick="closeBlow()" aria-label="Close" style="margin-left:auto;font:inherit;background:none;border:0;color:#797979;padding:0 4px;cursor:pointer;font-size:15px;">&times;</button>');
    return;
  }
  if (dockNarrow) {
    // Docked below (touch, narrow viewport, or a wrap too skinny for a side
    // panel): a plain stacked list under the chart. No absolute positioning,
    // no dodge/leader pass (alignBlowList stays desktop-only).
    panel.classList.add('narrow');
    return;
  }
  panel.style.left = (onLeft ? baseL : baseL + fullW - PANEL_W) + 'px';
  panel.style.width = PANEL_W + 'px';
  /* Geometry now, not in a later animation frame: a deferred assignment
     paints the absolute panel one frame at its un-positioned flow spot over
     the legend (the one-frame flash on bar swaps). All numbers are already
     measurable: offsets cause one sync layout, which is fine here. */
  const eng0 = cv.__svgChart;
  const caTop0 = eng0 ? (eng0.chartArea() ? eng0.chartArea().top : 0)
                      : ((cv && typeof Chart !== 'undefined' && Chart.getChart(cv) && Chart.getChart(cv).chartArea) ? Chart.getChart(cv).chartArea.top : 0);
  const head0 = panel.querySelector('.blow-head');
  const headH0 = head0 ? head0.offsetHeight : 0;
  const top0 = Math.max(baseT + 2, baseT + caTop0 - headH0 / 2);
  panel.style.top = top0 + 'px';
  panel.style.height = Math.max(140, baseT + baseH - 8 - top0) + 'px';
  alignBlowList(panel);
}

// Each item row's vertical middle is placed at its segment's midpoint inside
// the bar. Thin slices would crowd their rows on top of each other, so a dodge
// pass enforces a minimum gap and, if rows overflow the bottom, pulls the whole
// stack back up. Big slices automatically spread their rows out.
function alignBlowList(panel) {
  const list = panel.querySelector('.blow-list'), bar = panel.querySelector('.blow-bar');
  if (!list || !bar) return;
  const rows = Array.from(list.querySelectorAll('.blow-item'));
  if (!rows.length) return;
  const H = bar.clientHeight;
  if (!H) return;
  {
    const segsEls = Array.from(bar.children);
    const mids = segsEls.map(el => el.offsetTop + el.offsetHeight / 2);
    let hs = rows.map(n => n.offsetHeight);
    /* Owner 8/22 (12-row carbs blow-up: the last item lands on the Total row,
       "in the extreme case shrink the item-dot size, the name font and the
       value font so everything fits; adaptive, normal case unchanged"): when
       the rows cannot stack above the Total with the dodge pass, scale the
       row typography down until they fit - dot size, name/value font, and
       row padding move together. The factor is length-computed (stack the
       rows need / space above the Total) and floored at 0.5 so text never
       collapses. Comfortable lists get k = 1 and nothing moves. */
    {
      const totalEl0 = list.querySelector('.blow-total');
      const limit0 = H - (totalEl0 ? totalEl0.offsetHeight : 0) - 10;
      const needed = hs.reduce((a, h) => a + h, 0) + 2 * Math.max(rows.length - 1, 0);
      if (needed > limit0 && needed > 0) {
        const k = Math.max(0.5, limit0 / needed);
        rows.forEach(n => {
          n.style.fontSize = (12 * k) + 'px';
          n.style.paddingTop = n.style.paddingBottom = (3 * k) + 'px';
          n.style.gap = (8 * k) + 'px';
          const dot = n.querySelector('.dot');
          if (dot) { dot.style.width = (8 * k) + 'px'; dot.style.height = (8 * k) + 'px'; }
        });
        // Re-measure with the shrunk rows so the dodge pass sees real heights.
        hs = rows.map(n => n.offsetHeight);
      }
    }
    // Every row starts exactly at its own slice's vertical center. A row
    // moves ONLY when it genuinely collides with a neighbour, and the shift
    // ripples through the colliding chain only - rows with room to spare
    // keep their exact center (Owner's rule: displacement propagates between
    // actually-crowding neighbours, never across free space).
    const pos = mids.map((m, i) => m - hs[i] / 2);
    const minGap = 2;
    for (let i = 1; i < pos.length; i++) {
      if (pos[i] < pos[i - 1] + hs[i - 1] + minGap) pos[i] = pos[i - 1] + hs[i - 1] + minGap;
    }
    // A slice with a tiny share near the stack top lands its row's midpoint
    // ABOVE the list top. Lift only the top chain of touching rows, as a
    // unit; loose rows below are untouched.
    if (pos[0] < 0) {
      let j = 0;
      while (j + 1 < pos.length && pos[j + 1] <= pos[j] + hs[j] + minGap + 0.5) j++;
      const lift = -pos[0];
      for (let k = 0; k <= j; k++) pos[k] += lift;
    }
    // Bottom overflow: lift ONLY the bottom chain of touching rows into the
    // slack beneath the loose row above it. If the slack cannot absorb the
    // overflow, fall back to the uniform pull (everything is jammed anyway).
    const totalEl = list.querySelector('.blow-total');
    const limit = H - (totalEl ? totalEl.offsetHeight : 0) - 10;
    if (pos.length && pos[pos.length - 1] + hs[hs.length - 1] > limit) {
      const over = pos[pos.length - 1] + hs[hs.length - 1] - limit;
      let j = pos.length - 1;
      while (j > 0 && pos[j] <= pos[j - 1] + hs[j - 1] + minGap + 0.5) j--;
      const slack = j > 0 ? pos[j] - (pos[j - 1] + hs[j - 1] + minGap) : -1;
      if (slack >= over && j > 0) {
        for (let k = j; k < pos.length; k++) pos[k] -= over;
      } else {
        pos[pos.length - 1] = limit - hs[hs.length - 1];
        for (let i = pos.length - 2; i >= 0; i--) pos[i] = Math.min(pos[i], pos[i + 1] - hs[i] - minGap);
        if (pos[0] < 0) { const lift = -pos[0]; for (let i = 0; i < pos.length; i++) pos[i] += lift; }
      }
    }
    rows.forEach((n, i) => {
      n.style.position = 'absolute'; n.style.left = '4px'; n.style.right = '4px';
      n.style.top = Math.round(pos[i]) + 'px';
    });

    // Leader lines for EVERY row (Owner's rule): the line from the slice edge
    // to its row is straight when the row sits at its slice's center, and
    // bends diagonally when the row was dodged away from it.
    const body = list.parentElement, bodyRect = body.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const svgNS = 'http://www.w3.org/2000/svg';
    let svg = body.querySelector('svg.blow-leaders');
    if (svg) svg.remove();
    {
      svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('class', 'blow-leaders');
      svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible;pointer-events:none;z-index:1;';
      const W = body.clientWidth, Hh = body.clientHeight;
      svg.setAttribute('width', W); svg.setAttribute('height', Hh);
      const colors = rows.map(n => { const d = n.querySelector('.dot'); return d ? (d.style.background || '#b9bfc9') : '#bbb'; });
      rows.forEach((n, i) => {
        // The line always starts on the slice at its center, and always ends
        // AT THE DOT, wherever displacement actually put it - the dodge pass
        // owns the row's final y, the line just follows it. The stroke keeps
        // the SAME air off its slice edge and off its dot (Owner 7:19pm: the
        // gap on the right equals the gap on the left), 3px each side.
        const dot = n.querySelector('.dot');
        const dr = dot ? dot.getBoundingClientRect() : null;
        const segY = barRect.top - bodyRect.top + mids[i];
        const rowY = listRect.top - bodyRect.top + pos[i] + hs[i] / 2;
        const dotY = dr ? dr.top - bodyRect.top + dr.height / 2 : rowY;
        const SIDE_GAP = 3;
        const x0 = barRect.right - bodyRect.left + SIDE_GAP;
        let x1 = (dr ? dr.left - bodyRect.left : listRect.left - bodyRect.left + 7) - SIDE_GAP;
        if (x1 < x0 + 8) x1 = x0 + 8;
        const ln = document.createElementNS(svgNS, 'polyline');
        if (Math.abs(dotY - segY) <= 1.5) {
          // In its proper place: perfectly straight - and drawn AT THE DOT's
          // center y, not the slice's: segY and dotY can sit a half pixel
          // apart (odd row heights), and at dpr 2 that half pixel shows as a
          // full device pixel of misalignment (Owner 7:29pm).
          ln.setAttribute('points', x0 + ',' + dotY + ' ' + x1 + ',' + dotY);
        } else {
          // Dodged away: half the line runs straight out of the slice, the
          // other half is the diagonal. 50/50, per Owner's Quail eggs call.
          const xBend = x0 + (x1 - x0) * 0.5;
          ln.setAttribute('points', x0 + ',' + segY + ' ' + xBend + ',' + segY + ' ' + x1 + ',' + dotY);
        }
        ln.setAttribute('fill', 'none');
        ln.setAttribute('stroke', colors[i]);
        ln.setAttribute('stroke-width', '1');
        svg.appendChild(ln);
      });
      body.appendChild(svg);
    }
  }
}
// Workout burn estimate (Owner 8/19): flat retroactive burn by split for the
// day's Calories breakdown - Legs 250, Push/Pull 200 - never stored in
// Notion; computed at render from the Notion session dates already in WK.
function wkBurnFor(dateStr) {
  const wk = WK || {};
  const has = split => ((wk && wk[split]) || []).some(sess => sess.date === dateStr);
  return has('Legs') ? 250 : (has('Push') || has('Pull')) ? 200 : 0;
}
function openMacroBlow(cv, row, m, onLeft, di, i) {
  const idx = ITEM_KEYS.indexOf(m.key) + 1; // tuple[0] is the item name
  const entries = (ITEMS[row.date] || [])
    .map(it => ({ name: SHORTS[it[0]] || it[0].replace(/ \\(.*\\)$/, ''), v: Number(it[idx]) || 0, url: it[9] || null, rec: it }))
    .filter(e => e.v > 0)
    .sort((a, b) => a.v - b.v);
  const max = entries.length ? entries[entries.length - 1].v : 0;
  const colors = segColors(m.color, entries.length);
  const segs = entries.map((e, i) => ({ name: e.name, v: e.v, color: colors[i], url: e.url, rec: e.rec }));
  // Hatched estimated-burn segment pinned at the top of the Calories stack.
  const wob = m.key === 'calories' ? wkBurnFor(row.date) : 0;
  if (wob) segs.unshift({ name: 'Workout', v: wob, color: m.color, wo: 1, disp: '-' + wob + ' est' });
  let focus = null;
  const eng = cv && cv.__svgChart;
  if (eng && di != null && i != null && segs.length) {
    // The rendering engine hides the bar rect and stacks the item bands in
    // place; hover over it keeps the exact band palette (same effect as the
    // canvas build's per-index hover swap).
    if (eng.focusBar(di, i, segs)) {
      focus = { chart: eng.fake, di: di, color: m.color, hover: 0 };
    }
  }
  blowPanel(cv, fmt(row.date) + ' · ' + m.label.replace(/ \\((g|mg)\\)$/, ''), segs, m.unit, (wob ? (row[m.key] != null ? row[m.key] : segs.reduce((a, x) => a + x.v, 0)) - wob : row[m.key]), onLeft, focus, DAY_PAGES[row.date] || null);
}
/* Stacked-view (smooth mode) day blow-up: the day as ONE full-bleed stacked
   composition - every item a kcal-width band edge-to-edge across the panel
   (the "vibe of stacked" graphic the bar blow-up never had in this mode), a
   P/C/F kcal sub-strip under it, then the same item list as the raw blow-up,
   smallest first. Bars dock the same panel; nothing new to learn. */
function openDayBlow(cv, row, onLeft) {
  const items = (ITEMS[row.date] || [])
    .map(it => ({ name: SHORTS[it[0]] || it[0].replace(/ \\([^)]*\\)$/, ''), v: Number(it[1]) || 0, url: it[9] || null, rec: it }))
    .filter(e => e.v > 0)
    .sort((a, b) => a.v - b.v);
  if (!items.length) return;
  const colors = segColors(GREEN, items.length);
  const segs = items.map((e, i) => ({ name: e.name, v: e.v, color: colors[i], url: e.url, rec: e.rec }));
  /* Owner 8/15 (pane veto): the smoothed day blow-up uses the EXACT same pane
     as Raw - vertical stacked item bar with leader-aligned rows (base
     blowPanel render). The custom daystack band + P/C/F sub-strip ("this
     custom view... swap for the raw chart view") is gone: do NOT add the
     'dayblow' class (it hides the stacked bar) and do NOT insert .daystack. */
  blowPanel(cv, fmt(row.date), segs, 'kcal', row.calories || segs.reduce((a, s) => a + s.v, 0), onLeft, null, DAY_PAGES[row.date] || null);
}
let goalLinesOn = false; // Owner 8/17: triple-tap toggles the colored goal lines
function render(w) {
  currentW = w;
  let seriesOrder = null;
  const rows = windowRows(w);
  /* Owner 8/15: the macro x-axis is calendar-true and always ends TODAY. Every
     day in the window gets a slot, logged or not - an unlogged day is empty
     chart space that still shows on the axis ("today is 8-15, but there's
     nothing there... it should still be an empty part of the chart"). When
     the window reaches back past their first logged day it starts at the first
     log instead of padding empties before it. Same rule for All time. */
  const isoLocal = dd => dd.getFullYear() + '-' + String(dd.getMonth() + 1).padStart(2, '0') + '-' + String(dd.getDate()).padStart(2, '0');
  const todayS = isoLocal(new Date());
  const byDate = {};
  ROWS.forEach(r => { byDate[r.date] = r; });
  let axisStart = ROWS.length ? ROWS[0].date : todayS;
  if (w) {
    const dd = new Date(); dd.setDate(dd.getDate() - (w - 1));
    const rs = isoLocal(dd);
    if (rs > axisStart) axisStart = rs;
  }
  const slotDates = [];
  { let cur = new Date(axisStart + 'T00:00:00'); const end = new Date(todayS + 'T00:00:00');
    while (cur <= end) { slotDates.push(isoLocal(cur)); cur.setDate(cur.getDate() + 1); } }
  const slots = slotDates.map(dt => byDate[dt] || null);
  const shown = shownMacros();
  const plotted = plotOrder(shown);
  // Detail mode is grams-only: it takes the LEFT axis instead of the right
  // one, so axis placement never jumps sides between Core and Detail.
  const leftGrams = !shown.some(m => m.axis === 'y') && shown.some(m => m.axis === 'y1');
  const axisFor = m => (leftGrams && m.axis === 'y1') ? 'y' : m.axis;
  const labels = avgOn ? [] : slotDates.map(dt => fmt(dt));
  let avgDaysLabel = null;
  let datasets;
  if (avgOn) {
    const means = plotted.map(m => Object.assign({ m: m }, meanOf(rows, m.key)));
    const n = means.reduce((a, x) => Math.max(a, x.n), 0);
    labels.push('Average');
    avgDaysLabel = n + ' logged day' + (n === 1 ? '' : 's');
    datasets = means.map(x => ({
      kind: mMode === 'smooth' ? 'smooth' : 'bar', label: x.m.label, data: [x.avg === null ? null : round1(x.avg)],
      color: x.m.color, hover: shade(x.m.color, 0.16), axis: axisFor(x.m),
      goal: (x.m.goal === null || x.m.goal === undefined) ? null : x.m.goal
    }));
    /* Averaged Opaque: same biggest-behind paint hierarchy as the smoothed
       opaque view (protein front, sodium back, middle by magnitude). */
    if (mMode === 'smooth' && mOpaque) {
      seriesOrder = datasets.map((ds, i) => {
        let m2 = 0; ds.data.forEach(v => { if (isFinite(v)) m2 = Math.max(m2, v); });
        return { i: i, m: m2 };
      }).sort((x, y) => (y.m - x.m) || (x.i - y.i)).map(e => e.i);
    }
  } else if (mMode === 'smooth') {
    datasets = plotted.map(m => ({
      kind: 'smooth', label: m.label, data: slots.map(r => (r ? r[m.key] : null)),
      // Opaque view (Owner 8/15): same dual axes as the clear view (kcal/mg left,
      // grams right) but fills render SOLID - no transparency. Hierarchy is
      // paint order only: the lower the series' raw number, the later it paints
      // (protein always in front, sodium always behind, calories/carbs in the
      // middle by live magnitude), so each layer reads as an opaque silhouette
      // above whatever sits behind it.
      // Owner 8/15 v2: keep the daily goal lines + colored goal labels on both
      // edges exactly like the clear view - none of that changes in opaque.
      axis: axisFor(m),
      color: m.color, fill: mOpaque ? m.color : rgba(m.color, 0.18)
    }));
    if (mOpaque) {
      seriesOrder = datasets.map((ds, i) => {
        let m2 = 0; ds.data.forEach(v => { if (isFinite(v)) m2 = Math.max(m2, v); });
        return { i: i, m: m2 };
      }).sort((x, y) => (y.m - x.m) || (x.i - y.i)).map(e => e.i);
      // Owner 8/15 v2: opaque keeps the daily goal lines + colored goal labels.
      // The shared axis is value-true, so each goal sits where its number sits
      // (sodium 2,300 floats high, protein 100 rides near the baseline).

    }
  } else {
    datasets = plotted.map(m => ({
      kind: 'bar', label: m.label, data: slots.map(r => (r ? r[m.key] : null)), axis: axisFor(m),
      color: m.color, hover: shade(m.color, 0.16)
    }));
  }
  const anyOn = axis => shown.some(m => axisFor(m) === axis); // hinge on remapped axis or Detail mode loses both
  // Grams and kcal/mg on one plot made the right-axis series look as big as
  // calories. When both axes are up, the right one gets extra headroom so the
  // grams sit under the big numbers instead of competing with them. On a
  // grams-only view there is nothing to compete with, so it keeps full height.
  const RIGHT_COMPRESS = 2;
  // A goal line the axis can't reach is a goal line they never sees. Whatever the
  // visible series are, stretch each axis past its highest visible goal (and
  // below its lowest, if one ever goes negative) so the dotted line and its
  // colored tick always land inside the plot area.
  const goalsOn = axis => shownMacros().filter(m => axisFor(m) === axis && m.goal !== null);
  const goalVals = axis => goalsOn(axis).map(m => m.goal);
  const fitMax = (axis, base) => { const g = goalVals(axis); return g.length ? Math.max(base, Math.max.apply(null, g) * 1.08) : base; };
  const fitMin = axis => { const g = goalVals(axis); const lo = g.length ? Math.min.apply(null, g) : 0; return lo < 0 ? lo * 1.08 : undefined; };
  const tooltipEnabled = !(window.innerWidth <= 560 || (navigator.maxTouchPoints || 0) > 0);
  /* Owner 8/15 (ghosts, LOCKED basis): when the axis ends today and today is
     unlogged, project each shown macro into today's empty slot from an
     average of that macro's logged days. Owner 8/22 ("I'd prefer it to be
     the average of the past seven days... the seventh day back is not
     visible on the chart. That's okay"): the lookback is FIXED to the past
     7 CALENDAR DAYS (today-7 through today-1), read from the full row set,
     not from the visible window - in the default 7d view that means the 7th
     contributing day sits just off-chart. Skip days (null slots) count for
     nothing. Calculation-only, never persisted. Average view untouched;
     logged days render real values only. */
  /* Owner 8/17 ("show the ghost graph for each day even as I start filling it
     out... instead of average fill this ghost graph (the post logged ghost
     graph) with the ideal values"): today's ghost no longer disappears on the
     first log. Unlogged today keeps the AVERAGE ghost; the moment the day has
     any entries the ghost switches to the GOAL values (the ideal bar). A
     macro with no goal falls back to its average so the ghost stays whole. */
  const ghostCalc = { at: null, vals: null };
  if (!avgOn && slotDates.length && slotDates[slotDates.length - 1] === todayS && ROWS.length) {
    const todayLogged = !!slots[slots.length - 1];
    const vals = {};
    let any = false;
    plotted.forEach((m, pi) => {
      if (todayLogged && m.goal !== null && m.goal !== undefined && isFinite(m.goal)) {
        vals[pi] = m.goal; any = true;
      } else {
        /* Owner 8/22: fixed 7-day lookback (today-7..today-1), window-independent. */
        const d0wk = new Date(todayS + 'T00:00:00'); d0wk.setDate(d0wk.getDate() - 7);
        const loS = isoLocal(d0wk);
        const vs = ROWS.filter(r => r.date >= loS && r.date < todayS).map(r => r[m.key]).filter(v => v !== null && v !== undefined && isFinite(v));
        if (vs.length) { vals[pi] = round1(vs.reduce((a, v) => a + v, 0) / vs.length); any = true; }
      }
    });
    if (any) { ghostCalc.at = slotDates.length - 1; ghostCalc.vals = vals; }
  }
  const model = {
    labels: labels,
    dayDates: avgOn ? null : slotDates,
    labelMonths: avgOn ? [] : slotDates.map(dt => dt.slice(0, 7)),
    mode: mMode === 'smooth' ? 'smooth' : 'bars',
    monthFirstOnly: currentW === 0, // All-time: stroke only the 1st-of-month labels (Owner 8/15)
    smoothOpaque: mMode === 'smooth' && mOpaque,
    ghostAt: ghostCalc.at, ghosts: ghostCalc.vals,
    datasets: datasets,
    avgBars: avgOn,
    avgDaysLabel: avgDaysLabel,
    maxBarThickness: avgOn ? 54 : 38,
    theme: THEME,
    scales: {
      y: { position: 'left', display: anyOn('y'), suggestedMax: fitMax('y', (leftGrams ? PRO_TARGET * 1.4 : CAL_TARGET * 1.2)), suggestedMin: fitMin('y'), hardMax: (avgOn && leftGrams) ? 150 : undefined,
           goals: goalsOn('y').map(m => ({ value: m.goal, color: m.color })) },
      y1: { position: 'right', display: anyOn('y1') && !leftGrams, suggestedMax: fitMax('y1', PRO_TARGET * 1.4) * RIGHT_COMPRESS, suggestedMin: fitMin('y1'),
            goals: goalsOn('y1').map(m => ({ value: m.goal, color: m.color })) }
    },
    // Goal lines must read through the SAME axis their bars use, including the
    // Detail-mode left remap - never through the hidden/compressed y1 twin.
    seriesOrder: seriesOrder,
    goalRefs: shownMacros().filter(m => m.goal !== null).map(m => ({ value: m.goal, color: m.color, axis: axisFor(m) })),
    goalLinesOn: goalLinesOn
  };
  /* Smooth-mode blow-up dispatch: band hits open the nutrient pane, empty
     plot space opens the day pane (see the onDayClick hook comment). */
  const smoothBlow = (idx, di) => {
    const drow = slots[idx];
    if (!drow) return;
    const m = (typeof di === 'number' && di >= 0) ? plotted[di] : null;
    if (m) {
      const ci = ITEM_KEYS.indexOf(m.key) + 1;
      if (ci > 0 && (ITEMS[drow.date] || []).some(it => (Number(it[ci]) || 0) > 0)) {
        openMacroBlow(document.getElementById('c'), drow, m, false, null, null);
        return;
      }
    }
    openDayBlow(document.getElementById('c'), drow, false);
  };
  const hooks = {
    tooltipEnabled: tooltipEnabled,
    hoverBars: mMode === 'raw',
    hoverCursor: isDesktop() && !avgOn,
    onBarClick: (mMode === 'raw' && !avgOn) ? (di, idx) => {
      const m = plotted[di], row = slots[idx];
      if (m && row) openMacroBlow(document.getElementById('c'), row, m, false, di, idx);
    } : null,
    /* A tap that lands ON a band fans that NUTRIENT open at that day - same
       pane + item list as a Raw bar blow-up, minus the bar repaint (Owner 8/15:
       "When I click on different colors different blowups should come man").
       A tap above every band (-1) keeps the whole-day kcal blow-up, and a
       nutrient with nothing logged that day falls back to it too. */
    onDayClick: (mMode === 'smooth' && !avgOn) ? (idx, di) => smoothBlow(idx, di) : null,
    onTipClick: !avgOn ? idx => {
      const d = slots[idx] && slots[idx].date;
      const url = d && DAY_PAGES[d];
      if (url) openNotion(url);
    } : null
  };
  if (!chart) {
    chart = SVGCharts.create(document.getElementById('c'));
    document.getElementById('c').__svgChart = chart;
  }
  chart.render(model, hooks);
  // Average view: dock the numbers pane (opaque/clear only) or drop any stale one.
  if (avgOn && mMode === 'smooth') blowAvg(datasets, seriesOrder);
  else if (document.querySelector('.avgp')) closeBlow();
  // Triple-tap anywhere on the macros chart toggles the goal lines (Owner 8/17).
  if (!document.getElementById('c').__goalTapWired) {
    document.getElementById('c').__goalTapWired = true;
    let taps = 0, tapTimer = null;
    document.getElementById('c').addEventListener('touchend', () => {
      taps++;
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = setTimeout(() => { taps = 0; }, 450);
      if (taps >= 3) {
        taps = 0;
        if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
        goalLinesOn = !goalLinesOn;
        render(currentW);
      }
    });
  }
  // Registered for the document click handler: a bar click while a blow-up is
  // open retargets the panel through here instead of closing.
  document.getElementById('c').__blowRetarget = (di, idx) => {
    if (avgOn) return;
    if (mMode === 'smooth') {
      smoothBlow(idx, di);
      return;
    }
    if (mMode !== 'raw') return;
    const m = plotted[di], row = slots[idx];
    if (m && row) openMacroBlow(document.getElementById('c'), row, m, false, di, idx);
  };
  lastMode = mMode;
  macroLegend();
  markGroup();
}


/* Owner 8/15 (second pass): the Smoothed split/expansion is gone - flat
   switcher Raw | Opaque | Clear | Average. Opaque/Clear are plain modes,
   no click-to-expand interaction. */
const mmsButtons = Array.prototype.slice.call(document.querySelectorAll('#mmode button'));
mmsButtons.forEach(b => b.addEventListener('click', () => {
  mmsButtons.forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  if (b.dataset.ms) { mMode = 'smooth'; mOpaque = b.dataset.ms === 'opaque'; }
  else mMode = b.dataset.m;
  render(currentW);
}));
document.querySelectorAll('#mseg button').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.avg) {
    /* Average is a modifier, never a mode: it layers onto the current
       shape (Raw/Opaque/Clear) over the selected range. */
    avgOn = !avgOn;
    b.classList.toggle('on', avgOn);
    render(currentW);
    return;
  }
  document.querySelectorAll('#mseg [data-w]').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  render(Number(b.dataset.w));
}));
document.querySelector('#mmode [data-m="raw"]').classList.add('on');
document.querySelector('#mseg [data-w="7"]').classList.add('on');
render(7);

/* ---------------- Workout ---------------- */

// Weights come from the derived "<Exercise> (wt)" columns in Notion, computed by
// pickWeight() on the server. Changing the rule there changes both the chart and the DB.
let wchart, wkSplit = 'Push', wkW = 90, wkFill = 'opaque';
// Off by default, still toggleable back on.
/* Owner 8/15: Leg Press joins the default-off list - listed in the Legs legend
   but dimmed/hidden until clicked on ("I just wanted it to be in the chart"). */
const DEFAULT_OFF = ['Neutral Grip Press', 'Paused Incline Press', 'Preacher Curl', 'Hip Adductor', 'Pull Ups', 'Leg Press'];
const defaultHidden = () => { const h = {}; DEFAULT_OFF.forEach(n => { h[n] = true; }); return h; };
let wkHidden = {};   // per-split: exercises the user has X'd out

/* Owner 8/15: an "All" split - every lift across Push/Pull/Legs in one chart.
   Sessions merge by date (a two-a-day shows as one x position); each merged
   session remembers the underlying per-exercise origin (__byExercise) so a
   dot/band click in All opens the real split's record for THAT exercise. */
function wkMergedList() {
  const byDate = {};
  ['Push', 'Pull', 'Legs'].forEach(sp => {
    ((WK && WK[sp]) || []).forEach(s => {
      const d = s.date;
      const m = byDate[d] || (byDate[d] = { date: d, id: s.id, title: s.title, raw: {}, w: {}, __byExercise: {} });
      Object.keys(s.raw || {}).forEach(n => { if (!(n in m.raw)) { m.raw[n] = s.raw[n]; if (!m.__byExercise[n]) m.__byExercise[n] = { split: sp, session: s }; } });
      Object.keys(s.w || {}).forEach(n => { if (!(n in m.w)) { m.w[n] = s.w[n]; if (!m.__byExercise[n]) m.__byExercise[n] = { split: sp, session: s }; } });
    });
  });
  return Object.keys(byDate).sort().map(d => byDate[d]);
}
function wkSourceList() { return wkSplit === 'All' ? wkMergedList() : ((WK && WK[wkSplit]) || []); }
function wkResolveClick(sess, idx, name) {
  const s = sess[idx];
  if (!s || name == null) return null;
  if (wkSplit !== 'All' || !s.__byExercise) return { split: wkSplit, session: s, name: name };
  const o = s.__byExercise[name];
  return o ? { split: o.split, session: o.session, name: name } : null; // hidden-stripped names no-op (never a wrong-session table)
}
function wkSessions() {
  const all = wkSourceList();
  if (!wkW || !all.length) return all;
  const last = new Date(all[all.length - 1].date + 'T00:00:00');
  return all.filter(s => (last - new Date(s.date + 'T00:00:00')) / 86400000 < wkW);
}

function renderWorkout() {
  const sess = wkSessions();
  const names = [];
  /* Owner 8/15 ("you have to add leg press to this"): the legend lists every
     exercise EVER logged in this split, not just ones with a set inside the
     current window. Retired lifts (Leg Press, last logged 2025-02) stay in
     the legend in every view, draw their history in All time, and pick back
     up the moment a new set is logged. */
  for (const s of wkSourceList()) for (const n of Object.keys(s.w || {})) if (names.indexOf(n) < 0) names.push(n);
  // Same left-to-right order as the Notion table: active lifts first, retired
  // ones (the columns parked right of "Days") last. Anything not in the view
  // order yet falls to the end, alphabetically.
  const ord = wkSplit === 'All'
    ? ['Push', 'Pull', 'Legs'].reduce((a, sp) => a.concat((ORDER && ORDER[sp]) || []), [])
    : ((ORDER && ORDER[wkSplit]) || []);
  names.sort((a, b) => {
    const ia = ord.indexOf(a), ib = ord.indexOf(b);
    if (ia < 0 && ib < 0) return a.localeCompare(b);
    if (ia < 0) return 1;
    if (ib < 0) return -1;
    return ia - ib;
  });

  const hidden = wkHidden[wkSplit] || (wkHidden[wkSplit] = defaultHidden());
  const wlegEl = document.getElementById('wlegend');
  /* Owner 8/15: All stacks every lift's chip, so the legend itself shrinks -
     smaller swatch, font and X (see .legend.allfit) to stay 2-3 rows. */
  wlegEl.classList.toggle('allfit', wkSplit === 'All');
  drawLegend(wlegEl,
    names.map((n, i) => ({ label: n, color: THEME.pastel[i % THEME.pastel.length], off: !!hidden[n] })),
    name => { hidden[name] = !hidden[name]; renderWorkout(); });

  const emptyEl = document.getElementById('wempty');
  const haveSplit = wkSplit === 'All'
    ? wkSourceList().length
    : (WK && WK[wkSplit] && WK[wkSplit].length);
  if (!sess.length) {
    emptyEl.style.display = 'flex';
    emptyEl.textContent = haveSplit
      ? ('No ' + (wkSplit === 'All' ? 'workout' : wkSplit.toLowerCase()) + ' sessions in this range.')
      : ('No ' + (wkSplit === 'All' ? 'workout' : wkSplit.toLowerCase()) + ' data yet.');
  } else {
    emptyEl.style.display = 'none';
  }

  /* The SVG rebuild: the multi-series line chart (tension 0.25 spline, 2.5px
     dots, spanGaps, anchor-thinned MM/DD/YY axis, wkmid mid-pinned tooltip) is
     drawn by the wkSvg module below. Data shaping is unchanged from the
     canvas build; only the renderer and its hit layer are new. */
  const series = names.map((n, i) => ({
    label: n,
    values: sess.map(s => (s.w && s.w[n] !== undefined && s.w[n] !== null) ? s.w[n] : null),
    color: THEME.pastel[i % THEME.pastel.length],
    hidden: !!hidden[n]
  }));
  const host = document.getElementById('w');
  wkSvg.render(host, sess, names, series, (sidx, nidx) => {
    const hit = wkResolveClick(sess, sidx, names[nidx]);
    if (hit) openWkEntry(host, hit.split, hit.session, hit.name);
  }, wkFill === 'opaque');
  host.__blowRetarget = (di, idx) => {
    // Retarget path from the global close/retarget click handler (same one the
    // macro blow-up uses): sess/names are captured fresh on every render.
    if (di == null || idx == null) return;
    const hit = wkResolveClick(sess, idx, names[di]);
    if (hit) openWkEntry(host, hit.split, hit.session, hit.name);
  };
}

/* ---- Workout table editor: clicking a plotted point opens a duplicate of
   that split's Notion database view - every column across the top with the
   header row frozen, and a 5-day window of rows: the clicked day plus the 2
   logged days before and after it, clamped at the data edges. Desktop/web
   docks the panel right of the chart (chart squashes aside); touch or a
   skinny embed docks it below. Exercise cells edit like Notion cells and
   save back to Notion. ---- */
const wkEsc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Notion property-type glyphs in column headers (text, date, number, title).
const NK_GLYPH = {
  text: '<svg class="nkpi" width="14" height="14" viewBox="0 0 14 14"><path d="M2 3.6V2.4h10v1.2h-4.2v8h-1.6v-8H2z" fill="rgba(55,53,47,0.65)"/></svg>',
  date: '<svg class="nkpi" width="14" height="14" viewBox="0 0 14 14"><path d="M3 2h8a1.2 1.2 0 0 1 1.2 1.2v8A1.2 1.2 0 0 1 11 12.4H3a1.2 1.2 0 0 1-1.2-1.2v-8A1.2 1.2 0 0 1 3 2zm0 2.6v6.6h8V4.6H3zm1.7 2.4h1.6v1.6H4.7V7zm3 0h1.6v1.6H7.7V7z" fill="rgba(55,53,47,0.65)"/></svg>',
  number: '<svg class="nkpi" width="14" height="14" viewBox="0 0 14 14"><path d="M5.6 2.4l.4 2.3h2.4l.4-2.3h1.5l-.4 2.3h2.2v1.5H9.6l-.3 1.5h2.5v1.5H9.1l-.4 2.4H7.2l.4-2.4H5.2l-.4 2.4H3.3l.4-2.4H1.8V7.7h2.1l.3-1.5H2V4.7h2.5l-.4-2.3h1.5zm.6 3.8l-.3 1.5h2.4l.3-1.5H6.2z" fill="rgba(55,53,47,0.65)"/></svg>'
};

// Exercise columns in the exact order the Notion table shows them; any not in
// the view order fall to the end alphabetically (retired columns live there).
function wkColumns(split) {
  const ord = (ORDER && ORDER[split]) || [];
  const seen = {}, names = [];
  (Array.isArray(ord) ? ord : []).forEach(n => { if (!seen[n]) { seen[n] = 1; names.push(n); } });
  const extra = [];
  ((WK && WK[split]) || []).forEach(s => [s.raw, s.w].forEach(m => {
    if (!m) return;
    Object.keys(m).forEach(n => { if (!seen[n]) { seen[n] = 1; extra.push(n); } });
  }));
  extra.sort();
  return names.concat(extra);
}

/* sessions here is the RENDER window (<=5 rows around the clicked day),
   not the split's full list - openWkEntry owns the windowing. */
function wkTableHtml(split, sessions, focusSession, focusName, narrow) {
  const names = wkColumns(split);
  /* Owner 8/15 (delta 4, narrow/bottom-docked path): the frozen left column is
     DATES - the Days column is gone and the read-only "(wt)" twin columns are
     for QA only, so each exercise shows just its editable entry column. */
  /* Owner 8/15: the Days (day-number) column is gone on BOTH docks now - the
     frozen first column is Date everywhere. */
  let head = '<tr><th>' + NK_GLYPH.date + 'Date</th>';
  for (const n of names) {
    /* Owner 8/15: the auto-generated "(wt)" weight columns are gone from the
       viewer on BOTH docks - the parsed weight stays in the data path (chart
       series, s.w) but is no longer a rendered column. */
    head += '<th data-ex="' + wkEsc(n) + '"' + (n === focusName ? ' class="hlfocus"' : '') + '>' + NK_GLYPH.text + wkEsc(n) + '</th>';
  }
  head += '</tr>';
  const rows = [];
  /* Owner 8/15 (SVG rebuild delta #4): on the narrow/bottom-docked path later
     days list FIRST. Display order only; data-sid resolution and the
     window's focus centering are order-agnostic. */
  const disp = narrow ? sessions.slice().reverse() : sessions;
  for (const s of disp) {
    let cells = '<td class="nkt-daycol">' + wkEsc(fmt(s.date)) + '</td>';
    for (const n of names) {
      const raw = s.raw && s.raw[n] !== undefined ? s.raw[n] : '';
      const wv = s.w && s.w[n] !== undefined && s.w[n] !== null ? s.w[n] : null;
      const isFocus = focusSession && s.id === focusSession.id && n === focusName;
      cells += '<td class="nkt-cell' + (isFocus ? ' focus' : '') + '" data-ex="' + wkEsc(n) + '">' +
        '<div class="nkt-editor" contenteditable="true" spellcheck="false"' +
        ' title="Enter saves - Shift+Enter for a new line - Esc reverts">' + wkEsc(raw) + '</div></td>';
    }
    rows.push('<tr' + (focusSession && s.id === focusSession.id ? ' class="focus"' : '') +
      ' data-sid="' + wkEsc(s.id) + '">' + cells + '</tr>');
  }
  if (!sessions.length) rows.push('<tr><td colspan="2"><div class="blow-empty">No days logged yet.</div></td></tr>');
  const headTitle = focusSession ? (fmt(focusSession.date) + ' · ' + split + (focusSession.title ? ' · Day ' + focusSession.title : '')) : split;
  return '<div class="blow-head"><span>' + wkEsc(headTitle) + '</span></div>' +
    '<div class="nkt-scroller"><table class="nkt"><thead>' + head + '</thead><tbody>' +
    rows.join('') + '</tbody></table></div>' +
    '<div class="wkstatus" role="status"></div>';
}

/* A small user-visible toast for workout-table failures. The page ships data
   inline (no fetch on open), so the failure shapes that matter are a per-split
   server-side load error (WKERR) and any unexpected exception below - both
   used to die silently, which read as "the blow-up is broken on desktop". */
function wkToast(msg, ms) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
    'background:#37352f;color:#fff;padding:8px 12px;border-radius:8px;z-index:99;max-width:80vw;' +
    'font:13px/1.4 ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;' +
    'box-shadow:0 6px 20px rgba(0,0,0,0.25);';
  document.body.appendChild(t);
  setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, ms || 4000);
}

/* The 5-row render window around the clicked day: idx is the focus
   session's index in the DATE-ASCENDING full list; the window is a plain
   slice(max(0, idx-2), idx+3), so the bounds can never go negative and
   wrap around to the tail of the list - an edge click yields 3-4 rows,
   never pad-empty ones: earliest click -> clicked day + the next 2;
   latest click -> the 2 before + the clicked day. A focus that resolves
   to no row (stale WK snapshot) lands on the latest day instead. Pure
   and dependency-free on purpose: wkwindow.check.js loads and asserts it. */
function wkWindow5(sessions, focusSession) {
  if (!sessions.length) return [];
  if (sessions.length <= 5) return sessions.slice();
  let idx = focusSession ? sessions.findIndex(s => s.id === focusSession.id) : -1;
  if (idx < 0) idx = sessions.length - 1;
  return sessions.slice(Math.max(0, idx - 2), idx + 3);
}

function openWkEntry(cv, split, focusSession, focusName) {
  closeBlow();
  const wrap = cv.closest('.wrap');
  const card = cv.closest('.card, .hcard');
  if (!wrap || !card) return;
  /* Full split list, canonically ordered: date asc, Notion id as a stable
     tiebreak, duplicate page-ids dropped. The old comparator returned 1 for
     equal dates, which breaks antisymmetry - V8's sort then orders same-date
     rows arbitrarily, and any duplicated entry (a row synced into WK twice)
     rendered twice, which is how the list showed days out of order with a
     repeated day. Dedupe + a total order kill both. */
  const seenIds = {};
  const sessions = ((WK && WK[split]) || []).filter(s => {
    if (!s || !s.id || seenIds[s.id]) return false;
    seenIds[s.id] = 1;
    return true;
  }).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 :
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  /* The split's rows load inline with the page; when that load failed
     server-side (WKERR) the table would open with nothing in it and no hint
     why, which read as a silent dead click. Say so instead. */
  if (!sessions.length && WKERR && WKERR[split]) {
    wkToast('Could not load the ' + split + ' table: ' + WKERR[split]);
    return;
  }
  /* wkedit docks right at BLOW_PANEL_W - the exact same width and the same
     squish pass as the macros blow-up (Owner 8/15: shared item). Owner's rule
     stands: a sidebar that squishes the chart left, never a popup. */
  const fullW = wrap.clientWidth, baseL = wrap.offsetLeft, baseT = wrap.offsetTop;
  /* Cap the panel so the chart keeps >=340px beside it (Owner 8/15: at ~700px
     windows a 560px panel collapsed the chart to a sliver, which read as
     "the whole chart frame moves to the left"). */
  const PANEL_W = BLOW_PANEL_W; // same width as the macros blow-up (Owner 8/15: 'It's the exact same length')
  /* Docking (Owner, SVG rebuild): touch - a real touch device, the QA narrow
     override, or ANY sub-561px viewport (some phones report maxTouchPoints 0,
     so innerWidth<=560 is the reliable phone signal) - keeps the below-chart
     dock exactly as before. Every desktop width opens the table as a RIGHT
     sidebar: the wrap squashes and the chart redraws smaller. */
  /* Same dockNarrow rule as blowPanel (shared mechanism): touch, skinny
     viewport, debug force, OR a wrap that can't spare the panel + ~140px of
     chart docks below instead of squishing to a sliver. */
  const dockNarrow =
    (navigator.maxTouchPoints || 0) > 0 ||
    window.innerWidth <= 560 ||
    (window.__BLOW_DEBUG && window.__BLOW_DEBUG.forceNarrow) ||
    fullW <= PANEL_W + 140;
  /* Windowing is render-time ONLY: the retarget path (__blowRetarget) hands
     in sessions from the chart's full list, and wkSaveCell resolves rows by
     data-sid against WK[split] - neither ever sees the slice, so both stay
     correct against the full list.
     Windowing is dead on BOTH docks (Owner 8/15: "the up-down scroll
     mechanism for the workout chart ... is broken" on desktop AND mobile -
     the desktop 5-day slice hid every day outside it behind a clipped,
     unscrollable overflow). Both docks now hand the full date-ascending list
     to the scroller like Notion's database view: mobile scrolls it in the
     capped bottom dock, desktop scrolls it in the viewport-capped right
     sidebar. wkSaveCell/__blowRetarget always resolve by data-sid against
     WK[split], never the DOM list. */
  const windowed = sessions;
  closeBlow();
  if (!dockNarrow) {
    squishWrapForPanel(wrap, PANEL_W, () => { if (wkSvg) wkSvg.sync(); });
  }
  const panel = document.createElement('div');
  panel.className = 'blow wkedit right';
  panel.__wk = { split: split, id: focusSession ? focusSession.id : null, date: focusSession ? focusSession.date : null };
  panel.innerHTML = wkTableHtml(split, windowed, focusSession, focusName, dockNarrow);
  card.appendChild(panel);
  blowState = { wrap, cv, focus: null };
  if (dockNarrow) document.body.classList.add('blowing');
  /* Top-alignment math for the sidebar dock: the panel's head centers
     on the SVG chart area's top edge (what chartArea.top used to give). */
  const st0 = document.getElementById('w') && document.getElementById('w').__wkState;
  const caTop0 = st0 && st0.ca ? st0.ca.top : 0;
  const head0 = panel.querySelector('.blow-head');
  const headH0 = head0 ? head0.offsetHeight : 0;
  const sideTop = () => Math.max(baseT + 2, baseT + caTop0 - headH0 / 2);
  if ((window.innerHeight || document.documentElement.clientHeight || 1e5) <= 420) {
    // Strip-size embed (Notion phone app): no room anywhere - overlay the strip.
    panel.classList.add('narrow', 'compact');
    const headSpan = panel.querySelector('.blow-head span');
    if (headSpan) headSpan.insertAdjacentHTML('afterend', '<button class="bx" onclick="closeBlow()" aria-label="Close" style="margin-left:auto;font:inherit;background:none;border:0;color:#797979;padding:0 4px;cursor:pointer;font-size:15px;">&times;</button>');
  } else if (dockNarrow) {
    // Docked below (touch or a sub-561px viewport): a plain block under the
    // chart, never covering the plot.
    panel.classList.add('narrow');
  } else {
    panel.style.left = (baseL + fullW - PANEL_W) + 'px';
    panel.style.width = PANEL_W + 'px';
    panel.style.top = sideTop() + 'px';
    // Cap to the viewport: the full-list sidebar scrolls INSIDE the panel,
    // never spilling past the pinned desktop shell's bottom edge.
    const pTop = panel.getBoundingClientRect().top;
    const vh2 = window.innerHeight || document.documentElement.clientHeight || 1e5;
    const capH = vh2 - pTop - 14;
    if (capH > 140) panel.style.maxHeight = capH + 'px';
  }
  panel.querySelectorAll('.nkt-editor').forEach(ed => wkWireCell(panel, ed));
  // The clicked day sits mid-window already; center its clicked column
  // horizontally - then put the caret in that cell, like Notion does.
  const fcell = panel.querySelector('td.focus .nkt-editor');
  const frow = panel.querySelector('tr.focus');
  try {
    /* Center the focus cell INSIDE the table scroller only. scrollIntoView
       walks EVERY ancestor (incl. the page/Notion iframe) and, with inline
       'center', shoves the whole frame horizontally (Owner's frame-jump video,
       8/15). preventScroll keeps focus() from doing the same. */
    const scroller = panel.querySelector('.nkt-scroller');
    const target = fcell || frow;
    if (target && scroller) {
      const sR = scroller.getBoundingClientRect(), tR = target.getBoundingClientRect();
      scroller.scrollLeft += (tR.left + tR.width / 2) - (sR.left + sR.width / 2);
      if (!dockNarrow && !panel.classList.contains('compact') && frow) {
        // Desktop sidebar: center the clicked day inside the panel's own
        // vertical scroller (scrollIntoView walks ancestors and would shove
        // the page/iframe - never use it for the sidebar dock).
        scroller.scrollTop += (frow.getBoundingClientRect().top + frow.offsetHeight / 2) - (sR.top + sR.height / 2);
      }
      /* Owner 8/17 ("don't force scroll up. Never force scroll"): the page
         must never move the user's scroll position. scrollIntoView walks
         every ancestor (page AND the Notion iframe) - removed entirely. The
         panel's own internal scroller centering above stays; it never
         touches the page. */

    }
    if (fcell && isDesktop()) fcell.focus({ preventScroll: true });
  } catch (e) {}
  if (!sessions.length) {
    const st = panel.querySelector('.wkstatus');
    if (st) st.textContent = 'No sessions for this split yet.';
  }
}
/* ---- Workout SVG renderer (sibling B module; self-contained so merges do
   not collide with the macros engine). Draws the workout chart as SVG:
   multi-series lines with Chart.js's exact splineCurve at tension 0.25,
   linear y ticks generated by Chart.js's own niceNum/generateTicks algorithm
   (bounds 'ticks', so scale min/max snap to the outer ticks), 2.5px dots
   (+1px self-colored border -> solid r3 discs, hover r4.5), spanGaps (nulls
   simply never enter the point list), an MM/DD/YY axis that draws EVERY label
   and thins ONLY on collision via the month-anchor rule (Owner's delta), plus a
   DOM tooltip pinned to the chart-area middle with the wkmid left clamp and a
   DOM hit layer armed by mousemove/mouseover. Interaction latency: the
   mousemove handler allocates nothing (cached geometry, cached tooltip size;
   DOM writes only when the day index or hover set actually changes), and the
   one document retarget listener is registered once at module init. ---- */
const wkSvg = (function () {
  const NS = 'http://www.w3.org/2000/svg';
  // Measuring context ONLY (vector text stays in the SVG): the rotated-label
  // collision rule needs real glyph widths, same as the old canvas plugin.
  const measCtx = document.createElement('canvas').getContext('2d');
  const labelFont = () => THEME.tickSize + 'px ' + THEME.font;
  let measFont = '';
  const measure = t => {
    const f = labelFont();
    if (f !== measFont) { measCtx.font = f; measFont = f; }
    return measCtx.measureText(t).width;
  };

  /* Chart.js 4.4.1 helpers, ported verbatim so the y ticks match. */
  function niceNum(range) {
    const roundedRange = Math.round(range);
    range = Math.abs(range - roundedRange) < range / 1000 ? roundedRange : range;
    const niceRange = Math.pow(10, Math.floor(Math.log(range) / Math.LN10));
    const fraction = range / niceRange;
    const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
    return niceFraction * niceRange;
  }
  function decPlaces(x) {
    if (!isFinite(x)) return 0;
    let e = 1, p = 0;
    while (Math.round(x * e) / e !== x) { e *= 10; p++; }
    return p;
  }
  /* LinearScaleBase: scale range = data range, then bounds 'ticks' (the
     default) snaps min/max to the outer nice ticks. beginAtZero false, no
     grace. maxTicks = 11, capped by plot height at one tick per 13.2px. */
  function yTicks(vmin, vmax, plotH) {
    if (!(vmax > vmin)) { const off = vmax === 0 ? 1 : Math.abs(vmax * 0.05); vmax += off; vmin -= off; }
    let maxTicks = Math.min(11, Math.ceil(Math.max(plotH, 1) / (THEME.tickSize * 1.2)));
    maxTicks = Math.max(2, maxTicks);
    const maxSpaces = maxTicks - 1;
    let spacing = niceNum((vmax - vmin) / maxSpaces);
    if (spacing < 1e-14) return { min: vmin, max: vmax, ticks: [vmin, vmax] };
    let numSpaces = Math.ceil(vmax / spacing) - Math.floor(vmin / spacing);
    if (numSpaces > maxSpaces) spacing = niceNum(numSpaces * spacing / maxSpaces);
    if (spacing < 1) spacing = 1; /* whole-integer ticks (Owner 8/15) */
    let niceMin = Math.floor(vmin / spacing) * spacing;
    let niceMax = Math.ceil(vmax / spacing) * spacing;
    numSpaces = (niceMax - niceMin) / spacing;
    numSpaces = Math.abs(numSpaces - Math.round(numSpaces)) < spacing / 1000 ? Math.round(numSpaces) : Math.ceil(numSpaces);
    const factor = Math.pow(10, Math.max(decPlaces(spacing), decPlaces(niceMin)));
    niceMin = Math.round(niceMin * factor) / factor;
    niceMax = Math.round(niceMax * factor) / factor;
    const ticks = [];
    for (let j = 0; j < numSpaces; j++) ticks.push(Math.round((niceMin + j * spacing) * factor) / factor);
    ticks.push(niceMax);
    return { min: ticks[0], max: ticks[ticks.length - 1], ticks: ticks };
  }
  const fmtTick = v => {
    if (v === 0) return '0';
    const r = Math.round(v);
    return String(r);
  };

  /* Chart.js splineCurve (cubicInterpolationMode 'default'), verbatim math. */
  function splineCurve(a, b, c, t) {
    const d01 = Math.hypot(b.x - a.x, b.y - a.y);
    const d12 = Math.hypot(c.x - b.x, c.y - b.y);
    let s01 = d01 / (d01 + d12), s12 = d12 / (d01 + d12);
    s01 = isNaN(s01) ? 0 : s01;
    s12 = isNaN(s12) ? 0 : s12;
    const fa = t * s01, fb = t * s12;
    return {
      previous: { x: b.x - fa * (c.x - a.x), y: b.y - fa * (c.y - a.y) },
      next: { x: b.x + fb * (c.x - a.x), y: b.y + fb * (c.y - a.y) }
    };
  }

  function el(tag, attrs) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  let lastArgs = null;  // for sync() re-render after a synchronous wrap squash

  function render(host, sess, names, series, openDot, opaque) {
    lastArgs = { host: host, sess: sess, names: names, series: series, openDot: openDot, opaque: opaque };
    const st = { sess: sess, names: names, series: series, openDot: openDot, opaque: opaque, ca: null, dots: [], col: [], hoverIdx: -1, tip: null, tipW: 0, tipH: 0, suppressClick: false, n: sess.length };
    host.__wkState = st;
    host.innerHTML = '';
    const W = host.clientWidth, H = host.clientHeight;
    if (W < 10 || H < 10) return;
    /* Layout padding 4/2/46/8: the rotated MM/DD/YY labels live in the 46px
       bottom pad (34 clipped the low end of dense all-time labels), y = axis
       bottom + 9; the 8px left pad keeps the first label's rotated low end
       off the svg edge. */
    const PT = 4, PR = 2, PB = 46, PL = 8;
    const plotH = H - PT - PB;
    let vmin = Infinity, vmax = -Infinity;
    series.forEach(sr => { if (sr.hidden) return; sr.values.forEach(v => {
      if (v === null || v === undefined) return;
      if (v < vmin) vmin = v;
      if (v > vmax) vmax = v;
    }); });
    if (!isFinite(vmin)) { vmin = 0; vmax = 1; }
    const ys = yTicks(vmin, vmax, plotH);
    let labelW = 0;
    ys.ticks.forEach(v => { const w2 = measure(fmtTick(v)); if (w2 > labelW) labelW = w2; });
    // y box width = max label width + 3px tick padding, +1 for the border.
    const ca = { left: PL + Math.ceil(labelW) + 3 + 1, top: PT + THEME.tickSize / 2, right: W - PR, bottom: H - PB }; // QA A: canvas reserves half tick-label height at top (9.6)
    if (ca.right - ca.left < 10 || ca.bottom - ca.top < 10) return;
    st.ca = ca;
    const n = st.n;
    /* Calendar-true time scale (Owner 8/15): the axis shows EVERY calendar
       date, so a session's x is its date position and rest days take real
       horizontal space. A single session degenerates to the plot middle. */
    const dayMs = 86400000;
    const dateMs = s => { const d2 = s.date.split('-'); return Date.UTC(+d2[0], +d2[1] - 1, +d2[2]); };
    const t0 = n ? Math.min.apply(null, sess.map(dateMs)) : 0;
    const t1 = n ? Math.max.apply(null, sess.map(dateMs)) : 0;
    const span = Math.max(t1 - t0, dayMs);
    const xOfDate = t => t1 === t0 ? (ca.left + ca.right) / 2 : ca.left + (t - t0) / span * (ca.right - ca.left);
    const xOf = i => xOfDate(dateMs(sess[i]));
    /* Session-date labels for the index-mode tooltip title. */
    const labels = sess.map(s => {
      const p2 = s.date.split('-');
      return p2[1] + '/' + p2[2] + '/' + p2[0].slice(2);
    });
    const yOf = v => ca.bottom - (v - ys.min) / (ys.max - ys.min) * (ca.bottom - ca.top);

    const svg = el('svg', { width: W, height: H, style: 'display:block;user-select:none;-webkit-user-select:none;' });
    /* Chart.js clips datasets to the chartArea (E blocker B2): spline overshoot
       and outer-tick dots must half-clip exactly like canvas. */
    const wkDefs = el('defs', {});
    const wkClip = el('clipPath', { id: 'wkclip' });
    wkClip.appendChild(el('rect', { x: ca.left, y: ca.top, width: ca.right - ca.left, height: ca.bottom - ca.top }));
    wkDefs.appendChild(wkClip);
    svg.appendChild(wkDefs);
    const plotG = el('g', { 'clip-path': 'url(#wkclip)' });
    const fnt = 'font-family:' + THEME.font + ';font-size:' + THEME.tickSize + 'px;font-weight:400;';
    // Gridlines + axis borders (gridY draws no tick marks; border = AXIS).
    ys.ticks.forEach(v => {
      const y = Math.round(yOf(v)) + 0.5;
      svg.appendChild(el('line', { x1: ca.left, x2: ca.right, y1: y, y2: y, stroke: THEME.grid, 'stroke-width': 1 }));
    });
    svg.appendChild(el('line', { x1: ca.left + 0.5, x2: ca.left + 0.5, y1: ca.top, y2: ca.bottom, stroke: THEME.axis, 'stroke-width': 1 }));
    svg.appendChild(el('line', { x1: ca.left, x2: ca.right, y1: ca.bottom + 0.5, y2: ca.bottom + 0.5, stroke: THEME.axis, 'stroke-width': 1 }));
    ys.ticks.forEach(v => {
      const t = el('text', { x: ca.left - 3 - 1, y: yOf(v), 'text-anchor': 'end', 'dominant-baseline': 'central', fill: THEME.tick, style: fnt });
      t.textContent = fmtTick(v);
      svg.appendChild(t);
    });

    // Lines + points. spanGaps: null values never enter the point list, so
    // the spline closes over the gap exactly like the canvas build.
    /* Opaque mode (Owner 8/15, "the filled in stack chart that we have with
       macros"): every visible series also fills SOLID down to the plot
       baseline - no transparency - with the heaviest series painted first
       (back) and the lightest last (front): hierarchy by magnitude, same
       rule as the macros opaque view. Point discs stay out of the paint
       (the front fills would swallow them) but stay in the hit geometry. */
    const drawList = series.map((sr, di) => ({ sr: sr, di: di })).filter(x => !x.sr.hidden);
    if (st.opaque) {
      const maxOf = sr => sr.values.reduce((m, v) => (v !== null && v !== undefined ? Math.max(m, v) : m), 0);
      drawList.sort((a, b) => (maxOf(b.sr) - maxOf(a.sr)) || (a.di - b.di));
    }
    const dotLayer = el('g', {});
    drawList.forEach(x => {
      const sr = x.sr, di = x.di;
      const pts = [];
      sr.values.forEach((v, i) => { if (v !== null && v !== undefined) pts.push({ i: i, x: xOf(i), y: yOf(v), v: v, di: di }); });
      if (pts.length) {
        let d = '';
        if (st.opaque) {
          /* Owner 8/15 (revised, backfill veto): opaque is a SMOOTH curve in
             all cases - the same tension-0.25 spline as Line mode - run
             through a CARRIED series: each exercise's latest logged value
             fills its empty slots FORWARD (gaps before the first session
             stay EMPTY - never backfilled), and its last value runs to the
             right edge. A single session => constant band from that session
             rightward (their "stacked bar" look); more => a smooth curve. */
          const vals = sr.values;
          let firstI = 0;
          for (let i = 0; i < vals.length; i++) { if (vals[i] !== null && vals[i] !== undefined) { firstI = i; break; } }
          const valAt = [], srcAt = [];
          let lv = null, li = -1;
          for (let i = 0; i < vals.length; i++) {
            const v = vals[i];
            if (v !== null && v !== undefined) { lv = v; li = i; }
            /* Owner 8/15 live: NEVER backfill - before a series' first logged
               session the value stays null (no band at all), it does not
               flatten back to the first value. After the first session, gaps
               carry forward and to the right edge. */
            valAt.push(lv === null ? null : lv);
            srcAt.push(lv === null ? firstI : li);
          }
          const SP = [];
          for (let i = 0; i < vals.length; i++) { if (valAt[i] === null || valAt[i] === undefined) continue; SP.push({ i: srcAt[i], x: xOf(i), y: yOf(valAt[i]), v: valAt[i], di: di }); }
          /* Owner 8/15, live prod: NEVER backfill - a series begins at its
             first logged session even when the window reaches back years
             (Abs backfilled to 2024 read as a flat fake band). Forward carry
             across gaps and to the right edge stays. */
          SP.push({ i: srcAt[srcAt.length - 1], x: ca.right, y: SP[SP.length - 1].y, v: SP[SP.length - 1].v, di: di });
          const cps = SP.map((p, k) => splineCurve(SP[Math.max(0, k - 1)], p, SP[Math.min(SP.length - 1, k + 1)], 0.25));
          cps.forEach(cp => {
            ['previous', 'next'].forEach(key => {
              cp[key].x = Math.min(Math.max(cp[key].x, ca.left), ca.right);
              cp[key].y = Math.min(Math.max(cp[key].y, ca.top), ca.bottom);
            });
          });
          d = 'M ' + SP[0].x + ' ' + SP[0].y;
          const segs = [];
          for (let k = 1; k < SP.length; k++) {
            d += ' C ' + cps[k - 1].next.x + ' ' + cps[k - 1].next.y + ', ' + cps[k].previous.x + ' ' + cps[k].previous.y + ', ' + SP[k].x + ' ' + SP[k].y;
            segs.push({ a: SP[k - 1], b: SP[k], c1: cps[k - 1].next, c2: cps[k].previous });
          }
          plotG.appendChild(el('path', { d: d + ' L ' + SP[SP.length - 1].x + ' ' + ca.bottom + ' L ' + SP[0].x + ' ' + ca.bottom + ' Z', fill: sr.color, stroke: 'none' }));
          /* Click-anywhere geometry: stash the spline segments (push order =
             paint order, heaviest back .. lightest front). A segment's a.i is
             the SOURCE session of the value at its left end, so clicks on
             carried paint open the session that produced the value - latest
             at-or-before the click. pts below are band x-extents only. */
          (st.obands = st.obands || []).push({ di: di, pts: [{ x: ca.left }, { x: ca.right }], segs: segs });
          /* Owner 8/15: opaque stack bands are fills ONLY - no stroke line at
             the top edge of a band. */
        } else {
          const cps = pts.map((p, k) => splineCurve(pts[Math.max(0, k - 1)], p, pts[Math.min(pts.length - 1, k + 1)], 0.25));
          // capBezierPoints: control handles clamp into the chart area (canvas parity).
          cps.forEach(cp => {
            ['previous', 'next'].forEach(key => {
              cp[key].x = Math.min(Math.max(cp[key].x, ca.left), ca.right);
              cp[key].y = Math.min(Math.max(cp[key].y, ca.top), ca.bottom);
            });
          });
          d = 'M ' + pts[0].x + ' ' + pts[0].y;
          for (let k = 1; k < pts.length; k++) {
            d += ' C ' + cps[k - 1].next.x + ' ' + cps[k - 1].next.y + ', ' + cps[k].previous.x + ' ' + cps[k].previous.y + ', ' + pts[k].x + ' ' + pts[k].y;
          }
          plotG.appendChild(el('path', { d: d, fill: 'none', stroke: sr.color, 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
        }
      }
      pts.forEach(p => {
        // Owner 8/15 (revert): dots render at their TRUE x, even slightly past
        // the right plot edge - the clamp was wrong.
        const c = el('circle', { cx: p.x, cy: p.y, r: 3, fill: sr.color });
        if (!st.opaque) dotLayer.appendChild(c);
        const d2 = { x: p.x, y: p.y, v: p.v, di: di, i: p.i, el: c };
        st.dots.push(d2);
        (st.col[p.i] = st.col[p.i] || []).push(d2);
      });
    });
    plotG.appendChild(dotLayer);
    svg.appendChild(plotG);

    /* MM/DD/YY axis (Owner rule 8/15, emphatic + 8/15 repeat on prod): EVERY
       calendar date in the range draws, rest days included - never just
       session dates. The 2nd/29th milestones (Owner 8/15) carry the 3px white
       stroke PLUS bold weight and dark fill: white-on-white alone was
       invisible on the card, which read as "the strokes are gone" on prod. */
    const labY = ca.bottom + 9;
    /* Session dates ONLY (Owner 8/15 reversal): "show all dates" means all the
       dates they WENT to the gym - every one, no thinning - and rest days get
       no label (they still take horizontal space on the calendar-true x).
       Milestones stay: session dates on the 2nd/29th are stroked + bold and
       paint LAST above the plain labels they overlap. */
    /* Milestone windows (Owner 8/15): stroke the SESSION day closest to the
       2nd (2-4), 15th (12-18) and 29th (27-29) each month; exact wins. */
    const strokeSet = new Set();
    // Owner 8/15: All time strokes the 1st-of-month labels only.
    const MS2 = wkW === 0 ? [[1, 1, 31]] : [[2, 2, 4], [15, 12, 18], [29, 27, 29]];
    const byMo = {};
    sess.forEach((r, i) => { const k = r.date.slice(0, 7); (byMo[k] = byMo[k] || []).push(i); });
    Object.keys(byMo).forEach(k => {
      MS2.forEach(([a, lo, hi]) => {
        let best = -1, bd = 1e9;
        byMo[k].forEach(i => { const d = +sess[i].date.split('-')[2]; if (d < lo || d > hi) return; const dd = Math.abs(d - a); if (dd < bd) { bd = dd; best = i; } });
        if (best >= 0) strokeSet.add(best);
      });
    });
    const labM = (() => { const c = document.createElement('canvas').getContext('2d'); return (t, w) => { c.font = w + ' ' + THEME.tickSize + 'px ' + THEME.font; return c.measureText(t).width; }; })();
    const plainTx = [], strongTx = [];
    for (let i = 0; i < n; i++) {
      const dd = sess[i].date.split('-');
      const m2 = +dd[1], d2 = +dd[2], y2 = dd[0].slice(2);
      const strong = strokeSet.has(i);
      /* Universal frame clamp (Owner 8/15): the same rotated-rect math as the
         macros axis builders - shift the anchor, never shrink the font. */
      const lab = (m2 < 10 ? '0' : '') + m2 + '/' + (d2 < 10 ? '0' : '') + d2 + '/' + y2;
      const labHh = THEME.tickSize / 2;
      const labTw = labM(lab, strong ? '600' : '400');
      const lx = Math.min(Math.max(xOf(i), 1 + 0.8192 * labTw + 0.5736 * labHh), W - 1 - 0.5736 * labHh);
      const cly = Math.min(Math.max(labY, 1 + 0.8192 * labHh), H - 1 - 0.5736 * labTw - 0.8192 * labHh);
      const tx = el('text', {
        x: lx, y: cly, 'text-anchor': 'end', 'dominant-baseline': 'central',
        fill: strong ? '#1a1a1a' : THEME.tick,
        transform: 'rotate(-35 ' + lx + ' ' + cly + ')',
        style: 'font-family:' + THEME.font + ';font-size:' + THEME.tickSize + 'px;font-weight:' + (strong ? '600' : '400') + ';'
      });
      if (strong) {
        tx.setAttribute('stroke', '#fff');
        tx.setAttribute('stroke-width', 4.5);
        tx.setAttribute('stroke-linejoin', 'round');
        tx.setAttribute('paint-order', 'stroke');
      }
      tx.textContent = lab;
      (strong ? strongTx : plainTx).push(tx);
    }
    plainTx.forEach(tx => svg.appendChild(tx));
    strongTx.forEach(tx => svg.appendChild(tx));

    /* Hit + tooltip layer (mode index, intersect false): the nearest day
       column answers from anywhere inside the plot area, one row per visible
       non-null series. DOM-mousemove armed per the integrator's rule. */
    const hit = el('rect', { x: ca.left, y: ca.top, width: ca.right - ca.left, height: ca.bottom - ca.top, fill: 'rgba(0,0,0,0)', 'pointer-events': 'all' });
    svg.appendChild(hit);
    const tip = document.createElement('div');
    tip.style.cssText = 'position:absolute;display:none;background:#fff;border:1px solid #e4e4e4;border-radius:6px;' +
      'padding:10px;z-index:5;pointer-events:none;font-family:' + THEME.font + ';font-size:12px;color:#3d3d3d;white-space:nowrap;';
    host.appendChild(svg);
    host.appendChild(tip);
    st.tip = tip;

    const setHover = idx => {
      if (idx === st.hoverIdx) return;
      const old = st.col[st.hoverIdx];
      if (old) for (let k = 0; k < old.length; k++) old[k].el.setAttribute('r', 3);
      const nw = st.col[idx];
      if (nw) for (let k = 0; k < nw.length; k++) nw[k].el.setAttribute('r', 4.5);
      st.hoverIdx = idx;
    };
    const localPos = e => {
      const r = host.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const nearestDot = (s2, mx, my) => {
      let best = null, bd = Infinity;
      const ds = s2.dots;
      for (let k = 0; k < ds.length; k++) {
        const dx = ds[k].x - mx, dy = ds[k].y - my;
        const dd = dx * dx + dy * dy;
        if (dd < bd) { bd = dd; best = ds[k]; }
      }
      return { dot: best, dist: Math.sqrt(bd) };
    };
    const buildTip = idx => {
      const rows = series.map((sr, di) => ({ sr: sr, v: sr.values[idx] }))
        .filter(r2 => !r2.sr.hidden && r2.v !== null && r2.v !== undefined);
      if (!rows.length) { tip.style.display = 'none'; st.tipW = 0; return; }
      tip.innerHTML = '';
      const ttl = document.createElement('div');
      ttl.style.cssText = 'font-weight:600;font-size:12px;color:#1a1a1a;margin-bottom:2px;';
      ttl.textContent = labels[idx]; /* Chart.js index-mode title = the label string (MM/DD/YY); F fix */
      tip.appendChild(ttl);
      rows.forEach(r2 => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:1px 0;';
        const dot = document.createElement('span');
        dot.style.cssText = 'width:9px;height:9px;border-radius:50%;flex:none;background:' + r2.sr.color + ';display:inline-block;';
        const tx = document.createElement('span');
        tx.textContent = r2.sr.label + ': ' + fmtTick(r2.v);
        row.appendChild(dot); row.appendChild(tx);
        tip.appendChild(row);
      });
      tip.style.display = 'block';
      st.tipW = tip.offsetWidth;
      st.tipH = tip.offsetHeight;
    };
    hit.addEventListener('mousemove', e => {
      const p = localPos(e);
      // Nearest session by calendar position (time scale, 8/15).
      let idx = -1, bd2 = Infinity;
      if (n) {
        const tHit = t0 + (p.x - ca.left) / Math.max(ca.right - ca.left, 1e-6) * span;
        for (let i2 = 0; i2 < n; i2++) { const dd2 = Math.abs(dateMs(sess[i2]) - tHit); if (dd2 < bd2) { bd2 = dd2; idx = i2; } }
      }
      if (idx < 0) return;
      if (idx !== st.hoverIdx) { setHover(idx); buildTip(idx); }
      if (!st.tipW) return;
      /* wkmid: caret follows the event x, y pins to the chart-area MIDDLE; the
         body draws LEFT of the caret (xAlign right, caretPadding 8) and the
         left clamp keeps the leftmost columns' card inside the wrap. */
      const my = (ca.top + ca.bottom) / 2;
      let right = p.x - 8;
      if (right - st.tipW < ca.left) right = ca.left + st.tipW;
      if (right - st.tipW < 0) right = st.tipW;
      let top = my - st.tipH / 2;
      if (top < 0) top = 0;
      if (top + st.tipH > H) top = Math.max(0, H - st.tipH);
      tip.style.left = (right - st.tipW) + 'px';
      tip.style.top = top + 'px';
      if (isDesktop()) {
        const near = nearestDot(st, p.x, p.y);
        hit.style.cursor = (near.dot && near.dist <= 14) || (st.opaque && wkOpaqueHitState(st, p.x, p.y)) ? 'pointer' : 'default'; // dot-strict (canvas parity, E) OR any painted opaque band (Owner 8/15)
      } else if (hit.style.cursor) hit.style.cursor = '';
    });
    hit.addEventListener('mouseout', () => {
      setHover(-1);
      tip.style.display = 'none';
      hit.style.cursor = '';
    });
    hit.addEventListener('click', e => {
      const p = localPos(e);
      // QA C (canvas parity): the editor opens DOT-STRICT only. The old 24px
      // near-miss fallback is dropped - canvas never opened from a miss.
      const near = nearestDot(st, p.x, p.y);
      if (near.dot && near.dist <= 14) {
        // Panel-close retarget owns strict hits; honor its one-shot swallow.
        if (st.suppressClick) { st.suppressClick = false; return; }
        // Canvas armed the tooltip on touchstart before the editor opened
        // (E nit 3): on touch, a dot tap shows both.
        if (!isDesktop()) {
          setHover(near.dot.i); buildTip(near.dot.i);
          if (st.tipW) {
            const my2 = (ca.top + ca.bottom) / 2;
            let right2 = p.x - 8;
            if (right2 - st.tipW < ca.left) right2 = ca.left + st.tipW;
            if (right2 - st.tipW < 0) right2 = st.tipW;
            let top2 = my2 - st.tipH / 2;
            if (top2 < 0) top2 = 0;
            if (top2 + st.tipH > H) top2 = Math.max(0, H - st.tipH);
            tip.style.left = (right2 - st.tipW) + 'px';
            tip.style.top = top2 + 'px';
          }
        }
        openDot(near.dot.i, near.dot.di); return;
      }
      // QA C-follow-up: suppressClick must NOT swallow the touch arm on a
      // non-strict tap - that made dead spots wherever a panel close preceded
      // the tap (the click retarget only stopPropagates strict hits). In
      // opaque mode a capture-path panel close owns the click entirely: a
      // close must not reopen (Owner 8/15).
      if (st.suppressClick) { st.suppressClick = false; if (st.opaque) return; }
      /* Owner 8/15: in opaque mode every filled band is clickable - clicking a
         series' paint opens the editor at that exercise's latest logged
         session at-or-before the click, even when that exact day skipped the
         exercise. Unfilled regions stay inert. */
      if (st.opaque) {
        const oh = wkOpaqueHitState(st, p.x, p.y);
        if (!oh) return;
        if (!isDesktop()) {
          setHover(oh.focusI); buildTip(oh.focusI);
          if (st.tipW) {
            const myo = (ca.top + ca.bottom) / 2;
            let righto = p.x - 8;
            if (righto - st.tipW < ca.left) righto = ca.left + st.tipW;
            if (righto - st.tipW < 0) righto = st.tipW;
            let topo = myo - st.tipH / 2;
            if (topo < 0) topo = 0;
            if (topo + st.tipH > H) topo = Math.max(0, H - st.tipH);
            tip.style.left = (righto - st.tipW) + 'px';
            tip.style.top = topo + 'px';
          }
        }
        openDot(oh.focusI, oh.di); return;
      }
      if (isDesktop()) return;
      // Touch: a tap anywhere in the plot arms the nearest column's tooltip
      // (canvas Chart.js showed a tooltip on any tap; SVG had no touch path).
      // Nearest session by calendar position (time scale, 8/15).
      let idx = -1, bd2 = Infinity;
      if (n) {
        const tHit = t0 + (p.x - ca.left) / Math.max(ca.right - ca.left, 1e-6) * span;
        for (let i2 = 0; i2 < n; i2++) { const dd2 = Math.abs(dateMs(sess[i2]) - tHit); if (dd2 < bd2) { bd2 = dd2; idx = i2; } }
      }
      if (idx < 0) return;
      setHover(idx);
      buildTip(idx);
      if (st.tipW) {
        const my = (ca.top + ca.bottom) / 2;
        let right = p.x - 8;
        if (right - st.tipW < ca.left) right = ca.left + st.tipW;
        if (right - st.tipW < 0) right = st.tipW;
        let top = my - st.tipH / 2;
        if (top < 0) top = 0;
        if (top + st.tipH > H) top = Math.max(0, H - st.tipH);
        tip.style.left = (right - st.tipW) + 'px';
        tip.style.top = top + 'px';
      }
    });
  }

  /* Shared opaque band hit-test: the owner at (mx,my) is the LAST painted
     band (lightest series, front) whose fill region - spline top edge down to
     the plot baseline - covers the point. Resolves the exercise's latest
     logged session at-or-left of the click (the straddling segment's left
     point). Returns null outside every fill, which keeps unfilled paint inert. */
  function wkOpaqueHitState(st, mx, my) {
    if (!st || !st.opaque || !st.obands) return null;
    const ca = st.ca;
    if (!ca || mx < ca.left || mx > ca.right || my < ca.top || my > ca.bottom) return null;
    for (let b = st.obands.length - 1; b >= 0; b--) {
      const B = st.obands[b], pts = B.pts;
      if (pts.length < 2 || mx < pts[0].x || mx > pts[pts.length - 1].x) continue;
      let si = 0;
      while (si < B.segs.length - 1 && B.segs[si].b.x < mx) si++;
      const g = B.segs[si];
      let lo = 0, hi = 1;
      for (let it = 0; it < 32; it++) {
        const mid = (lo + hi) / 2, u = 1 - mid;
        const gx = u * u * u * g.a.x + 3 * u * u * mid * g.c1.x + 3 * u * mid * mid * g.c2.x + mid * mid * mid * g.b.x;
        if (gx < mx) lo = mid; else hi = mid;
      }
      const t2 = (lo + hi) / 2, u2 = 1 - t2;
      const gy = u2 * u2 * u2 * g.a.y + 3 * u2 * u2 * t2 * g.c1.y + 3 * u2 * t2 * t2 * g.c2.y + t2 * t2 * t2 * g.b.y;
      if (my >= gy) return { di: B.di, focusI: g.a.i };
    }
    return null;
  }

  /* Panel-open clicks on the workout SVG: the global canvas-targeted capture
     handler cannot see an SVG host, so it falls through to a plain closeBlow
     and runs BEFORE this one (script order). If the click was a strict dot
     hit, retarget the editor to that dot instead of leaving the panel closed;
     a near miss swallows the chart's own fallthrough click so the just-closed
     layout cannot reopen against stale coordinates. */
  /* Registered on WINDOW capture: the global closeBlow capture lives on
     document and used to run first, closing the panel before this handler
     could see it - which made suppressClick/retarget dead code (E blocker B3).
     Window capture fires before document capture. */
  window.addEventListener('click', e => {
    const host = document.getElementById('w');
    if (!host) return;
    // QA arbitration (touch parity): a tap outside the chart clears an armed
    // workout tooltip - on canvas, Chart.js dropped active tooltips when the
    // tap left the canvas, and the SVG build has no other outside-tap path.
    if (!host.contains(e.target)) {
      const st0 = host.__wkState;
      if (st0 && st0.tip && st0.tip.style.display !== 'none') st0.tip.style.display = 'none';
      return;
    }
    const panel = document.querySelector('.blow');
    if (!panel || panel.contains(e.target)) return;
    const st = host.__wkState;
    if (!st || !st.dots.length) return;
    st.suppressClick = true;
    const r = host.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bd = Infinity;
    for (let k = 0; k < st.dots.length; k++) {
      const d2 = st.dots[k];
      const dd = (d2.x - mx) * (d2.x - mx) + (d2.y - my) * (d2.y - my);
      if (dd < bd) { bd = dd; best = d2; }
    }
    if (best && Math.sqrt(bd) <= 13) {
      st.suppressClick = false; // one-shot flag must not outlive its own retarget (E nit 1)
      e.stopPropagation();
      if (st.sess[best.i] && st.names[best.di] != null) st.openDot(best.i, best.di);
      return;
    }
    /* Opaque retarget (Owner 8/15): with the editor open, a click on any filled
       band re-opens it at that exercise's latest day at-or-left of the click -
       computed in the CURRENT squashed layout, before the document-level close
       unsquishes the chart, so the geometry stays true. Same consumption rule
       as strict dots. */
    const oh0 = wkOpaqueHitState(st, mx, my);
    if (oh0) {
      st.suppressClick = false;
      e.stopPropagation();
      if (st.sess[oh0.focusI] && st.names[oh0.di] != null) st.openDot(oh0.focusI, oh0.di);
    }
  }, true);

  /* Wrap resize (window resize, squashes): re-render with the last data. */
  function sync() { if (lastArgs) render(lastArgs.host, lastArgs.sess, lastArgs.names, lastArgs.series, lastArgs.openDot, lastArgs.opaque); }
  let ro = null;
  const roCb = entries => {
    const r = entries[0] && entries[0].contentRect;
    if (!r || r.width < 10 || r.height < 10) return;
    if (roCb._w === r.width && roCb._h === r.height) return;
    roCb._w = r.width; roCb._h = r.height;
    // openWkEntry squashes synchronously with its own wkSvg.sync(); skip only
    // the RO echo of that same resize so the chart redraws exactly once.
    sync();
  };
  return {
    render: function (host, sess, names, series, openDot, opaque) {
      if (!ro && typeof ResizeObserver !== 'undefined' && host && host.parentNode) {
        ro = new ResizeObserver(roCb);
        ro.observe(host.parentNode);
      }
      render(host, sess, names, series, openDot, opaque);
    },
    sync: sync
  };
})();


function wkWireCell(panel, ed) {
  ed.__orig = ed.textContent;
  ed.addEventListener('blur', () => {
    if (ed.textContent !== ed.__orig) wkSaveCell(panel, ed);
  });
  ed.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); ed.blur(); }
    else if (e.key === 'Escape') { ed.textContent = ed.__orig; ed.__esc = true; ed.blur(); e.preventDefault(); e.stopPropagation(); }
  });
  ed.addEventListener('paste', e => {
    e.preventDefault();
    const t = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, t);
  });
}

async function wkSaveCell(panel, ed) {
  const meta = panel.__wk;
  const tr = ed.closest('tr');
  const td = ed.closest('td');
  const sid = tr && tr.getAttribute('data-sid');
  const ex = td && td.getAttribute('data-ex');
  const status = panel.querySelector('.wkstatus');
  const text = ed.textContent.replace(/\\n\\s*$/g, ''); // chartPage is a template literal: \\ survives to the page
  if (text === ed.__orig) return;
  const mark = (txt, cls) => { if (status) { status.textContent = txt; status.className = 'wkstatus' + (cls ? ' ' + cls : ''); } };
  if (!sid || !ex) { mark('This row is not linked to a Notion entry yet', 'err'); return; }
  const preEdit = ed.__orig;
  ed.__orig = text; // a second blur of the same edit must not POST twice
  mark('Saving "' + ex + '"...');
  ed.classList.add('busy');
  try {
    const r = await gateFetch('/workout/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ split: meta.split, id: sid, exercise: ex, text: text })
    });
    let j = null;
    try { j = await r.json(); } catch (e2) {}
    if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || ('http ' + r.status));
    const s = j.session;
    if (s) {
      const list = (WK && WK[meta.split]) || [];
      const i = list.findIndex(x => x.id === sid);
      if (i >= 0) list[i] = s; else { list.push(s); list.sort((a, b) => (a.date < b.date ? -1 : 1)); }
      if (WK) WK[meta.split] = list;
      // Notion is the truth after a save: the cell reflects exactly what was
      // written back, and its derived (wt) twin cell updates too.
      const rawCell = s.raw && s.raw[ex] !== undefined ? s.raw[ex] : '';
      if (ed.textContent !== rawCell) { ed.textContent = rawCell; }
      ed.__orig = rawCell;
      const wtCell = tr.querySelector('td[data-wt="' + CSS.escape(ex) + '"]');
      const wv = s.w && s.w[ex] !== undefined && s.w[ex] !== null ? s.w[ex] : null;
      if (wtCell) wtCell.textContent = wv !== null ? String(wv) : '';
    }
    renderWorkout();
    mark(j.warning ? ('Saved; ' + j.warning) : 'Saved to Notion · chart updated', j.warning ? '' : 'ok');
  } catch (e) {
    ed.__orig = preEdit; // let the next blur retry the same edit
    mark('Could not save: ' + (e && e.message ? e.message : e), 'err');
  } finally {
    ed.classList.remove('busy');
  }
}

const custEl = document.getElementById('wcust');
const custNum = document.getElementById('wcnum');
const custUnit = document.getElementById('wcunit');

function applyCustom() {
  const n = Math.max(1, Number(custNum.value) || 1);
  wkW = n * Number(custUnit.value);
  renderWorkout();
}
custNum.addEventListener('input', applyCustom);
custUnit.addEventListener('change', applyCustom);

document.querySelectorAll('#wseg button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#wseg button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  const row2 = document.getElementById('wrow2');
  if (b.dataset.w === 'custom') { custEl.classList.add('on'); row2.classList.add('on'); applyCustom(); return; }
  custEl.classList.remove('on'); row2.classList.remove('on');
  wkW = Number(b.dataset.w);
  renderWorkout();
}));
// Push/Pull/Legs/All tabs are real links (Owner 8/20): each tab owns a URL
// (?tab=push etc.), so cmd/ctrl-click, middle-click, or 'open in new tab'
// lands on that tab's page. A plain click keeps the in-place swap and just
// updates the address bar (refresh/back/bookmark land on the same tab).
// Hrefs are stamped client-side so existing params (?k= embed token etc.)
// are preserved verbatim.
(function wkSplitTabs() {
  const splitMap = { push:'Push', pull:'Pull', legs:'Legs', all:'All' };
  const splitSlug = { Push:'push', Pull:'pull', Legs:'legs', All:'all' };
  const tabs = Array.from(document.querySelectorAll('#wsplit a'));
  const tabUrl = (s) => { const u = new URL(location.href); u.searchParams.set('tab', splitSlug[s]); return u.toString(); };
  tabs.forEach(a => { a.href = tabUrl(a.dataset.s); });
  const p = new URLSearchParams(location.search).get('tab');
  if (p && splitMap[p.toLowerCase()]) wkSplit = splitMap[p.toLowerCase()];
  function activate(s, push) {
    tabs.forEach(x => x.classList.toggle('on', x.dataset.s === s));
    wkSplit = s;
    wkHidden[wkSplit] = defaultHidden();   // a fresh split starts from the defaults
    if (push) history.pushState(null, '', tabUrl(s));
    renderWorkout();
  }
  tabs.forEach(a => a.addEventListener('click', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return; // browser follows the href
    ev.preventDefault();
    if (a.dataset.s === wkSplit) return;
    activate(a.dataset.s, true);
  }));
  window.addEventListener('popstate', () => {
    const q = new URLSearchParams(location.search).get('tab');
    const s = (q && splitMap[q.toLowerCase()]) ? splitMap[q.toLowerCase()] : 'Push';
    if (s !== wkSplit) activate(s, false);
  });
})();
document.querySelector('#wseg [data-w="90"]').classList.add('on');
{ const t0 = document.querySelector('#wsplit [data-s="' + wkSplit + '"]'); if (t0) t0.classList.add('on'); }

// Workout fill toggle (Owner 8/15): Line is the existing chart, Opaque is the
// filled stack the macros view has. Default Line.
document.querySelectorAll('#wfill button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#wfill button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  wkFill = b.dataset.f;
  renderWorkout();
}));
document.querySelector('#wfill [data-f="opaque"]').classList.add('on');
renderWorkout();

async function poll() {
  try {
    const r = await gateFetch('/data.json');
    if (!r.ok) return;
    const j = await r.json();
    if (JSON.stringify(j.rows) !== JSON.stringify(ROWS) || j.source !== META.source) {
      ROWS = j.rows; META = { source: j.source }; render(currentW);
    }
    // Live items stream: refresh blow-up rows without waiting for a page reload.
    // Keep the baked __short name map - the stream carries raw rows only.
    if (j.items && JSON.stringify(j.items) !== JSON.stringify(ITEMS)) {
      const short = ITEMS.__short;
      ITEMS = j.items; if (short) ITEMS.__short = short;
      render(currentW);
    }
  } catch (e) {}
  try {
    const r2 = await gateFetch('/workout.json');
    if (!r2.ok) return;
    const j2 = await r2.json();
    let wkDirty = false;
    if (j2.order && JSON.stringify(j2.order) !== JSON.stringify(ORDER)) { ORDER = j2.order; wkDirty = true; }
    if (j2.splits && JSON.stringify(j2.splits) !== JSON.stringify(WK)) { WK = j2.splits; WKERR = j2.errors || {}; wkDirty = true; }
    if (wkDirty) renderWorkout();
  } catch (e) {}
}
// A tiny version string changes only when the server has new data, so an open
// page can check every 5s without refetching the whole payload.
/* Owner 8/17 perf: the page ships the data version it was built with, so the
   first 5s check is one tiny /v call instead of a full data.json +
   workout.json double fetch on every load. */
let VER = window.__D.ver || '';
let lastFull = Date.now();
async function checkVer() {
  if (document.hidden) return;
  try {
    const r = await gateFetch('/v');
    if (!r.ok) return;
    const t = (await r.text()).trim();
    if (t && t !== VER) { VER = t; lastFull = Date.now(); await poll(); return; }
  } catch (e) {}
  // Floor: if a webhook delivery is ever dropped, nothing bumps the version, so
  // force a full read every 5 minutes anyway.
  if (Date.now() - lastFull > 60000) { lastFull = Date.now(); await poll(); }
}
setInterval(checkVer, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVer(); });
checkVer();

/* ---- goals editor, in page ---- */
const gpanel = document.getElementById('gpanel');
function buildGoalRows() {
  document.getElementById('grows').innerHTML = GOAL_FIELDS.map(f =>
    '<div class="grow"><label for="g_' + f[0] + '">' + f[1] + '<span class="u">' + f[2] + '</span></label>' +
    '<input id="g_' + f[0] + '" type="number" step="any" min="0" value="' + (GOALS[f[0]] == null ? '' : GOALS[f[0]]) + '"></div>'
  ).join('');
}
function openGoals() { buildGoalRows(); document.getElementById('gmsg').hidden = true; gpanel.classList.remove('hiding'); gpanel.hidden = false; requestAnimationFrame(() => requestAnimationFrame(() => gpanel.classList.add('show'))); }
function closeGoals() { gpanel.classList.add('hiding'); gpanel.classList.remove('show'); setTimeout(() => { gpanel.hidden = true; }, 160); }
document.getElementById('goalslink').addEventListener('click', e => { e.preventDefault(); openGoals(); });
gpanel.addEventListener('click', e => { if (e.target === gpanel) { saveGoals(); closeGoals(); } });
async function saveGoals() {
  const body = new URLSearchParams();
  const next = {};
  for (const f of GOAL_FIELDS) {
    const el = document.getElementById('g_' + f[0]);
    const v = (el.value || '').trim();
    if (v === '') continue;
    const n = Number(v);
    if (!isFinite(n) || n <= 0) continue;
    body.set(f[0], String(n));
    next[f[0]] = n;
  }
  // Redraw straight away; the save is confirmed underneath it.
  for (const k in next) {
    GOALS[k] = next[k];
    const m = MACROS.find(x => x.key === k);
    if (m) m.goal = next[k];
  }
  render(currentW);
  const msg = document.getElementById('gmsg');
  msg.textContent = 'Saving\u2026'; msg.hidden = false;
  try {
    const r = await gateFetch('/goals', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    msg.textContent = r.ok ? 'Saved' : 'Save failed - still saved on this screen only';
  } catch (e) {
    msg.textContent = 'Save failed - still saved on this screen only';
  }
  setTimeout(() => { msg.hidden = true; }, 1800);
}

window.addEventListener('resize', () => {
  if (chart) chart.resize();
  if (wchart) wchart.resize();
});
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => { SVGCharts.clearMeasureCache(); if (chart) chart.resize(true); if (wchart) wchart.resize(); if (wkSvg) wkSvg.sync(); });
}

`;
function appVer() {
  let h = 5381;
  for (let i = 0; i < APP_JS.length; i++) h = ((h << 5) + h + APP_JS.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
const APP_VER = appVer();

function chartPage(rows, meta, wk, token, ek, goals, items) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>cbum chart</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preconnect" href="https://app.notion.com"><link rel="dns-prefetch" href="https://app.notion.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="preload" as="style" onload="this.onload=null;this.rel='stylesheet'"><noscript><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet"></noscript>

<style>${CSS}</style></head>
<body>
<div class="card">
  <div class="head">
    <span class="title">Macros</span>
    <span class="seg" id="mgrp">
      <button data-g="core">Core</button><button data-g="detail">Detail</button><button data-g="all">All</button>
    </span>
    <span class="seg" id="mmode">
      <button data-m="raw">Raw</button><button data-ms="opaque">Opaque</button><button data-ms="transparent">Clear</button>
    </span>
    <span class="seg" id="mseg">
      <button data-w="3">3 day</button><button data-w="7">7 day</button><button data-w="0">All time</button><button data-avg="1">Average</button>
    </span>
  </div>
  <div class="legend" id="mlegend"></div>
  <div class="wrap"><div id="c" class="svghost"></div></div>
  <div class="foot" style="margin-top:8px"><a id="goalslink" href="/goals">Edit macro goals</a></div>
</div>

<div class="card">
  <div class="head">
    <span class="title">Workout</span>
    <span class="seg" id="wsplit">
      <a data-s="Push">Push</a><a data-s="Pull">Pull</a><a data-s="Legs">Legs</a><a data-s="All">All</a>
    </span>
    <span class="seg" id="wfill">
      <button data-f="opaque">Opaque</button><button data-f="line">Line</button>
    </span>
    <span class="seg" id="wseg">
      <button data-w="30">Month</button><button data-w="90">90 day</button><button data-w="0">All time</button><button data-w="custom">Custom</button>
    </span>
  </div>
  <div class="row2" id="wrow2">
    <span class="cust" id="wcust">
      <input id="wcnum" type="number" min="1" step="1" value="7">
      <select id="wcunit">
        <option value="1" selected>day</option>
        <option value="30">month</option>
        <option value="365">year</option>
      </select>
    </span>
  </div>
  <div class="legend" id="wlegend"></div>
  <div class="wrap"><div class="wksvg" id="w" style="position:absolute;inset:0;"></div><div class="empty" id="wempty" style="display:none"></div></div>
</div>
<div class="gpanel" id="gpanel" hidden>
  <div class="card goals">
    <div class="head"><span class="title">Macro goals</span></div>
    <div id="grows"></div>
      <div class="ok" id="gmsg" hidden></div>
  </div>
</div>
<script>
function chartFail(msg) {
  document.querySelectorAll('.wrap').forEach(w => {
    if (w.querySelector('.err')) return;
    const d = document.createElement('div');
    d.className = 'empty err';
    d.textContent = msg;
    w.appendChild(d);
  });
}
window.addEventListener('error', e => chartFail('Chart failed to load on this device: ' + (e && e.message ? e.message : 'unknown error')));

<\/script>
<script>
window.__D = ${JSON.stringify({ gateToken: token || "", embedK: ek || "", ver: MEM.rowsSig || MEM.wkSig ? version() : "", rows, dayPages: DAY_PAGES, meta, wkSplits: wk && wk.splits ? wk.splits : {}, wkErrors: wk && wk.errors ? wk.errors : {}, wkOrder: wk && wk.order ? wk.order : {}, items: items || {}, calTarget: CAL_TARGET, proTarget: PRO_TARGET, goals: goals || {}, goalFields: GOAL_FIELDS })};
<\/script>
<script src="/app.js?v=${APP_VER}"><\/script>
</body></html>`;
}

function loginPage(err) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>cbum chart</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="preload" as="style" onload="this.onload=null;this.rel='stylesheet'"><noscript><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet"></noscript>
<style>${CSS}
  body { display:flex; align-items:center; justify-content:center; }
  form { width:min(300px, 100%); text-align:left; }
  label { display:block; font-size:12px; color:#797979; margin-bottom:6px; }
  input { width:100%; font:inherit; font-size:14px; padding:9px 11px; border:1px solid #e4e4e4; border-radius:6px; background:#fff; color:#1a1a1a; }
  input:focus { outline:none; border-color:#3E7C4F; }
  button { margin-top:10px; width:100%; font:inherit; font-size:13px; font-weight:600; padding:9px 12px; border:0; border-radius:6px;
           background:#3E7C4F; color:#fff; cursor:pointer; }
  .h { font-size:15px; font-weight:600; margin-bottom:10px; }
  .bad { font-size:12px; color:#b3261e; margin-top:8px; }
  .hint { font-size:12px; color:#797979; margin-top:12px; line-height:1.45; }
  .hint a { display:inline-block; margin-top:6px; color:#3E7C4F; }
</style></head>
<body>
<form method="POST" action="/">
  <div class="h">cbum chart</div>
  <label for="p">Password</label>
  <input id="p" name="password" type="password" inputmode="numeric" pattern="[0-9]*"
         autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus>
  <button type="submit">Unlock</button>
  ${err ? '<div class="bad">' + err + '</div>' : ''}
  <div class="hint" id="framed" style="display:none">
    This is embedded in another page. Tap <b>Open in browser</b> below if it keeps asking for the password.
    <a id="pop" href="/" target="_blank" rel="noopener">Open in browser</a>
  </div>
</form>
<script>
(async function () {
  var t = null;
  try { t = localStorage.getItem('cbum_gate_token'); } catch (e) {}
  if (!t) return;
  try {
    var r = await fetch('/', { headers: { 'X-Gate': t }, credentials: 'same-origin' });
    if (!r.ok) { try { localStorage.removeItem('cbum_gate_token'); } catch (e) {} return; }
    var html = await r.text();
    if (html.indexOf('id="c"') < 0) return;
    document.open(); document.write(html); document.close();
  } catch (e) {}
})();
if (window.top !== window.self) {
  document.getElementById('framed').style.display = 'block';
  if (document.requestStorageAccess) {
    document.getElementById('p').addEventListener('focus', () => {
      document.requestStorageAccess().catch(() => {});
    }, { once: true });
  }
}
<\/script>
</body></html>`;
}

const htmlHeaders = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };

const jsonHeaders = { "content-type": "application/json", "cache-control": "no-store" };

export default {
  async fetch(req, env, ctx) {
    hydrateIds(env);
    const url = new URL(req.url);

    if (url.pathname === "/notion-webhook" && req.method === "POST") {
      const bodyText = await req.text();
      let body = {};
      try { body = JSON.parse(bodyText); } catch (e) {}
      if (body.verification_token) {
        await env.CHART_KV.put(VERIF_KEY, body.verification_token);
        return new Response("ok", { status: 200 });
      }
      const secret = await env.CHART_KV.get(VERIF_KEY);
      const sigHeader = req.headers.get("X-Notion-Signature") || "";
      if (secret) {
        const expected = "sha256=" + (await hmacHex(secret, bodyText));
        if (!safeEqual(sigHeader, expected)) return new Response("bad signature", { status: 401 });
      }
      ctx.waitUntil((async () => {
        await env.CHART_KV.put(EVENT_KEY, JSON.stringify({ at: new Date().toISOString(), type: body.type || "unknown" }));
        try { await freshRows(env); } catch (e) {}
        try {
          // A webhook must actually re-read Notion, not take the cached copy.
          MEM.wkAt = 0;
          await refreshWorkout(env);
          if (LAST_PENDING.length) await writeWeights(env, LAST_PENDING, 30);
        } catch (e) {}
        try { await edgePagePurge(url.origin, env); } catch (e) {}
      })());
      return new Response("ok", { status: 200 });
    }

    /* Embed regression 8/17: the KV page cache can outlive a deploy, so a slow
       embed can hold old HTML pointing at ?v=<old hash> while this worker
       serves the NEW JS for any v - a mismatched HTML/JS pair, immutable-cached
       under the old hash forever (reference errors; Notion shows "tap to load
       embed"). Content-address properly: any ?v that is not THIS version's hash
       gets a non-cached 302 to the correct URL, so a pair never mixes. */
    const strictJs = (js, ver) => {
      const v = url.searchParams.get("v");
      if (v && v !== ver) {
        return new Response(null, { status: 302, headers: { location: url.pathname + "?v=" + ver, "cache-control": "no-store" } });
      }
      return new Response(js, {
        headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" },
      });
    };
    if (url.pathname === "/app.js") {
      return strictJs(APP_JS, APP_VER);
    }

    if (url.pathname === "/chart.js") {
      let js = await env.CHART_KV.get(CHARTJS_KEY);
      if (!js) {
        const r = await fetch(CHARTJS_CDN);
        if (!r.ok) return new Response("// chart lib unavailable", { status: 502, headers: { "content-type": "application/javascript" } });
        js = await r.text();
        await env.CHART_KV.put(CHARTJS_KEY, js);
      }
      return new Response(js, {
        headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" },
      });
    }


    // Owner 8/17 perf: browsers fetch /favicon.ico on every page view; without
    // this route it burned a full gated page render (133KB) as the answer.
    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204, headers: { "cache-control": "public, max-age=86400" } });
    }

    if (!env.GATE_PASSWORD) {
      return new Response("gate password not configured", { status: 503, headers: { "cache-control": "no-store" } });
    }

    if (req.method === "POST" && url.pathname === "/") {
      const form = await req.formData();
      const given = String(form.get("password") || "").trim();
      if (safeEqual(given, env.GATE_PASSWORD)) {
        // Render the chart on the POST response itself. A 303 hop is one more
        // place a phone browser can drop the cookie before the page loads.
        try {
          // Health lives on its own page and its own embed; not read here.
          return new Response(await buildChartPage(env, ctx, ""), {
            headers: withCookies(htmlHeaders, await deviceCookies(env)),
          });
        } catch (e) {
          return new Response(loginPage("Chart failed to load: " + String(e)), { status: 502, headers: htmlHeaders });
        }
      }
      return new Response(loginPage("Wrong password."), { status: 401, headers: htmlHeaders });
    }

    if (url.pathname === "/logout") {
      return new Response(loginPage("Signed out on this device."), {
        headers: withCookies(htmlHeaders, [
          `${COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Lax`,
          `${COOKIE_P}=; Path=/; Max-Age=0; Secure; SameSite=None; Partitioned`,
        ]),
      });
    }

    const kParam = url.searchParams.get("k");
    /* Owner 8/17 perf: on a cold isolate the token read and the page-snapshot
       read used to serialize (~2 KV round trips before first byte). Start the
       snapshot read speculatively - it is only served after auth passes. */
    const pageSnapP = (kParam && !MEM.page) ? env.CHART_KV.get(PAGE_KEY).catch(() => null) : null;
    const ekLive = kParam && safeEqual(kParam, await embedToken(env)) ? kParam : "";
    const ok = await authed(req, env, url);
    if (!ok) return new Response(loginPage(""), { status: 401, headers: htmlHeaders });

    // Owner 8/17 perf: edge-cached embed pages. Hit = serve instantly + refresh
    // behind; miss = build, store a 60s cacheable copy, serve the normal
    // no-store response. Skipped for the "_" verification bypass.
    if (ekLive && req.method === "GET" && (url.pathname === "/") && !url.searchParams.has("_")) {
      const ck = edgePageKey(url.origin, url.pathname, kParam);
      const hit = await caches.default.match(ck);
      if (hit) {
        bg(ctx, "edge-revalidate", async () => {
          try {
            const html = await getPageHtml(env, ctx, ekLive);
            await caches.default.put(ck, new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } }));
          } catch (e) {}
        });
        return hit;
      }
      const html = await getPageHtml(env, ctx, ekLive, pageSnapP);
      ctx.waitUntil(caches.default.put(ck, new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } })).catch(() => {}));
      return new Response(html, {
        headers: withCookies(Object.assign({}, htmlHeaders, { "cache-control": "no-store, no-cache, must-revalidate" }), await deviceCookies(env)),
      });
    }


    if (url.pathname === "/goals") {
      if (req.method === "POST") {
        const form = await req.formData();
        const cur = await getGoals(env);
        const next = Object.assign({}, cur);
        for (const [key] of GOAL_FIELDS) {
          const raw = form.get(key);
          if (raw === null || String(raw).trim() === "") continue;
          const n = Number(raw);
          if (!isFinite(n) || n <= 0) continue;
          next[key] = n;
        }
        await saveGoals(env, next);
        await bumpVer(env);
        return new Response(goalsPage(next, ekLive, true), { headers: htmlHeaders });
      }
      return new Response(goalsPage(await getGoals(env), ekLive, false), { headers: htmlHeaders });
    }

    if (url.pathname === "/v") {
      const cache = caches.default;
      const hit = await cache.match(req);
      if (hit) return hit;
      // Served from isolate memory in the common case, so a 5s poll costs no KV.
      const body = (MEM.rowsSig || MEM.wkSig) ? version() : ((await env.CHART_KV.get(VER_KEY)) || "0");
      const vr = new Response(body, { headers: { "content-type": "text/plain", "cache-control": "public, max-age=5" } });
      ctx.waitUntil(cache.put(req, vr.clone()));
      return vr;
    }

    if (url.pathname === "/reconcile") {
      MEM.wkAt = 0;
      const fresh = await notionWorkout(env);
      const pending = fresh.pending || [];
      const written = await writeWeights(env, pending, 30);
      MEM.wk = null; MEM.wkAt = 0;
      return new Response(JSON.stringify({ pending: pending.length, written, sample: pending.slice(0, 5) }), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/data.json") {
      try {
        const { rows, source } = await getRows(env, ctx);
        const items = await getItems(env, ctx).catch(() => null);
        return new Response(JSON.stringify({ rows, source, items }), {
          headers: withCookies({ "content-type": "application/json", "cache-control": "no-store" }, await deviceCookies(env)),
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: { "content-type": "application/json" } });
      }
    }

    if (url.pathname === "/workout/edit" && req.method === "POST") {
      try {
        const body = await req.json();
        const out = await updateWorkoutCell(env, ctx, String(body.split || ""), String(body.id || ""), String(body.exercise || ""), body.text);
        return new Response(JSON.stringify(out), { status: out.ok ? 200 : 400, headers: jsonHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }), { status: 400, headers: jsonHeaders });
      }
    }

    if (url.pathname === "/workout.json") {
      try {
        const w = await getWorkout(env, ctx);
        return new Response(JSON.stringify(w), {
          headers: withCookies({ "content-type": "application/json", "cache-control": "no-store" }, await deviceCookies(env)),
        });
      } catch (e) {
        return new Response(JSON.stringify({ splits: {}, errors: { all: String(e) } }), { status: 502, headers: { "content-type": "application/json" } });
      }
    }

    if (url.pathname === "/status") {
      const [ev, verif] = await Promise.all([env.CHART_KV.get(EVENT_KEY), env.CHART_KV.get(VERIF_KEY)]);
      return new Response(JSON.stringify({ last_event: ev ? JSON.parse(ev) : null, webhook_verified: !!verif }), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    try {
      // Serve the last fully-rendered page snapshot (KV/memory) the moment it is
      // available; getPageHtml refreshes it in the background when stale. Only
      // the embed-token variant is cached - the cookie-session variant embeds
      // the gate token in the page and is built per request as before.
      const html = await getPageHtml(env, ctx, ekLive, pageSnapP);
      return new Response(html, {
        // Scoped to the main dashboard page only: htmlHeaders already carries
        // no-store, but iOS Safari / the Notion webview kept serving the
        // pre-deploy build, so this response also forbids reuse of a cached
        // copy without revalidation. Other pages sharing htmlHeaders (login,
        // goals) keep the shared object untouched.
        headers: withCookies(Object.assign({}, htmlHeaders, { "cache-control": "no-store, no-cache, must-revalidate" }), await deviceCookies(env)),
      });
    } catch (e) {
      return new Response(`<!doctype html><body style="font:14px Inter,sans-serif"><p class="err">chart error: ${String(e)}</p>`, {
        status: 502, headers: htmlHeaders,
      });
    }
  },
};

