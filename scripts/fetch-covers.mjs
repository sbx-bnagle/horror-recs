// Backfill cover thumbnails for all works lacking one.
// Google Books first (better hit rate), Open Library covers as fallback.
// Run from repo root: node scripts/fetch-covers.mjs [--limit 200]
// Then: node scripts/make-seed-sql.mjs --sync-works && reseed D1.

import { readFileSync, writeFileSync } from "node:fs";
const worksURL = new URL("../data/works.json", import.meta.url);
const works = JSON.parse(readFileSync(worksURL));
const graph = JSON.parse(readFileSync(new URL("../data/graph.json", import.meta.url)));
const labelOf = Object.fromEntries(graph.nodes.map(n => [n.id, n.label]));
const li = process.argv.indexOf("--limit");
const LIMIT = li > -1 ? +process.argv[li + 1] : Infinity;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let done = 0, found = 0;
outer:
for (const author in works) {
  for (const w of works[author]) {
    if (w.cover || w.kind === "story") continue;
    if (done >= LIMIT) break outer;
    done++;
    try {
      const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(`intitle:"${w.title}" inauthor:"${labelOf[author]||""}"`)}&maxResults=3`);
      const items = r.ok ? (await r.json()).items || [] : [];
      let cover = items.map(i => i.volumeInfo?.imageLinks?.smallThumbnail).find(Boolean);
      if (!cover) {
        const ol = await fetch(`https://openlibrary.org/search.json?title=${encodeURIComponent(w.title)}&author=${encodeURIComponent(labelOf[author]||"")}&limit=1&fields=cover_i`);
        const ci = ol.ok ? (await ol.json()).docs?.[0]?.cover_i : null;
        if (ci) cover = `https://covers.openlibrary.org/b/id/${ci}-S.jpg`;
      }
      if (cover) { w.cover = cover.replace(/^http:/, "https:"); found++; }
    } catch {}
    if (done % 25 === 0) console.log(`${done} checked, ${found} covers`);
    await sleep(450);
  }
}
writeFileSync(worksURL, JSON.stringify(works, null, 1));
console.log(`checked ${done}, found ${found} covers`);
