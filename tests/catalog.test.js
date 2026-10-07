"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const C = require("../js/catalog.js");

const entries = [
  { mode: "Gem Grab", file: "Hard Rock Mine.png", w: 690, h: 1050 },
  { mode: "Brawl Ball", file: "Backyard Bowl (15000786).png", w: 690, h: 1050 },
  { mode: "Brawl Ball", file: "Backyard Bowl.png", w: 690, h: 1050 },
  { mode: "Brawl Ball", file: "Backyard Bowl (15000663).png", w: 930, h: 930 },
  { mode: "Brawl Ball", file: "Center Stage.png", w: 690, h: 1050 },
  { mode: "Hide & Seek", file: "Dr. Mortis's Lab-2 (Old).png", w: 930, h: 930 },
  { mode: "Bounty", file: "Crossroads.png", w: 690, h: 1050 },
  { mode: "Heist", file: "Crossroads.png", w: 690, h: 1050 },
  { mode: "Heist", file: "notes.txt", w: 0, h: 0 },
];

test.describe("parseFileName", () => {
  test("reads a plain map file", () => {
    assert.deepEqual(C.parseFileName("Hard Rock Mine.png"), { name: "Hard Rock Mine", version: null });
  });
  test("reads a numbered version", () => {
    assert.deepEqual(C.parseFileName("Backyard Bowl (15000663).png"), { name: "Backyard Bowl", version: "15000663" });
  });
  test("keeps non-numeric parentheses as part of the name", () => {
    assert.deepEqual(C.parseFileName("Dr. Mortis's Lab-2 (Old).png"), { name: "Dr. Mortis's Lab-2 (Old)", version: null });
  });
  test("accepts an upper-case extension", () => {
    assert.deepEqual(C.parseFileName("Atlas.PNG"), { name: "Atlas", version: null });
  });
  for (const f of ["notes.txt", ".png", "Atlas", "", null]) {
    test(`ignores ${JSON.stringify(f)}`, () => assert.equal(C.parseFileName(f), null));
  }
});

test.describe("buildCatalog", () => {
  const cat = C.buildCatalog("Brawlstars map", entries);

  test("sorts modes and maps by name and skips non-map files", () => {
    assert.equal(cat.root, "Brawlstars map");
    assert.deepEqual(cat.modes.map((m) => m.name), ["Bounty", "Brawl Ball", "Gem Grab", "Heist", "Hide & Seek"]);
    assert.deepEqual(cat.modes[1].maps.map((m) => m.name), ["Backyard Bowl", "Center Stage"]);
    assert.equal(cat.modes[3].maps.length, 1);
  });

  test("groups versions under one map, plain file first, then ids ascending", () => {
    assert.deepEqual(cat.modes[1].maps[0].versions, [
      { id: null, w: 690, h: 1050 },
      { id: "15000663", w: 930, h: 930 },
      { id: "15000786", w: 690, h: 1050 },
    ]);
  });

  test("counts maps and image files", () => {
    assert.deepEqual(C.catalogStats(cat), { modes: 5, maps: 6, images: 8 });
  });
});

test.describe("keys and URLs", () => {
  test("builds map and image keys", () => {
    assert.equal(C.mapKey("Gem Grab", "Hard Rock Mine"), "Gem Grab/Hard Rock Mine");
    assert.equal(C.imageKey("Brawl Ball", "Backyard Bowl", null), "Brawl Ball/Backyard Bowl");
    assert.equal(C.imageKey("Brawl Ball", "Backyard Bowl", "15000663"), "Brawl Ball/Backyard Bowl#15000663");
  });

  test("splits a map key at the first slash", () => {
    assert.deepEqual(C.parseMapKey("Hide & Seek/Dr. Mortis's Lab-2 (Old)"), { mode: "Hide & Seek", name: "Dr. Mortis's Lab-2 (Old)" });
    assert.equal(C.parseMapKey("All Maps"), null);
  });

  test("percent-encodes every path segment", () => {
    assert.equal(
      C.imageUrl("Brawlstars map", "Hide & Seek", "Dr. Mortis's Lab-2 (Old)", null),
      "Brawlstars%20map/Hide%20%26%20Seek/Dr.%20Mortis's%20Lab-2%20(Old).png"
    );
    assert.equal(
      C.imageUrl("Brawlstars map", "Brawl Ball", "Backyard Bowl", "15000663"),
      "Brawlstars%20map/Brawl%20Ball/Backyard%20Bowl%20(15000663).png"
    );
  });
});

