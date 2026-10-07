"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../js/storage.js");

const plain = (x) => JSON.parse(JSON.stringify(x));
const ISO = "2026-10-06T12:00:00.000Z";

function uiState() {
  return {
    project: "World Finals Prep",
    maps: ["All Maps", "Gem Fort", "내 맵 🗺️"],
    tiers: ["S", "A", "B", "C", "D"],
    placements: { Shelly: "S", Colt: "B" },
    mapPlacements: { "All Maps": { Shelly: "S", Colt: "B" }, "Gem Fort": { Shelly: "A", Colt: "D" } },
    mapOrders: { "All Maps": ["Colt", "Shelly"] },
    notes: { Shelly: "근접 압박 👍   line", Colt: "" },
    mapNotes: { "Gem Fort": "ban Mortis" },
    roles: [{ name: "Tank", color: "#ff0000" }],
    brawlerRoles: { Shelly: ["Tank"] },
    drawings: {},
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

// Builds a valid board JSON string of exactly `n` characters.
function boardJsonOfLength(n) {
  const head = '{"maps":["A"],"notes":{"x":"';
  const tail = '"}}';
  return head + "a".repeat(n - head.length - tail.length) + tail;
}

const legacyShareHash = (obj) => "#data=" + Buffer.from(JSON.stringify(obj), "utf8").toString("base64");

// A board whose standard base64 contains "+", "/" and "=" padding, so legacy-link
// handling (percent escapes, "+" turned into a space) is actually exercised.
function legacyPayloadWithAllSpecials() {
  // "~~~" encodes to a "+" and "???" to a "/" when aligned to a 3-byte group; the
  // 7-character unit shifts the alignment each repeat and the padding varies the tail.
  for (let i = 0; i < 50; i++) {
    const board = { ...uiState(), notes: { Shelly: "x".repeat(i % 7) + "~~~~???".repeat(3) + "y".repeat(Math.floor(i / 7)) } };
    const payload = legacyShareHash(board).slice(6);
    if (/\+/.test(payload) && /\//.test(payload) && /=$/.test(payload)) return { board, payload };
  }
  throw new Error("no fixture found");
}

test.describe("buildExportJson", () => {
  test("is self-describing and human-readable", () => {
    const text = S.buildExportJson(uiState(), ISO);
    const obj = JSON.parse(text);
    assert.deepEqual(Object.keys(obj).slice(0, 3), ["app", "schemaVersion", "exportedAt"]);
    assert.equal(obj.app, S.APP_ID);
    assert.equal(obj.schemaVersion, S.SCHEMA_VERSION);
    assert.equal(obj.exportedAt, ISO);
    assert.ok(text.includes("\n  "));
  });

  test("round-trips through parseBoardJson without loss", () => {
    const r = S.parseBoardJson(S.buildExportJson(uiState(), ISO));
    assert.equal(r.ok, true);
    assert.deepEqual(plain(r.state), uiState());
    assert.deepEqual(r.warnings, []);
    assert.equal(r.exportedAt, ISO);
  });

  // Pads a note so the pretty export is exactly `target` characters (each pad char adds 1).
  function stateWithPrettyLength(target) {
    const s = { ...uiState(), notes: { ...uiState().notes, pad: "" } };
    s.notes.pad = "p".repeat(target - S.buildExportJson(s, ISO).length);
    return s;
  }

  test("stays indented at exactly MAX_TRANSFER_CHARS and goes compact one character later", () => {
    const at = S.buildExportJson(stateWithPrettyLength(S.MAX_TRANSFER_CHARS), ISO);
    assert.equal(at.length, S.MAX_TRANSFER_CHARS);
    assert.ok(at.includes("\n  "));
    const over = S.buildExportJson(stateWithPrettyLength(S.MAX_TRANSFER_CHARS + 1), ISO);
    assert.ok(!over.includes("\n"));
    assert.ok(over.length <= S.MAX_TRANSFER_CHARS);
  });

  test("drops exportedAt rather than exceed the limit when only that field is in the way", () => {
    const s = { ...uiState(), notes: { pad: "" } };
    s.notes.pad = "p".repeat(S.MAX_TRANSFER_CHARS - 10 - S.serializeState(s).length);
    assert.ok(JSON.stringify({ exportedAt: ISO, ...JSON.parse(S.serializeState(s)) }).length > S.MAX_TRANSFER_CHARS);
    const text = S.buildExportJson(s, ISO);
    assert.ok(text.length <= S.MAX_TRANSFER_CHARS);
    assert.equal(S.parseBoardJson(text).ok, true);
  });

  test("falls back to compact JSON when indentation would push it over the import limit", () => {
    // Compact size just under the limit; pretty-printing 900 short notes adds far more than the slack
    // (900 + pad stays within MAX_IMPORT_BRAWLERS).
    const notes = {};
    for (let i = 0; i < 900; i++) notes["b" + i] = "x";
    const compactBase = S.serializeState({ ...uiState(), notes }).length + 60;
    notes.pad = "p".repeat(S.MAX_TRANSFER_CHARS - compactBase);
    const text = S.buildExportJson({ ...uiState(), notes }, ISO);
    assert.ok(text.length <= S.MAX_TRANSFER_CHARS, `export is ${text.length} chars`);
    assert.equal(S.parseBoardJson(text).ok, true);
  });
});

test.describe("parseBoardJson", () => {
  test("accepts files exported before versioning existed", () => {
    const r = S.parseBoardJson(JSON.stringify(uiState(), null, 2));
    assert.equal(r.ok, true);
    assert.deepEqual(plain(r.state), uiState());
    assert.equal(r.exportedAt, null);
  });

  test("accepts a UTF-8 byte order mark", () => {
    assert.equal(S.parseBoardJson("﻿" + S.buildExportJson(uiState(), ISO)).ok, true);
  });

  test("rejects text that is not JSON", () => {
    const r = S.parseBoardJson("{maps: nope");
    assert.equal(r.ok, false);
    assert.match(r.error, /JSON/);
  });

  for (const text of ["[]", '"board"', "42", "null", "true"]) {
    test(`rejects a JSON root of ${text}`, () => {
      assert.equal(S.parseBoardJson(text).ok, false);
    });
  }

  test("rejects a non-string input", () => {
    assert.equal(S.parseBoardJson(undefined).ok, false);
    assert.equal(S.parseBoardJson({ maps: [] }).ok, false);
  });

  test("rejects files from another app", () => {
    const r = S.parseBoardJson(JSON.stringify({ ...uiState(), app: "other-app" }));
    assert.equal(r.ok, false);
    assert.match(r.error, /different app/);
  });

  test("rejects unversioned JSON that does not look like a board", () => {
    assert.equal(S.parseBoardJson('{"name":"package","version":"1.0.0"}').ok, false);
  });

  test("accepts an explicit Team Brawl file even when it is empty", () => {
    const r = S.parseBoardJson(JSON.stringify({ app: S.APP_ID, schemaVersion: S.SCHEMA_VERSION }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.state.maps, S.DEFAULT_MAPS);
  });

  for (const v of [undefined, 2, 3, S.SCHEMA_VERSION]) {
    test(`accepts schema version ${v}`, () => {
      assert.equal(S.parseBoardJson(JSON.stringify({ ...uiState(), schemaVersion: v })).ok, true);
    });
  }

  test("rejects a file from a newer version with a hint to update", () => {
    const r = S.parseBoardJson(JSON.stringify({ ...uiState(), app: S.APP_ID, schemaVersion: S.SCHEMA_VERSION + 1 }));
    assert.equal(r.ok, false);
    assert.match(r.error, /newer/);
  });

  for (const v of ["3", 0, 2.5, null]) {
    test(`rejects schema version ${JSON.stringify(v)}`, () => {
      assert.equal(S.parseBoardJson(JSON.stringify({ ...uiState(), schemaVersion: v })).ok, false);
    });
  }

  test(`accepts exactly MAX_TRANSFER_CHARS characters`, () => {
    const text = boardJsonOfLength(S.MAX_TRANSFER_CHARS);
    assert.equal(text.length, S.MAX_TRANSFER_CHARS);
    assert.equal(S.parseBoardJson(text).ok, true);
  });

  test(`rejects MAX_TRANSFER_CHARS + 1 characters`, () => {
    const r = S.parseBoardJson(boardJsonOfLength(S.MAX_TRANSFER_CHARS + 1));
    assert.equal(r.ok, false);
    assert.match(r.error, /too large/);
  });

  test("checks the size before parsing", () => {
    // Invalid JSON over the limit: a parse-first implementation would report "json".
    assert.equal(S.parseBoardJson("{" + "x".repeat(S.MAX_TRANSFER_CHARS)).code, "too-large");
  });

  test(`accepts exactly MAX_IMPORT_MAPS maps and rejects one more`, () => {
    const maps = (n) => Array.from({ length: n }, (_, i) => "Map " + i);
    assert.equal(S.parseBoardJson(JSON.stringify({ maps: maps(S.MAX_IMPORT_MAPS) })).ok, true);
    const r = S.parseBoardJson(JSON.stringify({ maps: maps(S.MAX_IMPORT_MAPS + 1) }));
    assert.equal(r.ok, false);
    assert.equal(r.code, "too-many");
  });

  test(`accepts exactly MAX_IMPORT_ROLES roles and rejects one more`, () => {
    const roles = (n) => Array.from({ length: n }, (_, i) => ({ name: "r" + i, color: "#000000" }));
    assert.equal(S.parseBoardJson(JSON.stringify({ maps: ["A"], roles: roles(S.MAX_IMPORT_ROLES) })).ok, true);
    const r = S.parseBoardJson(JSON.stringify({ maps: ["A"], roles: roles(S.MAX_IMPORT_ROLES + 1) }));
    assert.equal(r.ok, false);
    assert.equal(r.code, "too-many");
  });

  const many = (n, f) => Object.fromEntries(Array.from({ length: n }, (_, i) => ["b" + i, f(i)]));
  for (const [label, build] of [
    ["a map tier table", (n) => ({ maps: ["All Maps"], mapPlacements: { "All Maps": many(n, () => "B") } })],
    ["the legacy tier list", (n) => ({ maps: ["All Maps"], placements: many(n, () => "B") })],
    ["a map order", (n) => ({ maps: ["All Maps"], mapOrders: { "All Maps": Array.from({ length: n }, (_, i) => "b" + i) } })],
    ["brawler notes", (n) => ({ maps: ["All Maps"], notes: many(n, () => "") })],
    ["role assignments", (n) => ({ maps: ["All Maps"], brawlerRoles: many(n, () => []) })],
  ]) {
    test(`accepts exactly MAX_IMPORT_BRAWLERS entries in ${label} and rejects one more`, () => {
      assert.equal(S.parseBoardJson(JSON.stringify(build(S.MAX_IMPORT_BRAWLERS))).ok, true);
      const r = S.parseBoardJson(JSON.stringify(build(S.MAX_IMPORT_BRAWLERS + 1)));
      assert.equal(r.ok, false);
      assert.equal(r.code, "too-many");
    });
  }

  test("rejects a brawler with more role assignments than MAX_IMPORT_ROLES", () => {
    const board = (n) => JSON.stringify({ maps: ["A"], brawlerRoles: { Shelly: Array(n).fill("Tank") } });
    assert.equal(S.parseBoardJson(board(S.MAX_IMPORT_ROLES)).ok, true);
    assert.equal(S.parseBoardJson(board(S.MAX_IMPORT_ROLES + 1)).code, "too-many");
  });

  for (const [label, build] of [
    ["map", (name) => ({ maps: ["All Maps", name] })],
    ["role", (name) => ({ maps: ["A"], roles: [{ name, color: "#000000" }] })],
    ["brawler", (name) => ({ maps: ["A"], notes: { [name]: "" } })],
  ]) {
    test(`accepts a ${label} name of exactly MAX_IMPORT_NAME_LENGTH characters and rejects one more`, () => {
      assert.equal(S.parseBoardJson(JSON.stringify(build("n".repeat(S.MAX_IMPORT_NAME_LENGTH)))).ok, true);
      assert.equal(S.parseBoardJson(JSON.stringify(build("n".repeat(S.MAX_IMPORT_NAME_LENGTH + 1)))).code, "too-long");
    });
  }

  test("neutralises markup in role colors and reports it", () => {
    const r = S.parseBoardJson(JSON.stringify({
      maps: ["A"],
      roles: [{ name: "Pwn", color: 'red"></span><img src=x onerror=alert(1)>' }],
    }));
    assert.equal(r.ok, true);
    assert.equal(r.state.roles[0].color, S.DEFAULT_ROLE_COLOR);
    assert.ok(r.warnings.length >= 1);
  });

  test("ignores an exportedAt that is not a date", () => {
    assert.equal(S.parseBoardJson(JSON.stringify({ ...uiState(), exportedAt: "yesterday" })).exportedAt, null);
    assert.equal(S.parseBoardJson(JSON.stringify({ ...uiState(), exportedAt: 5 })).exportedAt, null);
  });
});

test.describe("share links", () => {
  test("encodes into a URL-safe fragment", () => {
    assert.match(S.encodeShareHash(uiState()), /^#data=[A-Za-z0-9_-]+$/);
  });

  test("round-trips the shared part of the board including Korean, emoji and line separators", () => {
    const r = S.decodeShareHash(S.encodeShareHash(uiState()));
    assert.equal(r.ok, true);
    assert.deepEqual(plain(r.state), plain(S.shareableState(uiState())));
    assert.equal(r.state.notes.Shelly, uiState().notes.Shelly);
  });

  test("round-trips a large board without overflowing the stack", () => {
    const big = { ...uiState(), notes: { Shelly: "가".repeat(400000) } };
    const r = S.decodeShareHash(S.encodeShareHash(big));
    assert.equal(r.ok, true);
    assert.equal(r.state.notes.Shelly.length, 400000);
  });

  test("opens links made by the previous version (standard base64 with + / =, raw state)", () => {
    const { board, payload } = legacyPayloadWithAllSpecials();
    const r = S.decodeShareHash("#data=" + payload);
    assert.equal(r.ok, true);
    assert.deepEqual(plain(r.state), board);
  });

  test("opens a legacy link whose fragment was percent-encoded by a messenger", () => {
    const { board, payload } = legacyPayloadWithAllSpecials();
    const encoded = encodeURIComponent(payload);
    assert.notEqual(encoded, payload);
    const r = S.decodeShareHash("#data=" + encoded);
    assert.equal(r.ok, true);
    assert.deepEqual(plain(r.state), board);
  });

  test("opens a legacy link whose '+' characters arrived as spaces", () => {
    const { board, payload } = legacyPayloadWithAllSpecials();
    const r = S.decodeShareHash("#data=" + payload.replace(/\+/g, " "));
    assert.equal(r.ok, true);
    assert.deepEqual(plain(r.state), board);
  });

  test("rejects a link whose JSON contains invalid UTF-8 instead of opening garbled text", () => {
    const bytes = Buffer.concat([Buffer.from('{"maps":["A"],"notes":{"x":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}}')]);
    const r = S.decodeShareHash("#data=" + bytes.toString("base64"));
    assert.equal(r.ok, false);
  });

  for (const hash of ["", "#", "#top", "#data", "#datax=abc", null, undefined]) {
    test(`treats ${JSON.stringify(hash)} as not a share link`, () => {
      assert.equal(S.decodeShareHash(hash), null);
    });
  }

  for (const [label, hash] of [
    ["an empty payload", "#data="],
    ["invalid base64", "#data=@@@"],
    ["bytes that are not UTF-8", "#data=" + Buffer.from([0xff, 0xfe, 0xfd]).toString("base64")],
    ["JSON that is not a board", "#data=" + Buffer.from('{"hello":1}').toString("base64")],
    ["a broken percent escape", "#data=%E0%A4%A"],
  ]) {
    test(`rejects ${label} with a readable error`, () => {
      const r = S.decodeShareHash(hash);
      assert.equal(r.ok, false);
      assert.equal(typeof r.error, "string");
    });
  }

  for (const cut of [40, 200]) {
    test(`explains a link truncated to ${cut} characters as a damaged link, not a bad file`, () => {
      const r = S.decodeShareHash(S.encodeShareHash(uiState()).slice(0, cut));
      assert.equal(r.ok, false);
      assert.equal(r.code, "broken-link");
    });
  }

  test("rejects an oversized payload before decoding it", () => {
    const r = S.decodeShareHash("#data=" + "A".repeat(S.MAX_TRANSFER_CHARS * 4 + 1));
    assert.equal(r.ok, false);
    assert.match(r.error, /too large/);
  });
});

test.describe("compressed share links", () => {
  const zlib = require("node:zlib");
  // A realistic shared board: 110 brawlers on All Maps with an order, roles on every brawler.
  function realistic() {
    const names = Array.from({ length: 110 }, (_, i) => "Brawler " + i);
    return S.normalizeState({
      maps: ["All Maps"],
      mapPlacements: { "All Maps": Object.fromEntries(names.map((n, i) => [n, "SABCD"[i % 5]])) },
      mapOrders: { "All Maps": names },
      notes: { "Brawler 1": "Hold the left bush, then push with the team." },
      roles: [{ name: "Tank", color: "#b45309" }, { name: "Support", color: "#16a34a" }],
      brawlerRoles: Object.fromEntries(names.map((n, i) => [n, [i % 2 ? "Tank" : "Support"]])),
    }).state;
  }

  test("encodes into a short, URL-safe #z= fragment", async () => {
    const hash = await S.encodeShareHashAsync(realistic());
    const plainLength = S.encodeShareHash(realistic()).length;
    assert.match(hash, /^#z=[A-Za-z0-9_-]+$/);
    assert.ok(hash.length < plainLength * 0.5, hash.length + " vs " + plainLength);
  });

  test("round-trips exactly what an uncompressed link would carry", async () => {
    const r = await S.decodeShareHashAsync(await S.encodeShareHashAsync(uiState()));
    assert.equal(r.ok, true);
    assert.deepEqual(plain(r.state), plain(S.shareableState(uiState())));
  });

  test("still opens uncompressed links from earlier versions", async () => {
    const { board, payload } = legacyPayloadWithAllSpecials();
    const r = await S.decodeShareHashAsync("#data=" + payload);
    assert.equal(r.ok, true);
    assert.deepEqual(plain(r.state), board);
  });

  test("opens a compressed link whose fragment was percent-encoded", async () => {
    const hash = await S.encodeShareHashAsync(uiState());
    const r = await S.decodeShareHashAsync("#z=" + encodeURIComponent(hash.slice(3)).replace(/-/g, "%2D"));
    assert.equal(r.ok, true);
  });

  const broken = [
    ["an empty payload", async () => "#z="],
    ["invalid base64", async () => "#z=@@@"],
    ["bytes that are not deflate data", async () => "#z=" + Buffer.from("hello, not deflate").toString("base64url")],
    ["a truncated link", async () => (await S.encodeShareHashAsync(realistic())).slice(0, 60)],
    ["deflate of invalid UTF-8", async () => "#z=" + zlib.deflateRawSync(Buffer.from([0x7b, 0xc3, 0x28, 0x7d])).toString("base64url")],
    ["deflate of JSON that is not a board", async () => "#z=" + zlib.deflateRawSync(Buffer.from('{"hello":1}')).toString("base64url")],
  ];
  for (const [label, make] of broken) {
    test("rejects " + label + " with a readable error", async () => {
      const r = await S.decodeShareHashAsync(await make());
      assert.equal(r.ok, false);
      assert.equal(typeof r.error, "string");
    });
  }

  test("stops inflating a decompression bomb at the size limit", async () => {
    const bomb = zlib.deflateRawSync(Buffer.alloc(S.MAX_TRANSFER_CHARS * 3 + 1024, 0x20));
    const hash = "#z=" + bomb.toString("base64url") + "Z";
    assert.ok(hash.length < 20000, "bomb payload is tiny: " + hash.length);
    const r = await S.decodeShareHashAsync(hash);
    assert.equal(r.ok, false);
    assert.equal(r.code, "too-large");
  });

  for (const hash of ["", "#", "#top", "#zz=abc", null, undefined]) {
    test("treats " + JSON.stringify(hash) + " as not a share link", async () => {
      assert.equal(await S.decodeShareHashAsync(hash), null);
      assert.equal(S.isShareHash(hash), false);
    });
  }

  test("never ends a compressed link with a character autolinkers drop", async () => {
    for (let i = 0; i < 40; i++) {
      const hash = await S.encodeShareHashAsync({ ...realistic(), project: "p" + i });
      assert.match(hash, /[A-Za-z0-9]$/, hash.slice(-5));
    }
  });

  test("rejects a compressed payload that lost its end marker", async () => {
    const hash = await S.encodeShareHashAsync(uiState());
    const r = await S.decodeShareHashAsync(hash.slice(0, -1));
    assert.equal(r.ok, false);
    assert.equal(r.code, "broken-link");
  });

  test("rejects an oversized compressed payload before inflating it", async () => {
    const r = await S.decodeShareHashAsync("#z=" + "A".repeat(S.MAX_TRANSFER_CHARS * 4 + 1));
    assert.equal(r.ok, false);
    assert.equal(r.code, "too-large");
  });

  test("inflateCapped stops as soon as the output passes the cap", async () => {
    const bytes = zlib.deflateRawSync(Buffer.alloc(64 * 1024, 0x20));
    assert.equal(await S.inflateCapped(bytes, 1000), null);
    assert.equal((await S.inflateCapped(bytes, 64 * 1024)).length, 64 * 1024);
  });

  for (const [label, stub] of [
    ["is missing", () => { delete globalThis.CompressionStream; delete globalThis.DecompressionStream; }],
    ["does not support deflate-raw", () => {
      const reject = (format) => { if (format === "deflate-raw") throw new TypeError("Unsupported compression format"); };
      globalThis.CompressionStream = function (f) { reject(f); };
      globalThis.DecompressionStream = function (f) { reject(f); };
    }],
  ]) {
    test("falls back to an uncompressed link when CompressionStream " + label, async () => {
      const saved = [globalThis.CompressionStream, globalThis.DecompressionStream];
      const zipped = await S.encodeShareHashAsync(uiState());
      stub();
      try {
        assert.match(await S.encodeShareHashAsync(uiState()), /^#data=/);
        const r = await S.decodeShareHashAsync(zipped);
        assert.equal(r.ok, false);
        assert.equal(r.code, "unsupported");
      } finally {
        globalThis.CompressionStream = saved[0];
        globalThis.DecompressionStream = saved[1];
      }
    });
  }

  test("recognises both link formats without decoding them", () => {
    assert.equal(S.isShareHash("#z=abc"), true);
    assert.equal(S.isShareHash("#data=abc"), true);
  });
});

test.describe("import backup", () => {
  const KEY = "team-brawl-v2";

  test("keeps the previous board with when and why it was replaced", () => {
    const store = S.createStore(fakeStorage(), KEY);
    assert.equal(store.hasBackup(), false);
    assert.deepEqual(store.saveBackup(uiState(), "file", ISO), { ok: true });
    assert.equal(store.hasBackup(), true);
    const b = store.loadBackup();
    assert.equal(b.savedAt, ISO);
    assert.equal(b.source, "file");
    assert.deepEqual(plain(b.state), uiState());
  });

  test("restores an earlier backup exactly after a failed import overwrote it", () => {
    const st = fakeStorage();
    const store = S.createStore(st, KEY);
    store.saveBackup(uiState(), "file", ISO);
    const before = store.readBackupRaw();
    store.saveBackup({ ...uiState(), project: "newer board" }, "link", "2026-10-07T00:00:00.000Z");
    store.writeBackupRaw(before);
    assert.equal(st.data.get(KEY + ":import-backup"), before);
    assert.equal(store.loadBackup().savedAt, ISO);
  });

  for (const raw of ["{bad", '  {"savedAt":"x","source":"file","board":{}}  ']) {
    test(`writeBackupRaw puts back ${JSON.stringify(raw.slice(0, 12))} byte for byte`, () => {
      const st = fakeStorage({ initial: { [KEY + ":import-backup"]: raw } });
      const store = S.createStore(st, KEY);
      const before = store.readBackupRaw();
      store.saveBackup(uiState(), "file", ISO);
      assert.doesNotThrow(() => store.writeBackupRaw(before));
      assert.equal(st.data.get(KEY + ":import-backup"), raw);
    });
  }

  test("stores the backup board with app id and schema version", () => {
    const st = fakeStorage();
    S.createStore(st, KEY).saveBackup(uiState(), "file", ISO);
    const board = JSON.parse(st.data.get(KEY + ":import-backup")).board;
    assert.equal(board.app, S.APP_ID);
    assert.equal(board.schemaVersion, S.SCHEMA_VERSION);
  });

  test("clearing a backup never throws, even when removal is blocked", () => {
    const st = fakeStorage();
    const store = S.createStore(st, KEY);
    store.saveBackup(uiState(), "file", ISO);
    st.removeItem = () => {
      throw Object.assign(new Error("blocked"), { name: "SecurityError" });
    };
    assert.doesNotThrow(() => store.clearBackup());
    assert.doesNotThrow(() => store.writeBackupRaw(null));
  });

  test("writeBackupRaw(null) removes a backup that did not exist before", () => {
    const store = S.createStore(fakeStorage(), KEY);
    const before = store.readBackupRaw();
    assert.equal(before, null);
    store.saveBackup(uiState(), "file", ISO);
    store.writeBackupRaw(before);
    assert.equal(store.hasBackup(), false);
  });

  test("clearBackup removes it", () => {
    const store = S.createStore(fakeStorage(), KEY);
    store.saveBackup(uiState(), "link", ISO);
    store.clearBackup();
    assert.equal(store.hasBackup(), false);
    assert.equal(store.loadBackup(), null);
  });

  test("reports a full storage instead of throwing", () => {
    const err = Object.assign(new Error("full"), { name: "QuotaExceededError" });
    const store = S.createStore(fakeStorage({ setError: err }), KEY);
    assert.deepEqual(store.saveBackup(uiState(), "file", ISO), { ok: false, reason: "quota" });
  });

  for (const raw of ["{bad", "[]", '{"savedAt":"x","source":"file"}', '{"savedAt":"x","source":"file","board":5}']) {
    test(`treats a damaged backup ${raw} as missing`, () => {
      const store = S.createStore(fakeStorage({ initial: { [KEY + ":import-backup"]: raw } }), KEY);
      assert.equal(store.loadBackup(), null);
      assert.equal(store.hasBackup(), false);
    });
  }

  test("works without storage", () => {
    const store = S.createStore(null, KEY);
    assert.equal(store.hasBackup(), false);
    assert.equal(store.loadBackup(), null);
    assert.deepEqual(store.saveBackup(uiState(), "file", ISO), { ok: false, reason: "unavailable" });
    assert.doesNotThrow(() => store.clearBackup());
  });
});
