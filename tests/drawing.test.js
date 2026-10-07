"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../js/drawing.js");

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const plain = (x) => JSON.parse(JSON.stringify(x));

function deepFreeze(o) {
  if (o && typeof o === "object") {
    Object.values(o).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}

// One of every shape type, built the way the UI builds them.
function sampleShapes() {
  return [
    D.createPen([100, 100, 200, 300, 400, 120], "#ff0000", 20),
    D.createLine(0, 0, 10000, 10000, "#00FF00", 1),
    D.createArrow(500, 500, 2500, 800, "#0000ff", 500),
    D.createText(5000, 5000, "Push left 👈", "#ffffff", 300),
    D.createBrawler(7000, 2000, "Shelly", 800),
  ];
}

const validPen = () => ({ t: "pen", c: "#123456", w: 10, p: [1, 2, 3, 4] });
const validLine = () => ({ t: "line", c: "#123456", w: 10, p: [1, 2, 3, 4] });
const validText = () => ({ t: "text", c: "#123456", x: 10, y: 20, z: 100, s: "hi" });
const validBrawler = () => ({ t: "brawler", n: "Colt", x: 10, y: 20, z: 500 });

// Ramer-Douglas-Peucker deep case: each split peels one point off the end, so a
// recursive implementation needs one stack frame per point.
function shrinkingZigzag(n) {
  const p = [];
  for (let i = 0; i < n; i++) p.push(i, (i % 2 ? 1 : -1) * (n - i));
  return p;
}

// A ctx that records every call and fails on any member outside the allowed list.
const CTX_METHODS = ["save", "restore", "beginPath", "moveTo", "lineTo", "arc", "stroke", "fill", "fillText", "drawImage", "closePath"];
const CTX_PROPS = ["strokeStyle", "fillStyle", "lineWidth", "lineCap", "lineJoin", "font", "textAlign", "textBaseline", "globalAlpha"];
function fakeCtx() {
  const calls = [];
  const violations = [];
  const values = {};
  const target = {};
  const ctx = new Proxy(target, {
    get(_, k) {
      if (CTX_METHODS.includes(k)) return (...args) => calls.push([k, ...args]);
      if (CTX_PROPS.includes(k)) return values[k];
      violations.push(`get ${String(k)}`);
      return undefined;
    },
    set(_, k, v) {
      if (CTX_PROPS.includes(k)) {
        values[k] = v;
        calls.push(["set", k, v]);
      } else violations.push(`set ${String(k)}`);
      return true;
    },
  });
  return { ctx, calls, violations, values };
}
const named = (calls, name) => calls.filter((c) => c[0] === name);
const sets = (calls, prop) => calls.filter((c) => c[0] === "set" && c[1] === prop).map((c) => c[2]);

function assertBalanced(calls) {
  let depth = 0;
  for (const [m] of calls) {
    if (m === "save") depth++;
    if (m === "restore") depth--;
    assert.ok(depth >= 0, "restore without save");
  }
  assert.equal(depth, 0, "save/restore must balance");
}

// ---------------------------------------------------------------- constants

test("LIMITS and COORD_MAX are the documented frozen values", () => {
  assert.deepEqual({ ...D.LIMITS }, { shapes: 2000, points: 2000, text: 200, totalPoints: 20000 });
  assert.ok(Object.isFrozen(D.LIMITS));
  assert.equal(D.COORD_MAX, 10000);
});

// ---------------------------------------------------------------- quantize / units

test("quantize rounds and clamps to 0..10000", () => {
  assert.equal(D.quantize(0), 0);
  assert.equal(D.quantize(10000), 10000);
  assert.equal(D.quantize(-1), 0);
  assert.equal(D.quantize(10001), 10000);
  assert.equal(D.quantize(9999.6), 10000);
  assert.equal(D.quantize(4.5), 5);
  assert.equal(D.quantize(4.49), 4);
  assert.ok(Object.is(D.quantize(-0.4), 0), "never returns -0");
  assert.ok(Object.is(D.quantize(-0), 0));
});

test("quantize maps non-finite and non-number input to 0", () => {
  for (const v of [NaN, Infinity, -Infinity, "5", null, undefined, {}, [], true, Symbol("x"), 10n]) {
    assert.equal(D.quantize(v), 0, String(typeof v));
  }
});

test("toUnit / fromUnit convert one axis and guard bad sizes", () => {
  assert.equal(D.toUnit(50, 200), 2500);
  assert.equal(D.toUnit(0, 200), 0);
  assert.equal(D.toUnit(200, 200), 10000);
  assert.equal(D.toUnit(1, 3), 3333);
  // Not clamped: callers also convert drag deltas, which can be negative.
  assert.equal(D.toUnit(-10, 100), -1000);
  assert.equal(D.fromUnit(2500, 200), 50);
  assert.equal(D.fromUnit(10000, 640), 640);
  for (const size of [0, -5, NaN, Infinity, "100", undefined]) {
    assert.equal(D.toUnit(10, size), 0);
    assert.equal(D.fromUnit(10, size), 0);
  }
  assert.equal(D.toUnit(NaN, 100), 0);
  assert.equal(D.fromUnit(Infinity, 100), 0);
  assert.equal(D.toUnit(Symbol("x"), 100), 0);
});

// ---------------------------------------------------------------- simplify

test("simplify returns copies for trivial inputs and [] for non-arrays", () => {
  assert.deepEqual(D.simplify([], 8), []);
  const one = [1, 2];
  const two = [1, 2, 3, 4];
  assert.deepEqual(D.simplify(one, 8), one);
  assert.notEqual(D.simplify(one, 8), one);
  assert.deepEqual(D.simplify(two, 8), two);
  assert.notEqual(D.simplify(two, 8), two);
  for (const v of [null, undefined, "1,2", { length: 4 }, 5]) assert.deepEqual(D.simplify(v, 8), []);
});

test("simplify ignores a trailing odd number", () => {
  assert.deepEqual(D.simplify([0, 0, 100, 100, 7], 8), [0, 0, 100, 100]);
});

test("simplify drops points within tolerance and keeps points beyond it (boundary is exclusive)", () => {
  assert.deepEqual(D.simplify([0, 0, 50, 8, 100, 0], 8), [0, 0, 100, 0], "distance == tolerance is dropped");
  assert.deepEqual(D.simplify([0, 0, 50, 9, 100, 0], 8), [0, 0, 50, 9, 100, 0]);
  assert.deepEqual(D.simplify([0, 0, 50, 5, 100, 0], 8), [0, 0, 100, 0]);
  assert.deepEqual(D.simplify([0, 0, 50, 5, 100, 0], 4), [0, 0, 50, 5, 100, 0]);
});

test("simplify with tolerance 0 removes only exactly collinear points", () => {
  assert.deepEqual(D.simplify([0, 0, 5, 0, 10, 0, 10, 1], 0), [0, 0, 10, 0, 10, 1]);
});

test("simplify treats negative or non-finite tolerance as 0", () => {
  const pts = [0, 0, 5, 0, 10, 0, 10, 1];
  for (const tol of [-5, NaN, Infinity, undefined, "8"]) {
    assert.deepEqual(D.simplify(pts, tol), [0, 0, 10, 0, 10, 1], String(tol));
  }
});

test("simplify keeps first and last point of a closed loop", () => {
  const loop = [0, 0, 100, 0, 100, 100, 0, 0];
  assert.deepEqual(D.simplify(loop, 8), loop);
  // A huge tolerance still keeps both ends.
  assert.deepEqual(D.simplify([3, 4, 50, 50, 60, 70, 9, 9], 1e9), [3, 4, 9, 9]);
});

test("simplify does not mutate its input", () => {
  const pts = deepFreeze([0, 0, 50, 5, 100, 0, 150, 90]);
  assert.doesNotThrow(() => D.simplify(pts, 8));
});

test("simplify is iterative: a 10k-point peel-one-point-per-split input does not overflow", () => {
  const pts = shrinkingZigzag(10000);
  const out = D.simplify(pts, 0.5);
  assert.equal(out.length, pts.length, "every zigzag vertex is significant");
  assert.deepEqual(out, pts);
});

test("simplify handles 100k points and returns an ordered subset", () => {
  const n = 100000;
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(i / 10, 5000 + Math.sin(i / 500) * 3000 + ((i * 7919) % 13) / 13);
  const out = D.simplify(pts, 8);
  assert.equal(out.length % 2, 0);
  assert.ok(out.length >= 4 && out.length < pts.length / 10, `kept ${out.length / 2} points`);
  assert.deepEqual(out.slice(0, 2), pts.slice(0, 2));
  assert.deepEqual(out.slice(-2), pts.slice(-2));
  // Every kept point exists in the input at a strictly increasing index.
  let j = 0;
  for (let k = 0; k < out.length; k += 2) {
    while (j < pts.length && (pts[j] !== out[k] || pts[j + 1] !== out[k + 1])) j += 2;
    assert.ok(j < pts.length, "kept point must come from the input, in order");
    j += 2;
  }
});

// ---------------------------------------------------------------- createPen

test("createPen quantizes, drops consecutive duplicates and simplifies", () => {
  const pen = D.createPen([-50, 20000.4, 10.2, 10.1, 10, 10, 10.4, 9.6, 20, 20], "#ff0000", 20, 0);
  assert.deepEqual(pen, { t: "pen", c: "#ff0000", w: 20, p: [0, 10000, 10, 10, 20, 20] });
  const straight = D.createPen([0, 0, 10, 1, 20, 0, 30, 1, 40, 0], "#ff0000", 20);
  assert.deepEqual(straight.p, [0, 0, 40, 0], "default tolerance 8 smooths jitter");
  const kept = D.createPen([0, 0, 10, 1, 20, 0], "#ff0000", 20, 0);
  assert.deepEqual(kept.p, [0, 0, 10, 1, 20, 0]);
});

test("createPen keeps a single point (dot) and collapses repeated points to one", () => {
  assert.deepEqual(D.createPen([5, 6], "#000000", 3).p, [5, 6]);
  assert.deepEqual(D.createPen([5, 6, 5, 6, 5.2, 5.9], "#000000", 3).p, [5, 6]);
});

test("createPen skips non-finite pairs and returns null when none are left", () => {
  assert.deepEqual(D.createPen([NaN, 5, 10, 10, 20, Infinity, 30, 30], "#000000", 3, 0).p, [10, 10, 30, 30]);
  assert.equal(D.createPen([NaN, NaN, "1", 2], "#000000", 3), null);
  assert.equal(D.createPen([], "#000000", 3), null);
  assert.equal(D.createPen([1], "#000000", 3), null);
  for (const v of [null, undefined, "0,0", { 0: 1, 1: 2, length: 2 }]) assert.equal(D.createPen(v, "#000000", 3), null);
});

test("createPen validates color and width (1..500)", () => {
  const pts = [0, 0, 100, 100];
  for (const c of ["red", "#fff", "#12345g", " #123456", "#1234567", "#123456 ", "url(x)", null, 0x123456]) {
    assert.equal(D.createPen(pts, c, 3), null, String(c));
  }
  assert.equal(D.createPen(pts, "#ABCDEF", 3).c, "#ABCDEF", "case is kept");
  assert.equal(D.createPen(pts, "#000000", 0), null);
  assert.equal(D.createPen(pts, "#000000", 1).w, 1);
  assert.equal(D.createPen(pts, "#000000", 500).w, 500);
  assert.equal(D.createPen(pts, "#000000", 501), null);
  assert.equal(D.createPen(pts, "#000000", 1.4).w, 1, "widths are rounded");
  assert.equal(D.createPen(pts, "#000000", 0.4), null);
  for (const w of [NaN, Infinity, "5", null, undefined]) assert.equal(D.createPen(pts, "#000000", w), null, String(w));
});

test("createPen keeps exactly LIMITS.points points and reduces LIMITS.points + 1", () => {
  // 5-unit spacing keeps every vertex more than 8 units from any chord (4 would not).
  const zig = (n) => {
    const p = [];
    for (let i = 0; i < n; i++) p.push(i * 5, i % 2 ? 3000 : 2000);
    return p;
  };
  const exact = D.createPen(zig(D.LIMITS.points), "#000000", 5);
  assert.equal(exact.p.length, D.LIMITS.points * 2);
  assert.deepEqual(exact.p, zig(D.LIMITS.points));
  const over = D.createPen(zig(D.LIMITS.points + 1), "#000000", 5);
  // One point too many must cost about one point, not the drawing.
  assert.equal(over.p.length, D.LIMITS.points * 2);
  assert.deepEqual(over.p.slice(0, 2), [0, 2000]);
  assert.deepEqual(over.p.slice(-2), [D.LIMITS.points * 5, 2000]);
});

// Every corner deviates by the same 300 units, so one global tolerance either keeps all of
// them or none; a significance cap must spread the loss over the whole stroke instead.
test("createPen reduces an over-limit hatching scribble without collapsing or truncating it", () => {
  const hatch = [];
  for (let i = 0; i <= 2600; i++) hatch.push(1000 + 3 * i, i % 2 ? 4000 : 4300);
  const pen = D.createPen(hatch, "#000000", 5);
  const n = pen.p.length / 2;
  assert.ok(n <= D.LIMITS.points && n >= D.LIMITS.points / 2, `kept ${n} points`);
  assert.deepEqual(pen.p.slice(0, 2), [1000, 4300]);
  assert.deepEqual(pen.p.slice(-2), [8800, 4300]);
  // Every tenth of the stroke still reaches both edges of the hatch.
  for (let k = 0; k < 10; k++) {
    const lo = 1000 + 780 * k;
    const ys = new Set();
    for (let i = 0; i < pen.p.length; i += 2) if (pen.p[i] >= lo && pen.p[i] < lo + 780) ys.add(pen.p[i + 1]);
    assert.ok(ys.has(4000) && ys.has(4300), `decile ${k} lost its hatching`);
  }
  assert.deepEqual(D.normalizeShapes([pen]).shapes, [pen]);
});

// 400k samples step 0.025 units, so 40 share each quantized x: an even sampling step would
// pick only one side of the zigzag and draw a flat line.
test("createPen stays fast and keeps the shape of a long zigzag where every vertex matters", () => {
  for (const n of [8000, 20000, 100000, 400000]) {
    const raw = [];
    for (let i = 0; i < n; i++) raw.push((i * 10000) / n, 5000 + (i % 2 ? 100 : -100));
    const t0 = process.hrtime.bigint();
    const pen = D.createPen(raw, "#000000", 5);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1500, `n=${n} took ${ms.toFixed(0)}ms`);
    const kept = pen.p.length / 2;
    assert.ok(kept <= D.LIMITS.points && kept >= D.LIMITS.points / 2, `n=${n} kept ${kept} points`);
    assert.deepEqual(pen.p.slice(0, 2), [0, 4900]);
    assert.deepEqual(pen.p.slice(-2), [D.quantize(((n - 1) * 10000) / n), 5100]);
    let lows = 0;
    for (let i = 1; i < pen.p.length; i += 2) if (pen.p[i] === 4900) lows++;
    assert.ok(lows > kept / 4, `n=${n}: the zigzag must survive, ${lows} low vertices`);
  }
});

