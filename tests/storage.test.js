"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../js/storage.js");

const plain = (x) => JSON.parse(JSON.stringify(x));

function deepFreeze(o) {
  if (o && typeof o === "object") {
    Object.values(o).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}

// Every shape the current UI can produce, including ones it should not
// (duplicate role names via rename, orders holding retired brawlers).
function uiState() {
  return {
    project: "World Finals Prep",
    maps: ["All Maps", "Gem Fort", "내 맵 🗺️", "constructor"],
    tiers: ["S", "A", "B", "C", "D"],
    placements: { Shelly: "S", Colt: "B" },
    mapPlacements: {
      "All Maps": { Shelly: "S", Colt: "B" },
      "Gem Fort": { Shelly: "A", Colt: "D" },
      "constructor": { Shelly: "C" },
    },
    mapOrders: { "All Maps": ["Colt", "Shelly"], "Gem Fort": ["Shelly", "Colt", "Retired"] },
    notes: { Shelly: "근접 압박 👍", Colt: "", Retired: "old note" },
    mapNotes: { "All Maps": "", "Gem Fort": "ban Mortis", "constructor": "x" },
    roles: [{ name: "Tank", color: "#ff0000" }, { name: "Tank", color: "#00FF00" }],
    brawlerRoles: { Shelly: ["Tank", "Tank"], Colt: [] },
    drawings: { "Gem Grab/Atlas": [{ t: "arrow", c: "#ffffff", w: 60, p: [500, 500, 9000, 9000] }] },
    classRolesAdded: false,
  };
}

function fakeStorage(opts = {}) {
  const data = new Map(Object.entries(opts.initial || {}));
  return {
    data,
    getItem(k) {
      if (opts.getError) throw opts.getError;
      return data.has(k) ? data.get(k) : null;
    },
    setItem(k, v) {
      if (opts.setError) throw opts.setError;
      data.set(k, String(v));
    },
    removeItem(k) {
      data.delete(k);
    },
  };
}

const domError = (name, code) => Object.assign(new Error(name), { name, code });

function fakeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    tick(ms) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

test.describe("normalizeState", () => {
  test("keeps everything the current UI can produce, unchanged", () => {
    const { state, warnings } = S.normalizeState(uiState());
    assert.deepEqual(plain(state), uiState());
    assert.deepEqual(warnings, []);
  });

  test("does not mutate its input", () => {
    assert.doesNotThrow(() => S.normalizeState(deepFreeze(uiState())));
  });

  test("keeps untrimmed names from older data so their tables and assignments stay linked", () => {
    const raw = {
      maps: ["All Maps", "Gem Fort "],
      mapPlacements: { "Gem Fort ": { Shelly: "A" } },
      mapNotes: { "Gem Fort ": "trailing space" },
      roles: [{ name: " Tank", color: "#123456" }],
      brawlerRoles: { Shelly: [" Tank"] },
    };
    const { state, warnings } = S.normalizeState(raw);
    assert.deepEqual(state.maps, ["All Maps", "Gem Fort "]);
    assert.equal(state.mapPlacements["Gem Fort "].Shelly, "A");
    assert.equal(state.mapNotes["Gem Fort "], "trailing space");
    assert.equal(state.roles[0].name, " Tank");
    assert.deepEqual(state.brawlerRoles.Shelly, [" Tank"]);
    assert.deepEqual(warnings, []);
  });

  test("returns fresh default containers that do not alias the defaults", () => {
    const a = S.normalizeState(null).state;
    a.maps.push("Mutated");
    const b = S.normalizeState(null).state;
    assert.deepEqual(b.maps, S.DEFAULT_MAPS);
    assert.ok(!S.DEFAULT_MAPS.includes("Mutated"));
  });

  for (const raw of [null, undefined, 42, "text", true, [], [{ maps: ["x"] }]]) {
    test(`replaces non-object root ${JSON.stringify(raw)} with the default board and warns`, () => {
      const { state, warnings } = S.normalizeState(raw);
      assert.deepEqual(plain(state), plain(S.defaultState()));
      assert.equal(warnings.length, 1);
    });
  }

  test("falls back to default maps when maps is missing or empty, without warning", () => {
    assert.deepEqual(S.normalizeState({}).state.maps, S.DEFAULT_MAPS);
    assert.deepEqual(S.normalizeState({ maps: [] }).state.maps, S.DEFAULT_MAPS);
    assert.deepEqual(S.normalizeState({}).warnings, []);
  });

  test("falls back to default maps and warns when maps is not an array", () => {
    const { state, warnings } = S.normalizeState({ maps: "Gem Fort" });
    assert.deepEqual(state.maps, S.DEFAULT_MAPS);
    assert.equal(warnings.length, 1);
  });

  test("drops invalid, blank, duplicate and __proto__ map names", () => {
    const { state, warnings } = S.normalizeState({
      maps: ["Gem Fort", "", "   ", 5, null, "gem fort", "__proto__", "Brawl Ball"],
    });
    assert.deepEqual(state.maps, ["Gem Fort", "Brawl Ball"]);
    assert.ok(warnings.length >= 1);
  });

  test("keeps the first of two map names that differ only by case, whichever case comes first", () => {
    assert.deepEqual(S.normalizeState({ maps: ["gem fort", "Gem Fort"] }).state.maps, ["gem fort"]);
  });

  test("always uses the fixed tier list", () => {
    assert.deepEqual(S.normalizeState({ tiers: ["X"] }).state.tiers, S.TIERS);
  });

  test("drops placements whose tier is not S/A/B/C/D", () => {
    const { state, warnings } = S.normalizeState({
      placements: { Shelly: "S", Colt: "Z", Bull: 3, Nita: "s" },
      mapPlacements: { "All Maps": { Shelly: "D", Colt: null }, "Gem Fort": "S", "Heist": [] },
    });
    assert.deepEqual(plain(state.placements), { Shelly: "S" });
    assert.deepEqual(plain(state.mapPlacements), { "All Maps": { Shelly: "D" } });
    assert.ok(warnings.length >= 1);
  });

  test("keeps role duplicates but drops nameless roles and repairs unsafe colors", () => {
    const { state, warnings } = S.normalizeState({
      roles: [
        { name: "Tank", color: "#ABCDEF" },
        { name: "Evil", color: 'red"><img src=x onerror=alert(1)>' },
        { name: "Beacon", color: "url(https://evil.example/x)" },
        { name: "Short", color: "#abc" },
        { name: "", color: "#000000" },
        { color: "#000000" },
        "Support",
        null,
      ],
    });
    assert.deepEqual(plain(state.roles), [
      { name: "Tank", color: "#ABCDEF" },
      { name: "Evil", color: S.DEFAULT_ROLE_COLOR },
      { name: "Beacon", color: S.DEFAULT_ROLE_COLOR },
      { name: "Short", color: S.DEFAULT_ROLE_COLOR },
    ]);
    assert.ok(warnings.length >= 1);
  });

  for (const color of ["#000000 url(https://evil.example/b)", "url(https://evil.example/c) #000000", "#0000000", " #000000", "#000000\n"]) {
    test(`resets the color ${JSON.stringify(color)} instead of letting extra CSS through`, () => {
      const { state } = S.normalizeState({ roles: [{ name: "x", color }] });
      assert.equal(state.roles[0].color, S.DEFAULT_ROLE_COLOR);
    });
  }

  test("replaces a non-array roles field with an empty list", () => {
    assert.deepEqual(S.normalizeState({ roles: { Tank: "#fff" } }).state.roles, []);
  });

  test("drops non-string notes, non-array orders and non-array role assignments", () => {
    const { state, warnings } = S.normalizeState({
      notes: { Shelly: "ok", Colt: 5, Bull: null },
      mapNotes: { "Gem Fort": "ok", "Heist": { a: 1 } },
      mapOrders: { "Gem Fort": ["Shelly", 7, null, "Colt"], "Heist": "Shelly" },
      brawlerRoles: { Shelly: ["Tank", 3], Colt: "Tank" },
    });
    assert.deepEqual(plain(state.notes), { Shelly: "ok" });
    assert.deepEqual(plain(state.mapNotes), { "Gem Fort": "ok" });
    assert.deepEqual(plain(state.mapOrders), { "Gem Fort": ["Shelly", "Colt"] });
    assert.deepEqual(plain(state.brawlerRoles), { Shelly: ["Tank"] });
    assert.ok(warnings.length >= 1);
  });

  test("replaces non-object containers with empty ones", () => {
    const { state } = S.normalizeState({ placements: "x", notes: [], mapNotes: "x", mapOrders: 1, brawlerRoles: null });
    assert.deepEqual(plain(state.placements), {});
    assert.deepEqual(plain(state.notes), {});
    assert.deepEqual(plain(state.mapNotes), {});
    assert.deepEqual(plain(state.mapOrders), {});
    assert.deepEqual(plain(state.brawlerRoles), {});
  });

  test("replaces a non-string project name with the default", () => {
    assert.equal(S.normalizeState({ project: { x: 1 } }).state.project, S.DEFAULT_PROJECT);
  });

  test("never lets __proto__ keys reach a prototype", () => {
    const raw = JSON.parse(
      '{"maps":["A"],"notes":{"__proto__":{"polluted":"yes"}},' +
      '"mapPlacements":{"__proto__":{"Shelly":"S"},"A":{"__proto__":"S"}},' +
      '"mapNotes":{"__proto__":"x"},"mapOrders":{"__proto__":["x"]},"brawlerRoles":{"__proto__":["x"]}}'
    );
    const { state } = S.normalizeState(raw);
    assert.equal(({}).polluted, undefined);
    for (const k of ["notes", "mapPlacements", "mapNotes", "mapOrders", "brawlerRoles", "placements"]) {
      assert.equal(Object.getPrototypeOf(state[k]), Object.prototype, k);
      assert.ok(!Object.prototype.hasOwnProperty.call(state[k], "__proto__"), k);
    }
    assert.equal(Object.getPrototypeOf(state.mapPlacements.A), Object.prototype);
  });

  test("drops unknown top-level fields and storage metadata", () => {
    const { state } = S.normalizeState({ app: "team-brawl", schemaVersion: 3, exportedAt: "x", extra: 1 });
    assert.deepEqual(Object.keys(state).sort(), [
      "brawlerRoles", "classRolesAdded", "drawings", "mapNotes", "mapOrders", "mapPlacements", "maps", "notes", "placements", "project", "roles", "tiers",
    ]);
  });
});

test.describe("isReservedName", () => {
  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
    test(`rejects ${name}`, () => assert.equal(S.isReservedName(name), true));
  }
  for (const name of ["Gem Fort", "Constructor", "proto", "All Maps"]) {
    test(`allows ${name}`, () => assert.equal(S.isReservedName(name), false));
  }
});

