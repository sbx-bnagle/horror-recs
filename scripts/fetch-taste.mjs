// Taste-twin matching via Arctic Shift / PullPush (Pushshift successors, no Reddit app needed).
// People who comment about 2+ of your 4-5 star books in r/horrorlit/r/weirdlit are "twins";
// every other catalog title they mention is weighted by how many favorites you share.
// Falls back through: Arctic Shift -> PullPush -> Reddit public JSON (proper UA) -> subject overlap.
//
// Run from repo root: node scripts/fetch-taste.mjs recommendotron-userdata.json
// No credentials required. Writes tasteMatch (0-1) into data/works.json (keeps higher of old/new).

import { readFileSync, writeFileSync } from "node:fs";

const userFile = process.argv[2];
if (!userFile) { console.error("usage: node scripts/fetch-taste.mjs <userdata.json>"); process.exit(1); }
const U = JSON.parse(readFileSync(userFile));
const worksURL = new URL("../data/works.json", import.meta.url);
const works = JSON.parse(readFileSync(worksURL));

const SUBS = ["horrorlit", "weirdlit", "horror", "books"];
const UA = { "user-agent": "recommendotron/3.0 taste-research (personal, low-volume)" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const all = [];
for (const a in works) for (const w of works[a]) all.push(w);
const byId = Object.fromEntries(all.map(w => [w.id, w]));
const seeds = Object.entries(U.ratings || {})
  .filter(([, v]) => v.r >= 4).map(([id]) => byId[id]).filter(Boolean).slice(0, 12);
if (!seeds.length) { console.error("no 4-5 star ratings found"); process.exit(1); }
console.log(`seeds: ${seeds.map(s => s.title).join("; ")}`);
const candidates = all.filter(w => w.title.length > 6 && !(U.read || {})[w.id] && w.kind !== "story" && w.kind !== "anthology");

// ---- comment-search backends; each returns [{author, body}] for a query in a sub ----
async function viaArcticShift(q, sub) {
  const url = `https://arctic-shift.photon-reddit.com/api/comments/search?body=${encodeURIComponent(q)}&subreddit=${sub}&limit=100`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error("as " + r.status);
  return ((await r.json()).data || []).map(c => ({ author: c.author, body: c.body || "" }));
}
async function viaPullPush(q, sub) {
  const url = `https://api.pullpush.io/reddit/search/comment/?q=${encodeURIComponent(q)}&subreddit=${sub}&size=100`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error("pp " + r.status);
  return ((await r.json()).data || []).map(c => ({ author: c.author, body: c.body || "" }));
}
async function viaRedditJson(q, sub) {
  const url = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent('"' + q + '"')}&restrict_sr=1&limit=50&sort=relevance`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error("rj " + r.status);
  const posts = (await r.json()).data?.children || [];
  return posts.map(p => ({ author: p.data.author, body: (p.data.title || "") + " " + (p.data.selftext || "") }));
}
const BACKENDS = [["ArcticShift", viaArcticShift], ["PullPush", viaPullPush], ["RedditJSON", viaRedditJson]];

// pick the first backend that works, once
let backend = null;
for (const [name, fn] of BACKENDS) {
  try { await fn(seeds[0].title, SUBS[0]); backend = [name, fn]; console.log(`using ${name}`); break; }
  catch (e) { console.warn(`${name} unavailable: ${e.message}`); }
}
const counts = {};

if (backend) {
  const [, fetchComments] = backend;
  const userSeeds = {}, userText = {};
  for (const seed of seeds) {
    for (const sub of SUBS) {
      try {
        for (const c of await fetchComments(seed.title, sub)) {
          if (!c.author || c.author === "[deleted]" || !c.body) continue;
          if (!c.body.toLowerCase().includes(seed.title.toLowerCase())) continue;
          (userSeeds[c.author] ||= new Set()).add(seed.id);
          userText[c.author] = (userText[c.author] || "") + " " + c.body.toLowerCase();
        }
      } catch (e) { console.warn(`skip ${seed.title} r/${sub}: ${e.message}`); }
      await sleep(700);
    }
    console.log(`seed done: ${seed.title}`);
  }
  let twins = 0;
  for (const u in userSeeds) {
    const sim = userSeeds[u].size;
    if (sim < 2) continue;
    twins++;
    for (const c of candidates)
      if (userText[u].includes(c.title.toLowerCase())) counts[c.id] = (counts[c.id] || 0) + sim;
  }
  console.log(`taste twins: ${twins}`);
} else {
  console.warn("all Reddit backends failed; subject-overlap only");
}

// ---- Open Library subject overlap (always runs, weak signal) ----
const jget = async url => { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(r.status); return r.json(); };
async function subjectsFor(title) {
  try { const j = await jget(`https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&limit=1&fields=subject`);
    return (j.docs?.[0]?.subject || []).map(s => s.toLowerCase()).filter(s => !/fiction|literature|english|american|accessible|protected|large type|translations/.test(s));
  } catch { return []; }
}
const seedSubjects = {};
for (const seed of seeds) { for (const s of await subjectsFor(seed.title)) seedSubjects[s] = (seedSubjects[s] || 0) + 1; await sleep(500); }
let n = 0;
for (const c of candidates.slice(0, 200)) {
  const subs = await subjectsFor(c.title);
  let overlap = 0; for (const s of subs) if (seedSubjects[s]) overlap += seedSubjects[s];
  if (overlap) counts[c.id] = (counts[c.id] || 0) + overlap * 0.3;
  if (++n % 25 === 0) console.log(`openlibrary: ${n}`);
  await sleep(500);
}

const max = Math.max(...Object.values(counts), 1);
let written = 0;
for (const id in counts) {
  const v = +(Math.log1p(counts[id]) / Math.log1p(max)).toFixed(2);
  byId[id].tasteMatch = Math.max(byId[id].tasteMatch || 0, v); written++;
}
writeFileSync(worksURL, JSON.stringify(works, null, 1));
console.log(`wrote tasteMatch for ${written} works`);
