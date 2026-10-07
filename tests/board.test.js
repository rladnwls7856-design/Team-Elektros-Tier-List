"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../js/storage.js");
const D = require("../js/drawing.js");
const C = require("../js/catalog.js");

const plain = (x) => JSON.parse(JSON.stringify(x));
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const ROSTER = ["Shelly", "Colt", "Nova"];

function board(extra = {}) {
  const s = S.normalizeState({
    maps: ["All Maps"],
    mapPlacements: { "All Maps": { Shelly: "S", Colt: "A", Nova: "C" }, "Gem Grab/Atlas": { Shelly: "D" } },
    mapOrders: { "All Maps": ["Nova", "Colt", "Shelly"] },
    ...extra,
  }).state;
  return S.reconcileWithRoster(s, ROSTER);
}

const pen = D.createPen([100, 100, 2000, 2500, 4000, 900], "#ff0000", 80);
const arrow = D.createArrow(500, 500, 9000, 9000, "#ffffff", 60);
const text = D.createText(5000, 5000, "여기 대기", "#ffd60a", 350);
const icon = D.createBrawler(3000, 7000, "Shelly", 900);

test.describe("read-only views", () => {
  test("tierOf reads a map's own table first, then All Maps, then B", () => {
    const s = board();
    assert.equal(S.tierOf(s, "Gem Grab/Atlas", "Shelly"), "D");
    assert.equal(S.tierOf(s, "Gem Grab/Atlas", "Colt"), "A");
    assert.equal(S.tierOf(s, "Heist/Pit Stop", "Nova"), "C");
    assert.equal(S.tierOf(s, "All Maps", "Brand New"), "B");
    assert.equal(S.tierOf(s, "Heist/Pit Stop", "constructor"), "B");
  });

  test("placementFor gives every roster brawler a tier without writing anything", () => {
    const s = board();
    const before = plain(s);
    assert.deepEqual(plain(S.placementFor(s, "Heist/Pit Stop", ROSTER)), { Shelly: "S", Colt: "A", Nova: "C" });
    assert.deepEqual(plain(S.placementFor(s, "Gem Grab/Atlas", ROSTER)), { Shelly: "D", Colt: "A", Nova: "C" });
    assert.deepEqual(plain(s), before);
  });

  test("orderFor follows All Maps' order for an unedited map without writing it", () => {
    const s = board();
    const before = plain(s);
    assert.deepEqual(S.orderFor(s, "Heist/Pit Stop", ROSTER), ["Nova", "Colt", "Shelly"]);
    assert.deepEqual(plain(s), before);
  });

  test("orderFor keeps the saved order and appends new brawlers", () => {
    const s = board({ mapOrders: { "All Maps": ["Nova"], "Gem Grab/Atlas": ["Colt", "Retired"] } });
    assert.deepEqual(S.orderFor(s, "Gem Grab/Atlas", ROSTER), ["Colt", "Retired", "Shelly", "Nova"]);
  });

  test("views never expose the stored arrays or tables for mutation", () => {
    const s = board();
    S.orderFor(s, "All Maps", ROSTER).push("Hacked");
    S.placementFor(s, "All Maps", ROSTER).Shelly = "D";
    assert.deepEqual(s.mapOrders["All Maps"], ["Nova", "Colt", "Shelly"]);
    assert.equal(s.mapPlacements["All Maps"].Shelly, "S");
  });
});

