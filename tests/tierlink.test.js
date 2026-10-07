"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../js/storage.js");

const plain = (x) => JSON.parse(JSON.stringify(x));
const ID = 16000000;
// A small roster in API shape; ids are deliberately not in name order and have a gap (3).
const roster = [
  { id: ID + 0, name: "Shelly", class: { name: "Damage Dealer" } },
  { id: ID + 1, name: "Colt", class: { name: "Damage Dealer" } },
  { id: ID + 2, name: "Bull", class: { name: "Tank" } },
  { id: ID + 4, name: "Poco", className: "Support" },
  { id: ID + 10, name: "Piper", class: { name: "Marksman" } },
];
const names = roster.map((b) => b.name);

function board(tiers, order, brawlerRoles) {
  const s = S.normalizeState({
    maps: ["All Maps"],
    mapPlacements: { "All Maps": tiers },
    mapOrders: { "All Maps": order },
    notes: { Shelly: "never in the link" },
    brawlerRoles: brawlerRoles || {},
  }).state;
  S.ensureClassRoles(s, roster);
  return s;
}

test.describe("encodeTierLink", () => {
  test("lists hex codes by tier in card order, separated by g, with the code width first", () => {
    const s = board({ Shelly: "S", Colt: "A", Bull: "S", Poco: "D", Piper: "B" }, ["Bull", "Piper", "Shelly", "Colt", "Poco"]);
    assert.equal(S.encodeTierLink(s, roster), "#t=2" + "0200" + "g01" + "g0a" + "g" + "g04");
  });

  test("leaves notes, the role list and the project name out", () => {
    const s = board({ Shelly: "S", Colt: "A", Bull: "B", Poco: "C", Piper: "D" }, names);
    const link = S.encodeTierLink(s, roster);
    assert.ok(!/never|Shelly|Tank|World/.test(link), link);
  });

  test("adds only brawlers whose roles differ from their official class", () => {
    const s = board({ Shelly: "S", Colt: "S", Bull: "S", Poco: "S", Piper: "S" }, names, {
      Bull: ["Tank", "Support"],
      Poco: [],
    });
    // Tank = bit 1, Support = bit 6 -> 0x42; Poco untagged -> 0x00.
    assert.equal(S.encodeTierLink(s, roster), "#t=2" + "000102040a" + "g" + "g" + "g" + "g" + "r" + "0242" + "0400");
  });

  test("is about two characters per brawler for a full roster", () => {
    const big = Array.from({ length: 108 }, (_, i) => ({ id: ID + i, name: "B" + i, className: "Tank" }));
    const s = S.normalizeState({ maps: ["All Maps"] }).state;
    S.reconcileWithRoster(s, big.map((b) => b.name));
    S.ensureClassRoles(s, big);
    const link = S.encodeTierLink(s, big);
    assert.ok(link.length <= 3 + 1 + 108 * 2 + 4, link.length);
  });

  test("returns null when the roster has no usable ids", () => {
    assert.equal(S.encodeTierLink(S.defaultState(), [{ name: "X" }]), null);
    assert.equal(S.encodeTierLink(S.defaultState(), []), null);
  });

  test("sends a deliberate untag of a brawler that has no official class", () => {
    const classless = [...roster, { id: ID + 5, name: "Nita" }];
    const s = board({ Shelly: "S", Nita: "S" }, [...names, "Nita"], { Nita: [] });
    assert.match(S.encodeTierLink(s, classless), /r0500$/);
    const t = board({ Shelly: "S", Nita: "S" }, [...names, "Nita"]);
    assert.doesNotMatch(S.encodeTierLink(t, classless), /r/);
  });

  test("skips ids that cannot be a code (too large, unsafe) instead of breaking the link", () => {
    const odd = [...roster, { id: ID + 0x1000000, name: "Huge" }, { id: 1e21, name: "Unsafe" }, { id: ID + 7.5, name: "Half" }];
    const link = S.encodeTierLink(board({ Shelly: "S" }, names), odd);
    assert.match(link, /^#t=2/);
    assert.equal(S.decodeTierLink(link).ok, true);
  });

  test("writes each code once even when two roster names share an id", () => {
    const twins = [...roster, { id: ID + 2, name: "BullClone", className: "Tank" }];
    const s = board({ Shelly: "S", Bull: "S", BullClone: "A" }, ["Bull", "BullClone", ...names]);
    const link = S.encodeTierLink(s, twins);
    const codes = S.decodeTierLink(link).tiers.flat();
    assert.equal(codes.length, new Set(codes).size, link);
  });

  test("ignores a roster brawler named __proto__", () => {
    const evil = [...roster, { id: ID + 6, name: "__proto__", className: "Tank" }];
    const link = S.encodeTierLink(board({ Shelly: "S" }, names), evil);
    assert.ok(!S.decodeTierLink(link).tiers.flat().includes(6), link);
  });

  test("widens the codes once an id needs three hex digits", () => {
    const wide = [...roster, { id: ID + 300, name: "Future", className: "Tank" }];
    const s = board({ Shelly: "S" }, names);
    const link = S.encodeTierLink(s, wide);
    assert.match(link, /^#t=3000/);
    assert.ok(link.includes("12c"));
  });
});

test.describe("decodeTierLink", () => {
  test("parses tiers and role changes without needing the roster", () => {
    const r = S.decodeTierLink("#t=20200g01g0agg04r0242");
    assert.deepEqual(r, { ok: true, tiers: [[2, 0], [1], [10], [], [4]], roles: [[2, 0x42]] });
  });

  test("accepts upper-case hex and percent-encoding", () => {
    assert.equal(S.decodeTierLink("#t=20A0Bgggg").ok, true);
    assert.equal(S.decodeTierLink("#t=%32" + "00gggg").ok, true);
  });

  for (const hash of ["#t=", "#t=2", "#t=20gg", "#t=2000ggggg", "#t=2001xgggg", "#t=2000gggg0", "#t=7000gggg", "#t=1000gggg", "#t=2ggggr0280", "#t=2gggggr0280", "#t=2ggggr02", "#t=%E0%A4%A"]) {
    test("rejects " + JSON.stringify(hash), () => {
      const r = S.decodeTierLink(hash);
      assert.equal(r.ok, false);
      assert.equal(typeof r.error, "string");
    });
  }

  test("rejects an oversized link before parsing", () => {
    const r = S.decodeTierLink("#t=2" + "00".repeat(20000) + "gggg");
    assert.equal(r.code, "too-large");
  });

  for (const hash of ["", "#", "#z=abc", "#data=abc", "#tt=200gggg", null, undefined]) {
    test("treats " + JSON.stringify(hash) + " as not a tier link", () => assert.equal(S.decodeTierLink(hash), null));
  }

  test("isShareHash recognises tier links", () => {
    assert.equal(S.isShareHash("#t=200gggg"), true);
  });
});

test.describe("applyTierLink", () => {
  const mine = () => board({ Shelly: "D", Colt: "D", Bull: "D", Poco: "D", Piper: "D", Retired: "C" }, ["Retired", ...names], { Colt: [] });

  test("replaces All Maps tiers and order, keeping the receiver's notes and other maps", () => {
    const s = mine();
    s.mapPlacements["Heist/Pit Stop"] = { Shelly: "A" };
    const link = S.decodeTierLink("#t=20200g01g0aggr0242");
    const { state, unknown, missing } = S.applyTierLink(s, link, roster);
    assert.deepEqual([unknown, missing], [0, ["Poco"]]);
    assert.equal(state.mapPlacements["All Maps"].Bull, "S");
    assert.equal(state.mapPlacements["All Maps"].Shelly, "S");
    assert.equal(state.mapPlacements["All Maps"].Colt, "A");
    assert.equal(state.mapPlacements["All Maps"].Piper, "B");
    assert.equal(state.notes.Shelly, "never in the link");
    assert.deepEqual(plain(state.mapPlacements["Heist/Pit Stop"]), { Shelly: "A" });
  });

  test("puts brawlers the link does not list at the end of B", () => {
    const { state } = S.applyTierLink(mine(), S.decodeTierLink("#t=20200g01g0agg"), roster);
    assert.equal(state.mapPlacements["All Maps"].Poco, "B");
    const order = state.mapOrders["All Maps"];
    assert.deepEqual(order.slice(0, 5), ["Bull", "Shelly", "Colt", "Piper", "Poco"]);
    assert.ok(order.includes("Retired"));
  });

  test("keeps the receiver's own order among the brawlers the link does not list", () => {
    const s = board({ Shelly: "D", Colt: "D", Bull: "D", Poco: "D", Piper: "D" }, ["Piper", "Poco", "Colt", "Bull", "Shelly"]);
    const { state, missing } = S.applyTierLink(s, S.decodeTierLink("#t=2g02ggg"), roster);
    assert.deepEqual(missing, ["Piper", "Poco", "Colt", "Shelly"]);
    assert.deepEqual(state.mapOrders["All Maps"].slice(0, 5), ["Bull", "Piper", "Poco", "Colt", "Shelly"]);
  });

  test("sets listed brawlers' roles from the link: changed ones as sent, the rest back to their class", () => {
    const { state } = S.applyTierLink(mine(), S.decodeTierLink("#t=20200g01g0agg04r0242"), roster);
    assert.deepEqual(state.brawlerRoles.Bull, ["Tank", "Support"]);
    assert.deepEqual(state.brawlerRoles.Colt, ["Damage Dealer"]);
    assert.deepEqual(state.brawlerRoles.Poco, ["Support"]);
  });

  test("keeps the roles of brawlers the link does not list", () => {
    const { state } = S.applyTierLink(mine(), S.decodeTierLink("#t=20200gggg"), roster);
    assert.deepEqual(state.brawlerRoles.Colt, []);
  });

  test("counts and skips codes the receiver's roster does not have, and duplicates", () => {
    const { state, unknown } = S.applyTierLink(mine(), S.decodeTierLink("#t=2006f00g00ggg"), roster);
    assert.equal(unknown, 1);
    assert.equal(state.mapPlacements["All Maps"].Shelly, "S");
  });

  test("leaves a listed brawler with no known class untagged-by-default, so its class can fill in later", () => {
    const noClass = roster.map(({ id, name }) => ({ id, name }));
    const { state } = S.applyTierLink(mine(), S.decodeTierLink("#t=2gg000204gg"), noClass);
    assert.equal(Object.prototype.hasOwnProperty.call(state.brawlerRoles, "Bull"), false);
    S.ensureClassRoles(state, roster);
    assert.deepEqual(state.brawlerRoles.Bull, ["Tank"]);
  });

  test("applies an explicit untag (mask 00) as no roles", () => {
    const { state } = S.applyTierLink(mine(), S.decodeTierLink("#t=2gg02ggr0200"), roster);
    assert.deepEqual(state.brawlerRoles.Bull, []);
  });

  test("uses the first role entry when a link repeats a code", () => {
    const { state } = S.applyTierLink(mine(), S.decodeTierLink("#t=2gg02ggr02420200"), roster);
    assert.deepEqual(state.brawlerRoles.Bull, ["Tank", "Support"]);
  });

  test("never writes a brawler named __proto__", () => {
    const evil = [...roster, { id: ID + 6, name: "__proto__", className: "Tank" }];
    const { state, unknown } = S.applyTierLink(mine(), S.decodeTierLink("#t=20006gggg"), evil);
    assert.equal(unknown, 1);
    assert.equal(Object.getPrototypeOf(state.brawlerRoles), Object.prototype);
    assert.equal(Object.getPrototypeOf(state.mapPlacements["All Maps"]), Object.prototype);
  });

  test("does not mutate the receiver's board", () => {
    const s = mine();
    const before = plain(s);
    S.applyTierLink(s, S.decodeTierLink("#t=20200g01g0agg04r0242"), roster);
    assert.deepEqual(plain(s), before);
  });

  test("round-trips a board through a link", () => {
    const sender = board({ Shelly: "A", Colt: "S", Bull: "C", Poco: "B", Piper: "S" }, ["Piper", "Colt", "Shelly", "Poco", "Bull"], { Piper: ["Marksman", "Assassin"] });
    const receiver = board({ Shelly: "D", Colt: "D", Bull: "D", Poco: "D", Piper: "D" }, names);
    const { state } = S.applyTierLink(receiver, S.decodeTierLink(S.encodeTierLink(sender, roster)), roster);
    for (const n of names) assert.equal(S.tierOf(state, "All Maps", n), S.tierOf(sender, "All Maps", n), n);
    assert.deepEqual(S.orderFor(state, "All Maps", names), S.orderFor(sender, "All Maps", names));
    assert.deepEqual(state.brawlerRoles.Piper.slice().sort(), ["Assassin", "Marksman"]);
  });
});
