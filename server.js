// Company Finder — find local businesses by type + city, with websites and phones.
// Free sources, all optional (each turns on when its key is set in Render):
//   Google Places API (New)  GOOGLE_PLACES_KEY  1,000 free/month (hard daily cap)  — reviews/ratings drive the size rating
//   HERE Discover            HERE_API_KEY       5,000 free/month                    — up to 100 results per request
//   TomTom POI Search        TOMTOM_API_KEY     2,500 free/month, no card           — up to 100 results per request
//   Geoapify Places          GEOAPIFY_API_KEY   3,000 free/day, no card             — reliable OpenStreetMap data (websites/phones)
//   OpenStreetMap (Overpass) no key             free, best effort
// City lookup: Open-Meteo geocoding (free, no key), Nominatim fallback.
// No dependencies: Node 18+ (built-in fetch).
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const env = (...names) => { for (const n of names) if (process.env[n]) return String(process.env[n]).trim(); return ""; };
const PORT = process.env.PORT || 3000;
const KEYS = {
  google: env("GOOGLE_PLACES_KEY", "GOOGLE_API_KEY", "GOOGLE_PLACES_API_KEY", "GOOGLE_KEY"),
  here: env("HERE_API_KEY", "HERE_KEY"),
  tomtom: env("TOMTOM_API_KEY", "TOMTOM_KEY"),
  geoapify: env("GEOAPIFY_API_KEY", "GEOAPIFY_KEY"),
};
const ACCESS_CODE = env("ACCESS_CODE");
const CAPS = { // max requests per day per source (kept under each free monthly allowance)
  google: parseInt(env("DAILY_GOOGLE_CAP") || "33", 10),
  here: parseInt(env("DAILY_HERE_CAP") || "160", 10),
  tomtom: parseInt(env("DAILY_TOMTOM_CAP") || "80", 10),
  geoapify: parseInt(env("DAILY_GEOAPIFY_CAP") || "2500", 10),
};
const TZ = env("CAP_TIMEZONE") || "America/Chicago";
const URLS = {
  google: env("GOOGLE_URL") || "https://places.googleapis.com/v1/places:searchText",
  here: env("HERE_URL") || "https://discover.search.hereapi.com/v1/discover",
  tomtom: env("TOMTOM_URL") || "https://api.tomtom.com/search/2/poiSearch",
  geoapify: env("GEOAPIFY_URL") || "https://api.geoapify.com/v2/places",
  geo: env("GEO_URL") || "https://geocoding-api.open-meteo.com/v1/search",
  nominatim: env("NOMINATIM_URL") || "https://nominatim.openstreetmap.org/search",
  overpass: (env("OVERPASS_URL") || "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter").split(",").map(s => s.trim()),
};
const UA = "CompanyFinder/2.0 (team prospecting tool)";
const PUBLIC = path.join(__dirname, "public");
const RADIUS_M = 40000;

// ---------- daily caps (in memory; reset at midnight in TZ — set the matching limit in each provider's console too) ----------
const usage = { day: "", google: 0, here: 0, tomtom: 0, geoapify: 0 };
function rollDay() { const d = new Date().toLocaleDateString("en-CA", { timeZone: TZ }); if (usage.day !== d) Object.assign(usage, { day: d, google: 0, here: 0, tomtom: 0, geoapify: 0 }); }
function left(src) { rollDay(); return Math.max(0, CAPS[src] - usage[src]); }
function spend(src) { rollDay(); usage[src]++; }

// ---------- cache (7 days) so repeat searches cost nothing ----------
const cache = new Map();
const CACHE_MS = 7 * 24 * 3600 * 1000;