test.describe("materializeMap", () => {
  test("copies the current view into the map on its first edit, then the map is independent", () => {
    const s = board();
    const { table, order } = S.materializeMap(s, "Heist/Pit Stop", ROSTER);
    assert.deepEqual(plain(table), { Shelly: "S", Colt: "A", Nova: "C" });
    assert.deepEqual(order, ["Nova", "Colt", "Shelly"]);
    table.Shelly = "D";
    assert.equal(s.mapPlacements["All Maps"].Shelly, "S");
    s.mapPlacements["All Maps"].Colt = "D";
    assert.equal(S.tierOf(s, "Heist/Pit Stop", "Colt"), "A");
  });

  test("returns the existing table and order when the map was already edited", () => {
    const s = board({ mapOrders: { "All Maps": [], "Gem Grab/Atlas": ["Shelly"] } });
    const { table, order } = S.materializeMap(s, "Gem Grab/Atlas", ROSTER);
    assert.equal(table, s.mapPlacements["Gem Grab/Atlas"]);
    assert.equal(order, s.mapOrders["Gem Grab/Atlas"]);
    assert.deepEqual(order, ["Shelly", "Colt", "Nova"]);
    assert.deepEqual(plain(table), { Shelly: "D", Colt: "A", Nova: "C" });
  });

  test("copies only roster brawlers, so junk names in All Maps cannot multiply per map", () => {
    const junk = Object.fromEntries(Array.from({ length: 5 }, (_, i) => ["Junk " + i, "D"]));
    const s = board({
      mapPlacements: { "All Maps": { Shelly: "S", Colt: "A", Nova: "C", ...junk } },
      mapOrders: { "All Maps": ["Junk 0", "Nova", "Junk 1", "Colt", "Shelly"] },
    });
    const { table, order } = S.materializeMap(s, "Heist/Pit Stop", ROSTER);
    assert.deepEqual(Object.keys(table).sort(), ["Colt", "Nova", "Shelly"]);
    assert.deepEqual(order, ["Nova", "Colt", "Shelly"]);
    assert.equal(S.tierOf(s, "Heist/Pit Stop", "Junk 0"), "D");
  });

  test("keeps a map's own saved order entries when materializing it again", () => {
    const s = board({ mapOrders: { "All Maps": [], "Gem Grab/Atlas": ["Retired", "Colt"] } });
    assert.deepEqual(S.materializeMap(s, "Gem Grab/Atlas", ROSTER).order, ["Retired", "Colt", "Shelly", "Nova"]);
  });

  test("works for All Maps itself", () => {
    const s = board();
    const { table } = S.materializeMap(s, "All Maps", ROSTER);
    assert.equal(table, s.mapPlacements["All Maps"]);
  });

  test("never writes onto inherited members", () => {
    const s = board();
    S.materializeMap(s, "constructor", ROSTER);
    assert.equal(Object.Shelly, undefined);
    assert.ok(hasOwn(s.mapPlacements, "constructor"));
  });
});

