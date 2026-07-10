// Clean works.json after a bibliography run: dedupe variant editions, drop junk.
// Run: node scripts/clean-works.mjs [--min-year 1850] [--dry]
// Never removes: seed works, or anything enriched (desc/dims/signals/tasteMatch).

import { readFileSync, writeFileSync } from "node:fs";
const worksURL = new URL("../data/works.json", import.meta.url);
const works = JSON.parse(readFileSync(worksURL));
const graph = JSON.parse(readFileSync(new URL("../data/graph.json", import.meta.url)));
const labelOf = Object.fromEntries(graph.nodes.map(n => [n.id, n.label]));
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const my = args.indexOf("--min-year");
const minYear = my > -1 ? +args[my + 1] : null;

const JUNK = /brewing|cookery|husbandry|treatise|sermon|epistle|pythagor|way to health|grand preservative|letters? (to|of)|essays? upon|miscellan|planter's speech|dreams & visions|wisdom's dictates|country-man|memoirs of the life|planter|friendly advice/i;
const STRONG = new Set("el los las la le il un una une les de des dei aux au der und das dem ein eine einer gli della delle nel nella degli uno dos uma umas och det ett av na przy dla het een lo di du y".split(" "));
const isForeign = (t, exempt = "") => {
  const ex = new Set(exempt.toLowerCase().split(/[^a-z\u00e0-\u00ff]+/));
  const toks = t.toLowerCase().split(/[^a-z\u00e0-\u00ff]+/).filter(x => x && !ex.has(x));
  let score = toks.filter(x => STRONG.has(x)).length;
  if (/[\u00e0-\u00f6\u00f8-\u00ff]/.test(t.toLowerCase())) score++;
  return score >= 2;
};
const canon = t => t.toLowerCase().replace(/[:(].*$/, "").replace(/^(the|a|an)\s+/, "").replace(/[^a-z0-9]/g, "");
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
if (!dry) writeFileSync(worksURL, JSON.stringify(works, null, 1));
console.log(`${dry ? "[dry run] " : ""}dropped ${dropped} junk/old, merged ${deduped} duplicates; ${Object.values(works).flat().length} works remain`);