test("createPen output under the limit is exactly simplify() of the quantized points", () => {
  const raw = [];
  for (let i = 0; i < 3000; i++) raw.push(i * 3, 5000 + Math.sin(i / 40) * 2000);
  const q = [];
  for (let i = 0; i < raw.length; i++) q.push(D.quantize(raw[i]));
  const pen = D.createPen(raw, "#000000", 5);
  assert.deepEqual(pen.p, D.simplify(q, 8));
  assert.ok(pen.p.length / 2 < D.LIMITS.points);
});

test("createPen fits huge noisy input under the point limit, even with tolerance 0", () => {
  const raw = [];
  for (let i = 0; i < 30000; i++) raw.push((i * 37) % 10000, (i * 101) % 10000);
  for (const tol of [0, 8, -1, NaN]) {
    const pen = D.createPen(raw, "#000000", 5, tol);
    assert.ok(pen.p.length <= D.LIMITS.points * 2, `tol ${tol}: ${pen.p.length / 2} points`);
    assert.deepEqual(D.normalizeShapes([pen]).shapes, [pen]);
  }
});

// ---------------------------------------------------------------- createLine / createArrow

test("createLine / createArrow quantize endpoints and validate", () => {
  assert.deepEqual(D.createLine(-5, 10001, 3.6, 7.2, "#00ff00", 10), { t: "line", c: "#00ff00", w: 10, p: [0, 10000, 4, 7] });
  assert.deepEqual(D.createArrow(1, 2, 3, 4, "#00ff00", 10), { t: "arrow", c: "#00ff00", w: 10, p: [1, 2, 3, 4] });
  assert.deepEqual(D.createArrow(5, 5, 5, 5, "#00ff00", 10).p, [5, 5, 5, 5], "zero-length is allowed");
  for (const make of [D.createLine, D.createArrow]) {
    assert.equal(make(NaN, 0, 1, 1, "#000000", 5), null);
    assert.equal(make(0, 0, 1, Infinity, "#000000", 5), null);
    assert.equal(make(0, "0", 1, 1, "#000000", 5), null);
    assert.equal(make(0, 0, 1, 1, "black", 5), null);
    assert.equal(make(0, 0, 1, 1, "#000000", 0), null);
    assert.equal(make(0, 0, 1, 1, "#000000", 501), null);
    assert.equal(make(0, 0, 1, 1, "#000000", 500).w, 500);
    assert.equal(make(), null);
  }
});

