// Company Finder — find local businesses by type + city with websites.
// Sources: Google Places API (New) Text Search (free monthly allowance, hard daily cap)
//          + OpenStreetMap (Nominatim geocoding + Overpass), free.
// No dependencies: Node 18+ (built-in fetch).
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = process.env.PORT || 3000;
const GOOGLE_KEY = (process.env.GOOGLE_PLACES_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_KEY || "").trim();
const ACCESS_CODE = (process.env.ACCESS_CODE || "").trim();
const DAILY_GOOGLE_CAP = parseInt(process.env.DAILY_GOOGLE_CAP || "33", 10); // ~1,000/month = Google's free Enterprise allowance
const TZ = process.env.CAP_TIMEZONE || "America/Chicago";
const GOOGLE_URL = process.env.GOOGLE_URL || "https://places.googleapis.com/v1/places:searchText";
const NOMINATIM_URL = process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org/search";
const OVERPASS_URLS = (process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.private.coffee/api/interpreter").split(",");
const UA = "CompanyFinder/1.0 (team prospecting tool)";
const PUBLIC = path.join(__dirname, "public");

// ---------- daily cap (in memory; resets at midnight in TZ) ----------
const usage = { day: "", google: 0 };
function today() { return new Date().toLocaleDateString("en-CA", { timeZone: TZ }); }
function capLeft() {
  const d = today();
  if (usage.day !== d) { usage.day = d; usage.google = 0; }
  return Math.max(0, DAILY_GOOGLE_CAP - usage.google);
}

// ---------- cache (7 days) so repeat searches cost nothing ----------
const cache = new Map();
const CACHE_MS = 7 * 24 * 3600 * 1000;

// ---------- helpers ----------
const STATES = {AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",DC:"District of Columbia",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming"};

// OpenStreetMap tags for common trades (falls back to a name match for anything else)
const OSM_TAGS = {
  roof: ['craft="roofer"'], plumb: ['craft="plumber"'], electric: ['craft="electrician"'],
  hvac: ['craft="hvac"'], "heating": ['craft="hvac"'], "air condition": ['craft="hvac"'],
  paint: ['craft="painter"'], carpent: ['craft="carpenter"'], landscap: ['craft="gardener"','shop="garden_centre"'],
  "pest": ['office="pest_control"','shop="pest_control"'], insur: ['office="insurance"'],
  "real estate": ['office="estate_agent"'], realtor: ['office="estate_agent"'], account: ['office="accountant"'],
  law: ['office="lawyer"'], attorney: ['office="lawyer"'], dentist: ['amenity="dentist"'], dental: ['amenity="dentist"'],
  "auto repair": ['shop="car_repair"'], mechanic: ['shop="car_repair"'], "security": ['office="security"','craft="security"'],
  floor: ['shop="flooring"','craft="floorer"'], window: ['craft="window_construction"'], solar: ['craft="solar_installer"'],
  "pool": ['shop="swimming_pool"'], clean: ['office="cleaning"','shop="cleaning"'], "construction": ['office="construction_company"','craft="builder"'],
  contractor: ['office="construction_company"','craft="builder"'], fenc: ['craft="fence_maker"'], glass: ['craft="glaziery"'],
};
function osmTagsFor(type) {
  const t = type.toLowerCase(); const out = new Set();
  for (const k of Object.keys(OSM_TAGS)) if (t.includes(k)) OSM_TAGS[k].forEach(x => out.add(x));
  return [...out];
}

const LEADGEN_HOSTS = /(ueniweb\.com|square\.site|wixsite\.com|business\.site|godaddysites\.com|weebly\.com|\.homes$|yelp\.com|facebook\.com|homeadvisor\.com|angi\.com|thumbtack\.com|nextdoor\.com|linktr\.ee|sites\.google\.com|instagram\.com|bbb\.org|houzz\.com)/i;
function cleanUrl(u) {
  if (!u) return "";
  try { const x = new URL(u.startsWith("http") ? u : "https://" + u); x.search = ""; x.hash = "";
    let s = x.toString(); return s.endsWith("/") ? s.slice(0, -1) : s; } catch { return ""; }
}
function host(u) { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } }
function normName(n) { return (n || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").replace(/\b(inc|llc|co|corp|company|the)\b/g, "").replace(/\s+/g, " ").trim(); }

// Generic "<City> <Type> Pros"-style names are usually lead-generation pages, not real local firms.
function looksLeadGen(name, url, city) {
  const n = (name || "").toLowerCase(), c = (city || "").toLowerCase();
  if (url && LEADGEN_HOSTS.test(host(url))) return true;
  if (/\b(pros|experts near me|near me|best .* in|top rated)\b/.test(n) && c && n.includes(c)) return true;
  return false;
}

function tierFor(reviews) {
  if (reviews >= 100) return "Strong";
  if (reviews >= 30) return "Likely";
  return "Verify";
}

async function fetchJSON(url, opts = {}, ms = 25000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const txt = await r.text();
    let data; try { data = JSON.parse(txt); } catch { data = null; }
    if (!r.ok) {
      const ge = data && data.error;
      const reason = ge && Array.isArray(ge.details) ? ge.details.map(d => d.reason).filter(Boolean).join(", ") : "";
      const e = new Error(((ge && ge.message) || `HTTP ${r.status}`) + (reason ? ` [${reason}]` : ""));
      e.status = r.status; if (ge) console.error("upstream error", r.status, JSON.stringify(ge).slice(0, 800)); throw e;
    }
    return data;
  } finally { clearTimeout(t); }
}

// ---------- sources ----------
const GEO_URL = process.env.GEO_URL || "https://geocoding-api.open-meteo.com/v1/search";
async function geocode(city, st) {
  const stateName = (STATES[st] || st).toLowerCase();
  // 1) Open-Meteo geocoding (free, no key, works from cloud servers)
  try {
    const q = new URLSearchParams({ name: city, count: "20", country_code: "US", format: "json", language: "en" });
    const d = await fetchJSON(`${GEO_URL}?${q}`, {}, 10000);
    const hits = ((d && d.results) || []).filter(r => (r.admin1 || "").toLowerCase() === stateName);
    hits.sort((a, b) => (b.population || 0) - (a.population || 0));
    if (hits.length) return { lat: hits[0].latitude, lon: hits[0].longitude };
  } catch (e) { console.error("open-meteo geocode:", e.message); }
  // 2) Nominatim fallback (often rate-limits shared cloud IPs)
  try {
    const q = new URLSearchParams({ city, state: STATES[st] || st, country: "United States", format: "json", limit: "1" });
    const d = await fetchJSON(`${NOMINATIM_URL}?${q}`, { headers: { "User-Agent": UA, "Accept-Language": "en" } }, 10000);
    if (Array.isArray(d) && d.length) return { lat: parseFloat(d[0].lat), lon: parseFloat(d[0].lon) };
  } catch (e) { console.error("nominatim geocode:", e.message); }
  return null;
}

async function googleSearch({ type, city, st, target, center, log }) {
  if (!GOOGLE_KEY) { log.push("Google: not configured (no API key) — showing OpenStreetMap only."); return { rows: [], used: 0 }; }
  const queries = [
    `${type} in ${city}, ${st}`,
    `${type} company near ${city}, ${st}`,
    `${type} contractor ${city} ${st}`,
    `commercial ${type} ${city} ${st}`,
    `residential ${type} ${city} ${st}`,
    `${type} services ${city} ${STATES[st] || st}`,
  ];
  const maxReq = target >= 100 ? 12 : 6;
  const fieldMask = "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.businessStatus,places.primaryTypeDisplayName,nextPageToken";
  const seen = new Map(); let used = 0;
  outer:
  for (const textQuery of queries) {
    let pageToken;
    for (let page = 0; page < 3; page++) {
      if (used >= maxReq || seen.size >= Math.ceil(target * 1.35)) break outer;
      if (capLeft() <= 0) { log.push("Google: daily limit reached — remaining results come from OpenStreetMap."); break outer; }
      const body = { textQuery, pageSize: 20, regionCode: "US" };
      if (center) body.locationBias = { circle: { center: { latitude: center.lat, longitude: center.lon }, radius: 40000 } };
      if (pageToken) body.pageToken = pageToken;
      usage.google++; used++;
      let d;
      try {
        d = await fetchJSON(GOOGLE_URL, { method: "POST", headers: { "Content-Type": "application/json", "X-Goog-Api-Key": GOOGLE_KEY, "X-Goog-FieldMask": fieldMask }, body: JSON.stringify(body) });
      } catch (e) {
        log.push(`Google: ${e.status === 429 ? "Google's quota is used up for today" : "request failed (" + e.message + ")"}.`);
        break outer;
      }
      for (const p of (d && d.places) || []) {
        if (!seen.has(p.id)) seen.set(p.id, p);
      }
      pageToken = d && d.nextPageToken;
      if (!pageToken) break;
    }
  }
  const rows = [...seen.values()].map(p => ({
    name: (p.displayName && p.displayName.text) || "",
    website: cleanUrl(p.websiteUri),
    phone: p.nationalPhoneNumber || "",
    address: p.formattedAddress || "",
    rating: p.rating || null,
    reviews: p.userRatingCount || 0,
    category: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || "",
    status: p.businessStatus || "",
    source: "Google",
  }));
  log.push(`Google: ${rows.length} businesses from ${used} request${used === 1 ? "" : "s"}.`);
  return { rows, used };
}

async function osmSearch({ type, center, log }) {
  if (!center) { log.push("OpenStreetMap: couldn't locate the city."); return []; }
  const tags = osmTagsFor(type);
  const words = type.toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(w => w.length > 3);
  const stem = (words[0] || type).replace(/(ing|ers|er|s)$/, "");
  const around = `(around:30000,${center.lat},${center.lon})`;
  const parts = [];
  for (const t of tags) parts.push(`nwr[${t}]${around};`);
  if (stem.length >= 3) parts.push(`nwr["name"~"${stem.replace(/"/g, "")}",i]["website"]${around};`, `nwr["name"~"${stem.replace(/"/g, "")}",i]["contact:website"]${around};`);
  const q = `[out:json][timeout:25];(${parts.join("")});out center tags 300;`;
  let d = null;
  for (const u of OVERPASS_URLS) {
    try {
      d = await fetchJSON(u.trim(), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA }, body: "data=" + encodeURIComponent(q) }, 25000);
      if (d && d.elements) break;
    } catch (e) { console.error("overpass", u, e.message); d = null; }
  }
  if (!d) { log.push("OpenStreetMap: unavailable right now."); return []; }
  const rows = ((d && d.elements) || []).filter(e => e.tags && e.tags.name).map(e => {
    const t = e.tags;
    const addr = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
    const cityPart = [t["addr:city"], t["addr:state"]].filter(Boolean).join(", ");
    return {
      name: t.name, website: cleanUrl(t.website || t["contact:website"] || t.url || ""),
      phone: t.phone || t["contact:phone"] || "", address: [addr, cityPart].filter(Boolean).join(", "),
      rating: null, reviews: 0, category: t.craft || t.office || t.shop || "", status: "OPERATIONAL", source: "OpenStreetMap",
    };
  });
  log.push(`OpenStreetMap: ${rows.length} businesses.`);
  return rows;
}

