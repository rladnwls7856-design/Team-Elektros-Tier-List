"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../js/storage.js");

const plain = (x) => JSON.parse(JSON.stringify(x));

// The API shape (class: {id, name}) and the cached roster shape (className) both occur.
const apiRoster = [
  { id: 1, name: "Shelly", class: { id: 1, name: "Damage Dealer" } },
  { id: 2, name: "Bull", class: { id: 2, name: "Tank" } },
  { id: 3, name: "Piper", class: { id: 6, name: "Marksman" } },
  { id: 4, name: "Poco", class: { id: 4, name: "Support" } },
  { id: 5, name: "Mystery" },
];
const cachedRoster = [
  { id: 1, name: "Shelly", className: "Damage Dealer" },
  { id: 2, name: "Bull", className: "Tank" },
];

test.describe("addClassRoles", () => {
  test("creates one role per official class in a fixed order and assigns every brawler", () => {
    const s = S.defaultState();
    const r = S.addClassRoles(s, apiRoster);
    assert.deepEqual(s.roles.map((x) => x.name), ["Damage Dealer", "Tank", "Marksman", "Support"]);
    assert.deepEqual(plain(s.brawlerRoles), { Shelly: ["Damage Dealer"], Bull: ["Tank"], Piper: ["Marksman"], Poco: ["Support"] });
    assert.deepEqual(r, { added: ["Damage Dealer", "Tank", "Marksman", "Support"], assigned: 4 });
    assert.equal(s.classRolesAdded, true);
  });

  test("gives each class role a fixed, valid colour", () => {
    const s = S.defaultState();
    S.addClassRoles(s, apiRoster);
    for (const role of s.roles) {
      assert.match(role.color, /^#[0-9a-f]{6}$/i);
      assert.equal(role.color, S.CLASS_ROLE_COLORS[role.name]);
    }
  });

  test("reads the cached roster shape too", () => {
    const s = S.defaultState();
    S.addClassRoles(s, cachedRoster);
    assert.deepEqual(plain(s.brawlerRoles), { Shelly: ["Damage Dealer"], Bull: ["Tank"] });
  });

  test("keeps existing roles and assignments and reuses a role with the same name in any case", () => {
    const s = S.normalizeState({
      roles: [{ name: "tank", color: "#123456" }, { name: "Mine", color: "#654321" }],
      brawlerRoles: { Bull: ["Mine"], Shelly: ["Mine"] },
    }).state;
    const r = S.addClassRoles(s, apiRoster);
    assert.deepEqual(s.roles.map((x) => x.name), ["tank", "Mine", "Damage Dealer", "Marksman", "Support"]);
    assert.equal(s.roles[0].color, "#123456");
    assert.deepEqual(s.brawlerRoles.Bull, ["Mine", "tank"]);
    assert.deepEqual(s.brawlerRoles.Shelly, ["Mine", "Damage Dealer"]);
    assert.deepEqual(r.added, ["Damage Dealer", "Marksman", "Support"]);
  });

  test("is idempotent", () => {
    const s = S.defaultState();
    S.addClassRoles(s, apiRoster);
    const once = plain(s);
    assert.deepEqual(S.addClassRoles(s, apiRoster), { added: [], assigned: 0 });
    assert.deepEqual(plain(s), once);
  });

  test("appends a class it does not know after the known ones, with the default colour", () => {
    const s = S.defaultState();
    S.addClassRoles(s, [{ name: "Newbie", className: "Summoner" }, ...cachedRoster]);
    assert.deepEqual(s.roles.map((x) => x.name), ["Damage Dealer", "Tank", "Summoner"]);
    assert.equal(s.roles[2].color, S.DEFAULT_ROLE_COLOR);
  });

  test("ignores unusable class names and an empty roster", () => {
    const s = S.defaultState();
    const r = S.addClassRoles(s, [{ name: "A", className: "" }, { name: "B", class: { name: 5 } }, { name: "C", className: "x".repeat(101) }, null]);
    assert.deepEqual(r, { added: [], assigned: 0 });
    assert.deepEqual(s.roles, []);
  });

  test("never writes onto inherited members for odd brawler names", () => {
    const s = S.defaultState();
    S.addClassRoles(s, [{ name: "constructor", className: "Tank" }]);
    assert.ok(Object.prototype.hasOwnProperty.call(s.brawlerRoles, "constructor"));
    assert.equal(Object.Tank, undefined);
  });
});

test.describe("classRolesAdded in stored boards", () => {
  test("defaults to false and survives normalisation when true", () => {
    assert.equal(S.defaultState().classRolesAdded, false);
    assert.equal(S.normalizeState({ classRolesAdded: true }).state.classRolesAdded, true);
    assert.equal(S.normalizeState({ classRolesAdded: "yes" }).state.classRolesAdded, false);
  });
});

test.describe("roster cache", () => {
  test("keeps each brawler's class name for offline use", () => {
    const data = new Map();
    const storage = { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
    const store = S.createStore(storage, "k");
    store.saveRoster(apiRoster, "2026-10-07T00:00:00.000Z");
    const list = store.loadRoster().list;
    assert.equal(list[0].className, "Damage Dealer");
    assert.equal(list[4].className, undefined);
  });
});

test.describe("label colours on role colours", () => {
  // WCAG 2 contrast between two #rrggbb colours.
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const ch = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const contrast = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const ink = "#151413";
  const paper = "#f3f2f2";

  test("labelInkFor picks whichever of ink and paper contrasts more", () => {
    for (const hex of ["#16a34a", "#0891b2", "#ffffff", "#000000", "#7c5cff", "#ca8a04", "#2563eb"]) {
      const pick = S.labelInkFor(hex) === "ink" ? ink : paper;
      const other = pick === ink ? paper : ink;
      assert.ok(contrast(hex, pick) >= contrast(hex, other), hex);
    }
  });

  test("labelInkFor falls back to paper for anything that is not #rrggbb", () => {
    assert.equal(S.labelInkFor("red"), "paper");
    assert.equal(S.labelInkFor(undefined), "paper");
  });

  test("every class colour and the default role colour carry a label at AA (4.5:1)", () => {
    for (const hex of [...Object.values(S.CLASS_ROLE_COLORS), S.DEFAULT_ROLE_COLOR]) {
      const pick = S.labelInkFor(hex) === "ink" ? ink : paper;
      assert.ok(contrast(hex, pick) >= 4.5, hex + " " + contrast(hex, pick).toFixed(2));
    }
  });
});

test.describe("addClassRoles for brawlers released later", () => {
  test("newOnly tags only brawlers with no roles entry, with existing class roles, and creates none", () => {
    const s = S.defaultState();
    S.addClassRoles(s, apiRoster);
    s.brawlerRoles.Bull = [];
    s.roles = s.roles.filter((r) => r.name !== "Support");
    const r = S.addClassRoles(s, [...apiRoster, { name: "NewTank", class: { name: "Tank" } }, { name: "NewHealer", className: "Support" }], { newOnly: true });
    assert.deepEqual(r, { added: [], assigned: 1 });
    assert.deepEqual(s.brawlerRoles.NewTank, ["Tank"]);
    assert.deepEqual(s.brawlerRoles.Bull, []);
    assert.equal(Object.prototype.hasOwnProperty.call(s.brawlerRoles, "NewHealer"), false);
    assert.deepEqual(s.roles.map((x) => x.name), ["Damage Dealer", "Tank", "Marksman"]);
  });

  test("newOnly reuses a class role renamed only in case", () => {
    const s = S.normalizeState({ roles: [{ name: "TANK", color: "#92400e" }], classRolesAdded: true }).state;
    S.addClassRoles(s, [{ name: "NewTank", className: "Tank" }], { newOnly: true });
    assert.deepEqual(s.brawlerRoles.NewTank, ["TANK"]);
  });
});

test.describe("share-link merge and class roles", () => {
  test("roles that arrive by link are final: the receiver's board will not add class roles later", () => {
    const mine = S.defaultState();
    const merged = S.mergeSharedBoard(mine, S.normalizeState({ roles: [] }).state);
    assert.equal(merged.classRolesAdded, true);
  });
});

test.describe("ensureClassRoles (fixed official roles)", () => {
  test("always leaves exactly the seven official roles, in game order, with their fixed colours", () => {
    const s = S.normalizeState({ roles: [{ name: "My Role", color: "#123456" }, { name: "tank", color: "#000000" }] }).state;
    S.ensureClassRoles(s, apiRoster);
    assert.deepEqual(s.roles.map((r) => r.name), S.CLASS_ORDER);
    for (const r of s.roles) assert.equal(r.color, S.CLASS_ROLE_COLORS[r.name]);
  });

  test("keeps official roles a brawler was given in any case, drops custom ones and duplicates", () => {
    const s = S.normalizeState({ brawlerRoles: { Bull: ["tank", "My Role", "TANK", "Support"] } }).state;
    S.ensureClassRoles(s, apiRoster);
    assert.deepEqual(s.brawlerRoles.Bull, ["Tank", "Support"]);
  });

  test("a brawler that only had custom roles falls back to its class; an untagged one stays untagged", () => {
    const s = S.normalizeState({ brawlerRoles: { Shelly: ["My Role"], Poco: [] } }).state;
    S.ensureClassRoles(s, apiRoster);
    assert.deepEqual(s.brawlerRoles.Shelly, ["Damage Dealer"]);
    assert.deepEqual(s.brawlerRoles.Poco, []);
  });

  test("tags every brawler with no entry by its class and leaves edited ones alone", () => {
    const s = S.normalizeState({ brawlerRoles: { Piper: ["Marksman", "Assassin"] } }).state;
    S.ensureClassRoles(s, apiRoster);
    assert.deepEqual(plain(s.brawlerRoles), { Piper: ["Marksman", "Assassin"], Shelly: ["Damage Dealer"], Bull: ["Tank"], Poco: ["Support"] });
  });

  test("still fixes the role list when the roster is not available", () => {
    const s = S.defaultState();
    S.ensureClassRoles(s, []);
    assert.equal(s.roles.length, 7);
    assert.deepEqual(plain(s.brawlerRoles), {});
  });

  test("is idempotent", () => {
    const s = S.defaultState();
    S.ensureClassRoles(s, apiRoster);
    const once = plain(s);
    S.ensureClassRoles(s, apiRoster);
    assert.deepEqual(plain(s), once);
  });
});
