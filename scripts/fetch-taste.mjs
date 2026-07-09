// Co-occurrence taste matching. Seeds = your 4-5 star titles; candidates = unread works.
// Sources: Reddit (r/horrorlit, r/weirdlit search JSON) and Open Library subject overlap.
// Hardcover has an open GraphQL API (hardcover.app) if you want a third source later:
// set HARDCOVER_TOKEN and extend fetchHardcover() - schema left as a hook since it drifts.
//
// Run: node scripts/fetch-taste.mjs recommendotron-userdata.json
// Writes tasteMatch (0-1) into data/works.json (keeps the higher of old/new).

import { readFileSync, writeFileSync } from "node:fs";

const userFile = process.argv[2];
if (!userFile) { console.error("usage: node scripts/fetch-taste.mjs <userdata.json>"); process.exit(1); }
const U = JSON.parse(readFileSync(userFile));
const worksURL = new URL("../data/works.json", import.meta.url);
const works = JSON.parse(readFileSync(worksURL));

const SUBREDDITS = ["horrorlit", "weirdlit"];
const UA = { headers: { "user-agent": "recommendotron/1.0 (personal reading tool)" } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// index all works; seeds are rated >=4
const all = [];
for (const author in works) for (const w of works[author]) all.push(w);
const byId = Object.fromEntries(all.map(w => [w.id, w]));
const seeds = Object.entries(U.ratings || {})
  .filter(([, v]) => v.r >= 4).map(([id]) => byId[id]).filter(Boolean).slice(0, 15);
if (!seeds.length) { console.error("no 4-5 star ratings found in user data"); process.exit(1); }
console.log(`seeds: ${seeds.map(s => s.title).join("; ")}`);

const counts = {};   // workId -> co-occurrence score
const bump = (id, n) => counts[id] = (counts[id] || 0) + n;
// candidate titles long enough to match without noise
const candidates = all.filter(w => w.title.length > 6 && !(U.read||{})[w.id]);

/* ---- Reddit: search each seed, count candidate titles in result text ---- */
for (const seed of seeds) {
  for (const sub of SUBREDDITS) {
    try {
      const q = encodeURIComponent(`"${seed.title}"`);
      const r = await fetch(`https://www.reddit.com/r/${sub}/search.json?q=${q}&restrict_sr=1&limit=25&sort=relevance`, UA);
      if (!r.ok) throw new Error(r.status);
      const posts = (await r.json()).data?.children || [];
      const text = posts.map(p => (p.data.title + " " + (p.data.selftext || ""))).join(" ").toLowerCase();
      for (const c of candidates) {
        if (c.id === seed.id) continue;
        const t = c.title.toLowerCase();
        let i = 0, n = 0; while ((i = text.indexOf(t, i)) !== -1) { n++; i += t.length; }
        if (n) bump(c.id, n);
      }
      console.log(`reddit r/${sub} "${seed.title}": ${posts.length} posts`);
    } catch (e) { console.warn(`skip r/${sub} ${seed.title}: ${e.message}`); }
    await sleep(1200); // stay well under rate limits
  }
}

/* ---- Open Library: rare-subject overlap with seeds ---- */
async function subjectsFor(title) {
  try {
    const r = await fetch(`https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&limit=1&fields=subject`, UA);
    return ((await r.json()).docs?.[0]?.subject || []).map(s => s.toLowerCase())
      .filter(s => !/fiction|literature|english|american|accessible|protected|large type|translations/.test(s));
  } catch { return []; }
}
const seedSubjects = {};
for (const seed of seeds) {
  for (const s of await subjectsFor(seed.title)) seedSubjects[s] = (seedSubjects[s] || 0) + 1;
  await sleep(600);
}
const rare = new Set(Object.keys(seedSubjects)); // any shared subject counts; weight by seed frequency
let n = 0;
for (const c of candidates.slice(0, 250)) {  // cap API load; prioritize by current signals
  const subs = await subjectsFor(c.title);
  let overlap = 0; for (const s of subs) if (rare.has(s)) overlap += seedSubjects[s];
  if (overlap) bump(c.id, overlap * 0.5);
  if (++n % 25 === 0) console.log(`openlibrary: ${n} candidates checked`);
  await sleep(600);
}

/* ---- normalize (log scale) and merge ---- */
const max = Math.max(...Object.values(counts), 1);
let written = 0;
for (const id in counts) {
  const v = +(Math.log1p(counts[id]) / Math.log1p(max)).toFixed(2);
  byId[id].tasteMatch = Math.max(byId[id].tasteMatch || 0, v);
  written++;
}
writeFileSync(worksURL, JSON.stringify(works, null, 1));
console.log(`wrote tasteMatch for ${written} works`);