// ---------- search ----------
async function search({ type, city, st, target, requireWebsite }) {
  const key = [type, city, st, target, requireWebsite].join("|").toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.result, cached: true };

  const log = [];
  let center = null;
  try { center = await geocode(city, st); } catch {}
  if (!center) log.push("Couldn't look up the city's location; Google searched by name only.");
  const [g, osm] = await Promise.all([googleSearch({ type, city, st, target, center, log }), osmSearch({ type, center, log })]);

  // merge + dedupe (by website domain, then by name)
  const byKey = new Map(); let excluded = 0;
  const stTest = new RegExp(`,\\s*${st}\\b|\\b${(STATES[st] || st).replace(/ /g, "\\s")}\\b`, "i");
  for (const r of [...g.rows, ...osm]) {
    if (r.status && r.status !== "OPERATIONAL") { excluded++; continue; }
    if (r.address && r.source === "Google" && !stTest.test(r.address)) { excluded++; continue; }
    if (looksLeadGen(r.name, r.website, city)) { excluded++; continue; }
    if (requireWebsite && !r.website) { excluded++; continue; }
    const k = host(r.website) || normName(r.name);
    if (!k) continue;
    const prev = byKey.get(k) || byKey.get(normName(r.name));
    if (prev) { // keep Google's richer record, fill gaps from OSM
      for (const f of ["website", "phone", "address"]) if (!prev[f] && r[f]) prev[f] = r[f];
      if (r.reviews > prev.reviews) { prev.reviews = r.reviews; prev.rating = r.rating; }
      if (!prev.source.includes(r.source)) prev.source += " + " + r.source;
      continue;
    }
    const row = { ...r };
    byKey.set(k, row); byKey.set(normName(r.name), row);
  }
  const uniq = [...new Set(byKey.values())];
  uniq.forEach(r => { r.tier = tierFor(r.reviews); });
  uniq.sort((a, b) => (b.reviews - a.reviews) || a.name.localeCompare(b.name));
  const rows = uniq.slice(0, target);

  const result = { rows, log, excluded, googleRequests: g.used, capLeft: capLeft(), generatedAt: new Date().toISOString() };
  if (rows.length) cache.set(key, { at: Date.now(), result });
  return result;
}

