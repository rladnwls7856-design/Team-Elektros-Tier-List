/* The tournament map pool: the only maps the sidebar shows. Edit this list when the pool changes.
   Each mode lists its maps in order; the first one is the tiebreaker map.
   A map is its file name in "Brawlstars map/<mode>/" (without ".png"), or { name, label } when the
   tournament spells it differently from the file. tests/mappool.test.js checks every name exists.
   Saved tiers, notes and drawings of maps outside the pool are deleted when a board loads. */
(function (root, data) {
  if (typeof module === "object" && module.exports) module.exports = data;
  else root.BRAWL_MAP_POOL = data;
})(typeof globalThis !== "undefined" ? globalThis : this, {
  modes: [
    { mode: "Bounty", maps: ["Hideout", "Dry Season", "Layer Cake"] },
    { mode: "Heist", maps: ["Kaboom Canyon", "Hot Potato", "Safe Zone"] },
    { mode: "Hot Zone", maps: [{ name: "Ring Of Fire", label: "Ring of Fire" }, "Open Business", "Dueling Beetles"] },
    { mode: "Gem Grab", maps: ["Hard Rock Mine", "Deathcap Trap", "Crystal Arcade"] },
    { mode: "Knockout", maps: [{ name: "Out In The Open", label: "Out in the Open" }, { name: "Belles Rock", label: "Belle’s Rock" }, "Goldarm Gulch"] },
    { mode: "Brawl Ball", maps: ["Pinhole Punt", "Triple Dribble", "Beach Ball"] },
  ],
});
