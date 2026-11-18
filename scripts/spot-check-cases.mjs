#!/usr/bin/env node
/**
 * Spot-check imported cases against the source CSV.
 * Usage: node scripts/spot-check-cases.mjs [csvPath]
 * Picks 5 rows with a fixed seed so the same five can be re-checked.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "./import-cases.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const DEFAULT_CSV = "/workspace/research/wntrs-globe-200-20261118/cases.csv";
const SEED = 20261118;

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function pickIndices(n, k, seed) {
  const rand = mulberry32(seed);
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, k).sort((a, b) => a - b);
}

function norm(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function almostEqual(a, b, eps = 1e-6) {
  if (a == null && b == null) return true;
  if (typeof a !== "number" || typeof b !== "number") return false;
  return Math.abs(a - b) <= eps;
}

async function main() {
  const csvPath = path.resolve(process.argv[2] || DEFAULT_CSV);
  const casesPath = path.join(APP_ROOT, "data/cases.json");
  const rows = parseCsv(await readFile(csvPath, "utf8"));
  const doc = JSON.parse(await readFile(casesPath, "utf8"));
  const byId = new Map((doc.cases || []).map((c) => [c.id, c]));

  const picks = pickIndices(rows.length, 5, SEED);
  console.log("spot-check seed", SEED, "rows", picks.map((i) => i + 1).join(", "), "of", rows.length);

  let failed = 0;
  for (const i of picks) {
    const row = rows[i];
    const c = byId.get(row.id);
    const problems = [];
    if (!c) {
      problems.push("missing from cases.json");
    } else {
      if (!c.title || !norm(c.title).includes(norm(row.case_name).slice(0, 24)) && !norm(row.case_name).includes(norm(c.title).slice(0, 24))) {
        // Titles may add archive context; require the official case name to appear,
        // or the title to be a prefix of the printed name.
        if (!norm(c.title).includes(norm(row.case_name)) && !norm(row.case_name).includes(norm(c.title))) {
          problems.push(`title mismatch: json=${JSON.stringify(c.title)} csv=${JSON.stringify(row.case_name)}`);
        }
      }
      if (norm(c.date_as_printed) !== norm(row.date)) {
        problems.push(`date mismatch: json=${JSON.stringify(c.date_as_printed)} csv=${JSON.stringify(row.date)}`);
      }
      const srcUrls = (c.sources || []).map((s) => s.url);
      if (!row.url || !srcUrls.includes(row.url)) {
        problems.push(`url missing from citations: ${row.url}`);
      }
      const printedLat = row.lat && row.lat !== "[UNKNOWN]" ? Number(row.lat) : null;
      const printedLon = row.lon && row.lon !== "[UNKNOWN]" ? Number(row.lon) : null;
      if (Number.isFinite(printedLat) && Number.isFinite(printedLon)) {
        const point = (c.areas || []).find((a) => a.kind === "point");
        const ref = (c.reference_points || [])[0];
        const got = point || ref;
        if (!got || !almostEqual(got.lat, printedLat, 1e-4) || !almostEqual(got.lon, printedLon, 1e-4)) {
          problems.push(`coords not drawn as printed: csv=${printedLat},${printedLon} json=${got && got.lat},${got && got.lon}`);
        }
      }
      if (row.date === "[UNKNOWN]" || (row.lat === "[UNKNOWN]" && row.lon === "[UNKNOWN]" && !["named site", "named area"].includes(row.location_precision) && row.area_type !== "named site")) {
        // Soft check: unknown date must be in the feed.
        if (row.date === "[UNKNOWN]" && c.map_kind !== "feed") {
          problems.push(`unknown date should be in the feed, got ${c.map_kind}`);
        }
      }
      if (!c.sources || !c.sources.length) problems.push("no sources");
    }
    if (problems.length) {
      failed += 1;
      console.log("FAIL", row.id);
      problems.forEach((p) => console.log("  -", p));
    } else {
      console.log("OK  ", row.id, "|", c.map_kind, "|", c.date_as_printed, "|", (c.sources[0] && c.sources[0].url) || "");
    }
  }

  if (failed) {
    console.error(`spot-check failed: ${failed} of 5`);
    process.exit(1);
  }
  console.log("spot-check passed: 5 of 5");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
