// Merge Claude-suggested authors into graph.json and seed their works.
// Run: node scripts/merge-graph-additions.mjs graph-additions.json
// Format: {"nodes":[{id,label,type,cluster,note,works:[]}], "links":[["newId","existingId"],...]}

import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
if (!file) { console.error("usage: node scripts/merge-graph-additions.mjs <additions.json>"); process.exit(1); }
const add = JSON.parse(readFileSync(file));
const gURL = new URL("../data/graph.json", import.meta.url);
const wURL = new URL("../data/works.json", import.meta.url);
const g = JSON.parse(readFileSync(gURL));
const works = JSON.parse(readFileSync(wURL));
const have = new Set(g.nodes.map(n => n.id));
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

let added = 0;
for (const n of add.nodes || []) {
  if (have.has(n.id)) { console.warn(`exists: ${n.id}`); continue; }
  if (!g.clusters[n.cluster]) { console.warn(`bad cluster ${n.cluster} on ${n.id}, skipping`); continue; }
  g.nodes.push(n); have.add(n.id); added++;
  works[n.id] = (n.works || []).map(t => ({ id: n.id + "::" + slug(t), title: t, year: null,
    kind: /stories|tales|collection/i.test(t) ? "collection" : "novel",
    desc: "", dims: {}, signals: 0, source: "claude" }));
}
let linked = 0;
for (const [a, b] of add.links || []) {
  if (have.has(a) && have.has(b)) { g.links.push([a, b]); linked++; }
  else console.warn(`bad link ${a}->${b}`);
}
writeFileSync(gURL, JSON.stringify(g, null, 1));
writeFileSync(wURL, JSON.stringify(works, null, 1));
console.log(`added ${added} authors, ${linked} links`);