// ---------------------------------------------------------------- createText

test("createText validates text length 1..LIMITS.text without truncating", () => {
  const ok = D.createText(10.4, -3, "A", "#ffffff", 50);
  assert.deepEqual(ok, { t: "text", c: "#ffffff", x: 10, y: 0, z: 50, s: "A" });
  assert.equal(D.createText(0, 0, "", "#ffffff", 100), null);
  const max = "x".repeat(D.LIMITS.text);
  assert.equal(D.createText(0, 0, max, "#ffffff", 100).s, max);
  assert.equal(D.createText(0, 0, max + "x", "#ffffff", 100), null);
  assert.equal(D.createText(0, 0, "  spaced  ", "#ffffff", 100).s, "  spaced  ", "kept exactly");
  for (const s of [null, undefined, 5, ["a"], { toString: () => "a" }]) assert.equal(D.createText(0, 0, s, "#ffffff", 100), null);
});

test("createText validates size 50..2000, color and position", () => {
  assert.equal(D.createText(0, 0, "a", "#ffffff", 49), null);
  assert.equal(D.createText(0, 0, "a", "#ffffff", 50).z, 50);
  assert.equal(D.createText(0, 0, "a", "#ffffff", 2000).z, 2000);
  assert.equal(D.createText(0, 0, "a", "#ffffff", 2001), null);
  assert.equal(D.createText(0, 0, "a", "white", 100), null);
  assert.equal(D.createText(NaN, 0, "a", "#ffffff", 100), null);
  assert.equal(D.createText(0, undefined, "a", "#ffffff", 100), null);
});

// ---------------------------------------------------------------- createBrawler

test("createBrawler validates name 1..100 and size 100..3000", () => {
  assert.deepEqual(D.createBrawler(20000, 5, "El Primo", 100), { t: "brawler", n: "El Primo", x: 10000, y: 5, z: 100 });
  assert.equal(D.createBrawler(0, 0, "Colt", 99), null);
  assert.equal(D.createBrawler(0, 0, "Colt", 3000).z, 3000);
  assert.equal(D.createBrawler(0, 0, "Colt", 3001), null);
  assert.equal(D.createBrawler(0, 0, "", 500), null);
  assert.equal(D.createBrawler(0, 0, "n".repeat(100), 500).n.length, 100);
  assert.equal(D.createBrawler(0, 0, "n".repeat(101), 500), null);
  assert.equal(D.createBrawler(0, 0, 42, 500), null);
  assert.equal(D.createBrawler(0, NaN, "Colt", 500), null);
});

// ---------------------------------------------------------------- normalizeShapes

test("normalizeShapes round-trips one of every created shape losslessly", () => {
  const shapes = sampleShapes();
  assert.ok(shapes.every(Boolean));
  const direct = D.normalizeShapes(shapes);
  assert.deepEqual(direct, { shapes, dropped: 0 });
  const viaJson = D.normalizeShapes(JSON.parse(JSON.stringify(shapes)));
  assert.deepEqual(viaJson, { shapes, dropped: 0 });
  assert.equal(JSON.stringify(viaJson.shapes), JSON.stringify(shapes));
});

test("normalizeShapes returns fresh objects with only the documented keys", () => {
  const input = [
    { ...validPen(), extra: 1, x: 5 },
    { ...validText(), w: 3, p: [1, 2] },
    { ...validBrawler(), c: "#ffffff" },
    { ...validLine(), z: 100 },
  ];
  const { shapes, dropped } = D.normalizeShapes(input);
  assert.equal(dropped, 0);
  assert.deepEqual(shapes, [validPen(), validText(), validBrawler(), validLine()]);
  shapes.forEach((s, i) => assert.notEqual(s, input[i]));
  assert.notEqual(shapes[0].p, input[0].p);
  assert.deepEqual(Object.keys(shapes[0]).sort(), ["c", "p", "t", "w"]);
  assert.deepEqual(Object.keys(shapes[1]).sort(), ["c", "s", "t", "x", "y", "z"]);
  assert.deepEqual(Object.keys(shapes[2]).sort(), ["n", "t", "x", "y", "z"]);
});

test("normalizeShapes handles non-array input", () => {
  assert.deepEqual(D.normalizeShapes(undefined), { shapes: [], dropped: 0 });
  for (const v of [null, {}, "[]", 5, true, { length: 1, 0: validPen() }]) {
    assert.deepEqual(D.normalizeShapes(v), { shapes: [], dropped: 1 }, JSON.stringify(v));
  }
});

test("normalizeShapes rejects every malformed shape", () => {
  const bad = [
    null, undefined, 5, "pen", [], [validPen()],
    { ...validPen(), t: "circle" }, { ...validPen(), t: "constructor" }, { ...validPen(), t: "__proto__" }, { ...validPen(), t: undefined },
    { ...validPen(), c: "red" }, { ...validPen(), c: "#fff" }, { ...validPen(), c: "#12345z" }, { ...validPen(), c: undefined },
    { ...validPen(), c: "#123456;x" }, { ...validPen(), c: ["#123456"] },
    { ...validPen(), w: 0 }, { ...validPen(), w: 501 }, { ...validPen(), w: 1.5 }, { ...validPen(), w: "5" }, { ...validPen(), w: NaN },
    { ...validPen(), p: [] }, { ...validPen(), p: [1, 2, 3] }, { ...validPen(), p: [1, 2, 3, -1] }, { ...validPen(), p: [1, 2, 3, 10001] },
    { ...validPen(), p: [1, 2, 3, 4.5] }, { ...validPen(), p: [1, 2, "3", 4] }, { ...validPen(), p: [1, 2, null, 4] }, { ...validPen(), p: "1,2" },
    { ...validPen(), p: { 0: 1, 1: 2, length: 2 } }, { ...validPen(), p: [1, 2, 3, Infinity] },
    { ...validLine(), p: [1, 2] }, { ...validLine(), p: [1, 2, 3, 4, 5, 6] }, { ...validLine(), t: "arrow", p: [1, 2, 3, 4, 5, 6] },
    { ...validText(), s: "" }, { ...validText(), s: "x".repeat(201) }, { ...validText(), s: 5 }, { ...validText(), z: 49 }, { ...validText(), z: 2001 },
    { ...validText(), x: -1 }, { ...validText(), y: 10001 }, { ...validText(), x: 1.5 }, { ...validText(), c: "#000" }, { ...validText(), x: undefined },
    { ...validBrawler(), n: "" }, { ...validBrawler(), n: "n".repeat(101) }, { ...validBrawler(), n: null }, { ...validBrawler(), z: 99 },
    { ...validBrawler(), z: 3001 }, { ...validBrawler(), x: "10" },
  ];
  for (const s of bad) {
    assert.deepEqual(D.normalizeShapes([s]), { shapes: [], dropped: 1 }, JSON.stringify(s));
  }
});

test("normalizeShapes accepts both ends of every range", () => {
  const good = [
    { t: "pen", c: "#000000", w: 1, p: [0, 0] },
    { t: "pen", c: "#FFFFFF", w: 500, p: [10000, 10000, 0, 0] },
    { t: "arrow", c: "#aBcDeF", w: 1, p: [0, 10000, 10000, 0] },
    { t: "text", c: "#000000", x: 0, y: 10000, z: 50, s: "a" },
    { t: "text", c: "#000000", x: 10000, y: 0, z: 2000, s: "x".repeat(200) },
    { t: "brawler", n: "a", x: 0, y: 0, z: 100 },
    { t: "brawler", n: "n".repeat(100), x: 10000, y: 10000, z: 3000 },
  ];
  assert.deepEqual(D.normalizeShapes(good), { shapes: good, dropped: 0 });
});

test("normalizeShapes enforces the per-stroke point limit exactly", () => {
  const atLimit = { t: "pen", c: "#000000", w: 1, p: Array.from({ length: D.LIMITS.points * 2 }, (_, i) => i % 10001) };
  const over = { ...atLimit, p: [...atLimit.p, 1, 1] };
  assert.equal(D.normalizeShapes([atLimit]).shapes.length, 1);
  assert.deepEqual(D.normalizeShapes([over]), { shapes: [], dropped: 1 });
});

