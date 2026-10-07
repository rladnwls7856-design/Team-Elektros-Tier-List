"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../js/catalog.js");
const POOL = require("../js/map-pool.js");
const CATALOG = require("../js/maps-catalog.js");

// The tournament map pool (2026-10-07). Map 1 of each mode is the tiebreaker map.
const EXPECTED = [
  ["Bounty", ["Hideout", "Dry Season", "Layer Cake"]],
  ["Heist", ["Kaboom Canyon", "Hot Potato", "Safe Zone"]],
  ["Hot Zone", ["Ring of Fire", "Open Business", "Dueling Beetles"]],
  ["Gem Grab", ["Hard Rock Mine", "Deathcap Trap", "Crystal Arcade"]],
  ["Knockout", ["Out in the Open", "Belle’s Rock", "Goldarm Gulch"]],
  ["Brawl Ball", ["Pinhole Punt", "Triple Dribble", "Beach Ball"]],
];

test("js/map-pool.js lists the tournament pool, in order, with the table's spelling", () => {
  const { catalog } = C.poolCatalog(CATALOG, POOL);
  assert.deepEqual(catalog.modes.map((m) => [m.name, m.maps.map((x) => x.label)]), EXPECTED);
});

test("every pool map has an image in the catalog (names must match the files)", () => {
  assert.deepEqual(C.poolCatalog(CATALOG, POOL).missing, []);
});

test("map 1 of each mode is the tiebreaker, and only map 1", () => {
  for (const m of C.poolCatalog(CATALOG, POOL).catalog.modes) {
    assert.deepEqual(m.maps.map((x) => x.tiebreaker), [true, false, false], m.name);
  }
});

test("an old board moves onto a pool map only when its name is unique in the whole catalog", () => {
  const keyFor = C.poolKeyForName(C.indexCatalog(CATALOG), C.indexCatalog(C.poolCatalog(CATALOG, POOL).catalog));
  assert.equal(keyFor("Kaboom Canyon"), "Heist/Kaboom Canyon");
  assert.equal(keyFor("Belles Rock"), "Knockout/Belles Rock");
  // Shared by two modes (Bounty and Wipeout, Bounty and Gem Grab): stays a custom board.
  for (const name of ["Hideout", "Dry Season", "Layer Cake", "Deathcap Trap"]) assert.equal(keyFor(name), null, name);
  // A real map outside the pool: stays a custom board rather than being moved and deleted.
  assert.equal(keyFor("Snake Prairie"), null);
  assert.equal(keyFor("constructor"), null);
});

test("pool keys are the catalog's file-name keys", () => {
  const keys = C.poolKeys(POOL);
  assert.equal(keys.length, 18);
  assert.ok(keys.includes("Knockout/Belles Rock"));
  assert.ok(keys.includes("Hot Zone/Ring Of Fire"));
});
