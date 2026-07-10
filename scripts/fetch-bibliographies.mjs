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
const deacc = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const norm = s => deacc(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const canon = s => deacc(s).toLowerCase().replace(/[:(].*$/, "").replace(/^(the|a|an)\s+/, "").replace(/[^a-z0-9]/g, "");
const canonMatch = (a, b) => a.length > 5 && b.length > 5 && (a.includes(b) || b.includes(a));
const JUNK = /brewing|cookery|husbandry|treatise|sermon|epistle|pythagor|way to health|grand preservative|letters? (to|of)|essays? upon|miscellan|planter|friendly advice|country-man/i;
const STRONG = new Set("el los las la le il un una une les de des dei aux au der und das dem ein eine einer gli della delle nel nella degli uno dos uma umas och det ett av na przy dla het een lo di du y".split(" "));
const foreignScore = (t, exempt = "") => {
  const ex = new Set(exempt.toLowerCase().split(/[^a-z\u00e0-\u024f]+/));
  const toks = t.toLowerCase().split(/[^a-z\u00e0-\u024f]+/).filter(x => x && !ex.has(x));
  let score = toks.filter(x => STRONG.has(x)).length;
  const acc = (t.match(/[\u00c0-\u024f]/g) || []).length;   // accented/extended Latin chars
  score += acc >= 2 ? 2 : acc === 1 ? 1 : 0;
  return score;
};
const isForeign = (t, exempt = "") => foreignScore(t, exempt) >= 2;
const mostlyLatin = t => { const l = (t.match(/[a-z]/gi) || []).length; return l / Math.max(t.length, 1) > 0.5; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jget = async url => { const r = await fetch(url); if (!r.ok) throw new Error(r.status + " " + url); return r.json(); };

// search.json filtered by author key: relevance-ranked (canonical works first),
// English titles where English editions exist, with years and languages.
async function keyWorks(key, pages = 1) {
  const out = [];
  for (let p = 1; p <= pages; p++) {
    const j = await jget(`https://openlibrary.org/search.json?q=author_key%3A${key}&fields=title,first_publish_year,language&limit=100&page=${p}`);
    out.push(...(j.docs || []).filter(d => d.title));
    if (!j.docs || j.docs.length < 100) break;
    await sleep(400);
  }
  return out;
}

async function resolveByWork(label, seedTitles) {
  const counts = {};
  for (const t of seedTitles.slice(0, 3)) {
    try {
      const j = await jget(`https://openlibrary.org/search.json?title=${encodeURIComponent(t)}&author=${encodeURIComponent(label)}&fields=author_key&limit=5`);
      for (const d of j.docs || []) for (const k of d.author_key || []) counts[k] = (counts[k] || 0) + 1;
    } catch {}
    await sleep(400);
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

async function gbooksAuthor(label) {
  const out = [];
  for (let start = 0; start < 120; start += 40) {
    const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent('inauthor:"' + label + '"')}&langRestrict=en&maxResults=40&startIndex=${start}&printType=books`);
    if (!r.ok) break;
    const items = (await r.json()).items || [];
    for (const it of items) {
      const v = it.volumeInfo || {};
      if (!v.title) continue;
      // strict: the author list must contain this exact name (diacritic-insensitive)
      if (!(v.authors || []).some(a => norm(a) === norm(label))) continue;
      out.push({ title: v.title.length && v.subtitle ? v.title : v.title,
        first_publish_year: v.publishedDate ? parseInt(v.publishedDate) : null, language: ["eng"] });
    }
    if (items.length < 40) break;
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
    const seedTitles = works[id].filter(w => w.source === "seed").map(w => w.title)
      .concat(works[id].map(w => w.title)).filter((t, i, a) => a.indexOf(t) === i);
    const knownArr = [...knownCanon];

    // 1. PRIMARY: resolve author key via a known work (immune to name/diacritic variants)
    let key = await resolveByWork(node.label, seedTitles);
    let bestDocs = null;
    if (key) {
      bestDocs = await keyWorks(key, 1);
    } else {
      // 2. FALLBACK: entity candidates with tolerant name + title matching
      const search = await jget(`https://openlibrary.org/search/authors.json?q=${encodeURIComponent(node.label)}`);
      const candidates = (search.docs || [])
        .filter(d => { const a = norm(d.name || ""), b = norm(node.label);
          return a === b || a.includes(b) || b.includes(a); })
        .sort((a, b) => (b.work_count || 0) - (a.work_count || 0))
        .slice(0, 8);
      let bestOverlap = 0;
      for (const c of candidates) {
        await sleep(400);
        let docs = [];
        try { docs = await keyWorks(c.key.replace(/^\/authors\//, ""), 1); } catch { continue; }
        const overlap = docs.filter(d => knownArr.some(k => canonMatch(canon(d.title), k))).length
          + (c.top_work && knownArr.some(k => canonMatch(canon(c.top_work), k)) ? 1 : 0);
        if (overlap > bestOverlap) { key = c.key.replace(/^\/authors\//, ""); bestDocs = docs; bestOverlap = overlap; }
      }
      if (!key) {
        // FALLBACK 2: Google Books with strict author-name equality
        await sleep(400);
        const gb = await gbooksAuthor(node.label);
        if (!gb.length) { console.warn(`${node.label}: unresolved everywhere, skipped (add manually)`); continue; }
        bestDocs = gb; key = "gbooks";
        console.log(`${node.label}: via Google Books (${gb.length} volumes)`);
      }
    }
    const best = { key };
    const bestOverlap = "work-resolved";

    // 3. full catalog of the verified entity, filtered and merged
    let docs = bestDocs;
    if (best.key !== "gbooks" && docs.length >= 100) { await sleep(400);
      docs = await keyWorks(best.key, 3); }
    let added = 0;
    const haveCanon = new Set(knownCanon);
    for (const d of docs) {
      const t = d.title, c = canon(t);
      if (!c || haveCanon.has(c)) continue;
      if (JUNK.test(t) || !mostlyLatin(t) || isForeign(t, node.label)) continue;
      if (d.language && d.language.length && !d.language.includes("eng")) continue;
      haveCanon.add(c);
      works[id].push({ id: id + "::" + slug(t), title: t, year: d.first_publish_year || null,
        kind: /stories|tales|collection/i.test(t) ? "collection" : "novel",
        desc: "", dims: {}, signals: 0, source: "openlibrary" });
      added++;
    }
    console.log(`${node.label}: matched ${best.key}, +${added} (${works[id].length} total)`);
  } catch (e) { console.warn(`skip ${id}: ${e.message}`); }
  await sleep(600);
}

writeFileSync(worksURL, JSON.stringify(works, null, 1));
console.log("wrote data/works.json");
