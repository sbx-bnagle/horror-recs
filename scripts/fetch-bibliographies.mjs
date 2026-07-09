// Expand data/works.json toward full bibliographies using Open Library.
// Run: node scripts/fetch-bibliographies.mjs --all
//      node scripts/fetch-bibliographies.mjs barron mcdowell tuttle
// Merges by title; never overwrites desc/dims/signals you've already set.

import { readFileSync, writeFileSync } from "node:fs";

const graph = JSON.parse(readFileSync(new URL("../data/graph.json", import.meta.url)));
const worksURL = new URL("../data/works.json", import.meta.url);
const works = JSON.parse(readFileSync(worksURL));

const args = process.argv.slice(2);
const targets = args.includes("--all")
  ? graph.nodes.filter(n => n.type === "influence" || n.type === "rec").map(n => n.id)
  : args;

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const canon = s => s.toLowerCase().replace(/[:(].*$/, "").replace(/^(the|a|an)\s+/, "").replace(/[^a-z0-9]/g, "");
const JUNK = /brewing|cookery|husbandry|treatise|sermon|epistle|pythagor|way to health|grand preservative|letters? (to|of)|essays? upon|miscellan/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));

for (const id of targets) {
  const node = graph.nodes.find(n => n.id === id);
  if (!node) { console.warn(`unknown id: ${id}`); continue; }
  try {
    const q = encodeURIComponent(node.label);
    const r = await fetch(`https://openlibrary.org/search.json?author=${q}&limit=200&fields=title,first_publish_year,subject,language`);
    const docs = (await r.json()).docs || [];
    works[id] = works[id] || [];
    const have = new Set(works[id].map(w => norm(w.title)));
    const haveCanon = new Set(works[id].map(w => canon(w.title)));
    let added = 0;
    for (const d of docs) {
      if (!d.title || have.has(norm(d.title)) || haveCanon.has(canon(d.title))) continue;
      if (JUNK.test(d.title)) continue;
      if (d.language && d.language.length && !d.language.includes("eng")) continue;
      have.add(norm(d.title)); haveCanon.add(canon(d.title));
      works[id].push({
        id: id + "::" + slug(d.title),
        title: d.title,
        year: d.first_publish_year || null,
        kind: (d.subject || []).some(s => /short stories|collections/i.test(s)) ? "collection" : "novel",
        desc: "", dims: {}, signals: 0, source: "openlibrary"
      });
      added++;
    }
    works[id].sort((a, b) => (a.year || 9999) - (b.year || 9999));
    console.log(`${node.label}: +${added} (${works[id].length} total)`);
  } catch (e) { console.warn(`skip ${id}: ${e.message}`); }
  await sleep(600); // be polite to the API
}

writeFileSync(worksURL, JSON.stringify(works, null, 1));
console.log("wrote data/works.json");
