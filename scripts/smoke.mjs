#!/usr/bin/env node
/**
 * Headless smoke test: load the app, assert zero console errors,
 * screenshot globe level and street level.
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

    client.on("Runtime.consoleAPICalled", (params) => {
      const text = (params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
      console.log("console." + params.type + ":", text);
      if (params.type === "error") errors.push(text);
      else if (params.type === "warning") warnings.push(text);
    });
    client.on("Runtime.exceptionThrown", (params) => {
      const desc = params.exceptionDetails?.exception?.description
        || params.exceptionDetails?.text
        || "exception";
      console.log("exception:", desc);
      errors.push(desc);
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
    await sleep(2500);

    const globe = await client.send("Page.captureScreenshot", { format: "png" });
    const globePath = path.join(SHOTS, "globe.png");
    await writeFile(globePath, Buffer.from(globe.data, "base64"));
    console.log("wrote", globePath);

    const idsRes = await client.send("Runtime.evaluate", {
      expression: "(window.__WNTR_GLOBE_cases && window.__WNTR_GLOBE_cases() || [])[0]",
      returnByValue: true
    });
    const firstId = idsRes.result && idsRes.result.value;
    if (!firstId) throw new Error("No pilot case id available for street-level shot");

    await client.send("Runtime.evaluate", {
      expression: `window.__WNTR_GLOBE_gotoStreet(${JSON.stringify(firstId)})`,
      awaitPromise: true
    });
    await sleep(5000);

    const street = await client.send("Page.captureScreenshot", { format: "png" });
    const streetPath = path.join(SHOTS, "street.png");
    await writeFile(streetPath, Buffer.from(street.data, "base64"));
    console.log("wrote", streetPath);

    if (warnings.length) {
      console.log("warnings (" + warnings.length + "):");
      warnings.forEach((w) => console.log("  W:", w));
    }
    if (errors.length) {
      console.error("CONSOLE ERRORS (" + errors.length + "):");
      errors.forEach((e) => console.error("  E:", e));
      process.exitCode = 1;
    } else {
      console.log("console errors: 0");
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
