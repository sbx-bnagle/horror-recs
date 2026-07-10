// Clean works.json after a bibliography run: dedupe variant editions, drop junk.
// Run: node scripts/clean-works.mjs [--min-year 1850] [--dry] [--verify-lang]
// --verify-lang: titles with one weak foreign signal are checked against Google Books language (network)
// Never removes: seed works, or anything enriched (desc/dims/signals/tasteMatch).

import { readFileSync, writeFileSync } from "node:fs";
const worksURL = new URL("../data/works.json", import.meta.url);
const works = JSON.parse(readFileSync(worksURL));
const graph = JSON.parse(readFileSync(new URL("../data/graph.json", import.meta.url)));
const labelOf = Object.fromEntries(graph.nodes.map(n => [n.id, n.label]));
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const my = args.indexOf("--min-year");
const verifyLang = args.includes("--verify-lang");
const minYear = my > -1 ? +args[my + 1] : null;

const JUNK = /brewing|cookery|husbandry|treatise|sermon|epistle|pythagor|way to health|grand preservative|letters? (to|of)|essays? upon|miscellan|planter's speech|dreams & visions|wisdom's dictates|country-man|memoirs of the life|planter|friendly advice/i;
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
const deacc = t => t.normalize("NFD").replace(/[̀-ͯ]/g, "");
const canon = t => deacc(t).toLowerCase().replace(/[:(].*$/, "").replace(/^(the|a|an)\s+/, "").replace(/[^a-z0-9]/g, "");
const enriched = w => (w.desc && w.desc.length) || Object.keys(w.dims || {}).length || w.signals || w.tasteMatch;
const protectedW = w => w.source === "seed" || w.source === "release" || w.source === "claude" || enriched(w);

let dropped = 0, deduped = 0;
for (const author in works) {
  let list = works[author];
  // 1. junk + year floor (protected works exempt)
  list = list.filter(w => {
    if (protectedW(w)) return true;
    if (JUNK.test(w.title)) { dropped++; if (dry) console.log(`junk: ${author}: ${w.title}`); return false; }
    if (isForeign(w.title, labelOf[author] || "")) { dropped++; if (dry) console.log(`foreign: ${author}: ${w.title}`); return false; }
    if (minYear && w.year && w.year < minYear) { dropped++; if (dry) console.log(`old: ${author}: ${w.title} (${w.year})`); return false; }
    return true;
  });
  // 2. dedupe variant editions by canonical title; prefer protected, then earliest year
  const byCanon = {};
  for (const w of list) {
    const c = canon(w.title);
    const cur = byCanon[c];
    if (!cur) { byCanon[c] = w; continue; }
    const keep = protectedW(w) && !protectedW(cur) ? w
               : protectedW(cur) && !protectedW(w) ? cur
               : (w.year || 9999) < (cur.year || 9999) ? w : cur;
    if (keep !== cur) byCanon[c] = keep;
    deduped++; if (dry) console.log(`dupe: ${author}: kept "${keep.title}"`);
  }
  works[author] = Object.values(byCanon).sort((a, b) => (a.year || 9999) - (b.year || 9999));
}
if (verifyLang) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let checked = 0, removed = 0;
  for (const author in works) {
    const label = labelOf[author] || "";
    const keep = [];
    for (const w of works[author]) {
      const suspicious = !protectedW(w) && w.source === "openlibrary" && foreignScore(w.title, label) === 1;
      if (!suspicious) { keep.push(w); continue; }
      try {
        const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(`intitle:"${w.title}" inauthor:"${label}"`)}&maxResults=3`);
        const items = r.ok ? (await r.json()).items || [] : [];
        const lang = items.map(i => i.volumeInfo?.language).find(Boolean);
        checked++;
        if (lang && lang !== "en") { removed++; console.log(`lang ${lang}: ${author}: ${w.title}${dry ? " (dry)" : ""}`); if (dry) keep.push(w); continue; }
        keep.push(w);
      } catch { keep.push(w); }
      await sleep(350);
    }
    works[author] = keep;
  }
  console.log(`verify-lang: checked ${checked}, removed ${removed}`);
}
if (!dry) writeFileSync(worksURL, JSON.stringify(works, null, 1));
console.log(`${dry ? "[dry run] " : ""}dropped ${dropped} junk/old, merged ${deduped} duplicates; ${Object.values(works).flat().length} works remain`);