test.describe("indexCatalog", () => {
  const index = C.indexCatalog(C.buildCatalog("Brawlstars map", entries));

  test("finds a map by key", () => {
    const hit = index.byKey.get("Brawl Ball/Backyard Bowl");
    assert.equal(hit.mode, "Brawl Ball");
    assert.equal(hit.map.versions.length, 3);
    assert.equal(index.byKey.get("Brawl Ball/Nope"), undefined);
  });

  test("resolves a name only when exactly one mode has it", () => {
    assert.equal(index.uniqueKeyForName("Hard Rock Mine"), "Gem Grab/Hard Rock Mine");
    assert.equal(index.uniqueKeyForName("Crossroads"), null);
    assert.equal(index.uniqueKeyForName("hard rock mine"), null);
    assert.equal(index.uniqueKeyForName("Nowhere"), null);
  });

  test("never treats inherited object members as map names", () => {
    assert.equal(index.uniqueKeyForName("constructor"), null);
    assert.equal(index.uniqueKeyForName("__proto__"), null);
  });
});

test.describe("searchCatalog", () => {
  const cat = C.buildCatalog("Brawlstars map", entries);

  test("matches map names case-insensitively and keeps catalog order", () => {
    const r = C.searchCatalog(cat, "  backyard ");
    assert.deepEqual(r.map((m) => [m.name, m.maps.map((x) => x.name)]), [["Brawl Ball", ["Backyard Bowl"]]]);
  });

  test("a matching mode name keeps all of its maps", () => {
    const r = C.searchCatalog(cat, "brawl ball");
    assert.deepEqual(r[0].maps.map((x) => x.name), ["Backyard Bowl", "Center Stage"]);
  });

  test("an empty query returns everything", () => {
    assert.equal(C.searchCatalog(cat, "").length, 5);
  });

  test("returns nothing for no match", () => {
    assert.deepEqual(C.searchCatalog(cat, "zzz"), []);
  });
});

test.describe("generated js/maps-catalog.js", () => {
  const root = path.join(__dirname, "..", "Brawlstars map");
  const generated = require("../js/maps-catalog.js");

  test("is up to date with the Brawlstars map folder (run `npm run catalog` after adding maps)", { skip: !fs.existsSync(root) }, () => {
    const { scanFolder } = require("../tools/build-map-catalog.js");
    assert.deepEqual(generated, C.buildCatalog("Brawlstars map", scanFolder(root)));
  });

  test("points at images that exist", { skip: !fs.existsSync(root) }, () => {
    for (const mode of generated.modes) {
      for (const map of mode.maps) {
        for (const v of map.versions) {
          const file = decodeURIComponent(C.imageUrl(generated.root, mode.name, map.name, v.id));
          assert.ok(fs.existsSync(path.join(__dirname, "..", file)), file);
        }
      }
    }
  });
});