test("normalizeShapes keeps LIMITS.shapes shapes and drops (and counts) the rest", () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ t: "brawler", n: `b${i}`, x: 1, y: 1, z: 100 }));
  const exact = D.normalizeShapes(many(D.LIMITS.shapes));
  assert.equal(exact.shapes.length, D.LIMITS.shapes);
  assert.equal(exact.dropped, 0);
  const over = D.normalizeShapes(many(D.LIMITS.shapes + 1));
  assert.equal(over.shapes.length, D.LIMITS.shapes);
  assert.equal(over.dropped, 1);
  assert.equal(over.shapes[D.LIMITS.shapes - 1].n, `b${D.LIMITS.shapes - 1}`, "the first shapes win");
  const mixed = D.normalizeShapes([null, ...many(D.LIMITS.shapes + 2)]);
  assert.equal(mixed.shapes.length, D.LIMITS.shapes);
  assert.equal(mixed.dropped, 3);
});

// Per-shape limits alone still allow 2000 x 2000-point strokes (~40M JSON chars) per image,
// which no storage quota holds and which takes seconds to render.
test("normalizeShapes enforces LIMITS.totalPoints per image and counts what it drops", () => {
  const bigP = Array.from({ length: D.LIMITS.points * 2 }, (_, i) => (i * 37) % 10001);
  const pens = Array.from({ length: D.LIMITS.shapes }, () => ({ t: "pen", c: "#000000", w: 500, p: bigP }));
  const capped = D.normalizeShapes(pens);
  const fit = Math.floor(D.LIMITS.totalPoints / D.LIMITS.points);
  assert.equal(capped.shapes.length, fit);
  assert.equal(capped.dropped, D.LIMITS.shapes - fit);
  assert.ok(D.pointCount(capped.shapes) <= D.LIMITS.totalPoints);
  assert.ok(D.encodedLength(capped.shapes) < 300000, `${D.encodedLength(capped.shapes)} chars`);
  // A shape that no longer fits is dropped, but smaller ones after it still count.
  const nearlyFull = Array.from({ length: fit }, () => ({ t: "pen", c: "#000000", w: 5, p: bigP }));
  nearlyFull[fit - 1] = { t: "pen", c: "#000000", w: 5, p: bigP.slice(0, -2) };
  const mixed = D.normalizeShapes([...nearlyFull, { t: "line", c: "#000000", w: 5, p: [1, 2, 3, 4] }, validBrawler(), validText()]);
  assert.equal(D.pointCount(mixed.shapes), D.LIMITS.totalPoints);
  assert.equal(mixed.dropped, 2, "the 2-point line does not fit, the 1-point brawler does, then the budget is spent");
  assert.deepEqual(mixed.shapes[mixed.shapes.length - 1], validBrawler());
  assert.equal(mixed.shapes.length, fit + 1);
});

test("pointCount counts stored points: pen points, 2 per line/arrow, 1 per text/brawler", () => {
  const shapes = sampleShapes();
  const pen = shapes[0].p.length / 2;
  assert.equal(D.pointCount(shapes), pen + 2 + 2 + 1 + 1);
  assert.equal(D.pointCount(shapes[1]), 2, "a single shape");
  assert.equal(D.pointCount([null, { t: "bad" }, validText()]), 1, "invalid entries cost nothing");
  for (const v of [null, undefined, "x", 5, {}]) assert.equal(D.pointCount(v), 0);
  assert.ok(D.LIMITS.totalPoints >= D.LIMITS.points * 5, "room for several full-length strokes");
});

test("normalizeShapes keeps order and counts invalid entries mixed with valid ones", () => {
  const { shapes, dropped } = D.normalizeShapes([validPen(), { t: "x" }, validText(), null, validBrawler()]);
  assert.deepEqual(shapes, [validPen(), validText(), validBrawler()]);
  assert.equal(dropped, 2);
  // eslint-disable-next-line no-sparse-arrays
  assert.deepEqual(D.normalizeShapes([, validPen()]), { shapes: [validPen()], dropped: 1 });
});

test("normalizeShapes ignores __proto__ keys and inherited fields", () => {
  const withProto = JSON.parse('[{"t":"pen","c":"#000000","w":5,"p":[1,2],"__proto__":{"polluted":true}}]');
  const { shapes, dropped } = D.normalizeShapes(withProto);
  assert.equal(dropped, 0);
  assert.equal(Object.getPrototypeOf(shapes[0]), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(shapes[0], "__proto__"), false);
  assert.equal(shapes[0].polluted, undefined);
  assert.equal({}.polluted, undefined);
  const hidden = JSON.parse('[{"__proto__":{"t":"pen","c":"#000000","w":5,"p":[1,2]}}]');
  assert.deepEqual(D.normalizeShapes(hidden), { shapes: [], dropped: 1 });
  const inherited = Object.create(validPen());
  assert.deepEqual(D.normalizeShapes([inherited]), { shapes: [], dropped: 1 });
  const nullProto = Object.assign(Object.create(null), validBrawler());
  assert.deepEqual(D.normalizeShapes([nullProto]).shapes, [validBrawler()]);
});

test("normalizeShapes does not mutate its input", () => {
  const input = deepFreeze([validPen(), { t: "bad" }, validText()]);
  assert.doesNotThrow(() => D.normalizeShapes(input));
});

// ---------------------------------------------------------------- bounds

test("bounds of strokes expand the point extent by w/2", () => {
  assert.deepEqual(D.bounds({ t: "pen", c: "#000000", w: 20, p: [100, 200, 300, 50] }), { x0: 90, y0: 40, x1: 310, y1: 210 });
  assert.deepEqual(D.bounds({ t: "pen", c: "#000000", w: 5, p: [100, 100] }), { x0: 97.5, y0: 97.5, x1: 102.5, y1: 102.5 });
  assert.deepEqual(D.bounds({ t: "line", c: "#000000", w: 10, p: [0, 0, 100, 100] }), { x0: -5, y0: -5, x1: 105, y1: 105 });
  // A zero-length arrow is drawn as a dot, without a head.
  assert.deepEqual(D.bounds({ t: "arrow", c: "#000000", w: 10, p: [50, 50, 50, 50] }), { x0: 45, y0: 45, x1: 55, y1: 55 });
});

// render() draws the head with barbs 3w+100 width-units long; bounds and hit areas must
// cover them or the eraser and any selection box miss the most visible part of an arrow.
const headBarbs = (x0, y0, x1, y1, w, a = 1) => {
  const h = D.arrowHead(x0, y0 * a, x1, y1 * a, 3 * w + 100);
  return { lx: h[0], ly: h[1] / a, rx: h[4], ry: h[5] / a };
};

test("bounds of an arrow include the head that render draws", () => {
  const arrow = D.createArrow(1000, 5000, 9000, 5000, "#ff0000", 10);
  const { lx, ly, ry } = headBarbs(1000, 5000, 9000, 5000, 10);
  const b = D.bounds(arrow);
  assert.ok(Math.abs(b.y0 - (ly - 5)) < 1e-9 && Math.abs(b.y1 - (ry + 5)) < 1e-9, JSON.stringify(b));
  assert.equal(b.x0, 995);
  assert.equal(b.x1, 9005);
  assert.ok(lx < 8900);
  const diag = D.bounds({ t: "arrow", c: "#000000", w: 10, p: [100, 100, 0, 0] });
  const d = headBarbs(100, 100, 0, 0, 10);
  assert.ok(Math.abs(diag.x1 - (Math.max(100, d.lx, d.rx) + 5)) < 1e-9, JSON.stringify(diag));
  assert.ok(Math.abs(diag.y1 - (Math.max(100, d.ly, d.ry) + 5)) < 1e-9);
  assert.ok(diag.x1 > 105 && diag.y1 > 105);
  // With an aspect the head is built in width units and converted back to y units.
  const tall = D.bounds(arrow, 2);
  const t = headBarbs(1000, 5000, 9000, 5000, 10, 2);
  assert.ok(Math.abs(tall.y0 - (t.ly - 2.5)) < 1e-9 && Math.abs(tall.y1 - (t.ry + 2.5)) < 1e-9, JSON.stringify(tall));
});