test.describe("syncOrder", () => {
  test("keeps the saved order untouched when the roster could not be loaded", () => {
    assert.deepEqual(S.syncOrder(["Colt", "Shelly"], []), ["Colt", "Shelly"]);
  });

  test("keeps brawlers that left the roster and appends new ones in roster order", () => {
    assert.deepEqual(S.syncOrder(["Retired", "Colt"], ["Shelly", "Colt", "Nita"]), ["Retired", "Colt", "Shelly", "Nita"]);
  });

  test("removes duplicates and non-strings", () => {
    assert.deepEqual(S.syncOrder(["Colt", 3, "Colt", null, "Shelly"], ["Shelly"]), ["Colt", "Shelly"]);
  });

  test("starts from roster order when there is no saved order", () => {
    assert.deepEqual(S.syncOrder(undefined, ["Shelly", "Colt"]), ["Shelly", "Colt"]);
  });

  test("does not mutate its inputs", () => {
    assert.doesNotThrow(() => S.syncOrder(Object.freeze(["Colt"]), Object.freeze(["Shelly"])));
  });
});

test.describe("reconcileWithRoster", () => {
  const base = () => S.normalizeState({
    maps: ["All Maps", "Gem Fort", "Heist"],
    placements: { Shelly: "A" },
    mapPlacements: { "All Maps": { Shelly: "S", Nova: "A" }, "Gem Fort": { Shelly: "D" } },
  }).state;

  test("shows a brawler missing from an existing map at its All Maps tier without writing it", () => {
    const s = base();
    S.reconcileWithRoster(s, ["Shelly", "Nova"]);
    assert.equal(S.tierOf(s, "Gem Fort", "Nova"), "A");
    assert.deepEqual(plain(s.mapPlacements["Gem Fort"]), { Shelly: "D" });
  });

  test("puts a brand-new brawler in B on All Maps, and other maps follow it", () => {
    const s = base();
    S.reconcileWithRoster(s, ["Shelly", "Nova", "Brand New"]);
    assert.equal(s.mapPlacements["All Maps"]["Brand New"], "B");
    assert.equal(S.tierOf(s, "Gem Fort", "Brand New"), "B");
  });

  test("never fills tables other than All Maps, so imports cannot grow per map", () => {
    const s = S.normalizeState({ maps: ["All Maps"], mapPlacements: { "All Maps": {}, "Gem Grab/Atlas": {}, "Heist/Pit Stop": {} } }).state;
    S.reconcileWithRoster(s, ["Shelly", "Colt"]);
    assert.deepEqual(plain(s.mapPlacements["Gem Grab/Atlas"]), {});
    assert.deepEqual(plain(s.mapPlacements["Heist/Pit Stop"]), {});
  });

  test("never overrides an existing placement", () => {
    const s = base();
    S.reconcileWithRoster(s, ["Shelly"]);
    assert.equal(s.mapPlacements["All Maps"].Shelly, "S");
    assert.equal(s.mapPlacements["Gem Fort"].Shelly, "D");
  });

  test("leaves maps without a placement table to be created lazily", () => {
    const s = base();
    S.reconcileWithRoster(s, ["Shelly"]);
    assert.ok(!Object.prototype.hasOwnProperty.call(s.mapPlacements, "Heist"));
  });

  test("changes nothing when the roster could not be loaded", () => {
    const s = base();
    const before = plain(s);
    S.reconcileWithRoster(s, []);
    assert.deepEqual(plain(s), before);
  });

  test("seeds All Maps from the legacy single tier list", () => {
    const s = S.normalizeState({ maps: ["All Maps"], placements: { Shelly: "A" } }).state;
    S.reconcileWithRoster(s, ["Shelly", "Colt"]);
    assert.deepEqual(plain(s.mapPlacements["All Maps"]), { Shelly: "A", Colt: "B" });
  });

  test("seeds All Maps from the legacy tier list even while the roster is offline", () => {
    const s = S.normalizeState({ maps: ["All Maps"], placements: { Shelly: "A" } }).state;
    S.reconcileWithRoster(s, []);
    assert.deepEqual(plain(s.mapPlacements["All Maps"]), { Shelly: "A" });
  });

  test("ignores a stale All Maps table left behind after All Maps was renamed", () => {
    const s = S.normalizeState({
      maps: ["Default", "Gem Fort"],
      mapPlacements: { "All Maps": { Colt: "D" }, "Gem Fort": { Shelly: "D" } },
    }).state;
    assert.equal(S.baseTable(s), null);
    S.reconcileWithRoster(s, ["Shelly", "Colt"]);
    assert.equal(S.tierOf(s, "Gem Fort", "Colt"), "B");
  });

  test("never writes onto inherited members for maps named like Object.prototype members", () => {
    const s = S.normalizeState({ maps: ["All Maps", "constructor", "toString"] }).state;
    S.reconcileWithRoster(s, ["Shelly"]);
    assert.equal(Object.Shelly, undefined);
    assert.equal(Object.prototype.toString.Shelly, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(s.mapPlacements, "constructor"));
  });

  test("does not resurrect a renamed All Maps board as a hidden ghost", () => {
    const s = S.normalizeState({
      maps: ["Default", "Gem Fort"],
      placements: { Shelly: "A" },
      mapPlacements: { "Default": { Shelly: "S" }, "Gem Fort": { Shelly: "D" } },
    }).state;
    S.reconcileWithRoster(s, ["Shelly", "Colt"]);
    assert.ok(!Object.prototype.hasOwnProperty.call(s.mapPlacements, "All Maps"));
    assert.equal(S.tierOf(s, "Gem Fort", "Colt"), "B");
  });
});

