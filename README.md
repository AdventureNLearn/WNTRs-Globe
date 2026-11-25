# WNTR's Globe

A night globe for walking through WNTR's public UFO posts in time and on the Earth — sightings, receipts, cover stories, pattern-hunting, and the noise that gets called out — without inventing a single location.

Public static web app (live at [wntrsglobe.grok.me](https://wntrsglobe.grok.me/)). Nothing here has been posted in WNTR's name.

The first audience is WNTR. Pins go only on things tied to a place. Posts with no place sit in the **Not on the map** feed, on purpose.

Spelling of the name is always **WNTR**. The app is **WNTR's Globe**.

## Risks (read first)

- **Static client-side app, not a sandbox.** When run locally, `python3 -m http.server 8080 --bind 127.0.0.1` serves files from this folder on loopback only. That is not a VM or a separate OS user; anything running under the same OS user or browser profile shares local browser state.
- **No account or API key is required.** Do not add secrets, tokens, or personal data to `data/` or `scripts/`.
- **Public map and tile requests leave your browser.** The app loads MapLibre GL JS, the dark basemap/streets (OpenFreeMap), 3D terrain (AWS Open Data Terrain Tiles), and period basemaps (USGS, National Library of Scotland, OpenHistoricalMap) from those public hosts. Those hosts have no SLA.
- **Official-record precision is never tightened.** Locations marked `[UNKNOWN]` stay off the map, and named-site outlines from OpenStreetMap are site boundaries, not event fixes.
- **You are responsible** for rights and required attributions when reusing case data or map tiles.

## How to run it

From this folder (the repository root):

```bash
python3 -m http.server 8080 --bind 127.0.0.1
```

Then open [http://127.0.0.1:8080](http://127.0.0.1:8080).

Any simple static file server works. Do not open `index.html` as a `file://` URL; the app loads local JSON, and most browsers will block that.

Relative paths are used throughout so the same folder can be served from any static host root (such as grok.me or GitHub Pages). Do not add a leading `/` to asset or data URLs.

## What you are looking at

- A night-Earth globe that zooms smoothly down to a simulated street-level view (3D building shapes and terrain).
- A layer panel: Sightings, Receipts, Hid it in plain sight, Find the patterns, Psyop season, and How-to.
- A time slider that opens in **All years**, so official-record cases from the 1940s through the 2020s are visible together. Year and month buttons step out of All years into a single year or month. Posts stay monthly: the day track and **Posts:** label still follow one calendar month (the current window is June–November 2026).
- A **Not on the map** feed for official-record cases whose location or date is **[UNKNOWN]**, and for posts that have no place pin.
- Official-record cases drawn only as the official record allows. The badge is **Official-record cases: areas shown as recorded**. The app never tightens the source precision, never invents coordinates, and never treats a site outline or a published reference point as the object's position. At globe zoom, locators are clustered so the map stays uncluttered.

## How cases are drawn

Loaded from the 18 November 2026 official-record pack (200 cases: 133 from the first pass, plus 67 from `cases-part2.csv`). Every case card carries the primary-source citations with links. The import can be rerun when the pack is updated; duplicate ids are skipped.

- **Point** — the printed lat/lon, with a precision note. Typical GEIPAN export values are two decimal degrees (about 1 km). These are official printed values, not a surveyed event fix.
- **Reference point** — a cross at a printed reference coordinate (for example a published waypoint or an airport reference point), labeled **not the object's position**.
- **Named site** — the named place is geocoded with the OpenStreetMap Nominatim API (one request per second, cached in `data/geocode-cache.json`). If OSM has an outline, that outline is drawn; otherwise a labeled approximate circle sized to the place type is used. The label is **Named site location from OpenStreetMap, not an event fix**.
- **[UNKNOWN] location or date** — the case stays in the **Not on the map** feed. It is not placed on the globe.

Each case card shows the official status as printed, with a short English gloss. GEIPAN class D is labeled **Unexplained (GEIPAN class D)**. Chile rows that print Resuelto, Explicado or Cerrado are glossed as Resolved, Explained or Closed. A **Show explained/resolved cases** toggle, on by default, can hide that group.

Fifteen UK Ministry of Defence Directorate of Air Staff rows were read from dated archived snapshots of official MoD Publication Scheme pages. Each of those cards cites the original MoD URL and an archive URL labeled **Archived copy of official MoD page, captured** with the snapshot date.

Examples of those rules: the Puerto Rico Object is the OpenStreetMap outline of Rafael Hernandez Airport plus a cross at the FAA airport reference point, not an object path. Rendlesham Forest / RAF Woodbridge uses the OSM outlines of Rendlesham Forest and of MOD Woodbridge / Rock Barracks; event lat/lon in those records is **[UNKNOWN]**.

Primary-source links are in each case card and in `data/cases.json`.

## Data

- `data/cases.json` — official-record cases built by `scripts/import-cases.mjs` from the source pack (`cases.csv`, and `cases-part2.csv` when it is present). Rerun the script to refresh the file. Duplicates are skipped by id.
- `scripts/geocode-cache.json` — local Nominatim cache for named-site lookups, not published with the app. The import uses the User-Agent `WNTRs-Globe/1.0 (https://github.com/AdventureNLearn/WNTRs-Globe; official-record case import)` and waits at least one second between requests. Curated Rendlesham and Aguadilla fields in `scripts/curated-pilots.json` are kept when the import is rerun.
- `data/posts.json` — month-scoped posts for the layers and the unlocated feed. Currently empty; no posts have been approved for import.

No personal data and no witness details belong in these files, except public officials already named in the official records. No live scrape. No API keys.

Named-site outlines are © OpenStreetMap contributors, ODbL, retrieved via Nominatim on 18 November 2026. They are site outlines, not event coordinates.

## Keyless map sources and attribution

No API key, token, or account is required. Attribution is shown on the map and is repeated here.

**Globe, streets, and 3D buildings**

- Rendering: [MapLibre GL JS](https://maplibre.org/) v5, globe projection, with building extrusions from the vector `building` layer.
- Vector tiles and the dark style: [OpenFreeMap](https://openfreemap.org/) public instance (`https://tiles.openfreemap.org/styles/dark`), no signup and no API key.
- Schema: [OpenMapTiles](https://openmaptiles.org/).
- Map data: [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.

Required credit (OpenFreeMap): OpenFreeMap © OpenMapTiles Data from OpenStreetMap.

**3D terrain**

- [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) by Tilezen/Mapzen, hosted by AWS Open Data, Terrarium encoding, no API key (`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`).
- Terrain is turned on as you zoom in toward city and street level, so the globe overview stays smooth.

The upstream elevation sources require credit. The canonical list is in the [Tilezen joerd attribution notes](https://github.com/tilezen/joerd/blob/master/docs/attribution.md):

- ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736;
- Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017;
- Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich;
- Canada terrain data contains information licensed under the Open Government Licence – Canada;
- Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers;
- Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration
- Mexico terrain data source: INEGI, Continental relief, 2016;
- New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government (All rights reserved);
- Norway terrain data © Kartverket;
- United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved;
- United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey.

Street level in this prototype is **simulated**: extruded OpenStreetMap building footprints, roads, and terrain. It is not photographic street view.

## Ground at the time of the incident

When a case is opened, the app looks for a free, keyless basemap dated **at or before** the case date. "Period" means close in time: the map is used as the period ground only if it is **no more than 10 years** older than the incident. The label always includes that gap, for example `Period map: NLS OS 1:2,500 1974 (6 years before Dec 1980)`.

If the nearest dated map is more than 10 years older, the modern simulated view stays up, labeled like `Modern ground: no period map within 10 years (nearest: USGS topo 1960)`. A small **Show 1960 map** toggle still lets you view that older sheet, labeled with its year and the gap, for example `Older map: USGS topo 1960 (53 years before Apr 2013)`. If no earlier map is found at all, the label is `Modern ground: no period imagery available`. The app never claims a tighter date than the source supports.

The date used for that lookup is `incident_date` in `data/cases.json`, taken from the official printed date. Year-only, month-only, and year-range official dates are used as printed; a missing day is not invented. The year gap is the incident year minus the map year.

**Sources used in the app**

- United States and Puerto Rico: [USGS Historical Topographic Map Collection](https://www.usgs.gov/programs/national-geospatial-program/historical-topographic-maps-preserving-past) via the public ImageServer. Public domain; credit the U.S. Geological Survey. The latest sheet at the Aguadilla airport reference point before 2013 is a 1960 1:20,000 topo (imprint year 1983), which is more than 10 years earlier, so it is offered only behind the older-map toggle.
- Great Britain: National Library of Scotland keyless XYZ tiles, [CC BY](https://maps.nls.uk/guides/georeferencing/commercial-use/). Credit: Courtesy of the National Library of Scotland. Rendlesham uses the OS 1:2,500 National Grid 1974 layer (`https://geo.nls.uk/mapdata3/os/2500_1974/{z}/{x}/{y}.png`), 6 years before the first reported night. An OS 1:10,560 1949–1970 layer is the fallback when 1974 does not apply.
- Overlay only: [OpenHistoricalMap](https://www.openhistoricalmap.org/) vector tiles, generally CC0, filtered to features that have a `start_decdate` at or before the case date. Empty coverage is left blank. This overlay is never enough, on its own, to label the view as a period map.

**Looked at and not used**

- USGS `historic/MapServer` on basemap.nationalmap.gov: the service was not found (404) on 18 November 2026, and it would not have been date-selectable.
- USGS EROS aerials: no public keyless tile API was found; EarthExplorer requires a login to download frames.
- Esri World Imagery Wayback: tiles are keyless and CORS-open from 20 February 2014 onward, but they sit under Esri's Terms of Use, not a free reuse license, and the archive starts in 2014, after many of the official-record cases.
- NLS Historic Maps API on MapTiler Cloud: requires an API key.

The research table, including CORS checks, is in `data/period-sources.json`.

## License

MIT License. See `LICENSE`. Map data and tiles keep their own licenses and credits listed above.

## Status

Public repository; live site hosted at [wntrsglobe.grok.me](https://wntrsglobe.grok.me/) (GitHub Pages is currently off).

- Repository: https://github.com/AdventureNLearn/WNTRs-Globe
- Live site: https://wntrsglobe.grok.me/