test("hitTest and eraseAt reach the arrow head", () => {
  const arrow = D.createArrow(1000, 5000, 9000, 5000, "#ff0000", 10);
  const { lx, ly, rx, ry } = headBarbs(1000, 5000, 9000, 5000, 10);
  assert.equal(D.hitTest(arrow, Math.round(lx), Math.round(ly), 0), true, "upper barb end");
  assert.equal(D.hitTest(arrow, Math.round(rx), Math.round(ry), 0), true, "lower barb end");
  assert.equal(D.hitTest(arrow, (lx + 9000) / 2, (ly + 5000) / 2, 0), true, "middle of the barb");
  assert.equal(D.hitTest(arrow, lx, ly - 6, 0), false, "beyond the barb by more than w/2");
  assert.deepEqual(D.eraseAt([arrow], Math.round(lx), Math.round(ly), 5), []);
  assert.equal(D.hitTest({ ...arrow, t: "line" }, Math.round(lx), Math.round(ly), 0), false, "lines have no head");
  const t = headBarbs(1000, 5000, 9000, 5000, 10, 2);
  assert.equal(D.hitTest(arrow, t.lx, t.ly, 0, 2), true, "aspect-corrected barb end");
  assert.equal(D.hitTest(arrow, t.lx, t.ly - 4, 0, 2), false, "4 y-units are 8 width-units at aspect 2");
});

test("bounds of text and brawler", () => {
  assert.deepEqual(D.bounds({ t: "text", c: "#000000", x: 5000, y: 5000, z: 100, s: "abcd" }), { x0: 4880, y0: 4950, x1: 5120, y1: 5050 });
  assert.deepEqual(D.bounds({ t: "brawler", n: "Colt", x: 5000, y: 5000, z: 1000 }), { x0: 4500, y0: 4500, x1: 5500, y1: 5500 });
});

test("bounds converts width-relative sizes to y units with the optional aspect (height / width)", () => {
  assert.deepEqual(D.bounds({ t: "brawler", n: "Colt", x: 5000, y: 5000, z: 1000 }, 2), { x0: 4500, y0: 4750, x1: 5500, y1: 5250 });
  assert.deepEqual(D.bounds({ t: "line", c: "#000000", w: 40, p: [0, 0, 100, 100] }, 0.5), { x0: -20, y0: -40, x1: 120, y1: 140 });
  const text = { t: "text", c: "#000000", x: 5000, y: 5000, z: 100, s: "abcd" };
  assert.deepEqual(D.bounds(text, 2), { x0: 4880, y0: 4975, x1: 5120, y1: 5025 });
  assert.deepEqual(D.bounds({ t: "pen", c: "#000000", w: 10, p: [500, 500] }, 2), { x0: 495, y0: 497.5, x1: 505, y1: 502.5 });
});

test("bounds returns null for invalid shapes", () => {
  for (const s of [null, undefined, {}, { t: "pen" }, { ...validPen(), c: "bad" }, "x"]) assert.equal(D.bounds(s), null);
});

// ---------------------------------------------------------------- hitTest

test("hitTest on a line uses radius + w/2, boundary inclusive", () => {
  const line = { t: "line", c: "#000000", w: 20, p: [0, 0, 1000, 0] };
  assert.equal(D.hitTest(line, 500, 15, 5), true);
  assert.equal(D.hitTest(line, 500, 16, 5), false);
  assert.equal(D.hitTest(line, 1015, 0, 5), true, "beyond the end, within the round cap");
  assert.equal(D.hitTest(line, 1016, 0, 5), false);
  assert.equal(D.hitTest({ ...line, t: "arrow" }, 500, 15, 5), true);
  assert.equal(D.hitTest({ ...line, t: "arrow" }, 500, 16, 5), false);
});

test("hitTest on a pen checks every segment and treats one point as a dot", () => {
  const pen = { t: "pen", c: "#000000", w: 10, p: [0, 0, 1000, 0, 1000, 1000] };
  assert.equal(D.hitTest(pen, 1003, 600, 0), true, "second segment");
  assert.equal(D.hitTest(pen, 500, 500, 100), false, "inside the corner but far from both segments");
  const dot = { t: "pen", c: "#000000", w: 10, p: [500, 500] };
  assert.equal(D.hitTest(dot, 503, 504, 0), true);
  assert.equal(D.hitTest(dot, 506, 500, 0), false);
  assert.equal(D.hitTest(dot, 506, 500, 1), true);
});

test("hitTest on text uses its box (expanded by radius) and on a brawler its circle", () => {
  const text = { t: "text", c: "#000000", x: 5000, y: 5000, z: 100, s: "abcd" };
  assert.equal(D.hitTest(text, 5120, 5050, 0), true);
  assert.equal(D.hitTest(text, 5121, 5000, 0), false);
  assert.equal(D.hitTest(text, 5121, 5000, 1), true);
  assert.equal(D.hitTest(text, 5000, 5051, 0), false);
  const b = { t: "brawler", n: "Colt", x: 5000, y: 5000, z: 1000 };
  assert.equal(D.hitTest(b, 5300, 5400, 0), true, "distance exactly 500");
  assert.equal(D.hitTest(b, 5501, 5000, 0), false);
  assert.equal(D.hitTest(b, 5501, 5000, 1), true);
});

test("hitTest honours the aspect ratio so hit areas match what is drawn", () => {
  const b = { t: "brawler", n: "Colt", x: 5000, y: 5000, z: 1000 };
  assert.equal(D.hitTest(b, 5000, 5300, 0), true, "square image");
  assert.equal(D.hitTest(b, 5000, 5300, 0, 2), false, "tall image: 300 y-units are 600 width-units");
  assert.equal(D.hitTest(b, 5000, 5200, 0, 2), true);
  const line = { t: "line", c: "#000000", w: 10, p: [0, 1000, 10000, 1000] };
  assert.equal(D.hitTest(line, 5000, 1010, 0, 0.5), true, "10 y-units are 5 width-units");
  assert.equal(D.hitTest(line, 5000, 1010, 0, 1), false);
  // Text: half height z/2 width-units is 25 y-units at aspect 2.
  const text = { t: "text", c: "#000000", x: 5000, y: 5000, z: 100, s: "abcd" };
  assert.equal(D.hitTest(text, 5000, 5025, 0, 2), true);
  assert.equal(D.hitTest(text, 5000, 4975, 0, 2), true);
  assert.equal(D.hitTest(text, 5000, 5026, 0, 2), false);
  assert.equal(D.hitTest(text, 5000, 4974, 0, 2), false);
  // A one-point pen is a dot of radius w/2 = 5 width-units, i.e. 2.5 y-units at aspect 2.
  const dot = { t: "pen", c: "#000000", w: 10, p: [500, 500] };
  assert.equal(D.hitTest(dot, 500, 502, 0, 2), true);
  assert.equal(D.hitTest(dot, 500, 503, 0, 2), false);
  assert.equal(D.hitTest(dot, 500, 503, 0), true, "square image: 3 units are inside");
  // Most map images are 1.52 times taller than wide.
  assert.equal(D.hitTest(b, 5000, 5450, 0, 1.52), false);
  assert.equal(D.hitTest(b, 5000, 5320, 0, 1.52), true);
});

// The aspect is easy to misplace: topShapeAt takes it after the optional types, so a bare
// number there, or an options object anywhere, must still be honoured instead of ignored.
test("aspect can be given as an options object, or as topShapeAt's fifth argument", () => {
  const b = { t: "brawler", n: "Colt", x: 5000, y: 5000, z: 1000 };
  const txt = { t: "text", c: "#000000", x: 5000, y: 9000, z: 100, s: "go" };
  const shapes = [b, txt];
  assert.equal(D.topShapeAt(shapes, 5000, 5450, 0), 0, "square default");
  assert.equal(D.topShapeAt(shapes, 5000, 5450, 0, 1.52), -1, "number in the types slot is the aspect");
  assert.equal(D.topShapeAt(shapes, 5000, 5450, 0, { aspect: 1.52 }), -1);
  assert.equal(D.topShapeAt(shapes, 5000, 5320, 0, { aspect: 1.52, types: ["brawler"] }), 0);
  assert.equal(D.topShapeAt(shapes, 5000, 5320, 0, { aspect: 1.52, types: ["text"] }), -1);
  assert.equal(D.topShapeAt(shapes, 5000, 5450, 0, ["brawler"], 1.52), -1, "positional form still works");
  assert.equal(D.hitTest(b, 5000, 5450, 0, { aspect: 1.52 }), false);
  assert.deepEqual(D.eraseAt(shapes, 5000, 5450, 0, { aspect: 1.52 }), shapes);
  assert.deepEqual(D.bounds(b, { aspect: 2 }), { x0: 4500, y0: 4750, x1: 5500, y1: 5250 });
  for (const bad of [0, -1, NaN, "2", null, {}, { aspect: "2" }, { aspect: -3 }]) {
    assert.equal(D.hitTest(b, 5000, 5450, 0, bad), true, `bad aspect ${JSON.stringify(bad)} falls back to 1`);
  }
});