test.describe("createStore", () => {
  const KEY = "team-brawl-v2";

  test("reports empty storage", () => {
    assert.equal(S.createStore(fakeStorage(), KEY).load().status, "empty");
  });

  test("loads and normalizes a legacy unversioned board", () => {
    const st = fakeStorage({ initial: { [KEY]: JSON.stringify(uiState()) } });
    const r = S.createStore(st, KEY).load();
    assert.equal(r.status, "ok");
    assert.deepEqual(plain(r.state), uiState());
  });

  for (const raw of ["{not json", "null", "42", "[]", '"text"']) {
    test(`flags ${raw} as corrupt and leaves storage untouched`, () => {
      const st = fakeStorage({ initial: { [KEY]: raw } });
      const r = S.createStore(st, KEY).load();
      assert.equal(r.status, "corrupt");
      assert.equal(r.raw, raw);
      assert.equal(st.data.size, 1);
      assert.equal(st.data.get(KEY), raw);
    });
  }

  test("accepts the current schema version", () => {
    const st = fakeStorage({ initial: { [KEY]: JSON.stringify({ ...uiState(), schemaVersion: S.SCHEMA_VERSION }) } });
    assert.equal(S.createStore(st, KEY).load().status, "ok");
  });

  for (const v of [2, 3, S.SCHEMA_VERSION]) {
    test(`loads schema version ${v}`, () => {
      const st = fakeStorage({ initial: { [KEY]: JSON.stringify({ ...uiState(), schemaVersion: v }) } });
      assert.equal(S.createStore(st, KEY).load().status, "ok");
    });
  }

  for (const v of ["3", 0, 2.5, null]) {
    test(`flags schema version ${JSON.stringify(v)} as corrupt and returns the original for quarantine`, () => {
      const raw = JSON.stringify({ ...uiState(), schemaVersion: v });
      const st = fakeStorage({ initial: { [KEY]: raw } });
      const r = S.createStore(st, KEY).load();
      assert.equal(r.status, "corrupt");
      assert.equal(r.raw, raw);
      assert.equal(st.data.get(KEY), raw);
    });
  }

  test("flags data written by a newer version and still offers what it can read", () => {
    const raw = JSON.stringify({ ...uiState(), schemaVersion: S.SCHEMA_VERSION + 1 });
    const r = S.createStore(fakeStorage({ initial: { [KEY]: raw } }), KEY).load();
    assert.equal(r.status, "newer");
    assert.equal(r.raw, raw);
    assert.deepEqual(plain(r.state), uiState());
  });

  test("reports unavailable storage when reading throws", () => {
    const st = fakeStorage({ getError: domError("SecurityError", 18) });
    assert.equal(S.createStore(st, KEY).load().status, "unavailable");
  });

  test("reports unavailable storage when there is no storage at all", () => {
    const store = S.createStore(null, KEY);
    assert.equal(store.load().status, "unavailable");
    assert.deepEqual(store.save(S.defaultState()), { ok: false, reason: "unavailable" });
  });

  test("saves the board with app id and schema version", () => {
    const st = fakeStorage();
    assert.deepEqual(S.createStore(st, KEY).save(uiState()), { ok: true });
    const saved = JSON.parse(st.data.get(KEY));
    assert.equal(saved.app, S.APP_ID);
    assert.equal(saved.schemaVersion, S.SCHEMA_VERSION);
    assert.deepEqual(S.normalizeState(saved).state, S.normalizeState(uiState()).state);
  });

  for (const [label, err] of [
    ["QuotaExceededError", domError("QuotaExceededError", 22)],
    ["Firefox quota error", domError("NS_ERROR_DOM_QUOTA_REACHED", 1014)],
    ["legacy code 22", domError("Error", 22)],
  ]) {
    test(`reports a full storage on ${label}`, () => {
      const r = S.createStore(fakeStorage({ setError: err }), KEY).save(uiState());
      assert.equal(r.ok, false);
      assert.equal(r.reason, "quota");
    });
  }

  test("reports unavailable storage when writing is blocked", () => {
    const r = S.createStore(fakeStorage({ setError: domError("SecurityError", 18) }), KEY).save(uiState());
    assert.equal(r.reason, "unavailable");
  });

  test("quarantines unreadable data under a recovery key", () => {
    const st = fakeStorage();
    const store = S.createStore(st, KEY);
    assert.equal(store.quarantine("{broken", "corrupt", "2026-10-06T00:00:00.000Z").ok, true);
    assert.deepEqual(JSON.parse(st.data.get(KEY + ":recovery")), {
      reason: "corrupt", at: "2026-10-06T00:00:00.000Z", raw: "{broken",
    });
  });

  test("caches only the roster fields the board uses", () => {
    const st = fakeStorage();
    const store = S.createStore(st, KEY);
    store.saveRoster([{ id: 1, name: "Shelly", imageUrl: "a", imageUrl2: "b", imageUrl3: "c", description: "long" }], "2026-10-06T00:00:00.000Z");
    assert.deepEqual(store.loadRoster(), {
      savedAt: "2026-10-06T00:00:00.000Z",
      list: [{ id: 1, name: "Shelly", imageUrl: "a", imageUrl2: "b", imageUrl3: "c" }],
    });
  });

  test("ignores a broken roster cache", () => {
    for (const raw of ["{bad", "[]", '{"list":"x"}', '{"list":[{"id":1}]}']) {
      const st = fakeStorage({ initial: { [KEY + ":roster"]: raw } });
      assert.equal(S.createStore(st, KEY).loadRoster(), null, raw);
    }
  });

  test("roster cache failures never throw", () => {
    const store = S.createStore(fakeStorage({ setError: domError("QuotaExceededError", 22), getError: domError("SecurityError", 18) }), KEY);
    assert.doesNotThrow(() => store.saveRoster([{ id: 1, name: "Shelly" }], "x"));
    assert.equal(store.loadRoster(), null);
  });
});