// ---------- http ----------
function send(res, code, obj, headers = {}) {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": typeof obj === "string" ? "text/plain; charset=utf-8" : "application/json", "Cache-Control": "no-store", ...headers });
  res.end(body);
}
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) return send(res, 403, "Forbidden");
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, "Not found");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ""; req.on("data", c => { b += c; if (b.length > 1e5) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { reject(new Error("bad json")); } });
  });
}
function authed(req) {
  if (!ACCESS_CODE) return true;
  return (req.headers["x-access-code"] || "").trim() === ACCESS_CODE;
}

let busy = 0;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/status") {
    // Diagnostics: names only (never values) of settings that look like the Google key
    const googleSettingNames = Object.keys(process.env).filter(k => /goog|places|api.?key/i.test(k));
    return send(res, 200, { capLeft: capLeft(), dailyCap: DAILY_GOOGLE_CAP, googleConfigured: !!GOOGLE_KEY, googleKeyLooksValid: /^AIza[0-9A-Za-z_-]{35}$/.test(GOOGLE_KEY), googleSettingNames, accessCodeSet: !!ACCESS_CODE, needsCode: !!ACCESS_CODE, codeOk: authed(req) });
  }
  if (url.pathname === "/api/search" && req.method === "POST") {
    if (!authed(req)) return send(res, 401, { error: "Wrong or missing team access code." });
    let b; try { b = await readBody(req); } catch { return send(res, 400, { error: "Bad request." }); }
    const type = String(b.type || "").trim().slice(0, 60);
    const city = String(b.city || "").trim().slice(0, 60);
    const st = String(b.state || "").trim().toUpperCase();
    const target = [25, 50, 75, 100].includes(+b.count) ? +b.count : 50;
    const requireWebsite = b.requireWebsite !== false;
    if (!type || !city || !STATES[st]) return send(res, 400, { error: "Enter a business type, a city and a state." });
    if (busy >= 3) return send(res, 429, { error: "A few searches are already running — try again in a minute." });
    busy++;
    try { return send(res, 200, await search({ type, city, st, target, requireWebsite })); }
    catch (e) { console.error(e); return send(res, 500, { error: "Search failed. Please try again." }); }
    finally { busy--; }
  }
  if (req.method === "GET") return serveStatic(req, res);
  send(res, 405, "Method not allowed");
});
if (require.main === module) server.listen(PORT, () => console.log(`Company Finder on :${PORT} (Google ${GOOGLE_KEY ? "on" : "off"}, cap ${DAILY_GOOGLE_CAP}/day)`));
module.exports = { server, _internal: { looksLeadGen, tierFor, osmTagsFor, cleanUrl, usage } };
