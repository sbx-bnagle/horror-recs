// Generate worker/seed.sql from the data/*.json files (one-time D1 seed).
// Run: node scripts/make-seed-sql.mjs [--sync-works]   then:
// --sync-works purges seed/openlibrary rows first so local deletions propagate
// (works added via the app - source release/claude - are preserved). Then: wrangler d1 execute recommendotron --remote --file=worker/seed.sql
import { readFileSync, writeFileSync } from "node:fs";
const g = JSON.parse(readFileSync(new URL("../data/graph.json", import.meta.url)));
const works = JSON.parse(readFileSync(new URL("../data/works.json", import.meta.url)));
const q = v => v == null ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'";
const out = [];
if (process.argv.includes("--sync-works"))
  out.push("DELETE FROM works WHERE source IN ('seed','openlibrary');");
out.push(`INSERT OR REPLACE INTO kv(key,value) VALUES('clusters',${q(JSON.stringify(g.clusters))});`);
for (const n of g.nodes)
  out.push(`INSERT OR IGNORE INTO nodes(id,label,type,cluster,note) VALUES(${q(n.id)},${q(n.label)},${q(n.type)},${q(n.cluster)},${q(n.note||"")});`);
for (const [a,b] of g.links)
  out.push(`INSERT OR IGNORE INTO links(a,b) VALUES(${q(a)},${q(b)});`);
for (const author in works) for (const w of works[author])
  out.push(`INSERT OR IGNORE INTO works(id,author,title,year,kind,desc,dims,signals,tasteMatch,source,cover) VALUES(${q(w.id)},${q(author)},${q(w.title)},${w.year||"NULL"},${q(w.kind)},${q(w.desc||"")},${q(JSON.stringify(w.dims||{}))},${w.signals||0},${w.tasteMatch||0},${q(w.source||"seed")},${q(w.cover||null)});`);
writeFileSync(new URL("../worker/seed.sql", import.meta.url), out.join("\n"));
console.log(`wrote ${out.length} statements to worker/seed.sql`);
