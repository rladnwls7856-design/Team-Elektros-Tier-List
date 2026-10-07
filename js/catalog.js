/*
 * Map catalog helpers — turns the "Brawlstars map/<Mode>/<Map> (<version>).png" folder into
 * a sorted catalog and answers lookups for the sidebar, the map view and data migration.
 * Pure: used by the browser (window.BrawlCatalog), tools/build-map-catalog.js and the tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BrawlCatalog = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Only an all-digit suffix is a version id; "(Old)" or "(20 Player)" belong to the name.
  const VERSION_RE = /^(.*\S) \((\d+)\)$/;
  const PNG_RE = /^(.+)\.png$/i;

  const byName = (a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);

  function parseFileName(file) {
    if (typeof file !== "string") return null;
    const png = PNG_RE.exec(file);
    if (!png) return null;
    const v = VERSION_RE.exec(png[1]);
    return v ? { name: v[1], version: v[2] } : { name: png[1], version: null };
  }

  // entries: [{ mode, file, w, h }] as scanned from disk.
  function buildCatalog(rootDir, entries) {
    const modes = new Map();
    for (const e of entries) {
      const parsed = parseFileName(e.file);
      if (!parsed) continue;
      if (!modes.has(e.mode)) modes.set(e.mode, new Map());
      const maps = modes.get(e.mode);
      if (!maps.has(parsed.name)) maps.set(parsed.name, []);
      maps.get(parsed.name).push({ id: parsed.version, w: e.w, h: e.h });
    }
    const versionOrder = (a, b) => (a.id === null ? -1 : b.id === null ? 1 : Number(a.id) - Number(b.id));
    return {
      root: rootDir,
      modes: [...modes.keys()].sort(byName).map((mode) => ({
        name: mode,
        maps: [...modes.get(mode).keys()].sort(byName).map((name) => ({
          name,
          versions: modes.get(mode).get(name).sort(versionOrder),
        })),
      })),
    };
  }

  function catalogStats(catalog) {
    let maps = 0;
    let images = 0;
    for (const m of catalog.modes) {
      maps += m.maps.length;
      for (const map of m.maps) images += map.versions.length;
    }
    return { modes: catalog.modes.length, maps, images };
  }

  // Mode names and map names never contain "/", so the first slash always separates them.
  const mapKey = (mode, name) => mode + "/" + name;
  const imageKey = (mode, name, version) => (version ? mapKey(mode, name) + "#" + version : mapKey(mode, name));

  function parseMapKey(key) {
    if (typeof key !== "string") return null;
    const i = key.indexOf("/");
    return i > 0 && i < key.length - 1 ? { mode: key.slice(0, i), name: key.slice(i + 1) } : null;
  }

  function imageUrl(rootDir, mode, name, version) {
    const file = name + (version ? " (" + version + ")" : "") + ".png";
    return [rootDir, mode, file].map(encodeURIComponent).join("/");
  }

  function indexCatalog(catalog) {
    const byKey = new Map();
    const keysByName = new Map();
    for (const m of catalog.modes) {
      for (const map of m.maps) {
        const key = mapKey(m.name, map.name);
        byKey.set(key, { mode: m.name, map });
        if (!keysByName.has(map.name)) keysByName.set(map.name, []);
        keysByName.get(map.name).push(key);
      }
    }
    return {
      byKey,
      // Exact, case-sensitive: used to move old boards onto catalog maps, where a wrong
      // guess would attach someone's notes to a different map.
      uniqueKeyForName(name) {
        const keys = keysByName.get(name);
        return keys && keys.length === 1 ? keys[0] : null;
      },
    };
  }

  // Case and apostrophes do not count: a keyboard ' finds a label written with ’, and "belles" too.
  const fold = (s) => s.toLowerCase().replace(/['\u2018\u2019\u02bc`\u00b4]/g, "");

  function searchCatalog(catalog, query) {
    const q = fold(String(query || "").trim());
    if (!q) return catalog.modes;
    const out = [];
    for (const m of catalog.modes) {
      if (fold(m.name).includes(q)) {
        out.push(m);
        continue;
      }
      const maps = m.maps.filter((map) => fold(map.name).includes(q) || (typeof map.label === "string" && fold(map.label).includes(q)));
      if (maps.length) out.push({ name: m.name, maps });
    }
    return out;
  }

  const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const usableName = (s) => typeof s === "string" && s.trim() !== "" && !s.includes("/");

  // The map pool (js/map-pool.js) as a flat list: { mode, name, label, tiebreaker } in pool order.
  // name is the image file name, label how the tournament spells it; the first map of a mode is
  // its tiebreaker. Malformed entries, names with "/" (they would break the key) and repeats are
  // skipped.
  function poolEntries(pool) {
    const out = [];
    const seen = new Set();
    const modes = isPlainObject(pool) && Array.isArray(pool.modes) ? pool.modes : [];
    for (const m of modes) {
      if (!isPlainObject(m) || !usableName(m.mode) || !Array.isArray(m.maps)) continue;
      let first = true;
      for (const entry of m.maps) {
        const name = typeof entry === "string" ? entry : isPlainObject(entry) ? entry.name : null;
        if (!usableName(name)) continue;
        const key = mapKey(m.mode, name);
        if (seen.has(key)) continue;
        seen.add(key);
        const label = isPlainObject(entry) && typeof entry.label === "string" && entry.label.trim() ? entry.label : name;
        out.push({ mode: m.mode, name, label, tiebreaker: first });
        first = false;
      }
    }
    return out;
  }

  function poolKeys(pool) {
    return poolEntries(pool).map((e) => mapKey(e.mode, e.name));
  }

  // The catalog cut down to the pool, in pool order, each map carrying its label and tiebreaker
  // flag. missing: pool keys with no image in the catalog (a typo, or a renamed file).
  function poolCatalog(catalog, pool) {
    const index = indexCatalog(catalog);
    const modes = [];
    const missing = [];
    for (const e of poolEntries(pool)) {
      const hit = index.byKey.get(mapKey(e.mode, e.name));
      if (!hit) {
        missing.push(mapKey(e.mode, e.name));
        continue;
      }
      let mode = modes.find((m) => m.name === e.mode);
      if (!mode) modes.push((mode = { name: e.mode, maps: [] }));
      mode.maps.push({ name: e.name, label: e.label, tiebreaker: e.tiebreaker, versions: hit.map.versions.map((v) => ({ ...v })) });
    }
    return { catalog: { root: catalog.root, modes }, missing };
  }

  // For moving old boards (named by map name only) onto pool maps: the name must be unique in the
  // whole catalog — a name two modes share stays a custom board, as it always did — and that one
  // map must be in the pool. A map outside the pool stays a custom board instead of being deleted.
  function poolKeyForName(fullIndex, poolIndex) {
    return (name) => {
      const key = fullIndex.uniqueKeyForName(name);
      return key && poolIndex.byKey.has(key) ? key : null;
    };
  }

  return { parseFileName, buildCatalog, catalogStats, mapKey, imageKey, parseMapKey, imageUrl, indexCatalog, searchCatalog, poolEntries, poolKeys, poolCatalog, poolKeyForName };
});
