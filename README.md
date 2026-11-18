# WNTR's Globe

A night globe for walking through WNTR's public UFO posts in time and on the Earth — sightings, receipts, cover stories, pattern-hunting, and the noise that gets called out — without inventing a single location.

Public repository on GitHub Pages. Nothing here has been posted in WNTR's name.

The first audience is WNTR. Pins go only on things tied to a place. Posts with no place sit in the **Not on the map** feed, on purpose.

Spelling of the name is always **WNTR**. The app is **WNTR's Globe**.

## How to run it

From this folder (the repository root):

```bash
python3 -m http.server 8080
```

Then open [http://localhost:8080](http://localhost:8080).

Any simple static file server works. Do not open `index.html` as a `file://` URL; the app loads local JSON, and most browsers will block that.

Relative paths are used throughout so the same folder can be served from GitHub Pages at the repository root. Do not add a leading `/` to asset or data URLs.

## What you are looking at

- A night-Earth globe that zooms smoothly down to a simulated street-level view (3D building shapes and terrain).
- A layer panel: Sightings, Receipts, Hid it in plain sight, Find the patterns, Psyop season, and How-to.
- A month slider. Each layer shows one calendar month at a time. Dragging the day handle highlights a day; the rest of the month stays visible.
- A **Not on the map** feed for posts that have no place pin.
- Two official-record cases drawn as **named-site areas**, not exact event pins. Each area is labeled with the precision the source actually gives. The app never tightens that precision, and it never treats a site outline or a published airport point as the object's position.

## The two pilot cases

These two cases are a starter sample so people can get to know the app. More cases are added over time.

Loaded from the 18 November 2026 source pack. Event lat/lon are **[UNKNOWN]** in both official records.

1. **The Puerto Rico Object** — Rafael Hernandez Airport, near Aguadilla, 26 April 2013, 9:22 p.m. local time (AARO case-resolution report, 20 March 2025). The shaded area is the OpenStreetMap outline of the named airport (way 30289545). A cross marks the FAA airport reference point, printed in the pack as `18-29-41.468 N / 67-7-45.99 W` and converted to decimal degrees only for map display, labeled **Airport reference point (FAA), not the object's position**. The objects’ path is not drawn.
2. **Rendlesham Forest / RAF Woodbridge** — December 1980, as recorded in Lt Col Halt’s “Unexplained Lights” memorandum (UK National Archives, DEFE 24/1948). The shaded areas are the OpenStreetMap outlines of Rendlesham Forest (way 243960117) and of MOD Woodbridge / Rock Barracks (way 37325516), labeled **Named site location from OpenStreetMap, not an event fix**. OSM has no feature named “RAF Woodbridge” or “back gate” in the extract taken on 18 November 2026. An OSM tourism viewpoint named “Rendlesham East Gate” was not used as the official gate. Times and claims in the info panel are those printed in the pack, including every **[UNKNOWN]**.

Primary-source links are in each case card and in `data/cases.json`.

## Data

- `data/cases.json` — the two reference cases, including named-site polygons and (for Aguadilla) the FAA reference point.
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

## License

MIT License. See `LICENSE`. Map data and tiles keep their own licenses and credits listed above.

## Status

Public repository on GitHub Pages, 18 November 2026.

- Repository: https://github.com/AdventureNLearn/WNTRs-Globe
- Live site: https://adventurenlearn.github.io/WNTRs-Globe/
