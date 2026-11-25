#!/usr/bin/env node
/**
 * Import official-record cases from a local CSV pack into data/cases.json.
 * Rerun when a new pack or cases-part2.csv arrives.
 *
 * Usage:
 *   node scripts/import-cases.mjs
 *   node scripts/import-cases.mjs --pack /path/to/pack-dir
 *   node scripts/import-cases.mjs --csv extra.csv
 *
 * Reads cases.csv from the pack directory, then cases-part2.csv if present
 * (duplicate ids are skipped). Geocodes named sites via OpenStreetMap
 * Nominatim at 1 request per second, cached in scripts/geocode-cache.json
 * (local only; not published with the app). Curated pilot fields in
 * scripts/curated-pilots.json are kept on rerun rather than overwritten.
 * Never invents coordinates, dates or claims.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const DEFAULT_PACK = process.env.WNTR_PACK_DIR || path.join(APP_ROOT, "research-pack");
const UA = "WNTRs-Globe/1.0 (https://github.com/AdventureNLearn/WNTRs-Globe; official-record case import)";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const MIN_INTERVAL_MS = 1100;

const args = process.argv.slice(2);
function flagValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
const PACK_DIR = flagValue("--pack", DEFAULT_PACK);
const OUT_PATH = flagValue("--out", path.join(APP_ROOT, "data/cases.json"));
const CACHE_PATH = flagValue("--cache", path.join(APP_ROOT, "scripts/geocode-cache.json"));
const CURATED_PATH = path.join(__dirname, "curated-pilots.json");
const extraCsv = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--csv" && args[i + 1]) extraCsv.push(args[++i]);
}

// Official place-name searches for named-site cases. Queries use names from
// the official record (plus country/region for disambiguation only).
const GEOCODE_QUERIES = {
  "tna-defe24-1948-rendlesham-1980": [
    { id: "rendlesham-forest", name: "Rendlesham Forest", q: "Rendlesham Forest, Suffolk, England" },
    { id: "raf-woodbridge", name: "RAF Woodbridge", q: "RAF Woodbridge, Suffolk, England", fallbacks: ["MOD Woodbridge, Suffolk, England", "Woodbridge Airfield, Suffolk, England"] }
  ],
  "aaro-puerto-rico-2013": [
    { id: "bqn-airport", name: "Rafael Hernandez Airport", q: "Rafael Hernandez Airport, Aguadilla, Puerto Rico" }
  ],
  "aaro-al-taqaddum-2017": [
    { id: "al-taqaddum", name: "Al Taqaddum Air Base", q: "Al Taqaddum Air Base, Iraq" }
  ],
  "aaro-eglin-2023": [
    { id: "eglin-afb", name: "Eglin Air Force Base", q: "Eglin Air Force Base, Florida, United States" }
  ],
  "aaro-mt-etna-2018": [
    { id: "nas-sigonella", name: "Naval Air Station Sigonella", q: "Naval Air Station Sigonella, Italy", fallbacks: ["Sigonella Airport, Italy", "Base Aerea Sigonella, Italy", "Sigonella, Sicily, Italy"] }
  ],
  "nara-usaf-roswell-1947": [
    { id: "roswell", name: "Roswell", q: "Roswell, New Mexico, United States" }
  ],
  "cefeni-isla-mocha-1968": [
    { id: "isla-mocha", name: "Isla Mocha", q: "Isla Mocha, Chile" }
  ],
  "cefaa-arica-1988": [
    { id: "arica", name: "Arica", q: "Arica, Chile" }
  ],
  "cefaa-bandera-2010": [
    { id: "plaza-ciudadania", name: "Plaza de la Ciudadanía", q: "Plaza de la Ciudadanía, Santiago, Chile" }
  ],
  "cefaa-academia-de-guerra-2012": [
    { id: "academia-guerra-aerea", name: "Academia de Guerra Aérea", q: "Academia de Guerra Aerea, Santiago, Chile" }
  ],
  "tna-defe24-1938-belfast-airport-1989": [
    { id: "belfast-airport", name: "Belfast Airport", q: "Belfast International Airport, Northern Ireland" }
  ],
  "tna-defe31-181-heathrow-1992": [
    { id: "heathrow", name: "Heathrow", q: "Heathrow Airport, London, United Kingdom" }
  ],
  "tna-defe31-181-louth-1992": [
    { id: "louth", name: "Louth", q: "Louth, Lincolnshire, England" }
  ],
  "cefaa-c212-2012": [
    { id: "scat-calama", name: "Aeródromo Desierto de Atacama de Calama (SCAT)", q: "Aeródromo Desierto de Atacama, Calama, Chile", fallbacks: ["SCAT airport, Chile", "Aeródromo Desierto de Atacama, Chile"] },
    { id: "scha-chamonate", name: "Aeródromo de Chamonate (SCHA)", q: "Aeródromo Chamonate, Chile" },
    { id: "sccl-caldera", name: "Aeródromo de Caldera (SCCL)", q: "Aeródromo Caldera, Chile" }
  ],
  "tna-defe24-2086-cosford-1993": [
    { id: "raf-cosford", name: "RAF Cosford", q: "RAF Cosford, England" }
  ],
  "tna-defe24-1963-gatwick-1991": [
    { id: "gatwick", name: "Gatwick", q: "Gatwick Airport, England" }
  ],
  "tna-defe24-1961-chasetown-1995": [
    { id: "chasetown", name: "Chasetown", q: "Chasetown, Staffordshire, England" }
  ],
  "tna-defe24-1976-widnes-1996": [
    { id: "widnes", name: "Widnes", q: "Widnes, England", fallbacks: ["Widnes, Halton, England"] }
  ],
  "tna-defe24-1960-glastonbury-1994": [
    { id: "worthy-farm", name: "Worthy Farm, Pilton (Glastonbury Festival)", q: "Worthy Farm, Pilton, Somerset, England", fallbacks: ["Glastonbury Festival, Pilton, England", "Worthy Farm, Somerset, England"] }
  ],
  "tna-defe24-1963-london-airship-1993": [
    { id: "london", name: "London", q: "London, United Kingdom" }
  ],
  "mod-das-1999-03-10-chelsea-football-club": [
    { id: "chelsea-fc", name: "Chelsea Football Club", q: "Chelsea Football Club, London, United Kingdom", fallbacks: ["Stamford Bridge, London, United Kingdom"] }
  ],
  "mod-das-1997-12-28-over-malby": [
    { id: "malby", name: "Malby", q: "Malby, Co. Clare, Ireland" }
  ],
  "sefaa-caso-1425-2020-12-30": [
    { id: "isla-mocha", name: "Isla Mocha", q: "Isla Mocha, Chile" }
  ],
  "sefaa-caso-1437-2021-01-31": [
    { id: "talca", name: "Talca", q: "Talca, Región del Maule, Chile" }
  ],
  "sefaa-caso-1098-2018-09-18": [
    { id: "pichidegua", name: "Pichidegua", q: "Pichidegua, Chile" }
  ],
  "sefaa-caso-972-2019-08-12": [
    { id: "pucon", name: "Pucón", q: "Pucón, Chile" }
  ],
  "mod-das-1997-09-22-acton": [
    { id: "acton", name: "Acton", q: "Acton, London, England", fallbacks: ["Acton, London Borough of Ealing, England"] }
  ],
  "mod-das-1997-11-13-stoke-on-trent": [
    { id: "stoke-on-trent", name: "Stoke-on-Trent", q: "Stoke-on-Trent, England" }
  ],
  "mod-das-1999-02-10-swansea": [
    { id: "swansea", name: "Swansea", q: "Swansea, Wales, United Kingdom" }
  ],
  "mod-das-1999-04-10-wem-nr-shrewsbury": [
    { id: "wem", name: "Wem", q: "Wem, Shropshire, England" }
  ]
};

function isUnknown(v) {
  if (v == null) return true;
  const s = String(v).trim();
  return !s || s === "[UNKNOWN]";
}

function parseCsv(text) {
  const rows = [];
  let i = 0;
  const nextCell = () => {
    if (text[i] === '"') {
      i += 1;
      let out = "";
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { out += '"'; i += 2; continue; }
          i += 1;
          break;
        }
        out += text[i];
        i += 1;
      }
      if (text[i] === ",") i += 1;
      return out;
    }
    let out = "";
    while (i < text.length && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
      out += text[i];
      i += 1;
    }
    if (text[i] === ",") i += 1;
    return out;
  };
  const nextRow = () => {
    if (i >= text.length) return null;
    if (text[i] === "\r") i += 1;
    if (text[i] === "\n") i += 1;
    if (i >= text.length) return null;
    const cells = [];
    while (i < text.length && text[i] !== "\n" && text[i] !== "\r") {
      cells.push(nextCell());
    }
    return cells;
  };
  // handle starting row without leading newline
  const header = (() => {
    const cells = [];
    while (i < text.length && text[i] !== "\n" && text[i] !== "\r") cells.push(nextCell());
    return cells;
  })();
  let row;
  while ((row = nextRow())) {
    if (row.length === 1 && row[0] === "") continue;
    const obj = {};
    header.forEach((h, idx) => { obj[h] = row[idx] ?? ""; });
    rows.push(obj);
  }
  return rows;
}

function parseCaseDate(raw) {
  if (isUnknown(raw)) return { precision: "unknown", as_printed: raw || "[UNKNOWN]" };
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    return { precision: "day", year: +m[1], month: +m[2], day: +m[3], iso: s, as_printed: s };
  }
  m = s.match(/^(\d{4})-(\d{2})$/);
  if (m) {
    return { precision: "month", year: +m[1], month: +m[2], iso: s, as_printed: s };
  }
  m = s.match(/^(\d{4})$/);
  if (m) {
    return { precision: "year", year: +m[1], iso: s, as_printed: s };
  }
  m = s.match(/^(\d{4})\s*[–-]\s*(\d{4})$/);
  if (m) {
    return {
      precision: "range",
      year: +m[1],
      year_end: +m[2],
      iso: m[1],
      as_printed: s
    };
  }
  // Official incomplete GEIPAN-style dates, kept as printed.
  m = s.match(/^-{1,2}\/(\d{2})\/(\d{4})$/);
  if (m) {
    return { precision: "month", year: +m[2], month: +m[1], iso: `${m[2]}-${m[1]}`, as_printed: s };
  }
  m = s.match(/^\d-?\/(\d{2})\/(\d{4})$/);
  if (m) {
    return { precision: "month", year: +m[2], month: +m[1], iso: `${m[2]}-${m[1]}`, as_printed: s };
  }
  return { precision: "unknown", as_printed: s };
}

function toDecimalDegrees(raw) {
  if (isUnknown(raw)) return null;
  const original = String(raw).trim();
  if (/^[-+]?\d+(?:\.\d+)?$/.test(original)) return Number(original);
  // Official CEFAA figures use U+2019 for both minutes and seconds (’’ = seconds).
  let s = original
    .replace(/,/g, ".")
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/''/g, '"')
    .replace(/°/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // FAA style: 18-29-41.468 N  or  67-7-45.99 W
  let m = s.match(/^(\d{1,3})-(\d{1,2})(?:-(\d{1,2}(?:\.\d+)?))?\s*([NSEW])$/i);
  if (m) {
    let val = Number(m[1]) + Number(m[2]) / 60 + (m[3] != null ? Number(m[3]) : 0) / 3600;
    const hemi = m[4].toUpperCase();
    if (hemi === "S" || hemi === "W") val = -val;
    return val;
  }
  // DMS: 14 16' 28.92" S   or  74 29' W
  m = s.match(/^(\d{1,3})\s+(\d{1,2})(?:\s*'\s*(\d{1,2}(?:\.\d+)?)?)?\s*"?\s*([NSEW])$/i);
  if (m) {
    let val = Number(m[1]) + Number(m[2]) / 60 + (m[3] != null ? Number(m[3]) : 0) / 3600;
    const hemi = m[4].toUpperCase();
    if (hemi === "S" || hemi === "W") val = -val;
    return val;
  }
  return null;
}

function isReferenceSource(src) {
  const s = (src || "").toLowerCase();
  if (!s) return false;
  if (s.includes("not as the object") || s.includes("not as the objects")) return true;
  if (s.includes("airport reference point") || s.includes("identifier bqn")) return true;
  if (s.includes("named waypoint") || s.includes("reporting point") || s.includes("punto de")) return true;
  if (s.includes("used to locate the observation")) return true;
  if (s.includes("study location")) return true;
  return false;
}

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function formatWaybackDate(snap) {
  if (!/^\d{14}$/.test(snap)) return null;
  const year = snap.slice(0, 4);
  const month = Number(snap.slice(4, 6));
  const day = Number(snap.slice(6, 8));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

function addModArchiveCitations(row, add) {
  const notes = row.notes || "";
  const m = notes.match(/Wayback capture (\d{14})/i);
  if (!m || !row.url || !/mod\.uk/i.test(row.url)) return;
  const snap = m[1];
  const captured = formatWaybackDate(snap);
  if (!captured) return;
  const archiveUrl = `https://web.archive.org/web/${snap}id_/${row.url}`;
  add(archiveUrl, `Archived copy of official MoD page, captured ${captured}`);
  const list = notes.match(/https?:\/\/www\.mod\.uk\/DefenceInternet\/[^\s]+/);
  if (list) add(list[0].replace(/[.,;]+$/, ""), "MoD Publication Scheme listing page: UFO Reports in the UK");
}

function parsePrintedPair(raw) {
  if (isUnknown(raw)) return null;
  const parts = String(raw).split(",");
  if (parts.length < 2) return null;
  const lat = toDecimalDegrees(parts[0].trim());
  const lon = toDecimalDegrees(parts[1].trim());
  if (lat == null || lon == null) return null;
  return { lat, lon };
}

function stripPlaceDecorations(place) {
  let s = String(place || "").trim();
  s = s.replace(/\s*\(as named in[^)]*\)\s*/gi, " ").trim();
  s = s.replace(/^over the\s+/i, "").replace(/^over\s+/i, "");
  s = s.replace(/^near the island of\s+/i, "").replace(/^near\s+/i, "");
  s = s.replace(/^a field at\s+/i, "");
  const near = s.match(/cercano a\s+(.+)$/i);
  if (near) s = near[1];
  if (/,/.test(s) && /regi[oó]n/i.test(s)) {
    const first = s.split(",")[0].trim();
    if (first.split(/\s+/).length <= 3) s = first;
  }
  return s.replace(/\s+/g, " ").trim();
}