// ---------- reference data ----------
const STATES = {AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",DC:"District of Columbia",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming"};
const OSM_TAGS = {
  roof: ['craft="roofer"'], plumb: ['craft="plumber"'], electric: ['craft="electrician"'], hvac: ['craft="hvac"'], heating: ['craft="hvac"'],
  "air condition": ['craft="hvac"'], paint: ['craft="painter"'], carpent: ['craft="carpenter"'], landscap: ['craft="gardener"'],
  pest: ['office="pest_control"'], insur: ['office="insurance"'], "real estate": ['office="estate_agent"'], account: ['office="accountant"'],
  law: ['office="lawyer"'], attorney: ['office="lawyer"'], dentist: ['amenity="dentist"'], dental: ['amenity="dentist"'],
  "auto repair": ['shop="car_repair"'], mechanic: ['shop="car_repair"'], security: ['office="security"'], floor: ['craft="floorer"'],
  solar: ['craft="solar_installer"'], pool: ['shop="swimming_pool"'], clean: ['office="cleaning"'], construction: ['office="construction_company"', 'craft="builder"'],
  contractor: ['office="construction_company"', 'craft="builder"'], fenc: ['craft="fence_maker"'], glass: ['craft="glaziery"'],
};
const LEADGEN_HOSTS = /(ueniweb\.com|square\.site|wixsite\.com|business\.site|godaddysites\.com|weebly\.com|\.homes$|yelp\.com|facebook\.com|homeadvisor\.com|angi\.com|thumbtack\.com|nextdoor\.com|linktr\.ee|sites\.google\.com|instagram\.com|bbb\.org|houzz\.com|yellowpages\.com|mapquest\.com|porch\.com)/i;

