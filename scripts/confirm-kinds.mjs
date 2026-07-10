// Confirm work kinds against Google Books: collection vs anthology vs novella vs novel.
// Run from repo root: node scripts/confirm-kinds.mjs [--all | authorId ...] [--dry]
// Checks unconfirmed openlibrary/gbooks-sourced works (curated seed/claude kinds are trusted).
// "anthology" = multi-author compilation that merely includes the author.

import { readFileSync, writeFileSync } from "node:fs";
const worksURL = new URL("../data/works.json", import.meta.url);
const works = JSON.parse(readFileSync(worksURL));
const graph = JSON.parse(readFileSync(new URL("../data/graph.json", import.meta.url)));
const labelOf = Object.fromEntries(graph.nodes.map(n => [n.id, n.label]));

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const ids = args.filter(a => !a.startsWith("--"));
const targets = args.includes("--all") || !ids.length ? Object.keys(works) : ids;

const ANTH_TITLE = /anthology|year'?s best|best (new )?horror|best (of|american|british)|big book of|edited by|presents|treasury of|mammoth book/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

let checked = 0, changed = 0;
for (const author of targets) {
  const label = labelOf[author] || "";
  for (const w of works[author] || []) {
    if (!["openlibrary", "gbooks"].includes(w.source) || w.kindConfirmed) continue;
    // cheap pass first: obvious anthology titles need no lookup
    if (ANTH_TITLE.test(w.title)) {
      if (w.kind !== "anthology") { changed++; console.log(`anthology (title): ${author}: ${w.title}`); }
      w.kind = "anthology"; w.kindConfirmed = true; continue;
    }
    try {
      const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(`intitle:"${w.title}" inauthor:"${label}"`)}&maxResults=3`);
      const items = r.ok ? (await r.json()).items || [] : [];
      const v = items.map(i => i.volumeInfo || {}).find(x => x.title) || null;
      checked++;
      if (v) {
        const desc = (v.description || "").toLowerCase();
        const cats = (v.categories || []).join(" ").toLowerCase();
        const multi = (v.authors || []).length > 1 && !(v.authors || []).every(a => norm(a) === norm(label));
        let kind = w.kind;
        if (multi || ANTH_TITLE.test(v.title)) kind = "anthology";
        else if (/short stories|story collection|collection of (stories|tales)|collected stories/.test(desc + " " + cats)) kind = "collection";
        else if (/\bnovella\b/.test(desc)) kind = "novella";
        else if (/\bnovel\b/.test(desc + " " + cats)) kind = "novel";
        if (kind !== w.kind) { changed++; console.log(`${w.kind} -> ${kind}: ${author}: ${w.title}`); }
        w.kind = kind;
      }
      w.kindConfirmed = true;
    } catch { /* leave unconfirmed for a later run */ }
    await sleep(350);
  }
}
if (!dry) writeFileSync(worksURL, JSON.stringify(works, null, 1));
console.log(`${dry ? "[dry] " : ""}checked ${checked}, changed ${changed}`);