test.describe("upgradeBoard", () => {
  const index = C.indexCatalog(C.buildCatalog("Brawlstars map", [
    { mode: "Gem Grab", file: "Hard Rock Mine.png", w: 1, h: 1 },
    { mode: "Bounty", file: "Crossroads.png", w: 1, h: 1 },
    { mode: "Heist", file: "Crossroads.png", w: 1, h: 1 },
  ]));

  test("moves an old board onto the only catalog map with that name", () => {
    const s = S.normalizeState({
      maps: ["All Maps", "Hard Rock Mine", "Crossroads", "Scrim Notes"],
      mapPlacements: { "Hard Rock Mine": { Shelly: "A" }, Crossroads: { Colt: "S" } },
      mapOrders: { "Hard Rock Mine": ["Shelly"] },
      mapNotes: { "Hard Rock Mine": "ban Edgar", "Scrim Notes": "x" },
    }).state;
    const r = S.upgradeBoard(s, index.uniqueKeyForName);
    assert.deepEqual(r.adopted, [{ from: "Hard Rock Mine", to: "Gem Grab/Hard Rock Mine" }]);
    assert.deepEqual(s.maps, ["All Maps", "Crossroads", "Scrim Notes"]);
    assert.deepEqual(plain(s.mapPlacements["Gem Grab/Hard Rock Mine"]), { Shelly: "A" });
    assert.deepEqual(s.mapOrders["Gem Grab/Hard Rock Mine"], ["Shelly"]);
    assert.equal(s.mapNotes["Gem Grab/Hard Rock Mine"], "ban Edgar");
    assert.ok(!hasOwn(s.mapPlacements, "Hard Rock Mine"));
    assert.ok(!hasOwn(s.mapNotes, "Hard Rock Mine"));
    assert.deepEqual(plain(s.mapPlacements.Crossroads), { Colt: "S" });
  });

  test("keeps an old board as custom when the catalog map already has data", () => {
    const s = S.normalizeState({
      maps: ["All Maps", "Hard Rock Mine"],
      mapNotes: { "Hard Rock Mine": "old", "Gem Grab/Hard Rock Mine": "new" },
    }).state;
    assert.deepEqual(S.upgradeBoard(s, index.uniqueKeyForName).adopted, []);
    assert.deepEqual(s.maps, ["All Maps", "Hard Rock Mine"]);
    assert.equal(s.mapNotes["Gem Grab/Hard Rock Mine"], "new");
  });

  test("puts All Maps back when an older version let it be removed", () => {
    const s = S.normalizeState({ maps: ["Default"] }).state;
    S.upgradeBoard(s, index.uniqueKeyForName);
    assert.deepEqual(s.maps, ["All Maps", "Default"]);
  });

  test("a re-added All Maps starts fresh instead of reviving stale or ghost data", () => {
    const s = S.normalizeState({
      maps: ["Default"],
      placements: { Shelly: "D" },
      mapPlacements: { "All Maps": { Colt: "D" }, Default: { Shelly: "S" } },
      mapOrders: { "All Maps": ["Colt"] },
      mapNotes: { "All Maps": "deleted long ago" },
    }).state;
    S.upgradeBoard(s, index.uniqueKeyForName);
    S.reconcileWithRoster(s, ROSTER);
    assert.deepEqual(plain(s.mapPlacements["All Maps"]), { Shelly: "B", Colt: "B", Nova: "B" });
    assert.ok(!hasOwn(s.mapOrders, "All Maps"));
    assert.ok(!hasOwn(s.mapNotes, "All Maps"));
    assert.deepEqual(plain(s.mapPlacements.Default), { Shelly: "S" });
  });

  test("an All Maps renamed only in case becomes All Maps again with its data", () => {
    const s = S.normalizeState({
      maps: ["All maps", "Default"],
      mapPlacements: { "All maps": { Shelly: "A" } },
      mapOrders: { "All maps": ["Shelly"] },
      mapNotes: { "All maps": "mine" },
    }).state;
    S.upgradeBoard(s, index.uniqueKeyForName);
    assert.deepEqual(s.maps, ["All Maps", "Default"]);
    assert.deepEqual(plain(s.mapPlacements["All Maps"]), { Shelly: "A" });
    assert.deepEqual(s.mapOrders["All Maps"], ["Shelly"]);
    assert.equal(s.mapNotes["All Maps"], "mine");
    assert.ok(!hasOwn(s.mapPlacements, "All maps"));
    // Survives the next load's case-insensitive de-duplication.
    assert.deepEqual(S.normalizeState(plain(s)).state.maps, ["All Maps", "Default"]);
  });

  test("drops a custom board whose name is itself a catalog key; its data already lives there", () => {
    const s = S.normalizeState({
      maps: ["All Maps", "Gem Grab/Hard Rock Mine", "Scrim Notes"],
      mapNotes: { "Gem Grab/Hard Rock Mine": "kept" },
    }).state;
    S.upgradeBoard(s, index.uniqueKeyForName, (k) => index.byKey.has(k));
    assert.deepEqual(s.maps, ["All Maps", "Scrim Notes"]);
    assert.equal(s.mapNotes["Gem Grab/Hard Rock Mine"], "kept");
  });

  test("keeps everything as custom when no catalog is available", () => {
    const s = S.normalizeState({ maps: ["All Maps", "Hard Rock Mine"] }).state;
    assert.deepEqual(S.upgradeBoard(s, null).adopted, []);
    assert.deepEqual(s.maps, ["All Maps", "Hard Rock Mine"]);
  });

  test("is idempotent", () => {
    const s = S.normalizeState({ maps: ["All Maps", "Hard Rock Mine"], mapNotes: { "Hard Rock Mine": "x" } }).state;
    S.upgradeBoard(s, index.uniqueKeyForName);
    const once = plain(s);
    S.upgradeBoard(s, index.uniqueKeyForName);
    assert.deepEqual(plain(s), once);
  });
});