test("hitTest returns false for invalid shapes or coordinates and never throws", () => {
  const b = validBrawler();
  assert.equal(D.hitTest(null, 0, 0, 10), false);
  assert.equal(D.hitTest({ t: "pen", p: "x" }, 0, 0, 10), false);
  assert.equal(D.hitTest(b, NaN, 20, 10), false);
  assert.equal(D.hitTest(b, 10, "20", 10), false);
  assert.equal(D.hitTest(b, 10, 20, NaN), true, "bad radius counts as 0");
  assert.equal(D.hitTest(b, 10, 20, -50), true);
});

// ---------------------------------------------------------------- eraseAt / topShapeAt

test("eraseAt removes every shape hit and keeps the rest in order", () => {
  const a = { t: "brawler", n: "A", x: 1000, y: 1000, z: 200 };
  const b = { t: "line", c: "#000000", w: 10, p: [0, 1000, 2000, 1000] };
  const c = { t: "brawler", n: "C", x: 8000, y: 8000, z: 200 };
  const d = { t: "text", c: "#000000", x: 5000, y: 5000, z: 100, s: "hi" };
  const shapes = deepFreeze([a, b, c, d]);
  const out = D.eraseAt(shapes, 1000, 1000, 10);
  assert.deepEqual(out, [c, d]);
  assert.equal(out[0], c, "untouched shapes are the same objects");
  const none = D.eraseAt(shapes, 3000, 3000, 10);
  assert.equal(none, shapes, "a miss returns the same array, so history.push records nothing");
  assert.deepEqual(D.eraseAt(null, 0, 0, 10), []);
  assert.deepEqual(D.eraseAt([null, a], 1000, 1000, 10), [null], "unknown entries are never hit");
});

test("eraseAt passes the aspect ratio through", () => {
  const b = { t: "brawler", n: "Colt", x: 5000, y: 5000, z: 1000 };
  assert.deepEqual(D.eraseAt([b], 5000, 5300, 0), []);
  assert.deepEqual(D.eraseAt([b], 5000, 5300, 0, 2), [b]);
});

test("topShapeAt returns the last (topmost) hit, optionally filtered by type", () => {
  const b1 = { t: "brawler", n: "A", x: 1000, y: 1000, z: 400 };
  const txt = { t: "text", c: "#000000", x: 1000, y: 1000, z: 100, s: "go" };
  const pen = { t: "pen", c: "#000000", w: 50, p: [900, 1000, 1100, 1000] };
  const shapes = [b1, txt, pen];
  assert.equal(D.topShapeAt(shapes, 1000, 1000, 0), 2);
  assert.equal(D.topShapeAt(shapes, 1000, 1000, 0, ["brawler", "text"]), 1);
  assert.equal(D.topShapeAt(shapes, 1000, 1000, 0, ["brawler"]), 0);
  assert.equal(D.topShapeAt(shapes, 1000, 1150, 0), 0, "only the brawler circle reaches here");
  assert.equal(D.topShapeAt(shapes, 9000, 9000, 0), -1);
  assert.equal(D.topShapeAt(shapes, 1000, 1000, 0, []), -1);
  assert.equal(D.topShapeAt(shapes, 1000, 1000, 0, "brawler"), 2, "a non-array filter means all types");
  assert.equal(D.topShapeAt(null, 0, 0, 0), -1);
  assert.equal(D.topShapeAt([b1], 1000, 1150, 0, null, 2), -1, "aspect is the sixth argument");
});

// ---------------------------------------------------------------- moveShape

test("moveShape translates every point type and clamps to 0..10000", () => {
  const pen = deepFreeze({ t: "pen", c: "#000000", w: 5, p: [10, 10, 9990, 50] });
  const moved = D.moveShape(pen, 20, -30);
  // The whole stroke stops at the edge together, so its shape is kept.
  assert.deepEqual(moved, { t: "pen", c: "#000000", w: 5, p: [20, 0, 10000, 40] });
  assert.notEqual(moved, pen);
  assert.deepEqual(D.moveShape({ t: "arrow", c: "#000000", w: 5, p: [0, 0, 100, 100] }, 5.6, 0).p, [6, 0, 106, 100]);
  assert.deepEqual(D.moveShape(validText(), -100, 100), { ...validText(), x: 0, y: 120 });
  assert.deepEqual(D.moveShape(validBrawler(), 20000, 1), { ...validBrawler(), x: 10000, y: 21 });
});

test("moveShape moves strokes rigidly, so dragging against an edge and back restores them", () => {
  const line = { t: "line", c: "#000000", w: 5, p: [100, 100, 5000, 5000] };
  const pushed = D.moveShape(line, -200, 0);
  assert.deepEqual(pushed.p, [0, 100, 4900, 5000]);
  assert.deepEqual(D.moveShape(pushed, 100, 0).p, line.p);
  const pen = { t: "pen", c: "#000000", w: 5, p: [9900, 9950, 9800, 9700, 9990, 9000] };
  let m = pen;
  for (let i = 0; i < 5; i++) m = D.moveShape(m, 300, 300);
  assert.deepEqual(m.p, [9910, 10000, 9810, 9750, 10000, 9050], "stops at the edge without squashing");
  assert.deepEqual(D.moveShape(m, -10, -50).p, pen.p);
  assert.deepEqual(D.moveShape(line, -1e308, 1e308).p, [0, 5100, 4900, 10000]);
  assert.deepEqual(D.moveShape(line, 0.4, -0.4), line);
  for (const s of sampleShapes()) assert.deepEqual(D.normalizeShapes([D.moveShape(s, -99999, 99999)]).shapes.length, 1);
});

test("moveShape treats bad deltas as 0 and returns null for invalid shapes", () => {
  assert.deepEqual(D.moveShape(validBrawler(), NaN, Infinity), validBrawler());
  assert.deepEqual(D.moveShape(validBrawler(), "5", undefined), validBrawler());
  for (const s of [null, {}, { t: "pen", c: "#000000", w: 5, p: [1] }, "x"]) assert.equal(D.moveShape(s, 1, 1), null);
});

test("moveShape output is accepted by normalizeShapes unchanged", () => {
  for (const s of sampleShapes()) {
    const m = D.moveShape(s, 1234, -567);
    assert.deepEqual(D.normalizeShapes([m]).shapes, [m]);
  }
});

// ---------------------------------------------------------------- arrowHead

test("arrowHead places barbs at +/-25 degrees behind the tip", () => {
  const [lx, ly, tx, ty, rx, ry] = D.arrowHead(0, 0, 100, 0, 10);
  assert.equal(tx, 100);
  assert.equal(ty, 0);
  const cos = Math.cos((25 * Math.PI) / 180) * 10;
  const sin = Math.sin((25 * Math.PI) / 180) * 10;
  assert.ok(Math.abs(lx - (100 - cos)) < 1e-9 && Math.abs(ly - -sin) < 1e-9, `left ${lx},${ly}`);
  assert.ok(Math.abs(rx - (100 - cos)) < 1e-9 && Math.abs(ry - sin) < 1e-9, `right ${rx},${ry}`);
  const head = D.arrowHead(10, 20, -50, 300, 37);
  assert.ok(Math.abs(Math.hypot(head[0] - head[2], head[1] - head[3]) - 37) < 1e-9);
  assert.ok(Math.abs(Math.hypot(head[4] - head[2], head[5] - head[3]) - 37) < 1e-9);
});

test("arrowHead puts barbs at the tip for a zero-length arrow and never returns NaN", () => {
  assert.deepEqual(D.arrowHead(5, 6, 5, 6, 30), [5, 6, 5, 6, 5, 6]);
  const bad = D.arrowHead(NaN, undefined, "1", Infinity, NaN);
  assert.equal(bad.length, 6);
  assert.ok(bad.every(Number.isFinite));
});

// ---------------------------------------------------------------- history

test("history undo / redo walk the recorded states", () => {
  const s0 = deepFreeze([]);
  const s1 = deepFreeze([validPen()]);
  const s2 = deepFreeze([validPen(), validText()]);
  const h = D.createHistory(s0);
  assert.equal(h.current(), s0);
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
  assert.equal(h.undo(), null);
  assert.equal(h.redo(), null);
  h.push(s1);
  h.push(s2);
  assert.equal(h.current(), s2);
  assert.equal(h.undo(), s1);
  assert.equal(h.undo(), s0);
  assert.equal(h.undo(), null);
  assert.equal(h.current(), s0);
  assert.equal(h.canRedo(), true);
  assert.equal(h.redo(), s1);
  assert.equal(h.redo(), s2);
  assert.equal(h.redo(), null);
});

test("history push clears redo", () => {
  const h = D.createHistory([]);
  const a = [validPen()];
  const b = [validText()];
  h.push(a);
  h.undo();
  assert.equal(h.canRedo(), true);
  h.push(b);
  assert.equal(h.canRedo(), false);
  assert.equal(h.redo(), null);
  assert.equal(h.current(), b);
  assert.equal(h.undo().length, 0);
});

