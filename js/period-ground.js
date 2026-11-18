(() => {
  "use strict";

  const USGS_QUERY = "https://historical1.arcgis.com/arcgis/rest/services/USGS_Historical_Topographic_Maps/ImageServer/query";
  const USGS_EXPORT = "https://historical1.arcgis.com/arcgis/rest/services/USGS_Historical_Topographic_Maps/ImageServer/exportImage";
  const OHM_TILES = "https://vtiles.openhistoricalmap.org/maps/ohm/{z}/{x}/{y}.pbf";
  const PERIOD_SOURCE = "period-ground";
  const PERIOD_LAYER = "period-ground-raster";
  const OHM_SOURCE = "period-ohm";
  const OHM_LAYERS = ["period-ohm-buildings", "period-ohm-roads"];
  const MODERN_HIDE = ["buildings-3d", "building"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MAX_PERIOD_GAP_YEARS = 10;

  // Conservative footprint of the USGS Historical Topographic Map Collection.
  const USGS_BOXES = [
    { name: "conus", west: -125.1, south: 24.3, east: -66.8, north: 49.5 },
    { name: "alaska", west: -180, south: 51, east: -129, north: 72.5 },
    { name: "hawaii", west: -161.0, south: 18.7, east: -154.2, north: 22.4 },
    { name: "puerto-rico", west: -68.2, south: 17.8, east: -65.1, north: 18.6 },
    { name: "usvi", west: -65.2, south: 17.6, east: -64.5, north: 18.5 }
  ];

  // Keyless, CC-BY NLS XYZ layers. Year range is the layer's published span, not a per-pixel survey date.
  const NLS_LAYERS = [
    {
      id: "nls-os-2500-1974",
      yearStart: 1974,
      yearEnd: 1974,
      labelCore: "NLS OS 1:2,500 1974",
      tiles: "https://geo.nls.uk/mapdata3/os/2500_1974/{z}/{x}/{y}.png",
      minzoom: 12,
      maxzoom: 18,
      attribution: 'Courtesy of the <a href="https://maps.nls.uk/" target="_blank" rel="noopener">National Library of Scotland</a>',
      bounds: [-8.8, 49.8, 1.95, 60.9]
    },
    {
      id: "nls-os-10560-1949-1970",
      yearStart: 1949,
      yearEnd: 1970,
      labelCore: "NLS OS 1:10,560 1949–1970",
      tiles: "https://mapseries-tilesets.s3.amazonaws.com/os/britain10knatgrid/{z}/{x}/{y}.png",
      minzoom: 12,
      maxzoom: 16,
      attribution: 'Courtesy of the <a href="https://maps.nls.uk/" target="_blank" rel="noopener">National Library of Scotland</a>',
      bounds: [-8.8, 49.8, 1.95, 60.9]
    }
  ];

  function inBox(lon, lat, box) {
    if (Array.isArray(box)) {
      return lon >= box[0] && lat >= box[1] && lon <= box[2] && lat <= box[3];
    }
    return lon >= box.west && lat >= box.south && lon <= box.east && lat <= box.north;
  }

  function inUsgsCoverage(lon, lat) {
    return USGS_BOXES.some((b) => inBox(lon, lat, b));
  }

  function parseIncidentDate(c) {
    const iso = c && c.incident_date;
    if (!iso) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      const [year, month, day] = iso.split("-").map(Number);
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      return { year, month, day, iso, precision: "day" };
    }
    if (/^\d{4}-\d{2}$/.test(iso)) {
      const [year, month] = iso.split("-").map(Number);
      if (month < 1 || month > 12) return null;
      return { year, month, day: 1, iso, precision: "month" };
    }
    if (/^\d{4}$/.test(iso)) {
      const year = Number(iso);
      if (!year) return null;
      return { year, month: 0, day: 1, iso, precision: "year" };
    }
    return null;
  }

  function formatMonthYear(date) {
    if (!date || !date.year) return "[UNKNOWN]";
    if (!date.month) return String(date.year);
    return `${MONTHS[date.month - 1]} ${date.year}`;
  }

  function toDecDate(date) {
    const month = date.month || 1;
    const day = date.day || 1;
    const start = Date.UTC(date.year, 0, 1);
    const here = Date.UTC(date.year, month - 1, day);
    const days = (Date.UTC(date.year + 1, 0, 1) - start) / 86400000;
    return date.year + (here - start) / 86400000 / days;
  }

  function modernResult() {
    return {
      kind: "modern",
      label: "Modern ground: no period imagery available",
      note: "",
      showOlderToggle: false
    };
  }

  function yearsBefore(date, mapYear) {
    return date.year - mapYear;
  }

  function yearsBeforePhrase(years, date) {
    const when = formatMonthYear(date);
    if (years === 0) return `same year as ${when}`;
    if (years === 1) return `1 year before ${when}`;
    return `${years} years before ${when}`;
  }

  function periodLabel(core, date, years) {
    return `Period map: ${core} (${yearsBeforePhrase(years, date)})`;
  }

  function olderMapLabel(core, date, years) {
    return `Older map: ${core} (${yearsBeforePhrase(years, date)})`;
  }

  function tooOldModernLabel(core) {
    return `Modern ground: no period map within 10 years (nearest: ${core})`;
  }

  async function queryUsgs(lon, lat, year) {
    const params = new URLSearchParams({
      f: "json",
      geometry: `${lon},${lat}`,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      where: `DateCurrent <= ${year} AND DateCurrent IS NOT NULL`,
      outFields: "OBJECTID,Map_Name,DateCurrent,Date_On_Map,Year,Imprint_Year,Map_Scale,Scale,Primary_State",
      orderByFields: "DateCurrent DESC",
      returnGeometry: "false",
      resultRecordCount: "8"
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`${USGS_QUERY}?${params}`, { signal: ctrl.signal });
      if (!res.ok) return null;
      const data = await res.json();
      const rows = (data.features || [])
        .map((f) => f.attributes || {})
        .filter((a) => Number(a.DateCurrent) && Number(a.DateCurrent) <= year);
      if (!rows.length) return null;
      const latest = Number(rows[0].DateCurrent);
      const sameYear = rows.filter((a) => Number(a.DateCurrent) === latest);
      sameYear.sort((a, b) => (Number(a.Scale || a.Map_Scale) || 9e9) - (Number(b.Scale || b.Map_Scale) || 9e9));
      const best = sameYear[0];
      const mapYear = Number(best.DateCurrent);
      const mosaicRule = encodeURIComponent(JSON.stringify({
        mosaicMethod: "esriMosaicAttribute",
        where: `DateCurrent <= ${year} AND DateCurrent IS NOT NULL`,
        sortField: "DateCurrent",
        ascending: false
      }));
      const note = (best.Imprint_Year && Number(best.Imprint_Year) !== mapYear)
        ? `Sheet imprint year ${best.Imprint_Year}; map content date ${mapYear}.`
        : "";
      return {
        kind: "period",
        sourceId: "usgs-htmc",
        year: mapYear,
        labelCore: `USGS topo ${mapYear}`,
        label: "",
        note,
        tiles: `${USGS_EXPORT}?f=image&format=png&transparent=true&bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&mosaicRule=${mosaicRule}`,
        tileSize: 256,
        attribution: 'Historical topographic maps courtesy of the <a href="https://www.usgs.gov/" target="_blank" rel="noopener">U.S. Geological Survey</a>'
      };
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function pickNls(lon, lat, year) {
    const fits = NLS_LAYERS.filter((layer) => inBox(lon, lat, layer.bounds) && layer.yearEnd <= year);
    if (!fits.length) return null;
    fits.sort((a, b) => b.yearEnd - a.yearEnd);
    const layer = fits[0];
    return {
      kind: "period",
      sourceId: layer.id,
      year: layer.yearEnd,
      labelCore: layer.labelCore,
      label: "",
      note: layer.yearStart === layer.yearEnd
        ? ""
        : `Layer covers ${layer.yearStart}–${layer.yearEnd}; sheet dates inside that span are not selected per pixel.`,
      tiles: layer.tiles,
      minzoom: layer.minzoom,
      maxzoom: layer.maxzoom,
      bounds: layer.bounds,
      tileSize: 256,
      attribution: layer.attribution
    };
  }

  async function choose(caseObj, lon, lat) {
    const date = parseIncidentDate(caseObj);
    if (!date || typeof lon !== "number" || typeof lat !== "number") {
      const fallback = modernResult();
      fallback.date = date;
      return fallback;
    }
    const candidates = [];
    if (inUsgsCoverage(lon, lat)) {
      const usgs = await queryUsgs(lon, lat, date.year);
      if (usgs) candidates.push(usgs);
    }
    const nls = pickNls(lon, lat, date.year);
    if (nls) candidates.push(nls);
    if (!candidates.length) {
      const fallback = modernResult();
      fallback.date = date;
      return fallback;
    }
    candidates.sort((a, b) => b.year - a.year);
    const best = candidates[0];
    const gap = yearsBefore(date, best.year);
    best.yearsBefore = gap;
    best.date = date;
    if (gap > MAX_PERIOD_GAP_YEARS) {
      best.kind = "modern";
      best.showOlderToggle = true;
      best.label = tooOldModernLabel(best.labelCore);
      best.olderLabel = olderMapLabel(best.labelCore, date, gap);
      best.toggleLabel = `Show ${best.year} map`;
      return best;
    }
    best.kind = "period";
    best.showOlderToggle = false;
    best.label = periodLabel(best.labelCore, date, gap);
    return best;
  }

  function ohmDateFilter(dec) {
    return [
      "all",
      ["has", "start_decdate"],
      ["<=", ["to-number", ["get", "start_decdate"]], dec],
      ["any", ["!", ["has", "end_decdate"]], [">=", ["to-number", ["get", "end_decdate"]], dec]]
    ];
  }

  function removeLayer(map, id) {
    if (map.getLayer(id)) map.removeLayer(id);
  }

  function removeSource(map, id) {
    if (map.getSource(id)) map.removeSource(id);
  }

  function setModernHidden(map, hidden) {
    MODERN_HIDE.forEach((id) => {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", hidden ? "none" : "visible");
      }
    });
  }

  function clear(map) {
    if (!map) return;
    OHM_LAYERS.forEach((id) => removeLayer(map, id));
    removeLayer(map, PERIOD_LAYER);
    removeSource(map, OHM_SOURCE);
    removeSource(map, PERIOD_SOURCE);
    setModernHidden(map, false);
  }

  function addOhmOverlay(map, date, beforeId) {
    const dec = toDecDate(date);
    if (!map.getSource(OHM_SOURCE)) {
      map.addSource(OHM_SOURCE, {
        type: "vector",
        tiles: [OHM_TILES],
        minzoom: 0,
        maxzoom: 15,
        attribution: '<a href="https://www.openhistoricalmap.org/" target="_blank" rel="noopener">OpenHistoricalMap</a> contributors'
      });
    }
    if (!map.getLayer("period-ohm-buildings")) {
      map.addLayer({
        id: "period-ohm-buildings",
        type: "fill",
        source: OHM_SOURCE,
        "source-layer": "buildings",
        minzoom: 13,
        filter: ohmDateFilter(dec),
        paint: {
          "fill-color": "#c4a574",
          "fill-opacity": 0.35,
          "fill-outline-color": "#8a6a3a"
        }
      }, beforeId);
    } else {
      map.setFilter("period-ohm-buildings", ohmDateFilter(dec));
    }
    if (!map.getLayer("period-ohm-roads")) {
      map.addLayer({
        id: "period-ohm-roads",
        type: "line",
        source: OHM_SOURCE,
        "source-layer": "transport_lines",
        minzoom: 11,
        filter: ohmDateFilter(dec),
        paint: {
          "line-color": "#8a5a2a",
          "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.6, 16, 2.2],
          "line-opacity": 0.8
        }
      }, beforeId);
    } else {
      map.setFilter("period-ohm-roads", ohmDateFilter(dec));
    }
  }

  function apply(map, choice, opts = {}) {
    if (!map) return;
    const beforeId = (opts.beforeId && map.getLayer(opts.beforeId)) ? opts.beforeId : undefined;
    clear(map);
    const showRaster = choice && choice.tiles && (
      choice.kind === "period" || (choice.showOlderToggle && opts.showOlder)
    );
    if (!showRaster) {
      if (choice && choice.date) addOhmOverlay(map, choice.date, beforeId);
      return;
    }
    const source = {
      type: "raster",
      tiles: [choice.tiles],
      tileSize: choice.tileSize || 256,
      attribution: choice.attribution || ""
    };
    if (typeof choice.minzoom === "number") source.minzoom = choice.minzoom;
    if (typeof choice.maxzoom === "number") source.maxzoom = choice.maxzoom;
    if (Array.isArray(choice.bounds) && choice.bounds.length === 4) source.bounds = choice.bounds;
    map.addSource(PERIOD_SOURCE, source);
    const layer = {
      id: PERIOD_LAYER,
      type: "raster",
      source: PERIOD_SOURCE,
      paint: { "raster-opacity": 1, "raster-fade-duration": 0 }
    };
    if (typeof choice.minzoom === "number") layer.minzoom = choice.minzoom;
    if (typeof choice.maxzoom === "number") layer.maxzoom = choice.maxzoom;
    map.addLayer(layer, beforeId);
    setModernHidden(map, true);
    if (choice.date) addOhmOverlay(map, choice.date, beforeId);
  }

  window.WNTRPeriodGround = {
    parseIncidentDate,
    choose,
    apply,
    clear,
    MAX_PERIOD_GAP_YEARS
  };
})();
