// New books by collected authors + discovery of uncollected horror authors, via Google Books.
// Zero dependencies; Node 18+. Run: node scripts/fetch-releases.mjs
// The deployed worker does the same thing on a weekly cron; this is the offline/local version.

import { readFileSync, writeFileSync } from "node:fs";

const GRAPH = JSON.parse(readFileSync(new URL("../data/graph.json", import.meta.url)));
const WORKS = JSON.parse(readFileSync(new URL("../data/works.json", import.meta.url)));
const OUT = new URL("../data/releases.json", import.meta.url);
const MONTHS_BACK = 18;

const authors = GRAPH.nodes.filter(n => n.type === "influence" || n.type === "rec");
const knownLabels = authors.map(a => a.label.toLowerCase());
const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const have = new Set();
for (const a in WORKS) for (const w of WORKS[a]) have.add(a + "|" + norm(w.title));

const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - MONTHS_BACK);
const isRecent = d => d && new Date(d.length === 4 ? d + "-06-15" : d) >= cutoff;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gbooks(q) {
  const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&orderBy=newest&maxResults=15&printType=books&langRestrict=en`);
  if (!r.ok) throw new Error("gbooks " + r.status);
  return (await r.json()).items || [];
}

const items = [];
for (const a of authors) {
  try {
    for (const it of await gbooks(`inauthor:"${a.label}"`)) {
      const v = it.volumeInfo || {};
      if (!v.title || !isRecent(v.publishedDate)) continue;
      if (!(v.authors || []).some(x => x.toLowerCase().includes(a.label.toLowerCase()))) continue;
      if (have.has(a.id + "|" + norm(v.title))) continue;
      items.push({ title: v.title, url: v.infoLink || "", date: v.publishedDate,
        source: v.publisher || "Google Books", kind: "book", author: a.id,
        summary: (v.description || "").slice(0, 240) });
    }
    console.log(`${a.label}: checked`);
  } catch (e) { console.warn(`skip ${a.label}: ${e.message}`); }
  await sleep(400);
}
for (const q of ["subject:horror", 'subject:"horror fiction"']) {
  try {
    for (const it of await gbooks(q)) {
      const v = it.volumeInfo || {};
      if (!v.title || !v.authors || !isRecent(v.publishedDate)) continue;
      if (v.authors.some(x => knownLabels.includes(x.toLowerCase()))) continue;
      items.push({ title: `${v.title} \u2014 ${v.authors.join(", ")}`, url: v.infoLink || "",
        date: v.publishedDate, source: v.publisher || "Google Books", kind: "discovery",
        author: null, summary: (v.description || "").slice(0, 240) });
    }
  } catch (e) { console.warn(`skip discovery: ${e.message}`); }
}
const seen = new Set();
const merged = items.filter(i => { const k = (i.title + "|" + (i.author || i.source)).toLowerCase();
  if (seen.has(k)) return false; seen.add(k); return true; });
writeFileSync(OUT, JSON.stringify({ fetched: new Date().toISOString(), items: merged }, null, 1));
console.log(`wrote ${merged.length} items`);
