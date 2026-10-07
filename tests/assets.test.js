"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// GitHub Pages caches every file for about ten minutes. A new index.html running against a
// cached older js/storage.js broke the page at boot, so every local asset carries the same
// version query, and that version must change whenever any asset changes.
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const head = html.slice(0, html.indexOf("<script>"));
const refs = [...head.matchAll(/(?:src|href)="((?:js|css)\/[^"]+)"/g)].map((m) => m[1]);

test("every local script and stylesheet is referenced with a version query", () => {
  assert.ok(refs.length >= 5, refs.join(", "));
  for (const ref of refs) assert.match(ref, /\?v=[\w.-]+$/, ref);
});

test("all local assets share one version", () => {
  const versions = new Set(refs.map((r) => r.split("?v=")[1]));
  assert.equal(versions.size, 1, [...versions].join(", "));
});

test("every referenced asset exists", () => {
  for (const ref of refs) assert.ok(fs.existsSync(path.join(__dirname, "..", ref.split("?")[0])), ref);
});