test.describe("drawings in the board", () => {
  test("keep every shape the drawing tools produce, unchanged", () => {
    const drawings = { "Gem Grab/Atlas": [pen, arrow, text, icon], "Brawl Ball/Backyard Bowl#15000663": [pen] };
    const { state, warnings } = S.normalizeState({ maps: ["All Maps"], drawings });
    assert.deepEqual(plain(state.drawings), plain(drawings));
    assert.deepEqual(warnings, []);
  });

  test("report each dropped shape", () => {
    const { warnings } = S.normalizeState({ drawings: { "Gem Grab/Atlas": [pen, { t: "pen", c: "red", w: 5, p: [1, 2] }] } });
    assert.deepEqual(warnings, ["Skipped 1 invalid drawing shape."]);
  });

  test("drop invalid shapes and non-array drawings with a warning", () => {
    // JSON.parse makes "__proto__" an own key, exactly as an imported file would.
    const raw = JSON.parse(JSON.stringify({
      drawings: { "Gem Grab/Atlas": [pen, { t: "pen", c: "red", w: 5, p: [1, 2] }], "Heist/Pit Stop": "scribble" },
    }).replace('"Heist/Pit Stop"', '"__proto__":[{"t":"text","c":"#000000","x":1,"y":1,"z":300,"s":"x"}],"Heist/Pit Stop"'));
    const { state, warnings } = S.normalizeState(raw);
    assert.deepEqual(plain(state.drawings), { "Gem Grab/Atlas": [plain(pen)] });
    assert.equal(Object.getPrototypeOf(state.drawings), Object.prototype);
    assert.ok(warnings.length >= 1);
  });

  test("start empty", () => {
    assert.deepEqual(plain(S.defaultState().drawings), {});
  });

  test("survive an export round trip", () => {
    const st = S.normalizeState({ maps: ["All Maps"], drawings: { "Gem Grab/Atlas": [pen, text] } }).state;
    const r = S.parseBoardJson(S.buildExportJson(st, "2026-10-07T00:00:00.000Z"));
    assert.equal(r.ok, true);
    assert.deepEqual(plain(r.state.drawings), plain(st.drawings));
  });
});