test("history keeps at most `limit` undo steps", () => {
  const h = D.createHistory([], 3);
  const states = [1, 2, 3, 4, 5].map((i) => Array.from({ length: i }, validBrawler));
  states.forEach((s) => h.push(s));
  assert.equal(h.undo(), states[3]);
  assert.equal(h.undo(), states[2]);
  assert.equal(h.undo(), states[1]);
  assert.equal(h.canUndo(), false);
  assert.equal(h.undo(), null);
  const def = D.createHistory([]);
  for (let i = 0; i < 150; i++) def.push([validPen()]);
  let steps = 0;
  while (def.undo()) steps++;
  assert.equal(steps, 100, "default limit is 100");
});

test("dragging the eraser over empty space adds no undo steps", () => {
  const pen = { t: "pen", c: "#000000", w: 10, p: [100, 100, 200, 200] };
  const keep = { t: "brawler", n: "A", x: 9000, y: 9000, z: 200 };
  const h = D.createHistory([]);
  h.push([pen, keep]);
  for (let i = 0; i < 150; i++) h.push(D.eraseAt(h.current(), 5000, 5000 + i, 20));
  assert.equal(h.undo().length, 0, "one undo reaches the state before the drawing");
  h.redo();
  h.push(D.eraseAt(h.current(), 150, 150, 0));
  assert.deepEqual(h.current(), [keep]);
  assert.deepEqual(h.undo(), [pen, keep]);
});

test("history push ignores a copy that holds the same shapes as the current state", () => {
  const a = validPen();
  const b = validText();
  const h = D.createHistory([a, b]);
  h.push([a, b]);
  h.push([a, b].slice());
  assert.equal(h.canUndo(), false);
  h.push([b, a]);
  assert.equal(h.canUndo(), true, "a reorder is a change");
  h.push([b]);
  assert.equal(h.undo().length, 2);
});

test("history ignores non-array pushes and bad initial values", () => {
  const h = D.createHistory("nope", -1);
  assert.deepEqual(h.current(), []);
  const cur = h.current();
  h.push(null);
  h.push({ length: 0 });
  assert.equal(h.current(), cur);
  assert.equal(h.canUndo(), false);
  h.push(cur);
  assert.equal(h.canUndo(), false, "pushing the current state is a no-op");
  const zero = D.createHistory([], 0);
  zero.push([validPen()]);
  assert.equal(zero.canUndo(), false);
  assert.equal(zero.current().length, 1);
});

// ---------------------------------------------------------------- render

test("render draws every shape type using only the allowed ctx members", () => {
  const { ctx, calls, violations } = fakeCtx();
  const img = { complete: true, naturalWidth: 64 };
  assert.doesNotThrow(() => D.render(ctx, sampleShapes(), 800, 600, { images: new Map([["Shelly", img]]) }));
  assert.deepEqual(violations, []);
  assertBalanced(calls);
  assert.ok(named(calls, "stroke").length >= 3);
  assert.equal(named(calls, "drawImage").length, 1);
  assert.equal(named(calls, "drawImage")[0][1], img);
  assert.ok(named(calls, "fillText").some((c) => c[1] === "Push left 👈"));
});

test("render scales units to pixels for each axis", () => {
  const { ctx, calls } = fakeCtx();
  D.render(ctx, [{ t: "line", c: "#000000", w: 100, p: [0, 0, 10000, 5000] }], 200, 100);
  assert.deepEqual(named(calls, "moveTo")[0], ["moveTo", 0, 0]);
  assert.deepEqual(named(calls, "lineTo")[0], ["lineTo", 200, 50]);
  assert.deepEqual(sets(calls, "lineWidth"), [2], "w is relative to width");
});

test("render uses round caps and joins for pens and the documented font for text", () => {
  const { ctx, calls } = fakeCtx();
  D.render(ctx, [validPen(), { t: "text", c: "#123456", x: 5000, y: 5000, z: 500, s: "hi" }], 1000, 500);
  assert.ok(sets(calls, "lineCap").includes("round"));
  assert.ok(sets(calls, "lineJoin").includes("round"));
  const firstStroke = calls.findIndex((c) => c[0] === "stroke");
  const lastCap = calls.slice(0, firstStroke).filter((c) => c[0] === "set" && c[1] === "lineCap").pop();
  assert.equal(lastCap[2], "round");
  assert.ok(sets(calls, "font").some((f) => f === "bold 50px system-ui, sans-serif"), sets(calls, "font").join("|"));
  const textCall = named(calls, "fillText").filter((c) => c[1] === "hi").pop();
  assert.deepEqual(textCall.slice(2), [500, 250]);
});

test("render draws a single-point pen as a dot", () => {
  const { ctx, calls } = fakeCtx();
  D.render(ctx, [{ t: "pen", c: "#ff0000", w: 100, p: [5000, 5000] }], 1000, 1000);
  const arc = named(calls, "arc")[0];
  assert.deepEqual(arc.slice(1, 4), [500, 500, 5]);
  assert.ok(named(calls, "fill").length >= 1);
  assert.ok(sets(calls, "fillStyle").includes("#ff0000"));
});

test("render draws an arrow head at the tip", () => {
  const { ctx, calls } = fakeCtx();
  D.render(ctx, [{ t: "arrow", c: "#00ff00", w: 20, p: [0, 5000, 10000, 5000] }], 1000, 1000);
  const draw = calls.filter((c) => ["beginPath", "moveTo", "lineTo", "stroke", "fill", "arc"].includes(c[0]));
  assert.deepEqual(draw.map((c) => c[0]), ["beginPath", "moveTo", "lineTo", "stroke", "beginPath", "moveTo", "lineTo", "lineTo", "stroke"]);
  assert.deepEqual(draw[1].slice(1), [0, 500]);
  assert.deepEqual(draw[2].slice(1), [1000, 500]);
  // Head length is 3w+100 units = 160 units = 16px on a 1000px-wide canvas.
  const headLen = 16;
  const expected = D.arrowHead(0, 500, 1000, 500, headLen);
  const head = [draw[5], draw[6], draw[7]].flatMap((c) => c.slice(1));
  head.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-9, `head[${i}] ${v} vs ${expected[i]}`));
  assert.deepEqual(draw[6].slice(1), [1000, 500], "barbs meet at the tip");
  for (const barb of [draw[5], draw[7]]) {
    assert.ok(barb[1] > 1000 - headLen && barb[1] < 1000, `barb x ${barb[1]} sits just behind the tip`);
  }
  assert.ok(draw[5][2] < 500 && draw[7][2] > 500, "one barb on each side");
});

test("render draws a zero-length line or arrow as a dot, never as a zero-length stroke", () => {
  for (const t of ["line", "arrow"]) {
    const { ctx, calls } = fakeCtx();
    D.render(ctx, [{ t, c: "#00ff00", w: 100, p: [5000, 5000, 5000, 5000] }], 1000, 1000);
    assert.equal(named(calls, "stroke").length, 0, t);
    assert.deepEqual(named(calls, "arc").map((c) => c.slice(1, 4)), [[500, 500, 5]], t);
    assert.equal(named(calls, "fill").length, 1, t);
    assert.deepEqual(sets(calls, "fillStyle"), ["#00ff00"], t);
  }
});

const DRAW_CALLS = ["stroke", "fill", "fillText", "drawImage"];
// The globalAlpha in effect at each drawing call, replayed from the recorded assignments.
function alphaAtDraws(calls, initial) {
  let alpha = initial;
  const out = [];
  for (const c of calls) {
    if (c[0] === "set" && c[1] === "globalAlpha") alpha = c[2];
    else if (DRAW_CALLS.includes(c[0])) out.push([c[0], c[1], alpha]);
  }
  return out;
}

