// Expand data/works.json toward full bibliographies using Open Library AUTHOR ENTITIES.
// Resolves the right author by overlap with known works (defeats homonyms like the
// 17th-century Thomas Tryon). Run:
//   node scripts/fetch-bibliographies.mjs --all
//   node scripts/fetch-bibliographies.mjs tryon barron
// Merges by title; never overwrites desc/dims/signals/tasteMatch you've set.

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
const JUNK = /brewing|cookery|husbandry|treatise|sermon|epistle|pythagor|way to health|grand preservative|letters? (to|of)|essays? upon|miscellan|planter|friendly advice|country-man/i;
const STRONG = new Set("el los las la le il un una une les de des dei aux au der und das dem ein eine einer gli della delle nel nella degli uno dos uma umas och det ett av na przy dla het een lo di du y".split(" "));
const isForeign = (t, exempt = "") => {
  const ex = new Set(exempt.toLowerCase().split(/[^a-z\u00e0-\u00ff]+/));
  const toks = t.toLowerCase().split(/[^a-z\u00e0-\u00ff]+/).filter(x => x && !ex.has(x));
  let score = toks.filter(x => STRONG.has(x)).length;
  if (/[\u00e0-\u00f6\u00f8-\u00ff]/.test(t.toLowerCase())) score++;
  return score >= 2;
};
const mostlyLatin = t => { const l = (t.match(/[a-z]/gi) || []).length; return l / Math.max(t.length, 1) > 0.5; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jget = async url => { const r = await fetch(url); if (!r.ok) throw new Error(r.status + " " + url); return r.json(); };

async function authorWorks(key, limit = 200) {
  const out = [];
  for (let offset = 0; offset < limit; offset += 100) {
    const j = await jget(`https://openlibrary.org/authors/${key}/works.json?limit=100&offset=${offset}`);
    out.push(...(j.entries || []).map(e => e.title).filter(Boolean));
    if (!j.entries || j.entries.length < 100) break;
    await sleep(400);
  }
  return out;
}

for (const id of targets) {
  const node = graph.nodes.find(n => n.id === id);
  if (!node) { console.warn(`unknown id: ${id}`); continue; }
  works[id] = works[id] || [];
  const knownCanon = new Set(works[id].map(w => canon(w.title)));
  try {
    // 1. candidate author entities matching the name
    const search = await jget(`https://openlibrary.org/search/authors.json?q=${encodeURIComponent(node.label)}`);
    const candidates = (search.docs || [])
      .filter(d => norm(d.name || "") === norm(node.label) || norm(d.name || "").includes(norm(node.label)))
      .sort((a, b) => (b.work_count || 0) - (a.work_count || 0))
      .slice(0, 4);
    if (!candidates.length) { console.warn(`${node.label}: no author entity found, skipped`); continue; }

    // 2. pick the candidate whose catalog overlaps our known works
    let best = null, bestTitles = null, bestOverlap = 0;
    for (const c of candidates) {
      await sleep(400);
      const titles = await authorWorks(c.key, 100);
      const overlap = titles.filter(t => knownCanon.has(canon(t))).length
        + (c.top_work && knownCanon.has(canon(c.top_work)) ? 1 : 0);
      if (overlap > bestOverlap) { best = c; bestTitles = titles; bestOverlap = overlap; }
    }
    if (!best) { console.warn(`${node.label}: no candidate matched known works, skipped (add manually if needed)`); continue; }

    // 3. full catalog of the verified entity, filtered and merged
    await sleep(400);
    const titles = bestTitles.length >= 100 ? await authorWorks(best.key, 300) : bestTitles;
    let added = 0;
    const haveCanon = new Set(knownCanon);
    for (const t of titles) {
      const c = canon(t);
      if (!c || haveCanon.has(c)) continue;
      if (JUNK.test(t) || !mostlyLatin(t) || isForeign(t, node.label)) continue;
      haveCanon.add(c);
      works[id].push({ id: id + "::" + slug(t), title: t, year: null,
        kind: /stories|tales|collection/i.test(t) ? "collection" : "novel",
        desc: "", dims: {}, signals: 0, source: "openlibrary" });
      added++;
    }
    console.log(`${node.label}: matched ${best.key} (overlap ${bestOverlap}), +${added} (${works[id].length} total)`);
  } catch (e) { console.warn(`skip ${id}: ${e.message}`); }
  await sleep(600);
}

writeFileSync(worksURL, JSON.stringify(works, null, 1));
console.log("wrote data/works.json");