// ---------- helpers ----------
function cleanUrl(u) {
  if (!u) return "";
  try { const x = new URL(/^https?:\/\//i.test(u) ? u : "https://" + u); x.search = ""; x.hash = ""; const s = x.toString(); return s.endsWith("/") ? s.slice(0, -1) : s; } catch { return ""; }
}
const host = u => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const normName = n => (n || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").replace(/\b(inc|llc|co|corp|corporation|company|the|ltd)\b/g, "").replace(/\s+/g, " ").trim();
const digits = p => (p || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
function fmtPhone(p) { const d = digits(p); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p || ""); }
function looksLeadGen(name, url, city) {
  const n = (name || "").toLowerCase(), c = (city || "").toLowerCase();
  if (url && LEADGEN_HOSTS.test(host(url))) return true;
  if (/\b(pros|experts near me|near me|top rated)\b/.test(n) && c && n.includes(c)) return true;
  return false;
}
const tierFor = r => r >= 100 ? "Strong" : r >= 30 ? "Likely" : "Verify";

async function fetchJSON(url, opts = {}, ms = 20000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const txt = await r.text();
    let data = null; try { data = JSON.parse(txt); } catch {}
    if (!r.ok) {
      const ge = data && (data.error || data);
      let msg = (ge && (ge.message || ge.title || ge.errorText || ge.detailedError?.message)) || `HTTP ${r.status}`;
      const reason = ge && Array.isArray(ge.details) ? ge.details.map(d => d.reason).filter(Boolean).join(", ") : "";
      if (reason) msg += ` [${reason}]`;
      const e = new Error(String(msg).slice(0, 300)); e.status = r.status; e.reason = reason;
      console.error("upstream", r.status, url.split("?")[0], String(msg).slice(0, 300));
      throw e;
    }
    return data;
  } catch (e) {
    if (e.name === "AbortError") { const x = new Error("timed out"); x.status = 0; throw x; }
    throw e;
  } finally { clearTimeout(t); }
}

// Turn a provider error into plain English for the page
function explain(src, e) {
  const m = (e && e.message) || "";
  if (e && e.status === 0) return "took too long to answer";
  if (src === "google") {
    if (/API_KEY_SERVICE_BLOCKED/.test(m)) return "the key isn't allowed to use Places API (New). In Google Cloud → Credentials → your key → API restrictions, select Places API (New)";
    if (/SERVICE_DISABLED|has not been used|is disabled/.test(m)) return "Places API (New) isn't turned on for the key's project. Enable it in Google Cloud (same project as the key)";
    if (/BILLING|billing/.test(m)) return "billing isn't set up on the Google Cloud project. Add a billing account (needed even for the free allowance)";
    if (/API_KEY_INVALID|API key not valid/.test(m)) return "the key is invalid. Copy it again from Google Cloud → Credentials";
    if (e.status === 429 || /RATE_LIMIT|quota/i.test(m)) return "Google's daily limit is used up — it resets tomorrow";
    if (e.status === 403) return "Google refused the key (permission). Check the key's API restriction is Places API (New) and the API is enabled in the same project; new keys can take ~5 minutes";
  }
  if (e && (e.status === 401 || e.status === 403)) return "the key was refused — check it in Render's Environment settings";
  if (e && e.status === 429) return "daily/monthly free limit reached";
  return m || "unavailable";
}

// ---------- city lookup ----------
async function geocode(city, st) {
  const stateName = (STATES[st] || st).toLowerCase();
  try {
    const q = new URLSearchParams({ name: city, count: "20", country_code: "US", format: "json", language: "en" });
    const d = await fetchJSON(`${URLS.geo}?${q}`, {}, 8000);
    const hits = ((d && d.results) || []).filter(r => (r.admin1 || "").toLowerCase() === stateName).sort((a, b) => (b.population || 0) - (a.population || 0));
    if (hits.length) return { lat: hits[0].latitude, lon: hits[0].longitude, via: "Open-Meteo" };
  } catch {}
  try {
    const q = new URLSearchParams({ city, state: STATES[st] || st, country: "United States", format: "json", limit: "1" });
    const d = await fetchJSON(`${URLS.nominatim}?${q}`, { headers: { "User-Agent": UA } }, 8000);
    if (Array.isArray(d) && d.length) return { lat: +d[0].lat, lon: +d[0].lon, via: "Nominatim" };
  } catch {}
  return null;
}

// ---------- sources: each returns { rows, requests, note, ok } ----------
async function srcGoogle({ type, city, st, target, center }) {
  if (!KEYS.google) return { ok: null, rows: [], requests: 0, note: "not set up" };
  const queries = [`${type} in ${city}, ${st}`, `${type} company near ${city}, ${st}`, `${type} contractor ${city} ${st}`,
    `commercial ${type} ${city} ${st}`, `residential ${type} ${city} ${st}`, `${type} services ${city} ${STATES[st]}`];
  const maxReq = target >= 100 ? 10 : target >= 50 ? 6 : 3;
  const mask = "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.businessStatus,places.primaryTypeDisplayName,nextPageToken";
  const seen = new Map(); let used = 0, err = null, capped = false;
  outer: for (const textQuery of queries) {
    let pageToken;
    for (let page = 0; page < 3; page++) {
      if (used >= maxReq || seen.size >= Math.ceil(target * 1.3)) break outer;
      if (left("google") <= 0) { capped = true; break outer; }
      const body = { textQuery, pageSize: 20, regionCode: "US" };
      if (center) body.locationBias = { circle: { center: { latitude: center.lat, longitude: center.lon }, radius: RADIUS_M } };
      if (pageToken) body.pageToken = pageToken;
      spend("google"); used++;
      let d;
      try { d = await fetchJSON(URLS.google, { method: "POST", headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEYS.google, "X-Goog-FieldMask": mask }, body: JSON.stringify(body) }); }
      catch (e) { err = e; break outer; }
      for (const p of (d && d.places) || []) if (!seen.has(p.id)) seen.set(p.id, p);
      pageToken = d && d.nextPageToken; if (!pageToken) break;
    }
  }
  const rows = [...seen.values()].map(p => ({
    name: p.displayName?.text || "", website: cleanUrl(p.websiteUri), phone: fmtPhone(p.nationalPhoneNumber), address: p.formattedAddress || "",
    rating: p.rating || null, reviews: p.userRatingCount || 0, category: p.primaryTypeDisplayName?.text || "", status: p.businessStatus || "OPERATIONAL", source: "Google",
  }));
  if (err && !rows.length) return { ok: false, rows, requests: used, note: explain("google", err) };
  return { ok: true, rows, requests: used, note: `${rows.length} found${capped ? " (daily limit reached)" : ""}${err ? " (stopped early: " + explain("google", err) + ")" : ""}` };
}

async function srcHere({ type, st, center }) {
  if (!KEYS.here) return { ok: null, rows: [], requests: 0, note: "not set up" };
  if (!center) return { ok: false, rows: [], requests: 0, note: "needs the city location" };
  const queries = [type, `${type} contractor`];
  const seen = new Map(); let used = 0, err = null;
  for (const q of queries) {
    if (left("here") <= 0) break;
    spend("here"); used++;
    try {
      const p = new URLSearchParams({ q, at: `${center.lat},${center.lon}`, limit: "100", in: "countryCode:USA", lang: "en-US", apiKey: KEYS.here });
      const d = await fetchJSON(`${URLS.here}?${p}`);
      for (const it of (d && d.items) || []) if (it.resultType === "place" || !it.resultType) seen.set(it.id || it.title, it);
    } catch (e) { err = e; break; }
  }
  const pick = (it, k) => { for (const c of it.contacts || []) for (const v of c[k] || []) if (v.value) return v.value; return ""; };
  const rows = [...seen.values()].filter(it => !it.address?.stateCode || it.address.stateCode === st).map(it => ({
    name: it.title || "", website: cleanUrl(pick(it, "www")), phone: fmtPhone(pick(it, "phone") || pick(it, "mobile")), address: it.address?.label?.replace(/, United States$/, "") || "",
    rating: null, reviews: 0, category: it.categories?.[0]?.name || "", status: "OPERATIONAL", source: "HERE",
  }));
  if (err && !rows.length) return { ok: false, rows, requests: used, note: explain("here", err) };
  return { ok: true, rows, requests: used, note: `${rows.length} found` };
}

async function srcTomTom({ type, st, center }) {
  if (!KEYS.tomtom) return { ok: null, rows: [], requests: 0, note: "not set up" };
  if (!center) return { ok: false, rows: [], requests: 0, note: "needs the city location" };
  if (left("tomtom") <= 0) return { ok: true, rows: [], requests: 0, note: "daily limit reached" };
  spend("tomtom");
  try {
    const p = new URLSearchParams({ key: KEYS.tomtom, lat: center.lat, lon: center.lon, radius: String(RADIUS_M), limit: "100", countrySet: "US", language: "en-US" });
    const d = await fetchJSON(`${URLS.tomtom}/${encodeURIComponent(type)}.json?${p}`);
    const rows = ((d && d.results) || []).filter(r => r.poi && (!r.address?.countrySubdivision || r.address.countrySubdivision === st || r.address.countrySubdivisionName === STATES[st]))
      .map(r => ({ name: r.poi.name || "", website: cleanUrl(r.poi.url), phone: fmtPhone(r.poi.phone), address: r.address?.freeformAddress || "",
        rating: null, reviews: 0, category: (r.poi.categories || [])[0] || "", status: "OPERATIONAL", source: "TomTom" }));
    return { ok: true, rows, requests: 1, note: `${rows.length} found` };
  } catch (e) { return { ok: false, rows: [], requests: 1, note: explain("tomtom", e) }; }
}

const GEOAPIFY_CATS = {
  security: "office.security", insur: "office.insurance", law: "office.lawyer", attorney: "office.lawyer", account: "office.accountant",
  "real estate": "office.estate_agent", electric: "service.electrician", carpent: "service.carpenter", clean: "service.cleaning",
  locksmith: "service.locksmith", architect: "office.architect", consult: "office.consulting", "it ": "office.it", tax: "office.tax_advisor",
  dentist: "healthcare.dentist", dental: "healthcare.dentist", "auto repair": "service.vehicle.repair", mechanic: "service.vehicle.repair",
};
async function srcGeoapify({ type, st, center }) {
  if (!KEYS.geoapify) return { ok: null, rows: [], requests: 0, note: "not set up" };
  if (!center) return { ok: false, rows: [], requests: 0, note: "needs the city location" };
  const t = type.toLowerCase() + " ";
  const cats = new Set(); for (const k of Object.keys(GEOAPIFY_CATS)) if (t.includes(k)) cats.add(GEOAPIFY_CATS[k]);
  const stem = (t.replace(/[^a-z ]/g, "").split(/\s+/).filter(w => w.length > 3)[0] || t.trim()).replace(/(ing|ers|er|s)$/, "");
  const calls = [];
  if (cats.size) calls.push({ categories: [...cats].join(",") });
  if (stem.length >= 3) calls.push({ categories: "office,service,commercial,building", name: stem });
  const filter = `circle:${center.lon},${center.lat},${RADIUS_M}`;
  const seen = new Map(); let used = 0, err = null;
  for (const c of calls) {
    if (left("geoapify") <= 0) break;
    spend("geoapify"); used++;
    try {
      const p = new URLSearchParams({ ...c, filter, bias: `proximity:${center.lon},${center.lat}`, limit: "200", lang: "en", apiKey: KEYS.geoapify });
      const d = await fetchJSON(`${URLS.geoapify}?${p}`);
      for (const f of (d && d.features) || []) { const pr = f.properties || {}; if (pr.name) seen.set(pr.place_id || pr.name, pr); }
    } catch (e) { err = e; break; }
  }
  const rows = [...seen.values()].filter(pr => !pr.state_code || pr.state_code.toUpperCase() === st || (pr.state || "") === STATES[st]).map(pr => {
    const raw = (pr.datasource && pr.datasource.raw) || {}; const ct = pr.contact || {};
    return { name: pr.name, website: cleanUrl(pr.website || raw.website || raw["contact:website"] || raw.url), phone: fmtPhone(ct.phone || raw.phone || raw["contact:phone"]),
      address: (pr.formatted || "").replace(/, United States of America$/, ""), rating: null, reviews: 0,
      category: raw.craft || raw.office || raw.shop || (pr.categories || [])[0] || "", status: "OPERATIONAL", source: "Geoapify" };
  });
  if (err && !rows.length) return { ok: false, rows, requests: used, note: explain("geoapify", err) };
  return { ok: true, rows, requests: used, note: `${rows.length} found` };
}

async function srcOSM({ type, center }) {
  if (!center) return { ok: false, rows: [], requests: 0, note: "needs the city location" };
  const tags = new Set(); const t = type.toLowerCase();
  for (const k of Object.keys(OSM_TAGS)) if (t.includes(k)) OSM_TAGS[k].forEach(x => tags.add(x));
  const stem = (t.replace(/[^a-z ]/g, "").split(/\s+/).filter(w => w.length > 3)[0] || t).replace(/(ing|ers|er|s)$/, "").replace(/"/g, "");
  const around = `(around:${RADIUS_M},${center.lat},${center.lon})`;
  const parts = [...tags].map(x => `nwr[${x}]${around};`);
  if (stem.length >= 3) parts.push(`nwr["name"~"${stem}",i]["website"]${around};`);
  const q = `[out:json][timeout:20];(${parts.join("")});out center tags 250;`;
  for (const u of URLS.overpass) {
    try {
      const d = await fetchJSON(u, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA }, body: "data=" + encodeURIComponent(q) }, 15000);
      const rows = ((d && d.elements) || []).filter(e => e.tags && e.tags.name).map(e => {
        const g = e.tags; const street = [g["addr:housenumber"], g["addr:street"]].filter(Boolean).join(" ");
        return { name: g.name, website: cleanUrl(g.website || g["contact:website"] || g.url), phone: fmtPhone(g.phone || g["contact:phone"]),
          address: [street, g["addr:city"], g["addr:state"]].filter(Boolean).join(", "), rating: null, reviews: 0, category: g.craft || g.office || g.shop || "", status: "OPERATIONAL", source: "OpenStreetMap" };
      });
      return { ok: true, rows, requests: 0, note: `${rows.length} found` };
    } catch {}
  }
  return { ok: false, rows: [], requests: 0, note: "servers busy right now (free service — other sources still work)" };
}

