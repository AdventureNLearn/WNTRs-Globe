(() => {
  "use strict";

  const STYLE_URL = "https://tiles.openfreemap.org/styles/dark";
  const TERRAIN_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
  const CASES_URL = "./data/cases.json";
  const POSTS_URL = "./data/posts.json";
  const TERRAIN_MIN_ZOOM = 11;
  const GLOBE_VIEW = { center: [-32, 36], zoom: 1.65, pitch: 8, bearing: 0 };
  const MONTH_START = { y: 2026, m: 5 }; // June 2026 — posts stay in this window
  const MONTH_END = { y: 2026, m: 10 }; // November 2026
  const CLUSTER_MAX_ZOOM = 6;
  const AREA_MIN_ZOOM = 7;
  const RECORD_BADGE = "Official-record cases: areas shown as recorded";

  const LAYERS = [
    { id: "sightings", name: "Sightings", color: "#3ec6d8", on: true },
    { id: "receipts", name: "Receipts", color: "#e8b84a", on: false },
    { id: "plain-sight", name: "Hid it in plain sight", color: "#9b8cff", on: false },
    { id: "patterns", name: "Find the patterns", color: "#6ecf9a", on: false },
    { id: "psyop", name: "Psyop season", color: "#e8899a", on: false }
  ];

  const LOOKS = {
    night: {
      background: "#2a3548",
      water: "#070b14",
      building: "#1c2a44",
      atmosphere: 1
    },
    schematic: {
      background: "#1a2433",
      water: "#0b1018",
      building: "#2a3b55",
      atmosphere: 0.15
    },
    receipts: {
      background: "#3a342c",
      water: "#12100e",
      building: "#4a3f32",
      atmosphere: 0.35
    }
  };

  const state = {
    map: null,
    cases: [],
    posts: [],
    dataStatus: "EXAMPLE_PLACEHOLDER",
    year: 2026,
    month: 9, // October — posts stay monthly even in All years
    day: 15,
    allYears: true,
    showExplained: true,
    caseYearMin: 1940,
    caseYearMax: 2026,
    activeLook: "night",
    orbitsOn: false,
    feedOn: true,
    terrainOn: false,
    markers: [],
    selectedCaseId: null,
    periodToken: 0,
    periodReady: Promise.resolve(),
    periodLabel: "",
    periodChoice: null,
    olderMapOn: false
  };

  const $ = (id) => document.getElementById(id);

  function monthName(year, monthIndex) {
    return new Date(year, monthIndex, 1).toLocaleString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "America/New_York"
    });
  }

  function daysInMonth(year, monthIndex) {
    return new Date(year, monthIndex + 1, 0).getDate();
  }

  function parseEtDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t).value;
    return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")) };
  }

  function formatFeedDate(iso) {
    const p = parseEtDate(iso);
    if (!p) return "[UNKNOWN]";
    const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
    return `${months[p.month - 1]} ${String(p.day).padStart(2, "0")}`;
  }

  function circlePolygon(lon, lat, radiusM, steps = 64) {
    const coords = [];
    const latRad = (lat * Math.PI) / 180;
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos(latRad);
    for (let i = 0; i <= steps; i += 1) {
      const angle = (i / steps) * 2 * Math.PI;
      coords.push([
        lon + (radiusM * Math.sin(angle)) / mPerDegLon,
        lat + (radiusM * Math.cos(angle)) / mPerDegLat
      ]);
    }
    return { type: "Polygon", coordinates: [coords] };
  }

  function areaList(c) {
    if (Array.isArray(c.areas) && c.areas.length) return c.areas;
    if (c.area) return [c.area];
    return [];
  }

  function ringCenter(coordinates) {
    if (!Array.isArray(coordinates) || !coordinates.length) return null;
    const first = coordinates[0];
    if (typeof first === "number") return { lon: coordinates[0], lat: coordinates[1] };
    // Polygon: first ring; Multi: first polygon's first ring
    let ring = first;
    if (Array.isArray(ring[0]) && Array.isArray(ring[0][0])) ring = ring[0];
    if (Array.isArray(ring[0]) && typeof ring[0][0] === "number") {
      const pts = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
        ? ring.slice(0, -1) : ring;
      if (!pts.length) return null;
      const sum = pts.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
      return { lon: sum[0] / pts.length, lat: sum[1] / pts.length };
    }
    return null;
  }

  function areaCenter(a) {
    if (typeof a.lon === "number" && typeof a.lat === "number") return { lon: a.lon, lat: a.lat };
    if (Array.isArray(a.coordinates)) return ringCenter(a.coordinates);
    return null;
  }

  // Locator / camera aid only — never treat this as an event fix.
  function locatorCenter(c) {
    const areas = areaList(c);
    const pts = areas.map(areaCenter).filter(Boolean);
    if (pts.length) {
      return {
        lon: pts.reduce((s, p) => s + p.lon, 0) / pts.length,
        lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length
      };
    }
    const refs = (c.reference_points || []).filter((rp) => typeof rp.lat === "number" && typeof rp.lon === "number");
    if (refs.length) {
      return {
        lon: refs.reduce((s, p) => s + p.lon, 0) / refs.length,
        lat: refs.reduce((s, p) => s + p.lat, 0) / refs.length
      };
    }
    return null;
  }

  function geometryForArea(a) {
    if (!a) return null;
    if (a.kind === "point_radius" && typeof a.lon === "number" && typeof a.lat === "number" && typeof a.radius_m === "number") {
      return circlePolygon(a.lon, a.lat, a.radius_m);
    }
    if ((a.kind === "polygon" || !a.kind) && Array.isArray(a.coordinates)) {
      return { type: "Polygon", coordinates: a.coordinates };
    }
    if (a.kind === "multipolygon" && Array.isArray(a.coordinates)) {
      return { type: "MultiPolygon", coordinates: a.coordinates };
    }
    if (a.kind === "path" && Array.isArray(a.coordinates)) {
      return { type: "LineString", coordinates: a.coordinates };
    }
    if (a.kind === "point" && typeof a.lon === "number" && typeof a.lat === "number") {
      return { type: "Point", coordinates: [a.lon, a.lat] };
    }
    return null;
  }

  function featuresForCase(c) {
    return areaList(c).map((a, i) => {
      const geometry = geometryForArea(a);
      if (!geometry) return null;
      return {
        type: "Feature",
        properties: {
          id: c.id,
          area_id: a.id || String(i),
          title: c.title,
          area_name: a.name || "",
          precision_label: c.precision_label || "Precision: [UNKNOWN]",
          placeholder: !!c.placeholder
        },
        geometry
      };
    }).filter(Boolean);
  }

  function isFeedCase(c) {
    return c.map_kind === "feed";
  }

  function caseInDateWindow(c) {
    if (state.allYears) return true;
    const y = c.incident_year;
    if (!y) return false;
    const yEnd = c.incident_year_end || y;
    if (state.year < y || state.year > yEnd) return false;
    const prec = c.incident_date_precision;
    if (prec === "year" || prec === "range" || !c.incident_month) return true;
    return c.incident_month === state.month + 1;
  }

  function isExplainedResolved(c) {
    return c.official_status_kind === "explained_resolved";
  }

  function casePassesStatusFilter(c) {
    return state.showExplained || !isExplainedResolved(c);
  }

  function casesOnGlobe() {
    return state.cases.filter((c) => !isFeedCase(c) && caseInDateWindow(c) && casePassesStatusFilter(c) && locatorCenter(c));
  }

  function officialFeedCases() {
    return state.cases.filter((c) => {
      if (!isFeedCase(c)) return false;
      if (!casePassesStatusFilter(c)) return false;
      if (c.feed_reason === "unknown date" || !c.incident_year) return true;
      return caseInDateWindow(c);
    });
  }

  function setCaseYearBounds(cases) {
    const years = cases.map((c) => c.incident_year).filter(Boolean);
    const ends = cases.map((c) => c.incident_year_end).filter(Boolean);
    state.caseYearMin = 1940;
    state.caseYearMax = 2026;
    if (years.length) {
      state.caseYearMin = Math.min(state.caseYearMin, ...years);
      state.caseYearMax = Math.max(state.caseYearMax, ...years, ...ends);
    }
  }

  async function loadJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
    return res.json();
  }

  function reduceMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function flyDuration(ms) {
    return reduceMotion() ? 0 : ms;
  }

  function waitForIdle(map, timeoutMs = 12000) {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      if (!map.isMoving() && !map.isEasing() && map.areTilesLoaded()) {
        // One more frame so late paint can settle.
        map.once("idle", done);
        // If already idle, the event may not fire again; resolve shortly.
        setTimeout(done, 50);
        return;
      }
      map.once("idle", done);
    });
  }

  function initLayerPanel() {
    const wrap = $("layer-rows");
    wrap.innerHTML = "";
    LAYERS.forEach((layer) => {
      const row = document.createElement("div");
      row.className = "layer-row";
      row.innerHTML = `
        <b class="layer-dot" style="color:${layer.color};background:${layer.color}"></b>
        <span>${layer.name}</span>
        <label class="switch">
          <input type="checkbox" data-layer="${layer.id}" ${layer.on ? "checked" : ""} />
          <i></i>
        </label>`;
      wrap.appendChild(row);
    });
    wrap.addEventListener("change", (e) => {
      const input = e.target.closest("input[data-layer]");
      if (!input) return;
      const layer = LAYERS.find((l) => l.id === input.dataset.layer);
      if (layer) layer.on = input.checked;
      renderFeed();
    });
  }

  function postsInView() {
    const on = new Set(LAYERS.filter((l) => l.on).map((l) => l.id));
    return state.posts.filter((p) => {
      const d = parseEtDate(p.date_et);
      if (!d || d.year !== state.year || d.month !== state.month + 1) return false;
      const tags = Array.isArray(p.layers) ? p.layers : [];
      return tags.some((t) => on.has(t));
    });
  }

  function renderFeed() {
    const list = $("feed-list");
    const lead = $("feed-panel") && $("feed-panel").querySelector(".panel-lead");
    if (lead) {
      lead.textContent = "Official-record cases with an [UNKNOWN] location or date stay here, along with posts that have no place pin.";
    }
    const official = officialFeedCases();
    const items = postsInView().filter((p) => p.located === false);
    if (!official.length && !items.length) {
      list.innerHTML = `<p class="panel-lead">No official-record cases or unlocated posts in this window for the layers that are on.</p>`;
      return;
    }
    const officialHtml = official.map((c) => {
      const date = c.date_as_printed || "[UNKNOWN]";
      const reason = c.feed_reason === "unknown date"
        ? "Date [UNKNOWN] — not on the map"
        : c.feed_reason === "unknown location"
          ? "Location [UNKNOWN] — not on the map"
          : "Not on the map";
      const first = Array.isArray(c.sources) && c.sources[0];
      const source = first && first.url
        ? `<a href="${escapeHtml(first.url)}" target="_blank" rel="noopener">${escapeHtml(first.label || "Source")}</a>`
        : "";
      return `<article class="feed-card is-official" data-feed-case="${escapeHtml(c.id)}">
        <p class="feed-date">${escapeHtml(date)}</p>
        <p class="feed-excerpt">${escapeHtml(c.title || "[UNKNOWN]")}</p>
        <p class="feed-source">${escapeHtml(reason)}${source ? " · " + source : ""}</p>
      </article>`;
    }).join("");
    const postsHtml = items.map((p) => {
      const dim = parseEtDate(p.date_et)?.day !== state.day;
      const example = p.import_ok === false || state.dataStatus === "EXAMPLE_PLACEHOLDER";
      const source = p.source_url
        ? `<a href="${p.source_url}" target="_blank" rel="noopener">Source → post</a>`
        : `SOURCE → [UNKNOWN]`;
      return `<article class="feed-card${dim ? " is-dim" : " is-emphasized"}">
        <p class="feed-date">${formatFeedDate(p.date_et)}${example ? '<span class="example-tag">EXAMPLE</span>' : ""}</p>
        <p class="feed-excerpt">${escapeHtml(p.excerpt || "[UNKNOWN]")}</p>
        <p class="feed-source">${source}</p>
      </article>`;
    }).join("");
    list.innerHTML = officialHtml + postsHtml;
    list.querySelectorAll("[data-feed-case]").forEach((el) => {
      el.style.cursor = "pointer";
      el.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
        openCase(el.dataset.feedCase);
      });
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function daysWithPosts() {
    const set = new Set();
    postsInView().forEach((p) => {
      const d = parseEtDate(p.date_et);
      if (d) set.add(d.day);
    });
    return set;
  }

  function renderSlider() {
    const max = daysInMonth(state.year, state.month);
    const slider = $("day-slider");
    if (state.day > max) state.day = max;
    slider.max = String(max);
    slider.value = String(state.day);
    const label = state.allYears ? "All years" : monthName(state.year, state.month);
    $("month-label").textContent = label;
    $("slider-month").textContent = label;
    const postsLabel = $("posts-label");
    if (postsLabel) postsLabel.textContent = `Posts: ${monthName(state.year, state.month)}`;
    const allBtn = $("btn-all-years");
    if (allBtn) {
      allBtn.classList.toggle("is-on", state.allYears);
      allBtn.setAttribute("aria-pressed", state.allYears ? "true" : "false");
    }
    const marks = daysWithPosts();
    const ticks = $("slider-ticks");
    ticks.innerHTML = "";
    for (let d = 1; d <= max; d += 1) {
      const el = document.createElement("span");
      el.className = "tick" + (marks.has(d) ? " has-post" : "");
      el.style.left = `${((d - 1) / (max - 1)) * 100}%`;
      ticks.appendChild(el);
    }
    renderFeed();
  }

  function clampCaseWindow(y, m) {
    if (y < state.caseYearMin) return null;
    if (y > state.caseYearMax) return null;
    if (y === state.caseYearMax && m > MONTH_END.m) return null;
    return { y, m };
  }

  function shiftMonth(delta) {
    state.allYears = false;
    let y = state.year;
    let m = state.month + delta;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    const next = clampCaseWindow(y, m);
    if (!next) return;
    state.year = next.y;
    state.month = next.m;
    const max = daysInMonth(next.y, next.m);
    if (state.day > max) state.day = max;
    renderSlider();
    if (state.map && state.map.isStyleLoaded && state.map.isStyleLoaded()) addCaseLayers();
  }

  function shiftYear(delta) {
    state.allYears = false;
    const next = clampCaseWindow(state.year + delta, state.month);
    if (!next) return;
    state.year = next.y;
    state.month = next.m;
    const max = daysInMonth(next.y, next.m);
    if (state.day > max) state.day = max;
    renderSlider();
    if (state.map && state.map.isStyleLoaded && state.map.isStyleLoaded()) addCaseLayers();
  }

  function setAllYears() {
    state.allYears = true;
    renderSlider();
    if (state.map && state.map.isStyleLoaded && state.map.isStyleLoaded()) addCaseLayers();
  }

  function setDataBanner() {
    const el = $("data-banner");
    el.hidden = false;
    if (state.dataStatus === "EXAMPLE_PLACEHOLDER" || state.cases.some((c) => c.placeholder)) {
      el.textContent = "EXAMPLE data — not real cases";
      return;
    }
    const onMap = state.cases.filter((c) => !isFeedCase(c)).length;
    const feedN = state.cases.filter(isFeedCase).length;
    const postsN = state.posts.length;
    el.textContent = `${RECORD_BADGE} · ${onMap} on the map, ${feedN} in the feed · ${postsN} post${postsN === 1 ? "" : "s"}`;
    el.style.background = "rgba(62, 198, 216, 0.14)";
    el.style.borderColor = "rgba(62, 198, 216, 0.4)";
    el.style.color = "#b9eef5";
  }

  function applyLook(name) {
    const look = LOOKS[name] || LOOKS.night;
    state.activeLook = name;
    const map = state.map;
    if (!map || !map.getLayer("background")) return;
    map.setPaintProperty("background", "background-color", look.background);
    if (map.getLayer("water")) map.setPaintProperty("water", "fill-color", look.water);
    if (map.getLayer("buildings-3d")) {
      map.setPaintProperty("buildings-3d", "fill-extrusion-color", look.building);
    }
    map.setSky({
      "atmosphere-blend": [
        "interpolate", ["linear"], ["zoom"],
        0, look.atmosphere,
        5, look.atmosphere,
        7, 0
      ]
    });
  }

  function setOrbits(on) {
    state.orbitsOn = on;
    $("orbits").classList.toggle("is-off", !on);
    updateOrbitsZoom();
  }

  function updateOrbitsZoom() {
    const hide = !state.map || state.map.getZoom() >= 4.5;
    $("orbits").classList.toggle("is-hidden-zoom", hide);
  }

  function setTerrainForZoom() {
    const map = state.map;
    if (!map.getSource("terrain")) return;
    const should = map.getZoom() >= TERRAIN_MIN_ZOOM;
    if (should && !state.terrainOn) {
      map.setTerrain({ source: "terrain", exaggeration: 1.15 });
      state.terrainOn = true;
    } else if (!should && state.terrainOn) {
      map.setTerrain(null);
      state.terrainOn = false;
    }
  }

  function locatorFeatureCollection(cases) {
    const features = cases.map((c) => {
      const loc = locatorCenter(c);
      if (!loc) return null;
      return {
        type: "Feature",
        properties: { id: c.id, title: c.title || "", map_kind: c.map_kind || "" },
        geometry: { type: "Point", coordinates: [loc.lon, loc.lat] }
      };
    }).filter(Boolean);
    return { type: "FeatureCollection", features };
  }

  function addCaseLayers() {
    const map = state.map;
    if (!map) return;
    const visible = casesOnGlobe();
    const sourceData = { type: "FeatureCollection", features: visible.flatMap(featuresForCase) };
    const locatorData = locatorFeatureCollection(visible);

    if (map.getSource("cases")) {
      map.getSource("cases").setData(sourceData);
    } else {
      map.addSource("cases", { type: "geojson", data: sourceData });
      map.addLayer({
        id: "case-fill",
        type: "fill",
        source: "cases",
        minzoom: AREA_MIN_ZOOM,
        filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
        paint: {
          "fill-color": "#7ad4ea",
          "fill-opacity": 0.22
        }
      });
      map.addLayer({
        id: "case-line",
        type: "line",
        source: "cases",
        minzoom: AREA_MIN_ZOOM,
        filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon", "LineString"]]],
        paint: {
          "line-color": "#d7ecff",
          "line-width": 2,
          "line-opacity": 0.95
        }
      });
      map.addLayer({
        id: "case-points",
        type: "circle",
        source: "cases",
        minzoom: 8,
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 5, 14, 8, 17, 6],
          "circle-color": "#e8f6ff",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#7ad4ea",
          "circle-pitch-alignment": "map"
        }
      });
      map.on("click", "case-fill", (e) => {
        const id = e.features && e.features[0] && e.features[0].properties.id;
        if (id) openCase(id);
      });
      map.on("click", "case-points", (e) => {
        const id = e.features && e.features[0] && e.features[0].properties.id;
        if (id) openCase(id);
      });
      map.on("mouseenter", "case-fill", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "case-fill", () => { map.getCanvas().style.cursor = ""; });
      map.on("mouseenter", "case-points", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "case-points", () => { map.getCanvas().style.cursor = ""; });
    }

    if (map.getSource("case-locators")) {
      map.getSource("case-locators").setData(locatorData);
    } else {
      map.addSource("case-locators", {
        type: "geojson",
        data: locatorData,
        cluster: true,
        clusterMaxZoom: CLUSTER_MAX_ZOOM,
        clusterRadius: 56
      });
      map.addLayer({
        id: "case-clusters",
        type: "circle",
        source: "case-locators",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": [
            "step",
            ["get", "point_count"],
            "rgba(122, 212, 234, 0.85)",
            10, "rgba(90, 190, 220, 0.9)",
            30, "rgba(62, 198, 216, 0.95)"
          ],
          "circle-radius": [
            "step",
            ["get", "point_count"],
            16,
            10, 20,
            30, 26
          ],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#e8f6ff",
          "circle-pitch-alignment": "map"
        }
      });
      map.addLayer({
        id: "case-cluster-count",
        type: "symbol",
        source: "case-locators",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 12,
          "text-font": ["Noto Sans Regular"],
          "text-allow-overlap": true,
          "text-ignore-placement": true
        },
        paint: {
          "text-color": "#041018"
        }
      });
      map.addLayer({
        id: "case-locator-halo",
        type: "circle",
        source: "case-locators",
        filter: ["!", ["has", "point_count"]],
        maxzoom: 11,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 16, 4, 12, 9, 8],
          "circle-color": "rgba(122, 212, 234, 0.3)",
          "circle-stroke-width": 0,
          "circle-pitch-alignment": "map"
        }
      });
      map.addLayer({
        id: "case-locator-core",
        type: "circle",
        source: "case-locators",
        filter: ["!", ["has", "point_count"]],
        maxzoom: 11,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 7, 4, 6, 9, 5],
          "circle-color": "#e8f6ff",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#7ad4ea",
          "circle-pitch-alignment": "map"
        }
      });
      map.addLayer({
        id: "case-locator-label",
        type: "symbol",
        source: "case-locators",
        filter: ["!", ["has", "point_count"]],
        minzoom: 7,
        maxzoom: 11,
        layout: {
          "text-field": ["get", "title"],
          "text-size": 11,
          "text-offset": [0, 1.15],
          "text-anchor": "top",
          "text-font": ["Noto Sans Regular"]
        },
        paint: {
          "text-color": "#e8f6ff",
          "text-halo-color": "#070b14",
          "text-halo-width": 1.6
        }
      });
      map.on("click", "case-clusters", (e) => {
        const feature = e.features && e.features[0];
        if (!feature) return;
        const clusterId = feature.properties.cluster_id;
        map.getSource("case-locators").getClusterExpansionZoom(clusterId, (err, zoom) => {
          if (err) return;
          map.easeTo({
            center: feature.geometry.coordinates,
            zoom,
            duration: flyDuration(800)
          });
        });
      });
      map.on("click", "case-locator-core", (e) => {
        const id = e.features && e.features[0] && e.features[0].properties.id;
        if (id) openCase(id);
      });
      map.on("click", "case-locator-halo", (e) => {
        const id = e.features && e.features[0] && e.features[0].properties.id;
        if (id) openCase(id);
      });
      map.on("mouseenter", "case-clusters", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "case-clusters", () => { map.getCanvas().style.cursor = ""; });
      map.on("mouseenter", "case-locator-core", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "case-locator-core", () => { map.getCanvas().style.cursor = ""; });
    }

    buildCaseMarkers(visible);
  }

  function buildCaseMarkers(visible) {
    const map = state.map;
    state.markers.forEach((m) => m.remove());
    state.markers = [];
    if (!map || map.getZoom() < 8) return;
    visible.forEach((c) => {
      const loc = locatorCenter(c);
      if (loc) {
        const prec = document.createElement("div");
        prec.className = "area-label";
        prec.textContent = c.precision_label || "Precision: [UNKNOWN]";
        const precMarker = new maplibregl.Marker({ element: prec, anchor: "bottom", offset: [0, -14] })
          .setLngLat([loc.lon, loc.lat])
          .addTo(map);
        precMarker.getElement().dataset.role = "precision";
        state.markers.push(precMarker);
      }

      areaList(c).forEach((a) => {
        const center = areaCenter(a);
        if (!center || !a.name) return;
        const label = document.createElement("div");
        label.className = "area-label";
        label.textContent = a.name;
        const mk = new maplibregl.Marker({ element: label, anchor: "center" })
          .setLngLat([center.lon, center.lat])
          .addTo(map);
        mk.getElement().dataset.role = "area-name";
        state.markers.push(mk);
      });

      (c.reference_points || []).forEach((rp) => {
        if (typeof rp.lat !== "number" || typeof rp.lon !== "number") return;
        const cross = document.createElement("div");
        cross.className = "ref-point";
        const crossMk = new maplibregl.Marker({ element: cross, anchor: "center" })
          .setLngLat([rp.lon, rp.lat])
          .addTo(map);
        crossMk.getElement().dataset.role = "ref";
        state.markers.push(crossMk);

        const lab = document.createElement("div");
        lab.className = "ref-label";
        lab.textContent = rp.label || "Reference point, not the object's position";
        const labMk = new maplibregl.Marker({ element: lab, anchor: "top", offset: [0, 8] })
          .setLngLat([rp.lon, rp.lat])
          .addTo(map);
        labMk.getElement().dataset.role = "ref";
        state.markers.push(labMk);
      });
    });
    applyMarkerVisibility();
  }

    function updateLabelVisibility() {
    const z = state.map ? state.map.getZoom() : 0;
    const needMarkers = z >= 8;
    if (needMarkers && !state.markers.length && state.map && state.map.getSource("cases")) {
      buildCaseMarkers(casesOnGlobe());
      return;
    }
    if (!needMarkers && state.markers.length) {
      state.markers.forEach((m) => m.remove());
      state.markers = [];
      return;
    }
    applyMarkerVisibility();
  }

  function applyMarkerVisibility() {
    const z = state.map ? state.map.getZoom() : 0;
    state.markers.forEach((m) => {
      const el = m.getElement();
      if (!el || !el.dataset.role) return;
      const role = el.dataset.role;
      if (role === "locator") el.style.display = z < 10 ? "block" : "none";
      if (role === "precision") el.style.display = z >= 8 && z < 13 ? "block" : "none";
      if (role === "area-name") el.style.display = z >= 11 ? "block" : "none";
      if (role === "ref") el.style.display = z >= 13 ? "block" : "none";
    });
  }

  function addBuildingsAndTerrain() {
    const map = state.map;
    if (map.getLayer("building")) {
      map.setLayerZoomRange("building", 12, 14);
    }
    if (!map.getLayer("buildings-3d") && map.getSource("openmaptiles")) {
      map.addLayer({
        id: "buildings-3d",
        type: "fill-extrusion",
        source: "openmaptiles",
        "source-layer": "building",
        minzoom: 14,
        filter: ["!", ["has", "hide_3d"]],
        paint: {
          "fill-extrusion-color": LOOKS[state.activeLook].building,
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], 0],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
          "fill-extrusion-opacity": 0.92
        }
      });
    }
    if (!map.getSource("terrain")) {
      const dem = {
        type: "raster-dem",
        tiles: [TERRAIN_TILES],
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 15,
        attribution: 'Terrain tiles by <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Tilezen/Mapzen, AWS Open Data</a> (USGS, NOAA ETOPO1, EU-DEM/Copernicus, and other sources — see README)'
      };
      map.addSource("terrain", dem);
      map.addSource("terrain-hillshade", { ...dem });
      map.addLayer({
        id: "hillshade",
        type: "hillshade",
        source: "terrain-hillshade",
        minzoom: 11,
        paint: {
          "hillshade-exaggeration": 0.32,
          "hillshade-shadow-color": "#000000",
          "hillshade-highlight-color": "#8ea0bb",
          "hillshade-illumination-direction": 315
        }
      }, map.getLayer("buildings-3d") ? "buildings-3d" : undefined);
    }
    setTerrainForZoom();
  }

  function onStyleReady() {
    const map = state.map;
    map.setProjection({ type: "globe" });
    applyLook(state.activeLook);
    addBuildingsAndTerrain();
    addCaseLayers();
    if (state.selectedCaseId) {
      const c = state.cases.find((x) => x.id === state.selectedCaseId);
      if (c) state.periodReady = applyPeriodGround(c);
    }
  }

  function caseViewPoint(c) {
    const sv = (c && c.street_view) || {};
    if (typeof sv.lon === "number" && typeof sv.lat === "number") {
      return { lon: sv.lon, lat: sv.lat };
    }
    return locatorCenter(c);
  }

  function syncOlderToggles(on, show, text) {
    ["period-older-wrap", "case-older-wrap"].forEach((id) => {
      const wrap = $(id);
      if (wrap) wrap.hidden = !show;
    });
    ["toggle-older-map", "case-toggle-older-map"].forEach((id) => {
      const input = $(id);
      if (input) input.checked = !!on;
    });
    ["period-older-text", "case-older-text"].forEach((id) => {
      const span = $(id);
      if (span) span.textContent = text || "Show older map";
    });
  }

  function setPeriodLabel(choice, olderOn) {
    const showOlder = !!(choice && choice.showOlderToggle && olderOn);
    const label = showOlder
      ? (choice.olderLabel || choice.label)
      : ((choice && choice.label) || "Modern ground: no period imagery available");
    const note = (choice && choice.note) || "";
    state.periodLabel = label;
    const banner = $("period-banner") || $("period-label");
    const text = $("period-label");
    const card = $("case-period");
    const cardNote = $("case-period-note");
    if (banner) banner.hidden = false;
    if (text) text.textContent = label;
    if (card) {
      card.hidden = false;
      card.textContent = label;
    }
    if (cardNote) {
      cardNote.hidden = !note;
      cardNote.textContent = note;
    }
    syncOlderToggles(
      showOlder,
      !!(choice && choice.showOlderToggle),
      (choice && choice.toggleLabel) || "Show older map"
    );
  }

  function clearPeriodLabel() {
    state.periodLabel = "";
    state.periodChoice = null;
    state.olderMapOn = false;
    const banner = $("period-banner") || $("period-label");
    const text = $("period-label");
    const card = $("case-period");
    const cardNote = $("case-period-note");
    if (banner) banner.hidden = true;
    if (text) text.textContent = "";
    if (card) {
      card.hidden = true;
      card.textContent = "";
    }
    if (cardNote) {
      cardNote.hidden = true;
      cardNote.textContent = "";
    }
    syncOlderToggles(false, false, "Show older map");
  }

  function paintPeriodGround(choice, olderOn) {
    const api = window.WNTRPeriodGround;
    if (!api || !state.map) return;
    state.olderMapOn = !!olderOn;
    api.apply(state.map, choice, { beforeId: "case-fill", showOlder: !!olderOn });
    setPeriodLabel(choice, olderOn);
  }

  function setOlderMap(on) {
    if (!state.periodChoice || !state.periodChoice.showOlderToggle) return;
    paintPeriodGround(state.periodChoice, !!on);
  }

  async function waitForMapReady(map) {
    if (!map) return;
    if (!(map.isStyleLoaded && map.isStyleLoaded())) {
      await new Promise((resolve) => {
        if (map.isStyleLoaded && map.isStyleLoaded()) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, 12000);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        map.once("style.load", done);
        map.once("idle", done);
      });
    }
    await waitForIdle(map);
  }

  function clearPeriodNow() {
    state.periodToken += 1;
    state.periodChoice = null;
    state.olderMapOn = false;
    if (window.WNTRPeriodGround && state.map) window.WNTRPeriodGround.clear(state.map);
    clearPeriodLabel();
  }

  async function applyPeriodGround(c) {
    const token = ++state.periodToken;
    const loc = caseViewPoint(c);
    const api = window.WNTRPeriodGround;
    state.olderMapOn = false;
    if (api && state.map) api.clear(state.map);
    clearPeriodLabel();
    if (!api || !state.map) {
      if (token !== state.periodToken) return;
      setPeriodLabel({ label: "Modern ground: no period imagery available" }, false);
      return;
    }
    let choice;
    try {
      choice = await api.choose(c, loc && loc.lon, loc && loc.lat);
    } catch (err) {
      console.warn("period ground lookup failed:", err && err.message || err);
      choice = { kind: "modern", label: "Modern ground: no period imagery available" };
    }
    if (token !== state.periodToken) return;
    await waitForMapReady(state.map);
    if (token !== state.periodToken) return;
    state.periodChoice = choice;
    paintPeriodGround(choice, false);
  }

  function openCase(id) {
    const c = state.cases.find((x) => x.id === id);
    if (!c) return;
    clearPeriodNow();
    state.selectedCaseId = id;
    const card = $("case-card");
    card.hidden = false;
    $("case-kicker").textContent = c.placeholder
      ? "EXAMPLE — not a real case"
      : RECORD_BADGE;
    $("case-title").textContent = c.title || "[UNKNOWN]";
    $("case-place").textContent = c.place_label || "Place: [UNKNOWN]";
    const when = [c.date_as_printed, c.time_as_printed].filter(Boolean).join(" · ");
    const timeBits = [when, c.time_notes].filter(Boolean).join("\n\n");
    $("case-datetime").textContent = timeBits || "Date and time: [UNKNOWN]";
    $("case-datetime").style.whiteSpace = "pre-wrap";
    $("case-precision").textContent = c.precision_label || "Precision: [UNKNOWN]";
    $("case-note").textContent = c.precision_note || "";
    $("case-summary").textContent = c.summary || "";
    const gloss = $("case-status-gloss");
    if (gloss) {
      gloss.textContent = c.official_status_gloss || "";
      gloss.hidden = !c.official_status_gloss;
    }
    $("case-status").textContent = c.official_status || "";
    const unk = $("case-unknown");
    if (Array.isArray(c.unknown) && c.unknown.length) {
      unk.innerHTML = `<p class="panel-lead">Marked [UNKNOWN]</p><ul class="unknown-list">${c.unknown.map((u) => `<li>${escapeHtml(u)}</li>`).join("")}</ul>`;
    } else {
      unk.innerHTML = "";
    }
    const gaps = $("case-gaps");
    if (gaps) {
      if (Array.isArray(c.source_gaps) && c.source_gaps.length) {
        gaps.innerHTML = `<p class="panel-lead">Source gaps</p><ul class="unknown-list">${c.source_gaps.map((u) => `<li>${escapeHtml(u)}</li>`).join("")}</ul>`;
      } else {
        gaps.innerHTML = "";
      }
    }
    const src = $("case-sources");
    if (Array.isArray(c.sources) && c.sources.length) {
      src.innerHTML = `<p class="panel-lead">Primary sources</p><ul class="source-list">${c.sources.map((s) => {
        const href = s.url || s;
        const label = s.label || s.url || s;
        if (!href || href === "[UNKNOWN]") return `<li>[UNKNOWN]</li>`;
        return `<li><a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(label)}</a></li>`;
      }).join("")}</ul>`;
    } else {
      src.innerHTML = `<p class="panel-lead">Primary sources: [UNKNOWN]</p>`;
    }
    const canStreet = !!(c.street_view || locatorCenter(c));
    const streetBtn = $("btn-street");
    if (streetBtn) streetBtn.hidden = !canStreet;
    if (canStreet) {
      state.periodReady = applyPeriodGround(c);
    } else {
      state.periodToken += 1;
      if (window.WNTRPeriodGround && state.map) window.WNTRPeriodGround.clear(state.map);
      clearPeriodLabel();
      state.periodReady = Promise.resolve();
    }
  }

  function closeCase() {
    state.periodToken += 1;
    state.selectedCaseId = null;
    $("case-card").hidden = true;
    clearPeriodLabel();
    if (window.WNTRPeriodGround && state.map) window.WNTRPeriodGround.clear(state.map);
    state.periodReady = Promise.resolve();
  }

  async function flyToGlobe() {
    const map = state.map;
    map.flyTo({ ...GLOBE_VIEW, duration: flyDuration(3500), essential: true });
    await waitForIdle(map);
  }

  async function flyToStreet(id) {
    const c = state.cases.find((x) => x.id === id);
    if (!c) return;
    const sv = c.street_view || {};
    const loc = (typeof sv.lon === "number" && typeof sv.lat === "number")
      ? { lon: sv.lon, lat: sv.lat }
      : locatorCenter(c);
    if (!loc) return;
    openCase(c.id);
    state.map.flyTo({
      center: [loc.lon, loc.lat],
      zoom: sv.zoom ?? 16.5,
      pitch: sv.pitch ?? 58,
      bearing: sv.bearing ?? 0,
      duration: flyDuration(4500),
      essential: true
    });
    await Promise.all([waitForIdle(state.map), state.periodReady]);
    await waitForIdle(state.map);
  }

  function renderViewControls() {
    const wrap = $("view-controls");
    wrap.innerHTML = `<button type="button" id="btn-globe">Globe view</button>`;
    $("btn-globe").addEventListener("click", () => flyToGlobe());
  }

  function wireUi() {
    $("btn-all-years").addEventListener("click", () => setAllYears());
    $("btn-prev-year").addEventListener("click", () => shiftYear(-1));
    $("btn-prev-month").addEventListener("click", () => shiftMonth(-1));
    $("btn-next-month").addEventListener("click", () => shiftMonth(1));
    $("btn-next-year").addEventListener("click", () => shiftYear(1));
    $("day-slider").addEventListener("input", (e) => {
      state.day = Number(e.target.value);
      renderFeed();
    });
    $("btn-howto").addEventListener("click", () => {
      const panel = $("howto-panel");
      const open = panel.hidden;
      panel.hidden = !open;
      $("btn-howto").setAttribute("aria-expanded", String(open));
      if (window.matchMedia("(max-width: 900px)").matches) {
        panel.classList.toggle("is-open", open);
        $("layers-panel").classList.remove("is-open");
        $("feed-panel").classList.remove("is-open");
      }
    });
    document.querySelectorAll("input[name=look]").forEach((r) => {
      r.addEventListener("change", () => applyLook(r.value));
    });
    $("toggle-orbits").addEventListener("change", (e) => setOrbits(e.target.checked));
    $("toggle-feed").addEventListener("change", (e) => {
      state.feedOn = e.target.checked;
      $("feed-panel").style.display = state.feedOn ? "" : "none";
    });
    const explained = $("toggle-explained");
    if (explained) {
      explained.checked = state.showExplained;
      explained.addEventListener("change", (e) => {
        state.showExplained = e.target.checked;
        renderFeed();
        if (state.map && state.map.isStyleLoaded && state.map.isStyleLoaded()) addCaseLayers();
      });
    }
    $("btn-reset-look").addEventListener("click", () => {
      document.querySelector("input[name=look][value=night]").checked = true;
      applyLook("night");
      $("toggle-orbits").checked = false;
      setOrbits(false);
      $("toggle-feed").checked = true;
      $("toggle-feed").dispatchEvent(new Event("change"));
    });
    $("btn-close-card").addEventListener("click", closeCase);
    $("btn-street").addEventListener("click", () => {
      if (state.selectedCaseId) flyToStreet(state.selectedCaseId);
    });
    const onOlderToggle = (e) => setOlderMap(e.target.checked);
    ["toggle-older-map", "case-toggle-older-map"].forEach((id) => {
      const input = $(id);
      if (input) input.addEventListener("change", onOlderToggle);
    });
    $("btn-layers-toggle").addEventListener("click", () => {
      $("layers-panel").classList.toggle("is-open");
      $("feed-panel").classList.remove("is-open");
      $("howto-panel").hidden = true;
    });
    $("btn-feed-toggle").addEventListener("click", () => {
      $("feed-panel").classList.toggle("is-open");
      $("layers-panel").classList.remove("is-open");
      $("howto-panel").hidden = true;
    });
  }

  function exposeHooks() {
    window.__WNTR_GLOBE_gotoGlobe = flyToGlobe;
    window.__WNTR_GLOBE_gotoStreet = flyToStreet;
    window.__WNTR_GLOBE_cases = () => state.cases.map((c) => c.id);
    window.__WNTR_GLOBE_periodLabel = () => state.periodLabel;
    window.__WNTR_GLOBE_showOlderMap = (on) => setOlderMap(!!on);
    window.__WNTR_GLOBE_clusterStats = () => {
      const map = state.map;
      if (!map) return null;
      const has = (id) => !!map.getLayer(id);
      const clusters = has("case-clusters") ? map.queryRenderedFeatures({ layers: ["case-clusters"] }).length : 0;
      const unclustered = has("case-locator-core") ? map.queryRenderedFeatures({ layers: ["case-locator-core"] }).length : 0;
      return {
        clusters,
        unclustered,
        zoom: map.getZoom(),
        allYears: state.allYears,
        onGlobe: casesOnGlobe().length,
        feed: officialFeedCases().length,
        loaded: state.cases.length
      };
    };
  }

  async function start() {
    initLayerPanel();
    wireUi();
    let casesDoc;
    let postsDoc;
    try {
      [casesDoc, postsDoc] = await Promise.all([loadJson(CASES_URL), loadJson(POSTS_URL)]);
    } catch (err) {
      console.error(err);
      $("data-banner").hidden = false;
      $("data-banner").textContent = "Could not load local data files";
      return;
    }
    state.cases = Array.isArray(casesDoc.cases) ? casesDoc.cases.slice() : [];
    state.posts = Array.isArray(postsDoc.posts) ? postsDoc.posts : [];
    state.dataStatus = casesDoc.data_status || "EXAMPLE_PLACEHOLDER";
    setCaseYearBounds(state.cases);
    setDataBanner();
    renderSlider();
    renderViewControls();

    const map = new maplibregl.Map({
      container: "map",
      style: STYLE_URL,
      center: GLOBE_VIEW.center,
      zoom: GLOBE_VIEW.zoom,
      pitch: GLOBE_VIEW.pitch,
      bearing: GLOBE_VIEW.bearing,
      maxPitch: 80,
      maxZoom: 18.5,
      minZoom: 0.8,
      attributionControl: {
        compact: true,
        customAttribution: [
          '<a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
        ]
      },
      canvasContextAttributes: { antialias: true }
    });
    state.map = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    const collapseAttribOnPhone = () => {
      const el = document.querySelector(".maplibregl-ctrl-attrib");
      if (!el) return;
      if (window.innerWidth <= 900) {
        el.classList.add("maplibregl-compact");
        el.classList.remove("maplibregl-compact-show");
        const details = el.querySelector("details");
        if (details) details.open = false;
      }
    };
    map.on("load", collapseAttribOnPhone);
    window.addEventListener("resize", collapseAttribOnPhone);
    map.on("style.load", onStyleReady);
    map.on("zoom", () => {
      setTerrainForZoom();
      updateOrbitsZoom();
      updateLabelVisibility();
    });
    map.on("error", (e) => {
      const msg = (e && e.error && e.error.message) || String(e && e.error || "");
      // Cancelled / abort noise from fast fly-tos should not count as app errors.
      if (/abort|cancel|networkerror|failed to fetch/i.test(msg)) return;
      console.warn("map warning:", msg);
    });

    map.once("load", async () => {
      await waitForIdle(map);
      window.__WNTR_GLOBE_READY = true;
    });
    exposeHooks();
  }

  start().catch((err) => {
    console.error(err);
  });
})();
