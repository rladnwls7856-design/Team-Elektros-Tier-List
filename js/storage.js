/*
 * Team Brawl storage core — validation, persistence and transfer of the board state.
 * Loaded by index.html as a classic script (window.BrawlStorage) after js/drawing.js, so it
 * also runs from file://, and required by the Node tests. It must stay free of DOM access.
 *
 * Map data is keyed "All Maps", "<mode>/<map>" for catalog maps (js/catalog.js), or a plain
 * name for custom boards kept from before the catalog existed. Viewing a map never writes:
 * an unedited map shows All Maps' tiers and order, and materializeMap() copies them into
 * the map on its first edit.
 */
(function (root, factory) {
  const drawing = typeof module === "object" && module.exports ? require("./drawing.js") : root.BrawlDrawing;
  const api = factory(drawing);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BrawlStorage = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Drawing) {
  "use strict";

  const APP_ID = "team-brawl";
  // Data saved before this field existed has no schemaVersion and counts as version 2,
  // matching the "team-brawl-v2" key it has always been stored under.
  const LEGACY_SCHEMA_VERSION = 2;
  // 4: catalog map keys and drawings. A version-3 app would drop drawings on its next save,
  // so it must see version 4 as "newer" and set the original aside first.
  const SCHEMA_VERSION = 4;
  const TIERS = Object.freeze(["S", "A", "B", "C", "D", "F"]);
  // Catalog maps are not listed in `maps`; it holds All Maps plus custom boards.
  const DEFAULT_MAPS = Object.freeze(["All Maps"]);
  const DEFAULT_PROJECT = "World Finals Prep";
  // Dark enough for a light label at WCAG AA (4.6:1).
  const DEFAULT_ROLE_COLOR = "#6d4aff";
  // New maps and new brawlers inherit their tier from this board.
  const BASE_MAP = "All Maps";
  // Role colors end up in style attributes; anything but #rrggbb could inject markup or url() beacons.
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  // Imported boards are written to localStorage (about 5 MB per origin, shared by every
  // GitHub Pages project of the account) next to the current board and its backup.
  // A real board is ~50 KB, so 2M characters leaves room while keeping the quota safe.
  const MAX_TRANSFER_CHARS = 2000000;
  // Caps for untrusted boards only (own storage is never capped). `maps` holds custom boards
  // (catalog maps are not listed there) and render cost grows with role count; 200 is far
  // above a real team's list while keeping both bounded.
  const MAX_IMPORT_MAPS = 200;
  const MAX_IMPORT_ROLES = 200;
  // The live roster is ~110 brawlers. A map's first edit copies All Maps' table into it, so
  // brawler-keyed tables (and their key length) must be bounded too.
  const MAX_IMPORT_BRAWLERS = 1000;
  const MAX_IMPORT_NAME_LENGTH = 100;
  const SHARE_PREFIX = "#data=";
  // Compressed links (deflate-raw); "#data=" links from earlier versions still open.
  const ZIP_PREFIX = "#z=";
  // Tier links: All Maps tiers and card order as hex brawler codes, plus role changes.
  const TIER_PREFIX = "#t=";
  // Brawl Stars brawler ids start here; id - base is the brawler's code (00 = Shelly).
  const BRAWLER_ID_BASE = 16000000;
  // A full roster is about 220 characters; this bound is for thousands of brawlers.
  const MAX_TIER_LINK_CHARS = 8192;
  // The in-game brawler classes, in the order the game lists them. Colours are fixed so every
  // teammate's board shows the same class in the same colour.
  const CLASS_ORDER = Object.freeze(["Damage Dealer", "Tank", "Assassin", "Marksman", "Artillery", "Controller", "Support"]);
  // Each one carries a 9px label at WCAG AA with the ink or paper labelInkFor picks.
  const CLASS_ROLE_COLORS = Object.freeze({
    "Damage Dealer": "#b91c1c",
    Tank: "#92400e",
    Assassin: "#9333ea",
    Marksman: "#1d4ed8",
    Artillery: "#ca8a04",
    Controller: "#0891b2",
    Support: "#16a34a",
  });
  // The fixed label colours used on role colours, whatever the page theme.
  const LABEL_INK = "#151413";
  const LABEL_PAPER = "#f3f2f2";
  // Fields every board export has always contained; used to recognise files from before `app` existed.
  const BOARD_FIELDS = ["maps", "mapPlacements", "placements"];
  const INVALID = Symbol("invalid");

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const isTier = (v) => TIERS.includes(v);
  const isNonBlank = (v) => typeof v === "string" && v.trim() !== "";

  // Names that already exist on every object; used as keys they read inherited members
  // ("constructor") or rewrite the prototype ("__proto__"), so the UI must not create them.
  function isReservedName(name) {
    return typeof name === "string" && name in Object.prototype;
  }

  function defaultState() {
    return {
      project: DEFAULT_PROJECT,
      maps: [...DEFAULT_MAPS],
      tiers: [...TIERS],
      placements: {},
      mapPlacements: {},
      mapOrders: {},
      notes: {},
      mapNotes: {},
      roles: [],
      brawlerRoles: {},
      drawings: {},
      // Set once the official class roles were offered, so deleting them is respected.
      classRolesAdded: false,
    };
  }

  function schemaVersionOf(raw) {
    if (raw.schemaVersion === undefined) return LEGACY_SCHEMA_VERSION;
    return Number.isInteger(raw.schemaVersion) && raw.schemaVersion >= 1 ? raw.schemaVersion : NaN;
  }

  // Builds a well-typed board from any value (own storage or an untrusted file).
  // Everything the UI can produce survives untouched; only wrongly typed entries are
  // dropped, and each kind of drop is reported once in `warnings`.
  function normalizeState(raw) {
    if (!isPlainObject(raw)) {
      return { state: defaultState(), warnings: ["The data is not a Team Brawl board, so an empty board was used."] };
    }
    const skipped = new Map();
    const skip = (what, n = 1) => skipped.set(what, (skipped.get(what) || 0) + n);

    function dictOf(src, what, convert) {
      const out = {};
      if (src === undefined) return out;
      if (!isPlainObject(src)) {
        skip(what);
        return out;
      }
      for (const k of Object.keys(src)) {
        const v = k === "__proto__" ? INVALID : convert(src[k]);
        if (v === INVALID) skip(what);
        else out[k] = v;
      }
      return out;
    }
    const tierTable = (v) => (isPlainObject(v) ? dictOf(v, "tier placement", (t) => (isTier(t) ? t : INVALID)) : INVALID);
    const stringList = (v) => {
      if (!Array.isArray(v)) return INVALID;
      const kept = v.filter((x) => typeof x === "string");
      if (kept.length !== v.length) skip("list entry", v.length - kept.length);
      return kept;
    };
    const text = (v) => (typeof v === "string" ? v : INVALID);

    const state = defaultState();

    if (raw.project !== undefined) {
      if (typeof raw.project === "string") state.project = raw.project;
      else skip("project name");
    }

    if (raw.maps !== undefined && !Array.isArray(raw.maps)) skip("map list");
    if (Array.isArray(raw.maps)) {
      const seen = new Set();
      const maps = [];
      for (const m of raw.maps) {
        if (!isNonBlank(m) || m === "__proto__" || seen.has(m.toLowerCase())) {
          skip("map name");
          continue;
        }
        seen.add(m.toLowerCase());
        maps.push(m);
      }
      if (maps.length) state.maps = maps;
    }

    if (raw.placements !== undefined) {
      const legacy = tierTable(raw.placements);
      if (legacy === INVALID) skip("tier list");
      else state.placements = legacy;
    }
    state.mapPlacements = dictOf(raw.mapPlacements, "map tier list", tierTable);
    state.mapOrders = dictOf(raw.mapOrders, "map order", stringList);
    state.notes = dictOf(raw.notes, "brawler note", text);
    state.mapNotes = dictOf(raw.mapNotes, "map note", text);
    state.brawlerRoles = dictOf(raw.brawlerRoles, "role assignment", stringList);
    // Keyed by image ("<mode>/<map>" or "<mode>/<map>#<version>"): versions differ in layout.
    state.drawings = dictOf(raw.drawings, "drawing", (v) => {
      if (!Array.isArray(v)) return INVALID;
      const { shapes, dropped } = Drawing.normalizeShapes(v);
      if (dropped) skip("drawing shape", dropped);
      return shapes;
    });

    state.classRolesAdded = raw.classRolesAdded === true;

    if (raw.roles !== undefined && !Array.isArray(raw.roles)) skip("role list");
    if (Array.isArray(raw.roles)) {
      for (const r of raw.roles) {
        if (!isPlainObject(r) || !isNonBlank(r.name)) {
          skip("role");
          continue;
        }
        let color = r.color;
        if (typeof color !== "string" || !COLOR_RE.test(color)) {
          skip("role color (reset to default)");
          color = DEFAULT_ROLE_COLOR;
        }
        state.roles.push({ name: r.name, color });
      }
    }

    const warnings = [...skipped].map(([what, n]) => `Skipped ${n} invalid ${what}${n > 1 ? " entries" : ""}.`);
    return { state, warnings };
  }

  // The tier table new maps and new brawlers copy from. Only a live "All Maps" counts:
  // after it is renamed or deleted, a leftover table under that key is stale data.
  function baseTable(state) {
    return state.maps.includes(BASE_MAP) && hasOwn(state.mapPlacements, BASE_MAP) ? state.mapPlacements[BASE_MAP] : null;
  }

  // Never prunes: an empty roster usually means the API is down, not that every
  // brawler was removed, and pruning then would erase the saved order for good.
  function syncOrder(order, rosterNames) {
    const out = [];
    const seen = new Set();
    const add = (n) => {
      if (typeof n === "string" && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    };
    if (Array.isArray(order)) order.forEach(add);
    rosterNames.forEach(add);
    return out;
  }

  // Gives every roster brawler a tier on All Maps. Other maps are never filled: a brawler a
  // map's table lacks is shown at its All Maps tier (tierOf), so new releases appear
  // everywhere without writing to — and growing — every map ever edited or imported.
  function reconcileWithRoster(state, rosterNames) {
    const tables = state.mapPlacements;
    // Seeded even offline: otherwise rendering creates an empty All Maps table and the next
    // save copies that emptiness over the legacy `placements`.
    if (state.maps.includes(BASE_MAP) && !hasOwn(tables, BASE_MAP)) tables[BASE_MAP] = { ...state.placements };
    if (!rosterNames.length) return state;
    const base = baseTable(state);
    if (base) {
      for (const n of rosterNames) {
        if (!hasOwn(base, n)) base[n] = hasOwn(state.placements, n) ? state.placements[n] : "B";
      }
    }
    return state;
  }

  function tierOf(state, mapKey, name) {
    const own = hasOwn(state.mapPlacements, mapKey) ? state.mapPlacements[mapKey] : null;
    if (own && hasOwn(own, name)) return own[name];
    const base = baseTable(state);
    return base && hasOwn(base, name) ? base[name] : "B";
  }

  // A fresh object: callers render from it and must not edit through it.
  function placementFor(state, mapKey, rosterNames) {
    const out = {};
    for (const n of rosterNames) out[n] = tierOf(state, mapKey, n);
    return out;
  }

  // An unedited map shows All Maps' order, like it shows All Maps' tiers.
  function orderFor(state, mapKey, rosterNames) {
    const ownKey = hasOwn(state.mapOrders, mapKey) ? mapKey : hasOwn(state.mapOrders, BASE_MAP) ? BASE_MAP : null;
    return syncOrder(ownKey ? state.mapOrders[ownKey] : null, rosterNames);
  }

  // Called right before an edit: freezes what the map currently shows into its own table and
  // order, so from now on it no longer follows All Maps. Returns the live, editable objects.
  // Only roster brawlers are copied: anything else in All Maps (retired names, or junk from an
  // imported board) keeps showing through tierOf, and copying it would multiply it per map.
  function materializeMap(state, mapKey, rosterNames) {
    const shown = placementFor(state, mapKey, rosterNames);
    if (!hasOwn(state.mapPlacements, mapKey)) {
      state.mapPlacements[mapKey] = shown;
    } else {
      const table = state.mapPlacements[mapKey];
      for (const n of rosterNames) if (!hasOwn(table, n)) table[n] = shown[n];
    }
    if (hasOwn(state.mapOrders, mapKey)) {
      state.mapOrders[mapKey] = syncOrder(state.mapOrders[mapKey], rosterNames);
    } else {
      const inRoster = new Set(rosterNames);
      state.mapOrders[mapKey] = syncOrder(orderFor(state, mapKey, rosterNames).filter((n) => inRoster.has(n)), rosterNames);
    }
    return { table: state.mapPlacements[mapKey], order: state.mapOrders[mapKey] };
  }

  // Map-keyed collections a custom board's data lives in before it moves to a catalog key.
  const MAP_KEYED = ["mapPlacements", "mapOrders", "mapNotes", "drawings"];

  function ensureBaseMap(state) {
    if (state.maps.includes(BASE_MAP)) return;
    const variant = state.maps.find((m) => m.toLowerCase() === BASE_MAP.toLowerCase());
    if (variant) {
      // An older version allowed renaming "All Maps" by case only; that board is still the
      // base, and keeping both spellings would make the next load drop one as a duplicate.
      for (const c of MAP_KEYED) {
        delete state[c][BASE_MAP];
        if (hasOwn(state[c], variant)) {
          state[c][BASE_MAP] = state[c][variant];
          delete state[c][variant];
        }
      }
      state.maps.splice(state.maps.indexOf(variant), 1, BASE_MAP);
      return;
    }
    // The user deleted or renamed All Maps in an older version. What is left under its key and
    // in the legacy `placements` mirror is a stale copy; reviving it would silently drive every
    // unedited map, so the re-added All Maps starts empty (reconcile fills it with B).
    for (const c of MAP_KEYED) delete state[c][BASE_MAP];
    state.placements = {};
    state.maps.unshift(BASE_MAP);
  }

  // Brings a board saved before the map catalog into the v4 layout: All Maps always exists,
  // and an old board whose name matches exactly one catalog map moves onto that map. Anything
  // ambiguous, unknown or already taken stays a custom board, so nothing is lost. A custom
  // board named exactly like a catalog key already stores its data on that key, so it is only
  // unlisted (deleting it as a custom board would erase the catalog map). Idempotent.
  function upgradeBoard(state, uniqueKeyForName, isCatalogKey) {
    ensureBaseMap(state);
    const adopted = [];
    if (typeof isCatalogKey === "function") {
      state.maps = state.maps.filter((name) => name === BASE_MAP || !isCatalogKey(name));
    }
    if (typeof uniqueKeyForName !== "function") return { adopted };
    for (const name of [...state.maps]) {
      if (name === BASE_MAP) continue;
      const key = uniqueKeyForName(name);
      if (!key || MAP_KEYED.some((c) => hasOwn(state[c], key))) continue;
      for (const c of MAP_KEYED) {
        if (!hasOwn(state[c], name)) continue;
        state[c][key] = state[c][name];
        delete state[c][name];
      }
      state.maps.splice(state.maps.indexOf(name), 1);
      adopted.push({ from: name, to: key });
    }
    return { adopted };
  }

  // The tournament map pool is the only set of maps: tiers, orders, notes and drawings of any
  // other map are deleted (the user's decision, 2026-10-07). All Maps and custom boards stay.
  // Without a pool (the pool file failed to load) nothing is touched, so a missing file can never
  // wipe every map. Reports the maps that lost something worth keeping, and drawings removed.
  function pruneToMapPool(state, poolKeys) {
    const pool = new Set(Array.isArray(poolKeys) ? poolKeys.filter((k) => typeof k === "string") : []);
    const removed = new Set();
    let drawings = 0;
    if (!pool.size) return { maps: [], drawings };
    const keep = (key) => key === BASE_MAP || state.maps.includes(key) || pool.has(key);
    for (const c of ["mapPlacements", "mapOrders", "mapNotes"]) {
      for (const key of Object.keys(state[c])) {
        if (keep(key)) continue;
        if (c !== "mapNotes" || state.mapNotes[key]) removed.add(key);
        delete state[c][key];
      }
    }
    for (const key of Object.keys(state.drawings)) {
      const i = key.indexOf("#");
      const map = i < 0 ? key : key.slice(0, i);
      if (pool.has(map)) continue;
      if (state.drawings[key].length) {
        removed.add(map);
        drawings++;
      }
      delete state.drawings[key];
    }
    return { maps: [...removed].sort(), drawings };
  }

  const clone = (v) => JSON.parse(JSON.stringify(v));

  // What a share link carries: the general board only. Per-map tiers, notes and drawings
  // travel in Export files; including them made links tens of thousands of characters long.
  function shareableState(state) {
    const pick = (dict) => (hasOwn(dict, BASE_MAP) ? { [BASE_MAP]: clone(dict[BASE_MAP]) } : {});
    return {
      ...defaultState(),
      project: state.project,
      placements: clone(state.placements),
      mapPlacements: pick(state.mapPlacements),
      mapOrders: pick(state.mapOrders),
      mapNotes: pick(state.mapNotes),
      notes: clone(state.notes),
      roles: clone(state.roles),
      brawlerRoles: clone(state.brawlerRoles),
    };
  }

  // Opening a link replaces only what a link carries, so the receiver keeps their own map
  // boards and drawings. Links from older versions held every map; that part is ignored.
  function mergeSharedBoard(mine, shared) {
    const out = clone(mine);
    const theirs = shareableState(shared);
    out.project = theirs.project;
    if (hasOwn(theirs.mapPlacements, BASE_MAP)) out.mapPlacements[BASE_MAP] = theirs.mapPlacements[BASE_MAP];
    else if (Object.keys(theirs.placements).length) out.mapPlacements[BASE_MAP] = { ...theirs.placements };
    if (hasOwn(theirs.mapOrders, BASE_MAP)) out.mapOrders[BASE_MAP] = theirs.mapOrders[BASE_MAP];
    if (hasOwn(theirs.mapNotes, BASE_MAP)) out.mapNotes[BASE_MAP] = theirs.mapNotes[BASE_MAP];
    else delete out.mapNotes[BASE_MAP];
    if (hasOwn(out.mapPlacements, BASE_MAP)) out.placements = { ...out.mapPlacements[BASE_MAP] };
    out.notes = theirs.notes;
    out.roles = theirs.roles;
    out.brawlerRoles = theirs.brawlerRoles;
    if (!out.maps.includes(BASE_MAP)) out.maps.unshift(BASE_MAP);
    // The sender's roles are the team's choice; adding class roles later would undo it.
    out.classRolesAdded = true;
    return out;
  }

  function withMeta(state, extra) {
    return { app: APP_ID, schemaVersion: SCHEMA_VERSION, ...extra, ...state };
  }

  function serializeState(state) {
    return JSON.stringify(withMeta(state));
  }

  // Indented for people reading the file, unless that would push the board over the import
  // limit — then compact, and as a last resort without exportedAt, so that any board that
  // fits the limit at all exports to a file that can be imported again.
  function buildExportJson(state, exportedAt) {
    const board = withMeta(state, { exportedAt });
    const pretty = JSON.stringify(board, null, 2);
    if (pretty.length <= MAX_TRANSFER_CHARS) return pretty;
    const compact = JSON.stringify(board);
    return compact.length <= MAX_TRANSFER_CHARS ? compact : serializeState(state);
  }

  // Bounds that keep an untrusted board from growing past the storage quota once it is
  // reconciled with the roster and copied into maps, or from making every render slow.
  function importLimitError(state) {
    const longName = (names) => names.some((n) => n.length > MAX_IMPORT_NAME_LENGTH);
    if (state.maps.length > MAX_IMPORT_MAPS) {
      return fail("too-many", `This board has ${state.maps.length} maps; at most ${MAX_IMPORT_MAPS} can be imported.`);
    }
    if (state.roles.length > MAX_IMPORT_ROLES) {
      return fail("too-many", `This board has ${state.roles.length} roles; at most ${MAX_IMPORT_ROLES} can be imported.`);
    }
    const brawlerLists = [
      Object.keys(state.placements),
      Object.keys(state.notes),
      Object.keys(state.brawlerRoles),
      ...Object.values(state.mapPlacements).map(Object.keys),
      ...Object.values(state.mapOrders),
    ];
    if (brawlerLists.some((l) => l.length > MAX_IMPORT_BRAWLERS)) {
      return fail("too-many", `This board lists more than ${MAX_IMPORT_BRAWLERS} brawlers in one place, so it can't be a real board.`);
    }
    if (Object.values(state.brawlerRoles).some((l) => l.length > MAX_IMPORT_ROLES)) {
      return fail("too-many", `A brawler in this board has more than ${MAX_IMPORT_ROLES} role assignments.`);
    }
    if (longName(state.maps) || longName(state.roles.map((r) => r.name)) || brawlerLists.some(longName)) {
      return fail("too-long", `This board has a map, role or brawler name longer than ${MAX_IMPORT_NAME_LENGTH} characters.`);
    }
    return null;
  }

  const fail = (code, error) => ({ ok: false, code, error });

  // Validates an untrusted board (file contents or a decoded share link). Never throws.
  function parseBoardJson(text) {
    if (typeof text !== "string" || text === "") return fail("empty", "There is nothing to import.");
    if (text.length > MAX_TRANSFER_CHARS) return fail("too-large", "This board is too large to import (limit: about 2 MB).");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return fail("json", "This isn't a valid JSON file.");
    }
    if (!isPlainObject(raw)) return fail("not-board", "This doesn't look like a Team Brawl board.");
    if (raw.app !== undefined && raw.app !== APP_ID) return fail("other-app", "This file was made by a different app.");
    const version = schemaVersionOf(raw);
    if (Number.isNaN(version)) return fail("version", "This board has an unknown format version.");
    if (version > SCHEMA_VERSION) {
      return fail("newer", "This board was made by a newer version of the app. Reload the page to update, then try again.");
    }
    if (raw.app === undefined && !BOARD_FIELDS.some((k) => hasOwn(raw, k))) {
      return fail("not-board", "This doesn't look like a Team Brawl board.");
    }
    const { state, warnings } = normalizeState(raw);
    const limit = importLimitError(state);
    if (limit) return limit;
    const exportedAt = typeof raw.exportedAt === "string" && !Number.isNaN(Date.parse(raw.exportedAt)) ? raw.exportedAt : null;
    return { ok: true, state, warnings, exportedAt };
  }

  // base64url keeps the fragment safe from messengers that rewrite "+", "/" or "=".
  function utf8ToBase64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    // Chunked: spreading a whole large board into fromCharCode overflows the call stack.
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // Accepts base64url and the standard base64 the previous version wrote (a "+" may
  // arrive as a space after passing through a URL decoder).
  function base64ToUtf8(b64) {
    let s = b64.replace(/ /g, "+").replace(/-/g, "+").replace(/_/g, "/");
    s += "===".slice((s.length + 3) % 4);
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  function encodeShareHash(state) {
    return SHARE_PREFIX + utf8ToBase64Url(serializeState(shareableState(state)));
  }

  // null means "this fragment is not a share link"; otherwise a parseBoardJson result.
  function decodeShareHash(hash) {
    if (typeof hash !== "string" || !hash.startsWith(SHARE_PREFIX)) return null;
    let payload = hash.slice(SHARE_PREFIX.length);
    // base64 of UTF-8 is at most 4 characters per JSON character; checked before decoding.
    if (payload.length > MAX_TRANSFER_CHARS * 4) return fail("too-large", "This shared board is too large to open.");
    const broken = fail("broken-link", "This share link is damaged or incomplete. Ask for the link again, or for an Export file.");
    if (!payload) return broken;
    let text;
    try {
      if (payload.includes("%")) payload = decodeURIComponent(payload);
      text = base64ToUtf8(payload);
    } catch (error) {
      return broken;
    }
    const result = parseBoardJson(text);
    return !result.ok && (result.code === "json" || result.code === "empty") ? broken : result;
  }

  function bytesToBase64Url(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function base64UrlToBytes(b64) {
    let s = b64.replace(/ /g, "+").replace(/-/g, "+").replace(/_/g, "/");
    s += "===".slice((s.length + 3) % 4);
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function isShareHash(hash) {
    return typeof hash === "string" && (hash.startsWith(TIER_PREFIX) || hash.startsWith(ZIP_PREFIX) || hash.startsWith(SHARE_PREFIX));
  }

  // Constructing the streams is the only reliable test: some browsers have CompressionStream but
  // not the "deflate-raw" format (Chromium 80-102), and that must fall back, not throw.
  function canCompress() {
    if (typeof CompressionStream !== "function" || typeof DecompressionStream !== "function") return false;
    if (typeof Blob !== "function" || typeof Response !== "function") return false;
    try {
      new CompressionStream("deflate-raw");
      new DecompressionStream("deflate-raw");
      return true;
    } catch (error) {
      return false;
    }
  }
  // Appended to every compressed payload: base64url can end in "_" or "-", which autolinkers
  // (GitHub, chat apps) leave out of the link, silently cutting the last bytes.
  const ZIP_END = "Z";

  // Shared boards repeat every brawler name several times, which deflate removes: a typical
  // link shrinks to about a quarter. Falls back to an uncompressed link where unsupported.
  async function encodeShareHashAsync(state) {
    if (!canCompress()) return encodeShareHash(state);
    const text = serializeState(shareableState(state));
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return ZIP_PREFIX + bytesToBase64Url(new Uint8Array(await new Response(stream).arrayBuffer())) + ZIP_END;
  }

  // Reads the inflated stream chunk by chunk so a tiny crafted link (a "zip bomb") is stopped at
  // the size limit instead of being expanded in full first.
  async function inflateCapped(bytes, maxBytes) {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch (error) {
          // Already failing; the size verdict stands.
        }
        return null;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  // null means "this fragment is not a share link"; otherwise a parseBoardJson result.
  async function decodeShareHashAsync(hash) {
    if (typeof hash === "string" && hash.startsWith(SHARE_PREFIX)) return decodeShareHash(hash);
    if (typeof hash !== "string" || !hash.startsWith(ZIP_PREFIX)) return null;
    let payload = hash.slice(ZIP_PREFIX.length);
    if (payload.length > MAX_TRANSFER_CHARS * 4) return fail("too-large", "This shared board is too large to open.");
    const broken = fail("broken-link", "This share link is damaged or incomplete. Ask for the link again, or for an Export file.");
    if (!payload) return broken;
    if (!canCompress()) return fail("unsupported", "This browser can't open compressed links. Update it, or ask for an Export file.");
    let bytes;
    try {
      if (payload.includes("%")) payload = decodeURIComponent(payload);
      if (!payload.endsWith(ZIP_END)) return broken;
      payload = payload.slice(0, -ZIP_END.length);
      // UTF-8 needs at most 3 bytes per character, so anything bigger cannot pass parseBoardJson.
      bytes = await inflateCapped(base64UrlToBytes(payload), MAX_TRANSFER_CHARS * 3);
    } catch (error) {
      return broken;
    }
    if (bytes === null) return fail("too-large", "This shared board is too large to open.");
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      return broken;
    }
    const result = parseBoardJson(text);
    return !result.ok && (result.code === "json" || result.code === "empty") ? broken : result;
  }

  function classOf(b) {
    if (!isPlainObject(b)) return null;
    const c = typeof b.className === "string" ? b.className
      : isPlainObject(b.class) && typeof b.class.name === "string" ? b.class.name : null;
    return c && c.trim() && c.length <= MAX_IMPORT_NAME_LENGTH ? c : null;
  }

  // Adds the official classes as roles and tags every brawler with its class. Existing roles and
  // assignments stay; a class whose name a role already uses (any case) reuses that role.
  // newOnly (later loads): tag only brawlers with no roles entry at all — new releases — using
  // class roles that still exist, and create none, so roles or tags the user removed stay removed.
  function addClassRoles(state, roster, opts) {
    const newOnly = !!(opts && opts.newOnly);
    const pairs = [];
    for (const b of Array.isArray(roster) ? roster : []) {
      const c = classOf(b);
      if (c && typeof b.name === "string" && b.name && b.name !== "__proto__") pairs.push([b.name, c]);
    }
    const seen = [...new Set(pairs.map((p) => p[1]))];
    const rank = (c) => (CLASS_ORDER.includes(c) ? CLASS_ORDER.indexOf(c) : CLASS_ORDER.length + seen.indexOf(c));
    const roleFor = new Map();
    const added = [];
    for (const c of [...seen].sort((a, b) => rank(a) - rank(b))) {
      const existing = state.roles.find((r) => r.name.toLowerCase() === c.toLowerCase());
      if (existing) {
        roleFor.set(c, existing.name);
        continue;
      }
      if (newOnly) continue;
      state.roles.push({ name: c, color: hasOwn(CLASS_ROLE_COLORS, c) ? CLASS_ROLE_COLORS[c] : DEFAULT_ROLE_COLOR });
      roleFor.set(c, c);
      added.push(c);
    }
    let assigned = 0;
    for (const [name, c] of pairs) {
      const role = roleFor.get(c);
      if (!role || (newOnly && hasOwn(state.brawlerRoles, name))) continue;
      const current = hasOwn(state.brawlerRoles, name) ? state.brawlerRoles[name] : [];
      if (current.includes(role)) continue;
      state.brawlerRoles[name] = [...current, role];
      assigned++;
    }
    state.classRolesAdded = true;
    return { added, assigned };
  }

  // Keep roles fully user-editable. On an old/empty board, seed the official classes once;
  // after that, custom names, colors, additions and deletions are preserved.
  function ensureClassRoles(state, roster) {
    if (!Array.isArray(state.roles)) state.roles = [];
    if (!state.classRolesAdded && state.roles.length === 0) addClassRoles(state, roster, { newOnly: true });
    const valid = new Set(state.roles.map((r) => r.name));
    for (const name of Object.keys(state.brawlerRoles)) {
      state.brawlerRoles[name] = [...new Set((state.brawlerRoles[name] || []).filter((r) => valid.has(r)))];
    }
    state.classRolesAdded = true;
    return state;
  }

  const MAX_BRAWLER_CODE = 0xffffff; // six hex digits, the widest code a link can hold
  // A brawler's link code, or null when it has none: no usable id, or a name that must never
  // become an object key.
  function brawlerCode(b) {
    if (!isPlainObject(b) || typeof b.name !== "string" || b.name === "__proto__") return null;
    if (!Number.isSafeInteger(b.id) || b.id < BRAWLER_ID_BASE) return null;
    const code = b.id - BRAWLER_ID_BASE;
    return code <= MAX_BRAWLER_CODE ? code : null;
  }
  const hexOf = (n, width) => n.toString(16).padStart(width, "0");
  // Bit i stands for CLASS_ORDER[i]; names match in any case.
  function roleMask(roles) {
    let mask = 0;
    for (const r of roles) {
      const i = CLASS_ORDER.findIndex((c) => c.toLowerCase() === String(r).toLowerCase());
      if (i >= 0) mask |= 1 << i;
    }
    return mask;
  }
  // The brawler's class as a role list, in canonical case; [] when it has no official class.
  function officialRoles(b) {
    const c = classOf(b);
    const i = c ? CLASS_ORDER.findIndex((x) => x.toLowerCase() === c.toLowerCase()) : -1;
    return i >= 0 ? [CLASS_ORDER[i]] : [];
  }

  // "#t=" + code width + S codes "g" A codes "g" B … D codes [ "r" (code + 2-hex role mask)… ].
  // Codes in card order make the order implicit; only roles that differ from the official class
  // are sent. Notes, the role list and per-map data are not in the link. Returns null when the
  // roster has no brawler ids to build codes from.
  function encodeTierLink(state, roster) {
    const known = new Map();
    const usedCodes = new Set();
    for (const b of Array.isArray(roster) ? roster : []) {
      const code = brawlerCode(b);
      if (code === null || known.has(b.name) || usedCodes.has(code)) continue;
      usedCodes.add(code);
      known.set(b.name, { code, official: roleMask(officialRoles(b)) });
    }
    if (!known.size) return null;
    const width = Math.max(2, Math.max(...[...known.values()].map((v) => v.code)).toString(16).length);
    const groups = TIERS.map(() => []);
    for (const name of orderFor(state, BASE_MAP, [...known.keys()])) {
      const info = known.get(name);
      if (info) groups[TIERS.indexOf(tierOf(state, BASE_MAP, name))].push(hexOf(info.code, width));
    }
    let roles = "";
    for (const [name, info] of [...known].sort((a, b) => a[1].code - b[1].code)) {
      const own = hasOwn(state.brawlerRoles, name);
      const current = own ? roleMask(state.brawlerRoles[name]) : info.official;
      // With no class, "no entry" (tag it when a class arrives) and [] (keep untagged) differ.
      if (current !== info.official || (own && info.official === 0)) roles += hexOf(info.code, width) + hexOf(current, 2);
    }
    return TIER_PREFIX + width.toString(16) + groups.map((g) => g.join("")).join("g") + (roles ? "r" + roles : "");
  }

  // Structure only (no roster needed): { ok, tiers: [codes per S..D], roles: [[code, mask]] }.
  function decodeTierLink(hash) {
    if (typeof hash !== "string" || !hash.startsWith(TIER_PREFIX)) return null;
    let body = hash.slice(TIER_PREFIX.length);
    if (body.length > MAX_TIER_LINK_CHARS) return fail("too-large", "This shared tier list is too long to open.");
    const broken = fail("broken-link", "This share link is damaged or incomplete. Ask for the link again.");
    try {
      if (body.includes("%")) body = decodeURIComponent(body);
    } catch (error) {
      return broken;
    }
    const m = /^([2-6])((?:[0-9a-f]*g){4}[0-9a-f]*)(?:r([0-9a-f]*))?$/.exec(body.toLowerCase());
    if (!m) return broken;
    const width = parseInt(m[1], 16);
    const chunks = (s, size) => {
      const out = [];
      for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
      return out;
    };
    const groups = m[2].split("g");
    if (groups.some((g) => g.length % width)) return broken;
    const roleText = m[3] || "";
    if (roleText.length % (width + 2)) return broken;
    const roles = chunks(roleText, width + 2).map((x) => [parseInt(x.slice(0, width), 16), parseInt(x.slice(width), 16)]);
    if (roles.some(([, mask]) => mask >= 1 << CLASS_ORDER.length)) return broken;
    return { ok: true, tiers: groups.map((g) => chunks(g, width).map((h) => parseInt(h, 16))), roles };
  }

  // Applies a decoded tier link to a copy of the receiver's board: All Maps tiers and order come
  // from the link, brawlers the link does not list go to the end of B, listed brawlers take the
  // link's roles (their class unless the link changed them). Notes, other maps and drawings stay.
  // Codes the receiver's roster lacks are skipped and counted; a repeated code keeps its first place.
  function applyTierLink(mine, link, roster) {
    const out = clone(mine);
    const byCode = new Map();
    for (const b of Array.isArray(roster) ? roster : []) {
      const code = brawlerCode(b);
      if (code !== null && !byCode.has(code)) byCode.set(code, b);
    }
    let unknown = 0;
    const listed = new Map();
    link.tiers.forEach((codes, ti) => {
      for (const code of codes) {
        const b = byCode.get(code);
        if (!b) unknown++;
        else if (!listed.has(b.name)) listed.set(b.name, { tier: TIERS[ti], b });
      }
    });
    // Unlisted brawlers keep the order they had on the receiver's All Maps.
    const coded = new Set([...byCode.values()].map((b) => b.name));
    const previous = orderFor(out, BASE_MAP, [...coded]);
    const missing = previous.filter((n) => coded.has(n) && !listed.has(n));
    if (!hasOwn(out.mapPlacements, BASE_MAP)) out.mapPlacements[BASE_MAP] = {};
    const table = out.mapPlacements[BASE_MAP];
    const order = [];
    for (const tier of TIERS) {
      for (const [name, info] of listed) {
        if (info.tier !== tier) continue;
        table[name] = tier;
        order.push(name);
      }
      if (tier === "B") {
        for (const name of missing) {
          table[name] = "B";
          order.push(name);
        }
      }
    }
    out.mapOrders[BASE_MAP] = syncOrder(order, previous);
    const overrides = new Map();
    for (const [code, mask] of link.roles) if (!overrides.has(code)) overrides.set(code, mask);
    for (const [name, { b }] of listed) {
      const code = brawlerCode(b);
      if (overrides.has(code)) {
        const mask = overrides.get(code);
        out.brawlerRoles[name] = CLASS_ORDER.filter((_, i) => mask & (1 << i));
      } else {
        const official = officialRoles(b);
        if (official.length) out.brawlerRoles[name] = official;
        else delete out.brawlerRoles[name];
      }
    }
    if (!out.maps.includes(BASE_MAP)) out.maps.unshift(BASE_MAP);
    out.placements = { ...table };
    return { state: out, listed: listed.size, unknown, missing };
  }

  // WCAG relative luminance of a #rrggbb colour.
  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lin = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  }

  // Which fixed label colour reads better on a user-chosen role colour.
  function labelInkFor(hex) {
    if (typeof hex !== "string" || !COLOR_RE.test(hex)) return "paper";
    const l = luminance(hex);
    const onInk = (l + 0.05) / (luminance(LABEL_INK) + 0.05);
    const onPaper = (luminance(LABEL_PAPER) + 0.05) / (l + 0.05);
    return onInk >= onPaper ? "ink" : "paper";
  }

  function storageErrorReason(e) {
    const name = e && e.name;
    const code = e && e.code;
    if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || code === 22 || code === 1014) return "quota";
    if (name === "SecurityError") return "unavailable";
    return "unknown";
  }

  // Wraps a Web Storage object so no storage failure can throw into the UI.
  // `storage` may be null when the browser blocks access to localStorage entirely.
  function createStore(storage, key) {
    const recoveryKey = key + ":recovery";
    const rosterKey = key + ":roster";
    const backupKey = key + ":import-backup";

    function write(k, value) {
      if (!storage) return { ok: false, reason: "unavailable" };
      try {
        storage.setItem(k, value);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: storageErrorReason(error) };
      }
    }

    function clearBackup() {
      if (!storage) return;
      try {
        storage.removeItem(backupKey);
      } catch (error) {
        // Blocked storage has no backup to clear.
      }
    }

    function loadBackup() {
      if (!storage) return null;
      try {
        const parsed = JSON.parse(storage.getItem(backupKey));
        if (!isPlainObject(parsed) || !isPlainObject(parsed.board)) return null;
        return {
          savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : null,
          source: typeof parsed.source === "string" ? parsed.source : "file",
          state: normalizeState(parsed.board).state,
        };
      } catch (error) {
        return null;
      }
    }

    return {
      load() {
        if (!storage) return { status: "unavailable" };
        let raw;
        try {
          raw = storage.getItem(key);
        } catch (error) {
          return { status: "unavailable", error };
        }
        if (raw === null) return { status: "empty" };
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          return { status: "corrupt", raw, error };
        }
        if (!isPlainObject(parsed)) return { status: "corrupt", raw };
        const version = schemaVersionOf(parsed);
        if (Number.isNaN(version)) return { status: "corrupt", raw };
        const { state, warnings } = normalizeState(parsed);
        // A newer app may have stored fields this version would drop on its next save,
        // so the caller must quarantine `raw` before writing.
        return { status: version > SCHEMA_VERSION ? "newer" : "ok", raw, state, warnings };
      },

      save(state) {
        return write(key, serializeState(state));
      },

      // Keeps unreadable or too-new data aside before the app overwrites the main key,
      // so a bad read never destroys the only copy.
      quarantine(raw, reason, at) {
        return write(recoveryKey, JSON.stringify({ reason, at, raw }));
      },

      // One level deep: the board as it was right before the last import, for "Undo import".
      saveBackup(state, source, at) {
        return write(backupKey, JSON.stringify({ savedAt: at, source, board: withMeta(state) }));
      },
      loadBackup,
      hasBackup() {
        return loadBackup() !== null;
      },
      // Raw read/write so a failed import can put back exactly the backup it overwrote.
      readBackupRaw() {
        if (!storage) return null;
        try {
          return storage.getItem(backupKey);
        } catch (error) {
          return null;
        }
      },
      writeBackupRaw(raw) {
        if (raw === null) {
          clearBackup();
          return { ok: true };
        }
        return write(backupKey, raw);
      },
      clearBackup,

      saveRoster(list, at) {
        const slim = list.map((b) => ({
          id: b.id, name: b.name, imageUrl: b.imageUrl, imageUrl2: b.imageUrl2, imageUrl3: b.imageUrl3,
          className: classOf(b) || undefined,
        }));
        return write(rosterKey, JSON.stringify({ savedAt: at, list: slim }));
      },

      loadRoster() {
        if (!storage) return null;
        try {
          const parsed = JSON.parse(storage.getItem(rosterKey));
          if (!isPlainObject(parsed) || !Array.isArray(parsed.list)) return null;
          if (!parsed.list.every((b) => isPlainObject(b) && isNonBlank(b.name))) return null;
          return { savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : null, list: parsed.list };
        } catch (error) {
          return null;
        }
      },
    };
  }

  function createDebouncer(fn, delayMs, timers) {
    const t = timers || globalThis;
    let id = null;
    const run = () => {
      id = null;
      fn();
    };
    return {
      schedule() {
        if (id !== null) t.clearTimeout(id);
        id = t.setTimeout(run, delayMs);
      },
      flush() {
        if (id === null) return;
        t.clearTimeout(id);
        run();
      },
      cancel() {
        if (id === null) return;
        t.clearTimeout(id);
        id = null;
      },
      pending() {
        return id !== null;
      },
    };
  }

  return {
    APP_ID,
    SCHEMA_VERSION,
    TIERS,
    DEFAULT_MAPS,
    DEFAULT_PROJECT,
    DEFAULT_ROLE_COLOR,
    BASE_MAP,
    MAX_TRANSFER_CHARS,
    MAX_IMPORT_MAPS,
    MAX_IMPORT_ROLES,
    MAX_IMPORT_BRAWLERS,
    MAX_IMPORT_NAME_LENGTH,
    isReservedName,
    defaultState,
    normalizeState,
    baseTable,
    syncOrder,
    reconcileWithRoster,
    tierOf,
    placementFor,
    orderFor,
    materializeMap,
    upgradeBoard,
    shareableState,
    mergeSharedBoard,
    serializeState,
    buildExportJson,
    parseBoardJson,
    encodeShareHash,
    decodeShareHash,
    encodeShareHashAsync,
    decodeShareHashAsync,
    isShareHash,
    CLASS_ORDER,
    CLASS_ROLE_COLORS,
    addClassRoles,
    ensureClassRoles,
    pruneToMapPool,
    brawlerCode,
    encodeTierLink,
    decodeTierLink,
    applyTierLink,
    labelInkFor,
    inflateCapped,
    createStore,
    createDebouncer,
  };
});