// ---------- search ----------
async function search({ type, city, st, target, requireWebsite }) {
  const key = [type, city, st, target, requireWebsite].join("|").toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.result, cached: true };

  const center = await geocode(city, st);
  const args = { type, city, st, target, center };
  const [g, h, tt, ga] = await Promise.all([srcGoogle(args), srcHere(args), srcTomTom(args), srcGeoapify(args)]);
  // raw OpenStreetMap only when Geoapify (which serves the same data, more reliably) isn't available
  const o = ga.ok ? { ok: null, rows: [], requests: 0, note: "covered by Geoapify" } : await srcOSM(args);
  const sources = { Google: g, HERE: h, TomTom: tt, Geoapify: ga, OpenStreetMap: o };

  // merge: Google first (it has reviews), then others fill gaps; dedupe by website domain, phone, then name
  const out = []; const idx = new Map(); let excluded = 0;
  const stTest = new RegExp(`,\\s*${st}\\b|\\b${STATES[st].replace(/ /g, "\\s")}\\b`, "i");
  for (const r of [...g.rows, ...h.rows, ...tt.rows, ...ga.rows, ...o.rows]) {
    if (!r.name || (r.status && r.status !== "OPERATIONAL")) { excluded++; continue; }
    if (r.address && /, [A-Z]{2} \d{5}|, [A-Z]{2}$/.test(r.address) && !stTest.test(r.address)) { excluded++; continue; }
    if (looksLeadGen(r.name, r.website, city)) { excluded++; continue; }
    const keys = [host(r.website) && "h:" + host(r.website), digits(r.phone).length === 10 && "p:" + digits(r.phone), "n:" + normName(r.name)].filter(Boolean);
    const prev = keys.map(k => idx.get(k)).find(Boolean);
    if (prev) {
      for (const f of ["website", "phone", "address", "category"]) if (!prev[f] && r[f]) prev[f] = r[f];
      if (r.reviews > prev.reviews) { prev.reviews = r.reviews; prev.rating = r.rating; }
      if (!prev.sources.includes(r.source)) prev.sources.push(r.source);
      keys.forEach(k => idx.set(k, prev));
      continue;
    }
    const row = { ...r, sources: [r.source] }; delete row.source; delete row.status;
    out.push(row); keys.forEach(k => idx.set(k, row));
  }
  let rows = out;
  if (requireWebsite) { const before = rows.length; rows = rows.filter(r => r.website); excluded += before - rows.length; }
  rows.forEach(r => { r.tier = tierFor(r.reviews); r.confirmedBy = r.sources.length; });
  // rank: review volume, then how many sources agree, then has phone
  rows.sort((a, b) => (b.reviews - a.reviews) || (b.confirmedBy - a.confirmedBy) || ((b.phone ? 1 : 0) - (a.phone ? 1 : 0)) || a.name.localeCompare(b.name));
  rows = rows.slice(0, target);

  const status = Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, { ok: v.ok, note: v.note, requests: v.requests }]));
  const result = { rows, sources: status, located: !!center, excluded, left: { google: left("google"), here: left("here"), tomtom: left("tomtom"), geoapify: left("geoapify") }, generatedAt: new Date().toISOString() };
  if (rows.length && Object.values(sources).some(s => s.ok)) cache.set(key, { at: Date.now(), result });
  return result;
}