test("render restores globalAlpha after the text shadow, for the text and everything after it", () => {
  const shapes = [
    { t: "text", c: "#ffffff", x: 5000, y: 5000, z: 300, s: "first" },
    { t: "pen", c: "#ff0000", w: 20, p: [100, 100, 900, 900] },
    { t: "arrow", c: "#ff0000", w: 20, p: [100, 100, 900, 900] },
    { t: "brawler", n: "Colt", x: 3000, y: 3000, z: 500 },
    { t: "text", c: "#000000", x: 5000, y: 6000, z: 300, s: "second" },
  ];
  for (const callerAlpha of [undefined, 0.5]) {
    const { ctx, calls } = fakeCtx();
    if (callerAlpha !== undefined) ctx.globalAlpha = callerAlpha;
    D.render(ctx, shapes, 1000, 1000, { images: new Map([["Colt", { complete: true, naturalWidth: 64 }]]) });
    const base = callerAlpha === undefined ? 1 : callerAlpha;
    const draws = alphaAtDraws(calls, undefined);
    const texts = draws.filter((d) => d[0] === "fillText");
    assert.equal(texts.length, 4);
    for (const [i, d] of texts.entries()) {
      const want = i % 2 === 0 ? base * 0.7 : base;
      assert.ok(Math.abs(d[2] - want) < 1e-12, `fillText ${d[1]} at alpha ${d[2]}, want ${want}`);
    }
    const shadowIdx = new Set(texts.filter((_, i) => i % 2 === 0).map((d) => draws.indexOf(d)));
    draws.forEach((d, i) => {
      if (shadowIdx.has(i)) return;
      const a = d[2] === undefined ? 1 : d[2];
      assert.ok(Math.abs(a - base) < 1e-12, `${d[0]} #${i} drawn at alpha ${a}, want ${base}`);
    });
  }
});

test("render falls back to a lettered circle when a brawler image is missing or not loaded", () => {
  const cases = [
    undefined,
    { images: new Map() },
    { images: new Map([["élan", { complete: false, naturalWidth: 64 }]]) },
    { images: new Map([["élan", { complete: true, naturalWidth: 0 }]]) },
    { images: new Map([["élan", null]]) },
    { images: { get: () => ({ complete: true, naturalWidth: 10 }) } },
    { images: "not a map" },
  ];
  cases.forEach((opts, i) => {
    const { ctx, calls, violations } = fakeCtx();
    assert.doesNotThrow(() => D.render(ctx, [{ t: "brawler", n: "élan", x: 5000, y: 5000, z: 1000 }], 400, 400, opts));
    assert.deepEqual(violations, []);
    if (i === 5) {
      // A Map-like object with get() is accepted.
      assert.equal(named(calls, "drawImage").length, 1);
      return;
    }
    assert.equal(named(calls, "drawImage").length, 0, `case ${i}`);
    assert.ok(named(calls, "arc").length >= 1);
    assert.ok(named(calls, "fill").length >= 1);
    assert.ok(named(calls, "fillText").some((c) => c[1] === "É"), `case ${i}`);
  });
});

test("render centres the portrait inside the token and keeps the ring within it", () => {
  const img = { complete: true, naturalWidth: 64 };
  for (const [w, h] of [[400, 400], [400, 800]]) {
    const { ctx, calls } = fakeCtx();
    D.render(ctx, [{ t: "brawler", n: "Colt", x: 2500, y: 7500, z: 1000 }], w, h, { images: new Map([["Colt", img]]) });
    const r = (1000 * w) / 10000 / 2;
    const cx = (2500 * w) / 10000;
    const cy = (7500 * h) / 10000;
    const di = named(calls, "drawImage");
    assert.equal(di.length, 1);
    const want = [cx - r / Math.SQRT2, cy - r / Math.SQRT2, r * Math.SQRT2, r * Math.SQRT2];
    di[0].slice(2).forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-9, `drawImage[${i}] ${v} vs ${want[i]}`));
    const arcs = named(calls, "arc");
    assert.ok(arcs.length >= 2);
    for (const a of arcs) {
      assert.deepEqual(a.slice(1, 3), [cx, cy]);
      assert.ok(a[3] > 0 && a[3] <= r, `arc radius ${a[3]} exceeds the token radius ${r}`);
    }
    // The ring is stroked last; its outer edge (radius + half its width) stays on the token.
    const ringArc = arcs[arcs.length - 1];
    const ringWidth = sets(calls, "lineWidth").pop();
    assert.ok(ringArc[3] + ringWidth / 2 <= r + 1e-9, `ring reaches ${ringArc[3] + ringWidth / 2} > ${r}`);
    assert.equal(calls.filter((c) => c[0] !== "set").map((c) => c[0]).slice(-2).join(","), "stroke,restore");
  }
});

test("render only ever assigns validated #rrggbb colors and skips invalid shapes", () => {
  const { ctx, calls, violations } = fakeCtx();
  const evil = [
    { t: "pen", c: "url(javascript:alert(1))", w: 5, p: [1, 2, 3, 4] },
    { t: "text", c: "red", x: 1, y: 1, z: 100, s: "x" },
    { t: "line", c: "#000000", w: 5, p: [1, 2, NaN, 4] },
    { t: "arrow", c: "#000000", w: 5, p: [1, 2] },
    { t: "brawler", n: "", x: 1, y: 1, z: 500 },
    null, 5, "pen", { t: "unknown" },
  ];
  assert.doesNotThrow(() => D.render(ctx, [...evil, ...sampleShapes()], 300, 300));
  assert.deepEqual(violations, []);
  const styles = [...sets(calls, "strokeStyle"), ...sets(calls, "fillStyle")];
  assert.ok(styles.length > 0);
  for (const s of styles) assert.match(s, COLOR_RE);
  assert.ok(!named(calls, "fillText").some((c) => c[1] === "x"), "invalid text was skipped");
  for (const c of calls) {
    for (const v of c.slice(1)) if (typeof v === "number") assert.ok(Number.isFinite(v), `${c[0]} got ${v}`);
  }
});

test("render does not throw on any shape normalizeShapes accepts, including extremes", () => {
  const longPen = { t: "pen", c: "#000000", w: 500, p: Array.from({ length: D.LIMITS.points * 2 }, (_, i) => (i * 37) % 10001) };
  const extremes = D.normalizeShapes([
    longPen,
    { t: "pen", c: "#000000", w: 1, p: [0, 0] },
    { t: "line", c: "#000000", w: 1, p: [0, 0, 0, 0] },
    { t: "arrow", c: "#000000", w: 500, p: [10000, 10000, 10000, 10000] },
    { t: "text", c: "#000000", x: 0, y: 0, z: 50, s: "\u0000\n\t" },
    { t: "text", c: "#000000", x: 10000, y: 10000, z: 2000, s: "x".repeat(200) },
    { t: "brawler", n: "😀 smile", x: 0, y: 10000, z: 3000 },
    { t: "brawler", n: "a", x: 10000, y: 0, z: 100 },
  ]).shapes;
  assert.equal(extremes.length, 8);
  for (const [w, h] of [[1, 1], [4000, 3000], [0.5, 0.5]]) {
    const { ctx, calls, violations } = fakeCtx();
    assert.doesNotThrow(() => D.render(ctx, extremes, w, h));
    assert.deepEqual(violations, []);
    assertBalanced(calls);
  }
});

test("render ignores bad arguments without throwing", () => {
  const { ctx, calls } = fakeCtx();
  assert.doesNotThrow(() => D.render(null, sampleShapes(), 100, 100));
  assert.doesNotThrow(() => D.render(undefined));
  assert.doesNotThrow(() => D.render(ctx, "shapes", 100, 100));
  assert.doesNotThrow(() => D.render(ctx, sampleShapes(), 0, 100));
  assert.doesNotThrow(() => D.render(ctx, sampleShapes(), NaN, 100));
  assert.doesNotThrow(() => D.render(ctx, sampleShapes(), 100, -1));
  assert.doesNotThrow(() => D.render(ctx, sampleShapes(), 100, 100, null));
  assertBalanced(calls);
});

// ---------------------------------------------------------------- encodedLength

test("encodedLength is the JSON length and never throws", () => {
  const shapes = sampleShapes();
  assert.equal(D.encodedLength(shapes), JSON.stringify(shapes).length);
  assert.equal(D.encodedLength([]), 2);
  assert.equal(D.encodedLength(undefined), 0);
  const circular = [];
  circular.push(circular);
  assert.equal(D.encodedLength(circular), Infinity);
  assert.equal(D.encodedLength([10n]), Infinity);
});

// ---------------------------------------------------------------- no-throw sweep

test("no export throws on hostile input", () => {
  const junk = [undefined, null, NaN, -1, 1e308, "", "x", [], {}, [null], Symbol("s"), () => 1, 10n, Object.create(null)];
  const label = (v) => (v !== null && typeof v === "object" && !Object.getPrototypeOf(v) ? "[null-proto]" : String(v));
  const fns = Object.entries(D).filter(([, v]) => typeof v === "function");
  assert.ok(fns.length >= 17, `exports: ${fns.map(([k]) => k).join(",")}`);
  for (const [name, fn] of fns) {
    for (const a of junk) {
      for (const b of junk) {
        assert.doesNotThrow(() => fn(a, b, a, b, a, b), `${name}(${label(a)}, ${label(b)})`);
      }
    }
  }
});

test("module exposes plain JSON-safe values (shapes survive JSON round trip)", () => {
  for (const s of sampleShapes()) assert.deepEqual(plain(s), s);
});