test.describe("createDebouncer", () => {
  test("runs once, 500ms after the last call (boundary 499/500)", () => {
    const clock = fakeClock();
    let calls = 0;
    const d = S.createDebouncer(() => calls++, 500, clock);
    d.schedule();
    clock.tick(499);
    assert.equal(calls, 0);
    clock.tick(1);
    assert.equal(calls, 1);
  });

  test("restarts the wait on every call", () => {
    const clock = fakeClock();
    let calls = 0;
    const d = S.createDebouncer(() => calls++, 500, clock);
    d.schedule();
    clock.tick(300);
    d.schedule();
    clock.tick(300);
    assert.equal(calls, 0);
    clock.tick(200);
    assert.equal(calls, 1);
  });

  test("flush runs a pending call immediately and only once", () => {
    const clock = fakeClock();
    let calls = 0;
    const d = S.createDebouncer(() => calls++, 500, clock);
    d.schedule();
    assert.equal(d.pending(), true);
    d.flush();
    assert.equal(calls, 1);
    assert.equal(d.pending(), false);
    clock.tick(1000);
    assert.equal(calls, 1);
  });

  test("flush does nothing when nothing is pending", () => {
    let calls = 0;
    S.createDebouncer(() => calls++, 500, fakeClock()).flush();
    assert.equal(calls, 0);
  });

  test("uses the real timers when none are passed (the way index.html calls it)", async () => {
    let calls = 0;
    const d = S.createDebouncer(() => calls++, 1);
    d.schedule();
    assert.equal(d.pending(), true);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, 1);
    assert.equal(d.pending(), false);
  });

  test("cancel drops a pending call", () => {
    const clock = fakeClock();
    let calls = 0;
    const d = S.createDebouncer(() => calls++, 500, clock);
    d.schedule();
    d.cancel();
    clock.tick(1000);
    assert.equal(calls, 0);
    assert.equal(d.pending(), false);
  });
});
