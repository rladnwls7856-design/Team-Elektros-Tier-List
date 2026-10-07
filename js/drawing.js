/*
 * Team Brawl drawing core — a vector model for annotating map images.
 * Loaded by index.html as a classic script (window.BrawlDrawing) so it also runs from
 * file://, and required by the Node tests. It must stay free of DOM access: render() only
 * talks to the canvas context it is handed.
 *
 * Coordinates are integers 0..COORD_MAX relative to the image (x to its width, y to its
 * height) so a drawing lands on the same spot at any display size. Stroke widths and
 * text/icon sizes use the same unit but relative to the image WIDTH only, so a circle stays
 * a circle instead of stretching with the image's aspect ratio. Functions that measure
 * distances (bounds, hitTest, eraseAt, topShapeAt) therefore need the image's aspect,
 * naturalHeight / naturalWidth. It defaults to 1, which is wrong for most map images
 * (hit areas come out too tall), so callers should always pass it: as a trailing number or
 * as an options object { aspect } (topShapeAt also reads { aspect, types } there).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BrawlDrawing = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const COORD_MAX = 10000;
  // Drawings live in localStorage and share links next to the board, so every dimension
  // that grows the encoded size is capped. A freehand stroke rarely needs more than a few
  // hundred points after simplification. The per-shape caps still multiply out to millions
  // of points per image, which no storage quota holds and which takes seconds to render, so
  // totalPoints bounds the whole image (a point costs up to 12 JSON chars).
  const LIMITS = Object.freeze({ shapes: 2000, points: 2000, text: 200, totalPoints: 20000 });
  const RANGES = Object.freeze({
    w: Object.freeze([1, 500]),
    textSize: Object.freeze([50, 2000]),
    brawlerSize: Object.freeze([100, 3000]),
    // Matches storage.js MAX_IMPORT_NAME_LENGTH so any brawler key it accepts fits here.
    name: Object.freeze([1, 100]),
  });
  // In units: 8 is under 1px on a 1000px-wide image, invisible but drops pointer jitter.
  const DEFAULT_TOLERANCE = 8;
  // Exact simplification costs up to (input points x LIMITS.points) on a stroke whose
  // every vertex matters (about 0.1 s at this size), so createPen sends longer input
  // straight to the balanced reduction, whose splits stay near the middle.
  const RAW_POINT_CAP = LIMITS.points * 4;
  const DEFAULT_HISTORY_LIMIT = 100;
  // Colors end up in canvas styles; only #rrggbb can reach them, never names or url().
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  const TYPES = Object.freeze(["pen", "line", "arrow", "text", "brawler"]);
  const ARROW_ANGLE = (25 * Math.PI) / 180;
  const TAU = Math.PI * 2;
  // Below 1px a stroke or glyph vanishes on small previews; visible beats exact there.
  const MIN_PX = 1;
  const TOKEN_BG = "#1b1f2e";
  const TOKEN_RING = "#ffffff";
  const LETTER_COLOR = "#ffffff";
  // Dark enough for a white letter to stay readable on every entry.
  const FALLBACK_COLORS = ["#b91c1c", "#c2410c", "#a16207", "#15803d", "#0f766e", "#1d4ed8", "#6d28d9", "#be185d"];
  const CTX_METHODS = ["save", "restore", "beginPath", "moveTo", "lineTo", "arc", "stroke", "fill", "fillText", "drawImage", "closePath"];

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  // Inherited values never count: shapes come from JSON, where every real field is own.
  const own = (o, k) => (hasOwn(o, k) ? o[k] : undefined);
  const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const isUnit = (v) => Number.isInteger(v) && v >= 0 && v <= COORD_MAX;
  const inRange = (v, range) => Number.isInteger(v) && v >= range[0] && v <= range[1];
  const isColor = (v) => typeof v === "string" && COLOR_RE.test(v);
  const isLabel = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
  const aspectOf = (a) => (isNum(a) && a > 0 ? a : 1);
  // Accepts the aspect itself or an options object carrying it.
  const aspectArg = (v) => aspectOf(isPlainObject(v) ? own(v, "aspect") : v);
  const toleranceOf = (t) => (isNum(t) && t > 0 ? t : 0);

  function quantize(v) {
    // Math.max turns -0 into +0, so no shape ever carries a negative zero.
    return isNum(v) ? Math.min(COORD_MAX, Math.max(0, Math.round(v))) : 0;
  }

  // Not clamped: callers also convert drag deltas, which are legitimately negative.
  function toUnit(px, sizePx) {
    if (!isNum(px) || !isNum(sizePx) || sizePx <= 0) return 0;
    const u = Math.round((px / sizePx) * COORD_MAX);
    return Number.isFinite(u) ? u + 0 : 0;
  }

  function fromUnit(u, sizePx) {
    if (!isNum(u) || !isNum(sizePx) || sizePx <= 0) return 0;
    const px = (u * sizePx) / COORD_MAX;
    return Number.isFinite(px) ? px : 0;
  }

  // Sizes come from sliders and pixel conversions, so they are rounded rather than rejected
  // for being fractional; only out-of-range values are invalid.
  function sizeIn(v, range) {
    if (!isNum(v)) return null;
    const r = Math.round(v);
    return r >= range[0] && r <= range[1] ? r : null;
  }

  function segDist2(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    // Measured to the segment, not the infinite line: a closed loop has first == last.
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + t * dx - px;
    const qy = ay + t * dy - py;
    return qx * qx + qy * qy;
  }

  // Ramer–Douglas–Peucker with an explicit stack: an unlucky stroke splits off one point
  // per level, and recursion would then overflow at a few thousand points. Returns the
  // kept-point mask, or null as soon as more than maxKeep points would be kept, which
  // bounds the work when the caller has a cap anyway.
  function rdpMask(xy, n, tol2, maxKeep) {
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    let kept = 2;
    const stack = [0, n - 1];
    while (stack.length) {
      const e = stack.pop();
      const s = stack.pop();
      const ax = xy[2 * s];
      const ay = xy[2 * s + 1];
      const dx = xy[2 * e] - ax;
      const dy = xy[2 * e + 1] - ay;
      const len2 = dx * dx + dy * dy;
      let best = -1;
      let idx = -1;
      // segDist2 inlined with the segment terms hoisted: this loop is the whole cost.
      for (let i = s + 1; i < e; i++) {
        const px = xy[2 * i] - ax;
        const py = xy[2 * i + 1] - ay;
        let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = t * dx - px;
        const qy = t * dy - py;
        const d = qx * qx + qy * qy;
        if (d > best) {
          best = d;
          idx = i;
        }
      }
      if (idx === -1 || !(best > tol2)) continue;
      keep[idx] = 1;
      if (++kept > maxKeep) return null;
      if (idx - s > 1) stack.push(s, idx);
      if (e - idx > 1) stack.push(idx, e);
    }
    return keep;
  }

  const pickKept = (flat, keep) => {
    const out = [];
    for (let i = 0; i < keep.length; i++) if (keep[i]) out.push(flat[2 * i], flat[2 * i + 1]);
    return out;
  };

  function simplify(flat, tolerance) {
    if (!Array.isArray(flat)) return [];
    const n = Math.floor(flat.length / 2);
    if (n <= 2) return flat.slice(0, n * 2);
    // A typed copy keeps the hot loop monomorphic whatever mix of values the caller passed;
    // non-numbers become NaN, which never wins the max and so is simply dropped.
    const xy = new Float64Array(n * 2);
    for (let i = 0; i < n * 2; i++) xy[i] = typeof flat[i] === "number" ? flat[i] : NaN;
    return pickKept(flat, rdpMask(xy, n, toleranceOf(tolerance) ** 2, Infinity));
  }

  // Drops points within `tol` of the last kept one, in one pass. Each dropped point stays
  // within tol of the result, so this costs no visible detail; even sampling would, and
  // it aliases a regular scribble into a straight line when the step matches its period.
  function radialFilter(pts, tol) {
    if (!(tol > 0)) return pts;
    const t2 = tol * tol;
    const last = pts.length - 2;
    const out = [pts[0], pts[1]];
    for (let i = 2; i < last; i += 2) {
      const dx = pts[i] - out[out.length - 2];
      const dy = pts[i + 1] - out[out.length - 1];
      if (dx * dx + dy * dy > t2) out.push(pts[i], pts[i + 1]);
    }
    if (out[out.length - 2] !== pts[last] || out[out.length - 1] !== pts[last + 1]) out.push(pts[last], pts[last + 1]);
    return out;
  }

  // Best-first RDP down to at most `target` points, for strokes that keep too many points at
  // the requested tolerance. Raising one global tolerance instead is all-or-nothing on an
  // even scribble: every corner deviates about equally, so all of them survive until none
  // do. Here the most deviating segment is always split next, and among points deviating at
  // least half as much as the worst one the split takes the one nearest the segment's
  // middle, so equally important corners are thinned evenly along the whole stroke instead
  // of being kept from one end until the budget runs out.
  function reduceTo(pts, tol2, target) {
    const n = pts.length / 2;
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    const dist = new Float64Array(n);
    // Max-heap of [deviation², span, start, end, split]; ties go to the longer segment,
    // which turns an even scribble into a breadth-first, uniform subdivision.
    const heap = [];
    const above = (u, v) => u[0] > v[0] || (u[0] === v[0] && (u[1] > v[1] || (u[1] === v[1] && u[2] < v[2])));
    const swap = (i, j) => {
      const t = heap[i];
      heap[i] = heap[j];
      heap[j] = t;
    };
    const push = (e) => {
      let i = heap.push(e) - 1;
      while (i > 0 && above(heap[i], heap[(i - 1) >> 1])) {
        swap(i, (i - 1) >> 1);
        i = (i - 1) >> 1;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        for (let i = 0; ; ) {
          const l = 2 * i + 1;
          let m = i;
          if (l < heap.length && above(heap[l], heap[m])) m = l;
          if (l + 1 < heap.length && above(heap[l + 1], heap[m])) m = l + 1;
          if (m === i) break;
          swap(i, m);
          i = m;
        }
      }
      return top;
    };
    const consider = (s, e) => {
      if (e - s < 2) return;
      const ax = pts[2 * s];
      const ay = pts[2 * s + 1];
      const dx = pts[2 * e] - ax;
      const dy = pts[2 * e + 1] - ay;
      const len2 = dx * dx + dy * dy;
      let best = 0;
      for (let i = s + 1; i < e; i++) {
        const px = pts[2 * i] - ax;
        const py = pts[2 * i + 1] - ay;
        let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = t * dx - px;
        const qy = t * dy - py;
        dist[i] = qx * qx + qy * qy;
        if (dist[i] > best) best = dist[i];
      }
      if (!(best > tol2)) return;
      // Squared distances: a quarter of the squared maximum is half the deviation. The
      // maximum itself always qualifies, since it exceeds both bounds.
      const floor = Math.max(best / 4, tol2);
      const mid = (s + e) / 2;
      let idx = -1;
      let gap = Infinity;
      for (let i = s + 1; i < e; i++) {
        const g = Math.abs(i - mid);
        if (dist[i] > floor && g < gap) {
          idx = i;
          gap = g;
        }
      }
      push([best, e - s, s, e, idx]);
    };
    consider(0, n - 1);
    for (let kept = 2; kept < target && heap.length; kept++) {
      const [, , s, e, idx] = pop();
      keep[idx] = 1;
      consider(s, idx);
      consider(idx, e);
    }
    return pickKept(pts, keep);
  }

  function createPen(rawFlatPoints, color, width, tolerance = DEFAULT_TOLERANCE) {
    if (!Array.isArray(rawFlatPoints) || !isColor(color)) return null;
    const w = sizeIn(width, RANGES.w);
    if (w === null) return null;
    let pts = [];
    for (let i = 0; i + 1 < rawFlatPoints.length; i += 2) {
      const x = rawFlatPoints[i];
      const y = rawFlatPoints[i + 1];
      if (!isNum(x) || !isNum(y)) continue;
      const qx = quantize(x);
      const qy = quantize(y);
      const k = pts.length;
      if (k && pts[k - 2] === qx && pts[k - 1] === qy) continue;
      pts.push(qx, qy);
    }
    if (!pts.length) return null;
    const tol = toleranceOf(tolerance);
    // Only very long input takes the faster path, so ordinary strokes are exactly
    // simplify(pts, tol), or its balanced reduction when that keeps too many points.
    if (pts.length > RAW_POINT_CAP * 2) pts = radialFilter(pts, tol);
    const n = pts.length / 2;
    if (n <= 2) return { t: "pen", c: color, w, p: pts };
    const keep = n <= RAW_POINT_CAP ? rdpMask(Float64Array.from(pts), n, tol * tol, LIMITS.points) : null;
    return { t: "pen", c: color, w, p: keep ? pickKept(pts, keep) : reduceTo(pts, tol * tol, LIMITS.points) };
  }

  function createSegment(t, x0, y0, x1, y1, color, width) {
    if (![x0, y0, x1, y1].every(isNum) || !isColor(color)) return null;
    const w = sizeIn(width, RANGES.w);
    if (w === null) return null;
    return { t, c: color, w, p: [quantize(x0), quantize(y0), quantize(x1), quantize(y1)] };
  }

  const createLine = (x0, y0, x1, y1, color, width) => createSegment("line", x0, y0, x1, y1, color, width);
  const createArrow = (x0, y0, x1, y1, color, width) => createSegment("arrow", x0, y0, x1, y1, color, width);

  // Oversized text is refused rather than truncated so the user sees nothing silently lost.
  function createText(x, y, text, color, size) {
    if (!isNum(x) || !isNum(y) || !isColor(color) || !isLabel(text, LIMITS.text)) return null;
    const z = sizeIn(size, RANGES.textSize);
    if (z === null) return null;
    return { t: "text", c: color, x: quantize(x), y: quantize(y), z, s: text };
  }

  function createBrawler(x, y, name, size) {
    if (!isNum(x) || !isNum(y) || !isLabel(name, RANGES.name[1])) return null;
    const z = sizeIn(size, RANGES.brawlerSize);
    if (z === null) return null;
    return { t: "brawler", n: name, x: quantize(x), y: quantize(y), z };
  }

  function isPointList(p, minLen, maxLen) {
    if (!Array.isArray(p) || p.length < minLen || p.length > maxLen || p.length % 2) return false;
    for (let i = 0; i < p.length; i++) if (!isUnit(p[i])) return false;
    return true;
  }

  // Exactly the rules the create* functions enforce, so their output always passes and
  // anything they could not have produced is refused.
  function isValidShape(s) {
    if (!isPlainObject(s)) return false;
    switch (own(s, "t")) {
      case "pen":
        return isColor(own(s, "c")) && inRange(own(s, "w"), RANGES.w) && isPointList(own(s, "p"), 2, LIMITS.points * 2);
      case "line":
      case "arrow":
        return isColor(own(s, "c")) && inRange(own(s, "w"), RANGES.w) && isPointList(own(s, "p"), 4, 4);
      case "text":
        return isColor(own(s, "c")) && isUnit(own(s, "x")) && isUnit(own(s, "y")) &&
          inRange(own(s, "z"), RANGES.textSize) && isLabel(own(s, "s"), LIMITS.text);
      case "brawler":
        return isLabel(own(s, "n"), RANGES.name[1]) && isUnit(own(s, "x")) && isUnit(own(s, "y")) &&
          inRange(own(s, "z"), RANGES.brawlerSize);
      default:
        return false;
    }
  }

  // Fresh objects with only the documented keys, in the order create* uses, so the JSON of
  // a round-tripped drawing is byte-identical.
  function copyShape(s) {
    switch (s.t) {
      case "text":
        return { t: "text", c: s.c, x: s.x, y: s.y, z: s.z, s: s.s };
      case "brawler":
        return { t: "brawler", n: s.n, x: s.x, y: s.y, z: s.z };
      default:
        return { t: s.t, c: s.c, w: s.w, p: s.p.slice() };
    }
  }

  // What a valid shape costs against LIMITS.totalPoints: the points it stores.
  const pointsOf = (s) => (s.t === "pen" ? s.p.length / 2 : s.p ? 2 : 1);

  function pointCount(shapes) {
    if (!Array.isArray(shapes)) return isValidShape(shapes) ? pointsOf(shapes) : 0;
    let total = 0;
    for (const s of shapes) if (isValidShape(s)) total += pointsOf(s);
    return total;
  }

  // A shape that would overflow the point budget is dropped but later, smaller ones may
  // still fit, so as much of a foreign drawing as possible survives.
  function normalizeShapes(raw) {
    if (raw === undefined) return { shapes: [], dropped: 0 };
    if (!Array.isArray(raw)) return { shapes: [], dropped: 1 };
    const shapes = [];
    let budget = LIMITS.totalPoints;
    for (let i = 0; i < raw.length && shapes.length < LIMITS.shapes && budget > 0; i++) {
      const s = raw[i];
      if (!isValidShape(s)) continue;
      const cost = pointsOf(s);
      if (cost > budget) continue;
      budget -= cost;
      shapes.push(copyShape(s));
    }
    return { shapes, dropped: raw.length - shapes.length };
  }

  // Half extents in width units; the vertical one is converted to y units by the caller.
  const textHalfWidth = (s) => (s.s.length * s.z * 3) / 10;
  // Head grows with the stroke but keeps a floor so thin arrows still read as arrows.
  const arrowHeadUnits = (w) => 3 * w + 100;
  // The head render() draws, in width units on both axes (y multiplied by the aspect),
  // because the 25° barbs are true angles on screen, not in the stretched unit space.
  const headOf = (s, a) => arrowHead(s.p[0], s.p[1] * a, s.p[2], s.p[3] * a, arrowHeadUnits(s.w));

  function bounds(shape, aspect) {
    if (!isValidShape(shape)) return null;
    const a = aspectArg(aspect);
    if (shape.t === "text") {
      const hw = textHalfWidth(shape);
      const hh = shape.z / 2 / a;
      return { x0: shape.x - hw, y0: shape.y - hh, x1: shape.x + hw, y1: shape.y + hh };
    }
    if (shape.t === "brawler") {
      const r = shape.z / 2;
      return { x0: shape.x - r, y0: shape.y - r / a, x1: shape.x + r, y1: shape.y + r / a };
    }
    const p = shape.p;
    let x0 = p[0];
    let y0 = p[1];
    let x1 = p[0];
    let y1 = p[1];
    for (let i = 2; i < p.length; i += 2) {
      if (p[i] < x0) x0 = p[i];
      if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1];
      if (p[i + 1] > y1) y1 = p[i + 1];
    }
    if (shape.t === "arrow") {
      const h = headOf(shape, a);
      for (const k of [0, 4]) {
        x0 = Math.min(x0, h[k]);
        x1 = Math.max(x1, h[k]);
        y0 = Math.min(y0, h[k + 1] / a);
        y1 = Math.max(y1, h[k + 1] / a);
      }
    }
    const r = shape.w / 2;
    return { x0: x0 - r, y0: y0 - r / a, x1: x1 + r, y1: y1 + r / a };
  }

  // Distances are measured with y scaled by the aspect ratio so they are in width units on
  // both axes, matching how sizes are drawn; otherwise hit areas would be ellipses.
  function hitTest(shape, x, y, radius, aspect) {
    if (!isValidShape(shape) || !isNum(x) || !isNum(y)) return false;
    const r = isNum(radius) && radius > 0 ? radius : 0;
    const a = aspectArg(aspect);
    const py = y * a;
    if (shape.t === "text") {
      const dx = Math.max(Math.abs(x - shape.x) - textHalfWidth(shape), 0);
      const dy = Math.max(Math.abs(py - shape.y * a) - shape.z / 2, 0);
      return dx * dx + dy * dy <= r * r;
    }
    if (shape.t === "brawler") {
      const dx = x - shape.x;
      const dy = py - shape.y * a;
      const reach = shape.z / 2 + r;
      return dx * dx + dy * dy <= reach * reach;
    }
    const reach = r + shape.w / 2;
    const reach2 = reach * reach;
    const p = shape.p;
    if (p.length === 2) return segDist2(x, py, p[0], p[1] * a, p[0], p[1] * a) <= reach2;
    for (let i = 0; i + 3 < p.length; i += 2) {
      if (segDist2(x, py, p[i], p[i + 1] * a, p[i + 2], p[i + 3] * a) <= reach2) return true;
    }
    if (shape.t !== "arrow") return false;
    // A zero-length arrow has its barbs at the tip, which the dot test above covered.
    const h = headOf(shape, a);
    return segDist2(x, py, h[0], h[1], h[2], h[3]) <= reach2 || segDist2(x, py, h[4], h[5], h[2], h[3]) <= reach2;
  }

  // Whole shapes only: in a vector model there are no pixels to erase partially. A miss
  // returns the input itself so history.push can tell that nothing changed.
  function eraseAt(shapes, x, y, radius, aspect) {
    if (!Array.isArray(shapes)) return [];
    const out = shapes.filter((s) => !hitTest(s, x, y, radius, aspect));
    return out.length === shapes.length ? shapes : out;
  }

  // The fifth argument may be the types array, an options object { types, aspect }, or the
  // aspect itself: a number there is never a type filter, so it cannot be meant as one.
  function topShapeAt(shapes, x, y, radius, types, aspect) {
    if (!Array.isArray(shapes)) return -1;
    let only = Array.isArray(types) ? types : null;
    let a = aspect;
    if (isNum(types)) a = types;
    else if (isPlainObject(types)) {
      const t = own(types, "types");
      only = Array.isArray(t) ? t : null;
      a = own(types, "aspect");
    }
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (only && !(isPlainObject(s) && only.includes(own(s, "t")))) continue;
      if (hitTest(s, x, y, radius, a)) return i;
    }
    return -1;
  }

  // Rounds the delta and limits it so every point stays in range; clamping each point on
  // its own would squash a stroke dragged against an edge, and dragging back would not
  // restore it.
  const clampDelta = (d, lo, hi) => (isNum(d) ? Math.min(COORD_MAX - hi, Math.max(-lo, Math.round(d))) : 0);

  function moveShape(shape, dx, dy) {
    if (!isValidShape(shape)) return null;
    const out = copyShape(shape);
    if (!out.p) {
      out.x += clampDelta(dx, out.x, out.x);
      out.y += clampDelta(dy, out.y, out.y);
      return out;
    }
    const p = out.p;
    let x0 = p[0];
    let x1 = p[0];
    let y0 = p[1];
    let y1 = p[1];
    for (let i = 2; i < p.length; i += 2) {
      x0 = Math.min(x0, p[i]);
      x1 = Math.max(x1, p[i]);
      y0 = Math.min(y0, p[i + 1]);
      y1 = Math.max(y1, p[i + 1]);
    }
    const mx = clampDelta(dx, x0, x1);
    const my = clampDelta(dy, y0, y1);
    for (let i = 0; i < p.length; i += 2) {
      p[i] += mx;
      p[i + 1] += my;
    }
    return out;
  }

  // Works in whatever space it is given; render() calls it in pixels so the 25° barbs are
  // true angles on screen even when the image is not square.
  function arrowHead(x0, y0, x1, y1, size) {
    const n = (v) => (isNum(v) ? v : 0);
    const ax = n(x0);
    const ay = n(y0);
    const bx = n(x1);
    const by = n(y1);
    const len = isNum(size) && size > 0 ? size : 0;
    const dx = ax - bx;
    const dy = ay - by;
    if ((dx === 0 && dy === 0) || len === 0) return [bx, by, bx, by, bx, by];
    const back = Math.atan2(dy, dx);
    const fin = (v, fallback) => (Number.isFinite(v) ? v : fallback);
    return [
      fin(bx + len * Math.cos(back + ARROW_ANGLE), bx), fin(by + len * Math.sin(back + ARROW_ANGLE), by),
      bx, by,
      fin(bx + len * Math.cos(back - ARROW_ANGLE), bx), fin(by + len * Math.sin(back - ARROW_ANGLE), by),
    ];
  }

  // Shapes are immutable, so the same objects in the same order mean the same drawing.
  function sameShapes(a, b) {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // `limit` counts undo steps. States are stored by reference and never mutated, so callers
  // must build a new array for every change (which they do anyway to keep shapes immutable).
  function createHistory(initialShapes, limit = DEFAULT_HISTORY_LIMIT) {
    const max = Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_HISTORY_LIMIT;
    const states = [Array.isArray(initialShapes) ? initialShapes : []];
    let index = 0;
    return {
      current() {
        return states[index];
      },
      push(nextShapes) {
        // Recording the current state again would add an undo step that changes nothing,
        // and pointermove handlers push on every event, so empty steps would evict real ones.
        if (!Array.isArray(nextShapes) || sameShapes(nextShapes, states[index])) return states[index];
        states.length = index + 1;
        states.push(nextShapes);
        if (states.length > max + 1) states.splice(0, states.length - max - 1);
        index = states.length - 1;
        return nextShapes;
      },
      undo() {
        if (index === 0) return null;
        index--;
        return states[index];
      },
      redo() {
        if (index >= states.length - 1) return null;
        index++;
        return states[index];
      },
      canUndo() {
        return index > 0;
      },
      canRedo() {
        return index < states.length - 1;
      },
    };
  }

  const round2 = (v) => Math.round(v * 100) / 100;
  const fontFor = (px) => `bold ${round2(px)}px system-ui, sans-serif`;

  function isContext(ctx) {
    if (ctx === null || typeof ctx !== "object") return false;
    for (const m of CTX_METHODS) if (typeof ctx[m] !== "function") return false;
    return true;
  }

  // A shadow in the opposite lightness keeps any text color readable on a busy map.
  function shadowFor(color) {
    const v = parseInt(color.slice(1), 16);
    const luma = 0.299 * (v >> 16) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255);
    return luma > 140 ? "#000000" : "#ffffff";
  }

  function fallbackColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return FALLBACK_COLORS[h % FALLBACK_COLORS.length];
  }

  function readyImage(images, name) {
    if (!images) return null;
    let img;
    try {
      img = images.get(name);
    } catch (_) {
      return null;
    }
    return img && typeof img === "object" && img.complete === true && isNum(img.naturalWidth) && img.naturalWidth > 0 ? img : null;
  }

  function isDot(p) {
    for (let i = 2; i < p.length; i += 2) if (p[i] !== p[0] || p[i + 1] !== p[1]) return false;
    return true;
  }

  function drawPath(ctx, s, v) {
    const p = s.p;
    const lw = Math.max(MIN_PX, v.S(s.w));
    // Canvas prunes zero-length segments, so a tap would otherwise draw nothing.
    if (isDot(p)) {
      ctx.beginPath();
      ctx.arc(v.X(p[0]), v.Y(p[1]), lw / 2, 0, TAU);
      ctx.fillStyle = s.c;
      ctx.fill();
      return;
    }
    ctx.strokeStyle = s.c;
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(v.X(p[0]), v.Y(p[1]));
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(v.X(p[i]), v.Y(p[i + 1]));
    ctx.stroke();
    if (s.t !== "arrow") return;
    const h = arrowHead(v.X(p[0]), v.Y(p[1]), v.X(p[2]), v.Y(p[3]), v.S(arrowHeadUnits(s.w)));
    ctx.beginPath();
    ctx.moveTo(h[0], h[1]);
    ctx.lineTo(h[2], h[3]);
    ctx.lineTo(h[4], h[5]);
    ctx.stroke();
  }

  function drawText(ctx, s, v, alpha) {
    const px = Math.max(MIN_PX, v.S(s.z));
    const x = v.X(s.x);
    const y = v.Y(s.y);
    const off = Math.max(1, px * 0.06);
    ctx.font = fontFor(px);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.globalAlpha = alpha * 0.7;
    ctx.fillStyle = shadowFor(s.c);
    ctx.fillText(s.s, x + off, y + off);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = s.c;
    ctx.fillText(s.s, x, y);
  }

  function drawBrawler(ctx, s, v, images) {
    const r = Math.max(MIN_PX, v.S(s.z) / 2);
    const cx = v.X(s.x);
    const cy = v.Y(s.y);
    const img = readyImage(images, s.n);
    const disc = (color) => {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.fillStyle = color;
      ctx.fill();
    };
    let drawn = false;
    if (img) {
      disc(TOKEN_BG);
      // Inscribed square: the allowed ctx members include no clip(), so the portrait's
      // corners must already sit inside the circle (they end under the ring).
      const side = r * Math.SQRT2;
      try {
        ctx.drawImage(img, cx - side / 2, cy - side / 2, side, side);
        drawn = true;
      } catch (_) {
        // A broken or foreign image-like object must not stop the rest of the drawing.
      }
    }
    if (!drawn) {
      disc(fallbackColor(s.n));
      ctx.fillStyle = LETTER_COLOR;
      ctx.font = fontFor(r);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String.fromCodePoint(s.n.codePointAt(0)).toUpperCase(), cx, cy);
    }
    const ring = Math.max(MIN_PX, r * 0.12);
    ctx.beginPath();
    ctx.arc(cx, cy, r - ring / 2, 0, TAU);
    ctx.lineWidth = ring;
    ctx.strokeStyle = TOKEN_RING;
    ctx.stroke();
  }

  // Shapes are re-validated here because render() may receive state that never went
  // through normalizeShapes; an invalid one is skipped, so only #rrggbb reaches a style.
  function render(ctx, shapes, widthPx, heightPx, opts) {
    if (!isContext(ctx) || !Array.isArray(shapes)) return;
    if (!isNum(widthPx) || !isNum(heightPx) || widthPx <= 0 || heightPx <= 0) return;
    const images = opts && typeof opts === "object" && opts.images && typeof opts.images.get === "function" ? opts.images : null;
    const v = {
      X: (u) => (u * widthPx) / COORD_MAX,
      Y: (u) => (u * heightPx) / COORD_MAX,
      S: (u) => (u * widthPx) / COORD_MAX,
    };
    ctx.save();
    try {
      // Respects an alpha the caller set (e.g. a translucent preview layer).
      const alpha = isNum(ctx.globalAlpha) ? ctx.globalAlpha : 1;
      for (const s of shapes) {
        if (!isValidShape(s)) continue;
        if (s.t === "text") drawText(ctx, s, v, alpha);
        else if (s.t === "brawler") drawBrawler(ctx, s, v, images);
        else drawPath(ctx, s, v);
      }
    } finally {
      ctx.restore();
    }
  }

  // Unserialisable input cannot be stored at all, so it reports an infinite size and
  // fails any storage budget check instead of passing it.
  function encodedLength(shapes) {
    try {
      const json = JSON.stringify(shapes);
      return typeof json === "string" ? json.length : 0;
    } catch (_) {
      return Infinity;
    }
  }

  return {
    COORD_MAX,
    LIMITS,
    RANGES,
    TYPES,
    isColor,
    quantize,
    toUnit,
    fromUnit,
    simplify,
    createPen,
    createLine,
    createArrow,
    createText,
    createBrawler,
    normalizeShapes,
    pointCount,
    bounds,
    hitTest,
    eraseAt,
    topShapeAt,
    moveShape,
    arrowHead,
    createHistory,
    render,
    encodedLength,
  };
});
