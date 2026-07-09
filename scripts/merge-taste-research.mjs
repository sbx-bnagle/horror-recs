// Merge a taste-research file into data/works.json.
// Run: node scripts/merge-taste-research.mjs taste-research.json
//
// The research file is produced by Claude in chat (give it your exported
// recommendotron-userdata.json and ask for a refresh). Format:
// { "workId": 0.8, ... }  or  { "workId": { "tasteMatch": 0.8, "signals": 5, "desc": "..." } }
// Values are merged; higher tasteMatch wins, desc only fills blanks.

import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) { console.error("usage: node scripts/merge-taste-research.mjs <research.json>"); process.exit(1); }
const research = JSON.parse(readFileSync(file));
const worksURL = new URL("../data/works.json", import.meta.url);
const works = JSON.parse(readFileSync(worksURL));

let hit = 0, miss = [];
const index = {};
for (const author in works) for (const w of works[author]) index[w.id] = w;

for (const id in research) {
  const w = index[id];
  if (!w) { miss.push(id); continue; }
  const r = typeof research[id] === "number" ? { tasteMatch: research[id] } : research[id];
  if (r.tasteMatch != null) w.tasteMatch = Math.max(w.tasteMatch || 0, r.tasteMatch);
  if (r.signals != null) w.signals = Math.max(w.signals || 0, r.signals);
  if (r.desc && !w.desc) w.desc = r.desc;
  hit++;
}
writeFileSync(worksURL, JSON.stringify(works, null, 1));
console.log(`merged ${hit} entries${miss.length ? `; unknown ids: ${miss.join(", ")}` : ""}`);