test.describe("map pool", () => {
  const cat = C.buildCatalog("Brawlstars map", entries);
  const pool = {
    modes: [
      { mode: "Heist", maps: ["Crossroads"] },
      { mode: "Brawl Ball", maps: [{ name: "Center Stage", label: "Centre Stage" }, "Backyard Bowl", "Gone Map"] },
      { mode: "Nope Mode", maps: ["Anything"] },
    ],
  };

  test("poolEntries reads names, labels and the tiebreaker (first map of each mode)", () => {
    assert.deepEqual(C.poolEntries(pool).slice(0, 3), [
      { mode: "Heist", name: "Crossroads", label: "Crossroads", tiebreaker: true },
      { mode: "Brawl Ball", name: "Center Stage", label: "Centre Stage", tiebreaker: true },
      { mode: "Brawl Ball", name: "Backyard Bowl", label: "Backyard Bowl", tiebreaker: false },
    ]);
  });

  test("poolEntries skips malformed entries, names with a slash and repeats", () => {
    const messy = { modes: [null, { mode: "A", maps: ["x", "x", 3, { label: "y" }, "a/b", { name: "z", label: 5 }] }, { mode: "", maps: ["q"] }, { mode: "B/C", maps: ["q"] }, { mode: "D" }] };
    assert.deepEqual(C.poolEntries(messy), [
      { mode: "A", name: "x", label: "x", tiebreaker: true },
      { mode: "A", name: "z", label: "z", tiebreaker: false },
    ]);
    assert.deepEqual(C.poolEntries(null), []);
    assert.deepEqual(C.poolEntries({ modes: "x" }), []);
  });

  test("poolKeys lists the pool's map keys in order", () => {
    assert.deepEqual(C.poolKeys(pool), ["Heist/Crossroads", "Brawl Ball/Center Stage", "Brawl Ball/Backyard Bowl", "Brawl Ball/Gone Map", "Nope Mode/Anything"]);
  });

  test("poolCatalog keeps only pool maps, in pool order, with labels, tiebreakers and versions", () => {
    const { catalog, missing } = C.poolCatalog(cat, pool);
    assert.equal(catalog.root, "Brawlstars map");
    assert.deepEqual(catalog.modes.map((m) => [m.name, m.maps.map((x) => [x.name, x.label, x.tiebreaker, x.versions.length])]), [
      ["Heist", [["Crossroads", "Crossroads", true, 1]]],
      ["Brawl Ball", [["Center Stage", "Centre Stage", true, 1], ["Backyard Bowl", "Backyard Bowl", false, 3]]],
    ]);
    assert.deepEqual(missing, ["Brawl Ball/Gone Map", "Nope Mode/Anything"]);
  });

  test("poolCatalog does not share version objects with the full catalog", () => {
    const { catalog } = C.poolCatalog(cat, pool);
    catalog.modes[1].maps[1].versions[0].w = -1;
    assert.notEqual(cat.modes.find((m) => m.name === "Brawl Ball").maps[0].versions[0].w, -1);
  });

  test("the pool catalog indexes by the file name, and search matches labels too", () => {
    const { catalog } = C.poolCatalog(cat, pool);
    const index = C.indexCatalog(catalog);
    assert.equal(index.byKey.get("Brawl Ball/Center Stage").map.label, "Centre Stage");
    assert.equal(index.uniqueKeyForName("Crossroads"), "Heist/Crossroads");
    assert.deepEqual(C.searchCatalog(catalog, "centre").map((m) => m.maps.map((x) => x.name)), [["Center Stage"]]);
    assert.deepEqual(C.searchCatalog(catalog, "center").map((m) => m.maps.map((x) => x.name)), [["Center Stage"]]);
  });

  test("search ignores apostrophes, so a keyboard ' finds a label written with ’", () => {
    const c = C.poolCatalog(C.buildCatalog("r", [{ mode: "Knockout", file: "Belles Rock.png", w: 1, h: 1 }]), { modes: [{ mode: "Knockout", maps: [{ name: "Belles Rock", label: "Belle’s Rock" }] }] }).catalog;
    for (const q of ["belle's", "Belle’s Rock", "belles", "BELLE'S ROCK"]) assert.equal(C.searchCatalog(c, q).length, 1, q);
    assert.equal(C.searchCatalog(c, "belle'z").length, 0);
  });
});