// ---------- system check (cheap: Google uses the free IDs-only field mask) ----------
async function selftest() {
  const center = await geocode("Dallas", "TX");
  const t0 = Date.now();
  const checks = {};
  checks["City lookup"] = center ? { ok: true, note: `working (${center.via})` } : { ok: false, note: "both city-lookup services failed" };
  const run = async (name, fn) => { try { checks[name] = await fn(); } catch (e) { checks[name] = { ok: false, note: e.message }; } };
  await Promise.all([
    run("Google", async () => {
      if (!KEYS.google) return { ok: null, note: "not set up (add GOOGLE_PLACES_KEY)" };
      try {
        await fetchJSON(URLS.google, { method: "POST", headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEYS.google, "X-Goog-FieldMask": "places.id" }, body: JSON.stringify({ textQuery: "roofing in Dallas, TX", pageSize: 1 }) }, 12000);
        return { ok: true, note: `working · ${left("google")} of ${CAPS.google} lookups left today` };
      } catch (e) { return { ok: false, note: explain("google", e) }; }
    }),
    run("HERE", async () => {
      if (!KEYS.here) return { ok: null, note: "not set up (add HERE_API_KEY — free, 5,000/month)" };
      try { await fetchJSON(`${URLS.here}?${new URLSearchParams({ q: "roofing", at: "32.78,-96.8", limit: "1", apiKey: KEYS.here })}`, {}, 12000); return { ok: true, note: `working · ${left("here")} of ${CAPS.here} left today` }; }
      catch (e) { return { ok: false, note: explain("here", e) }; }
    }),
    run("TomTom", async () => {
      if (!KEYS.tomtom) return { ok: null, note: "not set up (add TOMTOM_API_KEY — free, 2,500/month)" };
      try { await fetchJSON(`${URLS.tomtom}/roofing.json?${new URLSearchParams({ key: KEYS.tomtom, lat: "32.78", lon: "-96.8", limit: "1" })}`, {}, 12000); return { ok: true, note: `working · ${left("tomtom")} of ${CAPS.tomtom} left today` }; }
      catch (e) { return { ok: false, note: explain("tomtom", e) }; }
    }),
    run("Geoapify", async () => {
      if (!KEYS.geoapify) return { ok: null, note: "not set up (add GEOAPIFY_API_KEY — free, 3,000/day, no card)" };
      try { await fetchJSON(`${URLS.geoapify}?${new URLSearchParams({ categories: "office", filter: "circle:-96.8,32.78,5000", limit: "1", apiKey: KEYS.geoapify })}`, {}, 12000); return { ok: true, note: `working · ${left("geoapify")} of ${CAPS.geoapify} left today` }; }
      catch (e) { return { ok: false, note: explain("geoapify", e) }; }
    }),
    run("OpenStreetMap", async () => {
      const r = await srcOSM({ type: "roofing", center: center || { lat: 32.78, lon: -96.8 } });
      return { ok: r.ok, note: r.ok ? "working" : r.note };
    }),
  ]);
  return { checks, accessCode: !!ACCESS_CODE, cache: cache.size, ms: Date.now() - t0 };
}

