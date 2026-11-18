#!/usr/bin/env node
/**
 * Headless smoke test: one load, period-label sequence, and a 390px phone shot.
 * Usage: node scripts/smoke.mjs [baseUrl]
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const SHOTS = path.join(APP_ROOT, "shots");
const BASE = process.argv[2] || "http://127.0.0.1:8080/";
const DEBUG_PORT = 9333;
const WIDTH = 1440;
const HEIGHT = 900;
const CHROME = process.env.CHROME || "google-chrome";

const errors = [];
const warnings = [];
const nls404s = [];
const otherNetErrors = [];

function isNlsUrl(url) {
  return /geo\.nls\.uk|mapseries-tilesets/.test(String(url || ""));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(fn, timeout, label) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    const v = await fn();
    last = v;
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label} (last=${JSON.stringify(last)})`);
}

async function cdpHttp(pathname, method = "GET") {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}${pathname}`, { method });
  if (!res.ok) throw new Error(`CDP HTTP ${res.status} ${method} ${pathname}`);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json") || pathname.includes("json")) return res.json();
  return res.text();
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.handlers = {};
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve);
      this.ws.addEventListener("error", reject);
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method && this.handlers[msg.method]) this.handlers[msg.method](msg.params);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  on(method, fn) { this.handlers[method] = fn; }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.ws.close(); }
}

function startChrome() {
  const args = [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-background-networking",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    "--hide-scrollbars",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "about:blank"
  ];
  const child = spawn(CHROME, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", () => {});
  return child;
}

async function findPage() {
  try {
    return await cdpHttp("/json/new?about:blank", "PUT");
  } catch {
    try {
      return await cdpHttp("/json/new?about:blank", "GET");
    } catch {
      const list = await cdpHttp("/json/list");
      const page = (list || []).find((t) => t.type === "page");
      if (!page) throw new Error("No page CDP target");
      return page;
    }
  }
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const chrome = startChrome();
  let client;
  try {
    await waitFor(async () => {
      try { await cdpHttp("/json/version"); return true; } catch { return false; }
    }, 15000, "chrome debug port");

    const page = await findPage();
    if (!page.webSocketDebuggerUrl) throw new Error("Page target missing websocket URL");
    client = new Cdp(page.webSocketDebuggerUrl);
    await client.ready;
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await client.send("Console.enable");
    await client.send("Log.enable");
    await client.send("Network.enable");

    client.on("Runtime.consoleAPICalled", (params) => {
      const text = (params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
      console.log("console." + params.type + ":", text);
      if (params.type === "error") {
        if (isNlsUrl(text)) nls404s.push(text);
        else errors.push(text);
      } else if (params.type === "warning") warnings.push(text);
    });
    client.on("Runtime.exceptionThrown", (params) => {
      const desc = params.exceptionDetails?.exception?.description
        || params.exceptionDetails?.text
        || "exception";
      console.log("exception:", desc);
      if (isNlsUrl(desc)) nls404s.push(desc);
      else errors.push(desc);
    });
    client.on("Log.entryAdded", (params) => {
      const entry = params.entry || {};
      const text = `${entry.source || ""} ${entry.level || ""} ${entry.text || ""} ${entry.url || ""}`;
      if (entry.level === "error" || /404/.test(entry.text || "")) {
        if (isNlsUrl(text)) nls404s.push(text.trim());
        else if (entry.level === "error") otherNetErrors.push(text.trim());
      }
    });
    client.on("Network.responseReceived", (params) => {
      const res = params.response || {};
      if (res.status === 404) {
        const url = res.url || "";
        if (isNlsUrl(url)) nls404s.push(url);
        else otherNetErrors.push("HTTP 404 " + url);
      }
    });

    await client.send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false
    });

    await client.send("Page.navigate", { url: BASE });
    try { await client.send("Page.loadEventFired"); } catch { /* may already have fired */ }

    try {
      await waitFor(async () => {
        const res = await client.send("Runtime.evaluate", {
          expression: "Boolean(window.__WNTR_GLOBE_READY)",
          returnByValue: true
        });
        return res.result && res.result.value === true;
      }, 45000, "__WNTR_GLOBE_READY");
    } catch (e) {
      const dump = await client.send("Runtime.evaluate", {
        expression: `JSON.stringify({
          href: location.href,
          title: document.title,
          ready: document.readyState,
          maplibre: typeof maplibregl !== "undefined",
          hook: Boolean(window.__WNTR_GLOBE_READY),
          canvases: document.querySelectorAll("canvas").length,
          text: (document.body && document.body.innerText || "").slice(0, 500)
        })`,
        returnByValue: true
      });
      console.error("debug dump:", dump.result && dump.result.value);
      throw e;
    }

    await client.send("Runtime.evaluate", {
      expression: "window.__WNTR_GLOBE_gotoGlobe && window.__WNTR_GLOBE_gotoGlobe()",
      awaitPromise: true
    });
    const stats = await waitFor(async () => {
      const res = await client.send("Runtime.evaluate", {
        expression: "window.__WNTR_GLOBE_clusterStats && window.__WNTR_GLOBE_clusterStats()",
        returnByValue: true
      });
      const v = res.result && res.result.value;
      if (v && v.loaded > 0 && v.clusters > 0) return v;
      return null;
    }, 20000, "globe-level clusters");
    console.log("cluster stats:", JSON.stringify(stats));
    if (stats.loaded < 200) throw new Error("Expected 200 loaded cases, got " + stats.loaded);
    if (!stats.allYears) throw new Error("Expected All years mode on first load");
    if (!(stats.onGlobe > 0)) throw new Error("Expected cases on the globe, got " + stats.onGlobe);
    if (!(stats.clusters > 0)) throw new Error("Expected globe-level clusters, got " + stats.clusters);
    await sleep(1500);

    const globe = await client.send("Page.captureScreenshot", { format: "png" });
    const globePath = path.join(SHOTS, "globe-clusters.png");
    await writeFile(globePath, Buffer.from(globe.data, "base64"));
    console.log("wrote", globePath);

    const idsAll = await client.send("Runtime.evaluate", {
      expression: "window.__WNTR_GLOBE_cases && window.__WNTR_GLOBE_cases() || []",
      returnByValue: true
    });
    const caseIds = idsAll.result && idsAll.result.value;
    const sequence = [
      {
        id: "tna-defe24-1948-rendlesham-1980",
        file: "period-rendlesham.png",
        expected: "Period map: NLS OS 1:2,500 1974 (6 years before Dec 1980)"
      },
      {
        id: "aaro-puerto-rico-2013",
        file: "period-aguadilla.png",
        expected: "Modern ground: no period map within 10 years (nearest: USGS topo 1960)"
      },
      {
        id: "geipan-1951-06-00002",
        file: "period-france.png",
        expected: "Modern ground: no period imagery available"
      }
    ];
    for (const step of sequence) {
      if (!Array.isArray(caseIds) || !caseIds.includes(step.id)) {
        throw new Error("Missing case " + step.id);
      }
      await client.send("Runtime.evaluate", {
        expression: `window.__WNTR_GLOBE_gotoStreet(${JSON.stringify(step.id)})`,
        awaitPromise: true
      });
      const label = await waitFor(async () => {
        const res = await client.send("Runtime.evaluate", {
          expression: "window.__WNTR_GLOBE_periodLabel && window.__WNTR_GLOBE_periodLabel() || ''",
          returnByValue: true
        });
        const value = res.result && res.result.value;
        return (typeof value === "string" && value.length > 0) ? value : null;
      }, 25000, "period label for " + step.id);
      console.log("period label", step.id, ":", label);
      if (label !== step.expected) {
        throw new Error("Unexpected period label for " + step.id + ": " + label);
      }
      await sleep(3000);
      const shot = await client.send("Page.captureScreenshot", { format: "png" });
      const shotPath = path.join(SHOTS, step.file);
      await writeFile(shotPath, Buffer.from(shot.data, "base64"));
      console.log("wrote", shotPath);
    }

    await client.send("Runtime.evaluate", {
      expression: 'window.__WNTR_GLOBE_gotoStreet("aaro-puerto-rico-2013")',
      awaitPromise: true
    });
    await sleep(2000);

    const layoutExpr = `(() => {
      const box = (el) => {
        if (!el || el.hidden) return null;
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) };
      };
      const overlaps = (a, b) => a && b && !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
      const card = box(document.getElementById("case-card"));
      const banner = box(document.getElementById("period-banner"));
      const nextYear = box(document.getElementById("btn-next-year"));
      const slider = box(document.querySelector(".slider-bar"));
      const attrib = box(document.querySelector(".maplibregl-ctrl-attrib"));
      const layers = box(document.getElementById("btn-layers-toggle"));
      const feed = box(document.getElementById("btn-feed-toggle"));
      const attribEl = document.querySelector(".maplibregl-ctrl-attrib");
      const attribOpen = !!(attribEl && (attribEl.classList.contains("maplibregl-compact-show") || attribEl.querySelector("details[open]") || (attribEl.classList.contains("maplibregl-compact") === false && attribEl.getAttribute("open") != null)));
      return {
        viewport: { w: window.innerWidth, h: window.innerHeight },
        card, banner, nextYear, slider, attrib, layers, feed, attribOpen,
        bannerCoversCard: overlaps(card, banner),
        nextYearOnFirstRow: !!(nextYear && slider && nextYear.top < slider.top + 36 && nextYear.bottom <= slider.bottom + 2),
        attribCoversChrome: !!(overlaps(attrib, layers) || overlaps(attrib, feed) || overlaps(attrib, banner))
      };
    })()`;

    const desktopLayout = await client.send("Runtime.evaluate", { expression: layoutExpr, returnByValue: true });
    console.log("desktop layout:", JSON.stringify(desktopLayout.result && desktopLayout.result.value));
    if (desktopLayout.result && desktopLayout.result.value && desktopLayout.result.value.bannerCoversCard) {
      throw new Error("period banner covers the case card at 1440x900");
    }

    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true
    });
    await client.send("Runtime.evaluate", {
      expression: "window.dispatchEvent(new Event('resize'));",
      returnByValue: true
    });
    await sleep(1500);
    const phoneLayout = await client.send("Runtime.evaluate", { expression: layoutExpr, returnByValue: true });
    const phoneVal = phoneLayout.result && phoneLayout.result.value;
    console.log("phone layout:", JSON.stringify(phoneVal));
    if (!phoneVal || phoneVal.viewport.w !== 390) throw new Error("expected 390px phone viewport");
    if (phoneVal.bannerCoversCard) throw new Error("period banner covers the case card at 390px");
    if (!phoneVal.nextYearOnFirstRow) throw new Error("slider >> wrapped off the first row at 390px");
    if (phoneVal.attribOpen) throw new Error("map credits should start collapsed on the phone");
    if (phoneVal.attribCoversChrome) throw new Error("collapsed map credits cover Layers, Feed, or the banner");
    const opened = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const root = document.querySelector(".maplibregl-ctrl-attrib");
        if (!root) return "missing";
        const details = root.querySelector("details");
        if (details) { details.open = true; return "details"; }
        const btn = root.querySelector("button, summary, .maplibregl-ctrl-attrib-button");
        if (btn) { btn.click(); return "button"; }
        root.click();
        return "root";
      })()`,
      returnByValue: true
    });
    console.log("opened attrib:", opened.result && opened.result.value);
    await sleep(400);
    const phoneOpen = await client.send("Runtime.evaluate", { expression: layoutExpr, returnByValue: true });
    const openVal = phoneOpen.result && phoneOpen.result.value;
    console.log("phone attrib expanded:", JSON.stringify(openVal));
    if (openVal && openVal.attribCoversChrome) {
      throw new Error("expanded map credits cover Layers, Feed, or the banner at 390px");
    }
    const phone = await client.send("Page.captureScreenshot", { format: "png" });
    const phonePath = path.join(SHOTS, "phone.png");
    await writeFile(phonePath, Buffer.from(phone.data, "base64"));
    console.log("wrote", phonePath);

    const uniqueNls = [...new Set(nls404s.map((s) => {
      const m = String(s).match(/https?:\/\/\S+?\.png/);
      return m ? m[0] : String(s);
    }))];
    if (warnings.length) {
      console.log("warnings (" + warnings.length + "):");
      warnings.forEach((w) => console.log("  W:", w));
    }
    console.log("NLS tile 404s (unique):", uniqueNls.length);
    console.log("other network errors:", otherNetErrors.length);
    console.log("other console/page errors:", errors.length);
    const trueCount = uniqueNls.length + otherNetErrors.length + errors.length;
    console.log("true console-error count:", trueCount);
    if (uniqueNls.length) {
      uniqueNls.slice(0, 8).forEach((u) => console.log("  NLS 404:", u));
      if (uniqueNls.length > 8) console.log("  ...", uniqueNls.length - 8, "more");
    }
    if (errors.length || otherNetErrors.length) {
      console.error("NON-NLS ERRORS:");
      errors.concat(otherNetErrors).forEach((e) => console.error("  E:", e));
      process.exitCode = 1;
    } else {
      console.log("non-NLS errors: 0");
    }
  } finally {
    if (client) client.close();
    chrome.kill("SIGTERM");
    await sleep(300);
    try { chrome.kill("SIGKILL"); } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