test.describe("share links carry the general board only", () => {
  function full() {
    return S.normalizeState({
      project: "Scrims",
      maps: ["All Maps", "Scrim Notes"],
      placements: { Shelly: "S" },
      mapPlacements: { "All Maps": { Shelly: "S", Colt: "A" }, "Gem Grab/Atlas": { Shelly: "D" }, "Scrim Notes": { Colt: "C" } },
      mapOrders: { "All Maps": ["Colt", "Shelly"], "Gem Grab/Atlas": ["Shelly", "Colt"] },
      notes: { Shelly: "tank killer" },
      mapNotes: { "All Maps": "general plan", "Gem Grab/Atlas": "mid control" },
      roles: [{ name: "Tank", color: "#ff0000" }],
      brawlerRoles: { Shelly: ["Tank"] },
      drawings: { "Gem Grab/Atlas": [pen] },
    }).state;
  }

  test("shareableState keeps All Maps, brawler notes and roles and drops every map's data", () => {
    const s = S.shareableState(full());
    assert.equal(s.project, "Scrims");
    assert.deepEqual(s.maps, ["All Maps"]);
    assert.deepEqual(Object.keys(s.mapPlacements), ["All Maps"]);
    assert.deepEqual(Object.keys(s.mapOrders), ["All Maps"]);
    assert.deepEqual(plain(s.mapNotes), { "All Maps": "general plan" });
    assert.deepEqual(plain(s.notes), { Shelly: "tank killer" });
    assert.deepEqual(plain(s.roles), [{ name: "Tank", color: "#ff0000" }]);
    assert.deepEqual(plain(s.brawlerRoles), { Shelly: ["Tank"] });
    assert.deepEqual(plain(s.drawings), {});
  });

  test("encodeShareHash puts no map data or drawing in the link", () => {
    const r = S.decodeShareHash(S.encodeShareHash(full()));
    assert.equal(r.ok, true);
    assert.deepEqual(plain(r.state), plain(S.shareableState(full())));
  });

  test("a link of a board with many edited maps stays as short as one without", () => {
    const many = full();
    for (let i = 0; i < 50; i++) {
      many.mapPlacements["Gem Grab/Map " + i] = { Shelly: "D", Colt: "D" };
      many.drawings["Gem Grab/Map " + i] = [pen, arrow, text, icon];
    }
    assert.equal(S.encodeShareHash(many).length, S.encodeShareHash(full()).length);
  });

  test("mergeSharedBoard replaces the general board and keeps the receiver's maps and drawings", () => {
    // Every general field holds an entry the link lacks, so a merge instead of a replace shows up.
    const mine = S.normalizeState({
      maps: ["All Maps", "My Custom"],
      mapPlacements: { "All Maps": { Shelly: "D", Nova: "D" }, "Heist/Pit Stop": { Colt: "S" } },
      mapOrders: { "All Maps": ["Shelly"], "Heist/Pit Stop": ["Colt"] },
      notes: { Colt: "mine" },
      mapNotes: { "All Maps": "my general", "Heist/Pit Stop": "my heist plan" },
      roles: [{ name: "Mine", color: "#00ff00" }],
      brawlerRoles: { Colt: ["Mine"] },
      drawings: { "Heist/Pit Stop": [arrow] },
    }).state;
    const merged = S.mergeSharedBoard(mine, S.shareableState(full()));
    assert.equal(merged.project, "Scrims");
    assert.deepEqual(plain(merged.mapPlacements["All Maps"]), { Shelly: "S", Colt: "A" });
    assert.deepEqual(merged.mapOrders["All Maps"], ["Colt", "Shelly"]);
    assert.equal(merged.mapNotes["All Maps"], "general plan");
    assert.deepEqual(plain(merged.notes), { Shelly: "tank killer" });
    assert.deepEqual(plain(merged.roles), [{ name: "Tank", color: "#ff0000" }]);
    assert.deepEqual(plain(merged.brawlerRoles), { Shelly: ["Tank"] });
    assert.deepEqual(merged.maps, ["All Maps", "My Custom"]);
    assert.deepEqual(plain(merged.mapPlacements["Heist/Pit Stop"]), { Colt: "S" });
    assert.deepEqual(merged.mapOrders["Heist/Pit Stop"], ["Colt"]);
    assert.equal(merged.mapNotes["Heist/Pit Stop"], "my heist plan");
    assert.deepEqual(plain(merged.drawings), { "Heist/Pit Stop": [plain(arrow)] });
  });

  test("mergeSharedBoard ignores map data even when an old full link carries it", () => {
    const mine = S.normalizeState({ maps: ["All Maps"], mapNotes: { "Gem Grab/Atlas": "mine" } }).state;
    const merged = S.mergeSharedBoard(mine, full());
    assert.equal(merged.mapNotes["Gem Grab/Atlas"], "mine");
    assert.ok(!hasOwn(merged.mapPlacements, "Gem Grab/Atlas"));
    assert.deepEqual(plain(merged.drawings), {});
    assert.deepEqual(merged.maps, ["All Maps"]);
  });

  test("mergeSharedBoard clears the receiver's All Maps note when the link has none", () => {
    const mine = S.normalizeState({ maps: ["All Maps"], mapNotes: { "All Maps": "mine" } }).state;
    const merged = S.mergeSharedBoard(mine, S.normalizeState({ maps: ["All Maps"] }).state);
    assert.ok(!hasOwn(merged.mapNotes, "All Maps"));
  });

  test("mergeSharedBoard does not mutate either input", () => {
    const mine = board();
    const theirs = full();
    const a = plain(mine);
    const b = plain(theirs);
    S.mergeSharedBoard(mine, theirs).mapPlacements["All Maps"].Shelly = "C";
    assert.deepEqual(plain(mine), a);
    assert.deepEqual(plain(theirs), b);
  });
});