// ---------- http ----------
function send(res, code, obj) {
  const isStr = typeof obj === "string";
  res.writeHead(code, { "Content-Type": isStr ? "text/plain; charset=utf-8" : "application/json", "Cache-Control": "no-store" });
  res.end(isStr ? obj : JSON.stringify(obj));
}
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) return send(res, 403, "Forbidden");
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, "Not found");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": p.endsWith(".html") ? "no-cache" : "public, max-age=3600" });
    res.end(buf);
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ""; req.on("data", c => { b += c; if (b.length > 1e5) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { reject(new Error("bad json")); } });
  });
}
const authed = req => !ACCESS_CODE || (req.headers["x-access-code"] || new URL(req.url, "http://x").searchParams.get("code") || "").trim() === ACCESS_CODE;

let busy = 0;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/status") {
      const configured = { Google: !!KEYS.google, HERE: !!KEYS.here, TomTom: !!KEYS.tomtom, Geoapify: !!KEYS.geoapify, OpenStreetMap: true };
      return send(res, 200, { ok: true, configured, left: { google: left("google"), here: left("here"), tomtom: left("tomtom"), geoapify: left("geoapify") }, caps: CAPS,
        googleKeyLooksValid: /^AIza[0-9A-Za-z_-]{35}$/.test(KEYS.google), needsCode: !!ACCESS_CODE, codeOk: authed(req) });
    }
    if (url.pathname === "/api/selftest") {
      if (!authed(req)) return send(res, 401, { error: "Wrong or missing team access code." });
      return send(res, 200, await selftest());
    }
    if (url.pathname === "/api/search" && req.method === "POST") {
      if (!authed(req)) return send(res, 401, { error: "Wrong or missing team access code." });
      let b; try { b = await readBody(req); } catch { return send(res, 400, { error: "Bad request." }); }
      const type = String(b.type || "").replace(/\s+/g, " ").trim().slice(0, 60);
      const city = String(b.city || "").replace(/\s+/g, " ").trim().slice(0, 60);
      const st = String(b.state || "").trim().toUpperCase();
      const target = [25, 50, 100].includes(+b.count) ? +b.count : 100;
      const requireWebsite = b.requireWebsite !== false;
      if (!type || !city || !STATES[st]) return send(res, 400, { error: "Enter a business type, a city and a state." });
      if (busy >= 4) return send(res, 429, { error: "A few searches are already running — try again in a minute." });
      busy++;
      try { return send(res, 200, await search({ type, city, st, target, requireWebsite })); }
      finally { busy--; }
    }
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
    send(res, 405, "Method not allowed");
  } catch (e) { console.error(e); send(res, 500, { error: "Something went wrong on the server. Please try again." }); }
});
if (require.main === module) server.listen(PORT, () => console.log(`Company Finder on :${PORT} · Google ${KEYS.google ? "on" : "off"} · HERE ${KEYS.here ? "on" : "off"} · TomTom ${KEYS.tomtom ? "on" : "off"} · Geoapify ${KEYS.geoapify ? "on" : "off"}`));
module.exports = { server };