function isUsablePlaceName(name) {
  const s = (name || "").trim();
  if (!s || s.length < 2) return false;
  if (/no aplica|empez[oó]|objeto|instalaciones|empresa|trayectoria|puntos negros|desapareciendo|\bmiles\b|sector norte/i.test(s)) return false;
  if (/["“”]/.test(s)) return false;
  if (/^\d/.test(s)) return false;
  if (s.split(/\s+/).length > 8) return false;
  return true;
}

function isWeakGeocode(result) {
  if (!result) return true;
  const typ = `${result.class || ""} ${result.type || ""} ${result.addresstype || ""}`.toLowerCase();
  if (/\b(residential|living_street|unclassified|service|footway|path|pedestrian|school|house|tertiary|secondary|primary|motorway|trunk|bus_stop|canal)\b/.test(typ)) {
    return true;
  }
  if ((result.class === "highway" || /\bhighway\b/.test(typ)) && !/\b(city|town|village|suburb|hamlet|neighbourhood|municipality|administrative|aerodrome)\b/.test(typ)) {
    return true;
  }
  return false;
}

function geocodeQueriesFor(row) {
  if (Array.isArray(GEOCODE_QUERIES[row.id]) && GEOCODE_QUERIES[row.id].length) {
    return GEOCODE_QUERIES[row.id];
  }
  const prec = String(row.location_precision || "").toLowerCase();
  if (!["named site", "town", "city"].includes(prec)) return [];
  const name = stripPlaceDecorations(row.place);
  if (!isUsablePlaceName(name)) return [];
  const region = (!isUnknown(row.region) && !/no aplica/i.test(row.region)) ? String(row.region).trim() : "";
  const country = !isUnknown(row.country) ? String(row.country).trim() : "";
  const parts = [name];
  if (region && !name.toLowerCase().includes(region.toLowerCase())) parts.push(region);
  if (country) parts.push(country);
  const slug = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "site";
  return [{ id: slug, name, q: parts.join(", ") }];
}

function officialStatusMeta(row) {
  const printed = row.official_status || "";
  const lower = printed.toLowerCase();
  const tags = [];
  if (/\bresuelto\b/.test(lower)) tags.push("Resuelto");
  if (/\bexplicado\b/.test(lower)) tags.push("Explicado");
  if (/\bcerrado\b/.test(lower) || /\bcerrar\b/.test(lower) || /\bcerr[oó]\b/.test(lower)) tags.push("Cerrado");
  if (/GEIPAN class D/i.test(printed) || /\bPAN D\b/.test(printed)) {
    return { gloss: "Unexplained (GEIPAN class D)", kind: "unexplained", tags: [] };
  }
  if (tags.length) {
    const glossFor = { Resuelto: "Resolved", Explicado: "Explained", Cerrado: "Closed" };
    const gloss = tags.map((tag) => `${tag} (${glossFor[tag]})`).join(" · ");
    return { gloss, kind: "explained_resolved", tags };
  }
  if (/\bpendiente\b/.test(lower)) return { gloss: "Pending (Pendiente)", kind: "other", tags: [] };
  if (/\binexplicado\b/.test(lower) || /sin explicaci[oó]n/.test(lower) || /fen[oó]meno no identificado/.test(lower)) {
    return { gloss: "Unexplained, as printed", kind: "unexplained", tags: [] };
  }
  if (/\brelato\b/.test(lower)) return { gloss: "Account only (Relato)", kind: "other", tags: [] };
  if (/\bfalso\b/.test(lower)) return { gloss: "False (Falso), as printed", kind: "other", tags: [] };
  if (/no investigation conclusion/i.test(printed)) {
    return { gloss: "Listed in the official tables; no investigation conclusion printed", kind: "other", tags: [] };
  }
  return { gloss: "", kind: "other", tags: [] };
}

function extractUrls(row) {
  const out = [];
  const seen = new Set();
  const add = (url, label) => {
    if (!url || isUnknown(url)) return;
    const clean = url.replace(/[.,;:]+$/, "");
    if (seen.has(clean)) return;
    seen.add(clean);
    out.push({ url: clean, label: label || clean });
  };
  if (row.url) {
    const label = [row.archive, row.record_or_file_id].filter((x) => x && !isUnknown(x)).join(" — ") || row.url;
    add(row.url, label);
  }
  addModArchiveCitations(row, add);
  const text = `${row.notes || ""} ${row.coords_source || ""} ${row.official_status || ""}`;
  const re = /https?:\/\/[^\s\]\)>"']+/g;
  let m;
  while ((m = re.exec(text))) {
    add(m[0], m[0]);
  }
  return out;
}

function nowEtStamp() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}-05:00`;
}

function circleRadiusForType(item) {
  const t = `${item.type || ""} ${item.category || ""} ${item.addresstype || ""}`.toLowerCase();
  if (/(island)/.test(t)) return 4000;
  if (/(city)/.test(t)) return 5000;
  if (/(forest|wood|park|nature)/.test(t)) return 2500;
  if (/(aerodrome|airport|airfield)/.test(t)) return 1800;
  if (/(military|base|barracks)/.test(t)) return 1500;
  if (/(town)/.test(t)) return 2000;
  if (/(village)/.test(t)) return 800;
  if (/(suburb|hamlet|neighbourhood|neighborhood)/.test(t)) return 400;
  if (/(building|amenity|tourism|square|plaza)/.test(t)) return 180;
  return 1000;
}

function radiusFromBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length < 4) return null;
  const south = Number(bbox[0]);
  const north = Number(bbox[1]);
  const west = Number(bbox[2]);
  const east = Number(bbox[3]);
  if (![south, north, west, east].every(Number.isFinite)) return null;
  const latM = Math.abs(north - south) * 111320 / 2;
  const midLat = (north + south) / 2;
  const lonM = Math.abs(east - west) * 111320 * Math.cos((midLat * Math.PI) / 180) / 2;
  const r = Math.max(latM, lonM);
  if (!Number.isFinite(r) || r < 80) return null;
  return Math.min(Math.round(r), 25000);
}

function loadCache() {
  if (!existsSync(CACHE_PATH)) return { retrieved_et: null, queries: {} };
  return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
}

let lastNominatim = 0;
async function nominatimSearch(q) {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastNominatim);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
  const url = `${NOMINATIM}?${new URLSearchParams({
    q,
    format: "jsonv2",
    addressdetails: "1",
    polygon_geojson: "1",
    limit: "5"
  })}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" }
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status} for ${q}`);
  return res.json();
}

async function geocodeOne(cache, query) {
  const key = query.q;
  if (cache.queries[key] && cache.queries[key].status && cache.queries[key].status !== "error") {
    return cache.queries[key];
  }
  console.log("geocode:", key);
  try {
    const results = await nominatimSearch(key);
    const best = Array.isArray(results) && results.length ? results[0] : null;
    const entry = {
      q: key,
      retrieved_et: nowEtStamp(),
      status: best ? "hit" : "miss",
      result: best
        ? {
          place_id: best.place_id,
          osm_type: best.osm_type,
          osm_id: best.osm_id,
          lat: Number(best.lat),
          lon: Number(best.lon),
          category: best.category,
          type: best.type,
          addresstype: best.addresstype,
          display_name: best.display_name,
          boundingbox: best.boundingbox,
          geojson: best.geojson || null
        }
        : null
    };
    cache.queries[key] = entry;
    return entry;
  } catch (err) {
    const entry = {
      q: key,
      retrieved_et: nowEtStamp(),
      status: "error",
      error: String(err && err.message || err),
      result: null
    };
    cache.queries[key] = entry;
    return entry;
  }
}

function areaFromGeocode(query, entry) {
  const r = entry && entry.result;
  if (!r || typeof r.lat !== "number" || typeof r.lon !== "number") return null;
  const precision_label = "Named site location from OpenStreetMap, not an event fix";
  const geo = r.geojson;
  if (geo && (geo.type === "Polygon" || geo.type === "MultiPolygon") && Array.isArray(geo.coordinates)) {
    return {
      id: query.id,
      name: query.name,
      kind: geo.type === "MultiPolygon" ? "multipolygon" : "polygon",
      coordinates: geo.coordinates,
      lon: r.lon,
      lat: r.lat,
      osm_type: r.osm_type,
      osm_id: r.osm_id,
      display_name: r.display_name,
      precision_label
    };
  }
  const radius = radiusFromBbox(r.boundingbox) || circleRadiusForType(r);
  return {
    id: query.id,
    name: query.name,
    kind: "point_radius",
    lon: r.lon,
    lat: r.lat,
    radius_m: radius,
    osm_type: r.osm_type,
    osm_id: r.osm_id,
    display_name: r.display_name,
    precision_label,
    radius_note: "Approximate circle sized from the OpenStreetMap feature, not an event area."
  };
}

function classify(row, lat, lon, reference, queries) {
  const date = parseCaseDate(row.date);
  if (date.precision === "unknown") {
    return { map_kind: "feed", feed_reason: "unknown date" };
  }
  if (isUnknown(row.place) && (isUnknown(row.lat) || lat == null) && !(queries && queries.length)) {
    return { map_kind: "feed", feed_reason: "unknown location" };
  }
  const hasQueries = Array.isArray(queries) && queries.length > 0;
  if (reference && lat != null && lon != null) {
    return { map_kind: hasQueries ? "named_site_and_reference" : "reference_point", feed_reason: null };
  }
  if (!reference && lat != null && lon != null) {
    return { map_kind: "point", feed_reason: null };
  }
  if (hasQueries) {
    return { map_kind: "named_site", feed_reason: null };
  }
  // Region, ocean area, path, or a place too vague to geocode without inventing a point.
  return { map_kind: "feed", feed_reason: "unknown location" };
}


function looksLikeDms(s) {
  const text = String(s || "");
  return /[°º]/.test(text) || /\d{1,3}\s*[-–]\s*\d{1,2}\s*[-–]\s*\d/.test(text);
}

function printedCoordsAreDms(row) {
  return looksLikeDms(row.coords_as_printed) || looksLikeDms(row.lat) || looksLikeDms(row.lon);
}

function rewriteConversionClaim(text, converted) {
  if (!text || !converted) return text;
  let out = String(text).replace(
    /Values are quoted as printed and were not converted\.?/g,
    "Converted from the printed DMS."
  );
  out = out.replace(/\s*Decimal degrees, if shown, are a conversion of the printed figures for map display only\.?/g, "");
  return out.replace(/[ \t]+/g, " ").trim();
}

function precisionForPoint(row) {
  const printed = row.coords_as_printed || `${row.lat}, ${row.lon}`;
  if ((row.archive || "").includes("GEIPAN")) {
    return {
      label: "Coordinates as printed in the official GEIPAN export, not a surveyed event fix",
      note: `Official export values as printed: ${printed}. Typical printed precision is two decimal degrees (about 1 km). Geographic meaning of these fields beyond the printed values: [UNKNOWN]. Values were not estimated or geocoded.`
    };
  }
  const converted = printedCoordsAreDms(row);
  const source = rewriteConversionClaim(
    row.coords_source || "Source of the printed figures is in the citations.",
    converted
  );
  const extra = converted
    ? ""
    : " Decimal degrees, if shown, are a conversion of the printed figures for map display only.";
  return {
    label: "Coordinates as printed in the official record, not a surveyed event fix",
    note: rewriteConversionClaim(`Official values as printed: ${printed}. ${source}${extra}`.replace(/\s+/g, " ").trim(), converted)
  };
}

function streetViewFor(lon, lat, zoom = 15.5) {
  if (typeof lon !== "number" || typeof lat !== "number") return null;
  return {
    lon,
    lat,
    zoom,
    pitch: 54,
    bearing: 20,
    note: "Camera is framed on the mapped official printed point or named-site locator. This is not an event fix unless the official record printed these coordinates as the event position."
  };
}

function buildCase(row, cls, lat, lon, areas, referencePoints) {
  const date = parseCaseDate(row.date);
  const title = row.case_name || "[UNKNOWN]";
  const place = row.place || "[UNKNOWN]";
  const sources = extractUrls(row);
  const statusMeta = officialStatusMeta(row);
  const unknown = [];
  if (date.precision === "unknown") unknown.push("Date: [UNKNOWN]");
  if (isUnknown(row.time_with_zone)) unknown.push("Clock time: [UNKNOWN]");
  if (cls.map_kind === "feed" || isUnknown(row.lat)) {
    if (isUnknown(row.lat) || isUnknown(row.lon)) unknown.push("Event lat/lon: [UNKNOWN]");
  }
  let precision_label = "";
  let precision_note = "";
  if (cls.map_kind === "point") {
    const p = precisionForPoint(row);
    precision_label = p.label;
    precision_note = p.note;
  } else if (cls.map_kind === "reference_point") {
    precision_label = "Reference point, not the object's position";
    precision_note = row.coords_source || "Printed coordinates are a named reference, not the object's path.";
  } else if (cls.map_kind === "named_site" || cls.map_kind === "named_site_and_reference") {
    precision_label = "Named site location from OpenStreetMap, not an event fix";
    precision_note = "The official record names this place but does not print event coordinates. The outline or circle is the OpenStreetMap feature for the named site. Event lat/lon: [UNKNOWN].";
    if (cls.map_kind === "named_site_and_reference") {
      precision_note += " The cross marks a printed official reference point, not the object's position.";
    }
  } else if (cls.feed_reason === "unknown date") {
    precision_label = "Not on the map: date [UNKNOWN]";
    precision_note = "This official-record case has no usable official date, so it is kept in the Not on the map feed.";
  } else {
    precision_label = "Not on the map: location [UNKNOWN]";
    precision_note = "The official record does not give a location precise enough to place without inventing coordinates, so this case is kept in the Not on the map feed.";
  }
  precision_note = rewriteConversionClaim(precision_note, printedCoordsAreDms(row));

  const loc = (areas[0] && typeof areas[0].lon === "number")
    ? { lon: areas[0].lon, lat: areas[0].lat }
    : (referencePoints[0] ? { lon: referencePoints[0].lon, lat: referencePoints[0].lat } : (lat != null ? { lon, lat } : null));

  const incident_date = date.iso || null;
  const incident_date_source = date.precision === "unknown"
    ? "Official date field is [UNKNOWN] or could not be parsed without inventing a day."
    : `Taken from the official date field as printed: ${date.as_printed}.`;

  return {
    id: row.id,
    placeholder: false,
    title,
    place_label: place,
    place_as_written: place,
    date_as_printed: date.as_printed,
    incident_date,
    incident_date_precision: date.precision,
    incident_date_source,
    incident_year: date.year || null,
    incident_month: date.month || null,
    incident_day: date.day || null,
    incident_year_end: date.year_end || null,
    time_as_printed: isUnknown(row.time_with_zone) ? "[UNKNOWN]" : row.time_with_zone,
    country: row.country || "[UNKNOWN]",
    region: row.region || "",
    summary: row.summary || "",
    claimed: row.claimed || "",
    official_status: row.official_status || "",
    official_status_gloss: statusMeta.gloss,
    official_status_kind: statusMeta.kind,
    official_status_tags: statusMeta.tags,
    confidence: row.confidence || "",
    archive: row.archive || "",
    record_or_file_id: row.record_or_file_id || "",
    location_precision: row.location_precision,
    area_type: row.area_type,
    map_kind: cls.map_kind,
    feed_reason: cls.feed_reason,
    precision_label,
    precision_note,
    areas,
    reference_points: referencePoints,
    sources,
    unknown,
    notes: row.notes || "",
    street_view: loc ? streetViewFor(loc.lon, loc.lat, cls.map_kind === "point" ? 16 : 15.2) : null
  };
}


function labelFestivalArea(query, entry, area) {
  if (!area || !query) return;
  const display = (entry && entry.result && entry.result.display_name) || "";
  const askedFestival = /worthy farm|glastonbury festival|pilton/i.test(`${query.id} ${query.name} ${query.q || ""}`);
  if (!askedFestival) return;
  if (/worthy farm|pilton/i.test(display) || /festival/i.test(display)) {
    area.name = "Worthy Farm, Pilton (Glastonbury Festival)";
    return;
  }
  if (/glastonbury/i.test(display)) {
    area.name = "Glastonbury (named town, not the festival site)";
  }
}

function loadCurated() {
  if (!existsSync(CURATED_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CURATED_PATH, "utf8"));
  } catch (err) {
    console.warn("could not read curated pilots:", err && err.message || err);
    return {};
  }
}

const CURATED = loadCurated();

function mergeSources(primary, extra) {
  const out = [];
  const seen = new Set();
  for (const list of [primary || [], extra || []]) {
    for (const s of list) {
      const url = (s && s.url) || s;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(s && s.url ? s : { url, label: url });
    }
  }
  return out;
}

function applyCurated(built, studyLocation) {
  const over = CURATED[built.id];
  if (studyLocation && built.precision_note) {
    built.precision_note = "The cross marks an observer or analyst position printed in the official case PDF, converted from the printed DMS. It is not the object's position.";
  }
  if (!over) return built;
  const skip = new Set(["area_overlays", "reference_points", "sources"]);
  for (const [k, v] of Object.entries(over)) {
    if (skip.has(k) || v == null) continue;
    built[k] = v;
  }
  if (Array.isArray(over.sources)) {
    const gaps = over.source_gaps || built.source_gaps || [];
    const extras = (built.sources || []).filter((s) => {
      const url = (s && s.url) || s;
      return url && !gaps.some((g) => String(g).includes(url));
    });
    built.sources = mergeSources(over.sources, extras);
  }
  if (Array.isArray(over.reference_points) && over.reference_points.length) {
    built.reference_points = over.reference_points;
  }
  if (Array.isArray(over.area_overlays) && Array.isArray(built.areas)) {
    const byId = new Map(over.area_overlays.map((a) => [a.id, a]));
    built.areas = built.areas.map((area) => {
      const add = byId.get(area.id);
      if (!add) return area;
      return { ...area, ...Object.fromEntries(Object.entries(add).filter(([k]) => k !== "id" && k !== "coordinates")) };
    });
  }
  if (over.street_view) built.street_view = over.street_view;
  return built;
}

const CASE_KEEP = new Set([
  "id", "placeholder", "title", "place_label", "place_as_written",
  "date_as_printed", "incident_date", "incident_date_precision", "incident_date_source",
  "incident_year", "incident_month", "incident_day", "incident_year_end",
  "time_as_printed", "time_notes", "summary", "official_status", "official_status_gloss",
  "official_status_kind", "precision_label", "precision_note", "map_kind", "feed_reason",
  "areas", "reference_points", "sources", "unknown", "source_gaps", "street_view"
]);
const AREA_KEEP = new Set(["id", "name", "kind", "coordinates", "lon", "lat", "radius_m", "radius_note", "as_printed", "note"]);
const REF_KEEP = new Set(["id", "lat", "lon", "as_printed", "label", "source_label"]);

function pick(obj, keep) {
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const k of keep) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

function slimCase(c) {
  const out = pick(c, CASE_KEEP);
  if (Array.isArray(c.areas)) out.areas = c.areas.map((a) => pick(a, AREA_KEEP));
  if (Array.isArray(c.reference_points)) out.reference_points = c.reference_points.map((a) => pick(a, REF_KEEP));
  return out;
}

async function loadCsvFiles() {
  const paths = [];
  const main = path.join(PACK_DIR, "cases.csv");
  if (!existsSync(main) && extraCsv.length === 0) {
    throw new Error(`Missing pack CSV: ${main}`);
  }
  if (existsSync(main)) paths.push(main);
  const part2 = path.join(PACK_DIR, "cases-part2.csv");
  if (existsSync(part2)) paths.push(part2);
  for (const p of extraCsv) paths.push(p);

  const byId = new Map();
  const skipped = [];
  for (const p of paths) {
    const text = await readFile(p, "utf8");
    const rows = parseCsv(text);
    console.log(`read ${rows.length} rows from ${p}`);
    for (const row of rows) {
      if (!row.id) continue;
      if (byId.has(row.id)) {
        skipped.push({ id: row.id, file: p });
        continue;
      }
      byId.set(row.id, row);
    }
  }
  return { rows: [...byId.values()], files: paths, skipped };
}

async function main() {
  const { rows, files, skipped } = await loadCsvFiles();
  const cache = loadCache();
  if (!cache.queries) cache.queries = {};

  const counts = {
    point: 0,
    reference_point: 0,
    named_site: 0,
    named_site_and_reference: 0,
    feed: 0,
    geocode_hits: 0,
    geocode_misses: 0,
    geocode_errors: 0,
    named_site_areas: 0,
    feed_unknown_date: 0,
    feed_unknown_location: 0,
    coord_parse_failures: 0,
    explained_resolved: 0
  };

  const cases = [];
  for (const row of rows) {
    let lat = toDecimalDegrees(row.lat);
    let lon = toDecimalDegrees(row.lon);
    if (!isUnknown(row.lat) && (lat == null || lon == null)) {
      counts.coord_parse_failures += 1;
      console.warn("could not parse printed coordinates for", row.id, row.lat, row.lon);
    }
    let reference = isReferenceSource(row.coords_source);
    if ((lat == null || lon == null) && row.coords_as_printed) {
      const pair = parsePrintedPair(row.coords_as_printed);
      if (pair && (reference || /study location/i.test(row.coords_source || ""))) {
        lat = pair.lat;
        lon = pair.lon;
        reference = true;
      }
    }
    const queries = geocodeQueriesFor(row);
    const cls = classify(row, lat, lon, reference, queries);
    const areas = [];
    const referencePoints = [];
    const studyLocation = /study location/i.test(row.coords_source || "");

    if (cls.map_kind === "point" && lat != null && lon != null) {
      areas.push({
        id: "printed-point",
        name: row.place,
        kind: "point",
        lon,
        lat,
        as_printed: row.coords_as_printed || `${row.lat}, ${row.lon}`
      });
    }

    if ((cls.map_kind === "reference_point" || cls.map_kind === "named_site_and_reference") && lat != null && lon != null) {
      referencePoints.push({
        id: `${row.id}-ref`,
        lon,
        lat,
        as_printed: row.coords_as_printed || `${row.lat}, ${row.lon}`,
        label: studyLocation
          ? "Observer/analyst position as printed, not the object's position"
          : "Reference point, not the object's position",
        source_label: studyLocation
          ? "Printed in the official SEFAA/CEFAA case PDF as a georeferenced observer or analyst position. Converted from the printed DMS to decimal degrees. This is not the object's position."
          : rewriteConversionClaim(row.coords_source || "", printedCoordsAreDms(row))
      });
    }

    if (cls.map_kind === "named_site" || cls.map_kind === "named_site_and_reference") {
      const siteQueries = queries;
      let anyHit = false;
      for (const q of siteQueries) {
        const tried = [q, ...(q.fallbacks || []).map((fb) => ({ ...q, q: fb }))];
        let entry = null;
        for (const attempt of tried) {
          entry = await geocodeOne(cache, attempt);
          if (entry && entry.status === "hit" && !isWeakGeocode(entry.result)) break;
          if (entry && entry.status === "hit" && isWeakGeocode(entry.result)) {
            entry = { ...entry, status: "miss", weak: true };
          }
        }
        if (entry && entry.status === "hit" && !isWeakGeocode(entry.result)) {
          counts.geocode_hits += 1;
          const area = areaFromGeocode(q, entry);
          if (area) {
            labelFestivalArea(q, entry, area);
            areas.push(area);
            anyHit = true;
            counts.named_site_areas += 1;
          } else {
            counts.geocode_misses += 1;
          }
        } else if (entry && entry.status === "error") {
          counts.geocode_errors += 1;
          counts.geocode_misses += 1;
        } else {
          counts.geocode_misses += 1;
        }
      }
      if (!anyHit && !referencePoints.length) {
        cls.map_kind = "feed";
        cls.feed_reason = "unknown location";
      } else if (!anyHit && referencePoints.length) {
        cls.map_kind = "reference_point";
      }
    }

    if (cls.map_kind === "feed") {
      counts.feed += 1;
      if (cls.feed_reason === "unknown date") counts.feed_unknown_date += 1;
      else counts.feed_unknown_location += 1;
    } else if (cls.map_kind === "point") counts.point += 1;
    else if (cls.map_kind === "reference_point") counts.reference_point += 1;
    else if (cls.map_kind === "named_site") counts.named_site += 1;
    else if (cls.map_kind === "named_site_and_reference") counts.named_site_and_reference += 1;
    if (officialStatusMeta(row).kind === "explained_resolved") counts.explained_resolved += 1;

    const built = applyCurated(buildCase(row, cls, lat, lon, areas, referencePoints), studyLocation);
    cases.push(built);
  }

  cache.retrieved_et = nowEtStamp();
  cache.user_agent = UA;
  await mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");

  const doc = {
    data_status: "OFFICIAL_RECORD_CASES",
    note: "Official-record cases from the 18 November 2026 source pack. Event coordinates are drawn only when a primary record or official gazetteer printed them. Named-site outlines come from OpenStreetMap and are not event fixes. Cases with an [UNKNOWN] location or date are kept in the Not on the map feed. The app does not add precision the sources do not give.",
    source_pack: `cases.csv (${rows.length} rows), compiled 18 November 2026, America/New_York. See NOTES.md in the pack.`,
    source_files: ["research notes (not published)"],
    updated_et: nowEtStamp(),
    import_counts: counts,
    cases
  };
  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  const slim = {
    ...doc,
    cases: doc.cases.map(slimCase)
  };
  const body = JSON.stringify(slim);
  await writeFile(OUT_PATH, body);
  console.log("cases.json bytes:", Buffer.byteLength(body));

  console.log("\nImport complete");
  console.log("files:", files.join(", "));
  if (skipped.length) console.log("skipped duplicate ids:", skipped);
  console.log("cases:", cases.length);
  console.log("  points:", counts.point);
  console.log("  reference points:", counts.reference_point);
  console.log("  named sites:", counts.named_site);
  console.log("  named site + reference:", counts.named_site_and_reference);
  console.log("  named-site areas drawn:", counts.named_site_areas);
  console.log("  feed:", counts.feed, `(unknown date ${counts.feed_unknown_date}, unknown location ${counts.feed_unknown_location})`);
  console.log("  geocode hits:", counts.geocode_hits, "misses:", counts.geocode_misses, "errors:", counts.geocode_errors);
  console.log("  explained/resolved (filter group):", counts.explained_resolved);
  console.log("  coord parse failures:", counts.coord_parse_failures);
  console.log("wrote", OUT_PATH);
  console.log("cache", CACHE_PATH);
}

export { parseCsv, toDecimalDegrees, parsePrintedPair, officialStatusMeta, geocodeQueriesFor, addModArchiveCitations };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