test.describe("pruneToMapPool", () => {
  const POOL = ["Gem Grab/Hard Rock Mine", "Heist/Safe Zone"];
  const stroke = () => [{ t: "pen", c: "#ff0000", w: 40, p: [0, 0, 10, 10] }];
  function messy() {
    return S.normalizeState({
      maps: ["All Maps", "Scrim Notes", "Heist/Hot Potato"],
      mapPlacements: { "All Maps": { Shelly: "S" }, "Gem Grab/Hard Rock Mine": { Shelly: "A" }, "Bounty/Hideout": { Colt: "S" }, "Scrim Notes": { Nova: "B" }, "Heist/Hot Potato": { Nova: "A" }, "Old Renamed Map": { Colt: "D" } },
      mapOrders: { "All Maps": ["Shelly"], "Bounty/Hideout": ["Colt"], "Gem Grab/Hard Rock Mine": ["Shelly"] },
      mapNotes: { "All Maps": "general", "Bounty/Hideout": "ban Edgar", "Heist/Safe Zone": "pool note", "Brawl Ball/Beach Ball": "" },
      drawings: {
        "Gem Grab/Hard Rock Mine": stroke(),
        "Gem Grab/Hard Rock Mine#15000305": stroke(),
        "Bounty/Hideout#15000001": stroke(),
        "Knockout/Belles Rock": [],
      },
    }).state;
  }

  test("deletes tiers, orders, notes and drawings of maps outside the pool", () => {
    const s = messy();
    const r = S.pruneToMapPool(s, POOL);
    assert.deepEqual(Object.keys(s.mapPlacements).sort(), ["All Maps", "Gem Grab/Hard Rock Mine", "Heist/Hot Potato", "Scrim Notes"]);
    assert.deepEqual(Object.keys(s.mapOrders).sort(), ["All Maps", "Gem Grab/Hard Rock Mine"]);
    assert.deepEqual(Object.keys(s.mapNotes).sort(), ["All Maps", "Heist/Safe Zone"]);
    assert.deepEqual(Object.keys(s.drawings).sort(), ["Gem Grab/Hard Rock Mine", "Gem Grab/Hard Rock Mine#15000305"]);
    // Reported: maps that had something worth keeping (empty notes and empty drawings are not).
    assert.deepEqual(r.maps, ["Bounty/Hideout", "Old Renamed Map"]);
    assert.equal(r.drawings, 1);
  });

  test("keeps All Maps and custom boards, even one named like a map key", () => {
    const s = messy();
    S.pruneToMapPool(s, POOL);
    assert.deepEqual(s.maps, ["All Maps", "Scrim Notes", "Heist/Hot Potato"]);
    assert.deepEqual(plain(s.mapPlacements["Scrim Notes"]), { Nova: "B" });
    assert.equal(s.mapNotes["All Maps"], "general");
  });

  test("does nothing without a pool, so a missing pool file can never wipe every map", () => {
    for (const empty of [[], null, undefined, "x"]) {
      const s = messy();
      const before = plain(s);
      assert.deepEqual(S.pruneToMapPool(s, empty), { maps: [], drawings: 0 });
      assert.deepEqual(plain(s), before);
    }
  });

  test("is idempotent and leaves a board normalizeState keeps as is", () => {
    const s = messy();
    S.pruneToMapPool(s, POOL);
    const once = plain(s);
    assert.deepEqual(S.pruneToMapPool(s, POOL), { maps: [], drawings: 0 });
    assert.deepEqual(plain(s), once);
    const again = S.normalizeState(plain(s));
    assert.deepEqual(again.warnings, []);
    assert.deepEqual(plain(again.state), once);
  });
});
