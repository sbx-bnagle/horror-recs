// Collaborative-filtering baseline from the UCSD Goodreads research dump (static, ~2017).
// Users whose ratings correlate with yours contribute weighted votes for books they rated highly.
// Output feeds tasteMatch as a baseline (merged, higher value wins).
//
// Download (large files) from https://mengtingwan.github.io/data/goodreads.html :
//   goodreads_books.json.gz          (book metadata: id -> title)
//   goodreads_interactions.csv       (user_id, book_id, is_read, rating, is_reviewed)
//   book_id_map.csv                  (csv book id -> real book id)
//
// Run: node scripts/cf-baseline.mjs <dir-with-dump> recommendotron-userdata.json
// Streams everything; needs disk, not memory.

import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { join } from "node:path";

const [dir, userFile] = process.argv.slice(2);
if (!dir || !userFile) { console.error("usage: node scripts/cf-baseline.mjs <dump-dir> <userdata.json>"); process.exit(1); }

const U = JSON.parse(readFileSync(userFile));
const worksURL = new URL("../data/works.json", import.meta.url);
const works = JSON.parse(readFileSync(worksURL));
const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const all = [];
for (const a in works) for (const w of works[a]) all.push(w);
const wantByTitle = {};                      // normalized title -> work
for (const w of all) wantByTitle[norm(w.title)] = w;
const ratedByTitle = {};                     // normalized title -> your rating
for (const [id, v] of Object.entries(U.ratings || {})) {
  const w = all.find(x => x.id === id); if (w) ratedByTitle[norm(w.title)] = v.r;
}
if (!Object.keys(ratedByTitle).length) { console.error("no ratings in user data"); process.exit(1); }

const lines = (path, gz) => createInterface({ input: gz ? createReadStream(path).pipe(createGunzip()) : createReadStream(path) });

// pass 1: book metadata -> map dump book_id to your titles
console.log("pass 1: mapping titles to dump book ids…");
const myBookIds = new Map();       // dump book_id -> your rating
const candidateIds = new Map();    // dump book_id -> work
for await (const line of lines(join(dir, "goodreads_books.json.gz"), true)) {
  let b; try { b = JSON.parse(line); } catch { continue; }
  const t = norm(b.title || "");
  if (ratedByTitle[t] != null) myBookIds.set(b.book_id, ratedByTitle[t]);
  else if (wantByTitle[t]) candidateIds.set(b.book_id, wantByTitle[t]);
}
console.log(`matched ${myBookIds.size} rated titles, ${candidateIds.size} candidates`);

// interactions use remapped csv ids
const idMap = new Map();
for await (const line of lines(join(dir, "book_id_map.csv"))) {
  const [csvId, realId] = line.split(","); idMap.set(csvId, realId);
}

// pass 2: find users who rated >=2 of your books, score correlation
console.log("pass 2: scanning interactions for similar users…");
const userSim = new Map();  // user -> {n, agree}
for await (const line of lines(join(dir, "goodreads_interactions.csv"))) {
  const [user, csvBook, , rating] = line.split(",");
  const real = idMap.get(csvBook); if (!real) continue;
  const mine = myBookIds.get(real);
  if (mine != null && +rating > 0) {
    const s = userSim.get(user) || { n: 0, agree: 0 };
    s.n++; s.agree += 1 - Math.abs(mine - +rating) / 4;   // 1 = identical, 0 = opposite
    userSim.set(user, s);
  }
}
const similar = new Map();
for (const [u, s] of userSim) if (s.n >= 2 && s.agree / s.n > 0.7) similar.set(u, s.agree / s.n);
console.log(`similar users: ${similar.size}`);

// pass 3: their high ratings on candidate books
console.log("pass 3: collecting votes…");
const votes = new Map();
for await (const line of lines(join(dir, "goodreads_interactions.csv"))) {
  const [user, csvBook, , rating] = line.split(",");
  const sim = similar.get(user); if (!sim || +rating < 4) continue;
  const real = idMap.get(csvBook);
  const w = candidateIds.get(real); if (!w) continue;
  votes.set(w.id, (votes.get(w.id) || 0) + sim);
}
const max = Math.max(...votes.values(), 1);
let written = 0;
for (const [id, v] of votes) {
  const w = all.find(x => x.id === id);
  const t = +(Math.log1p(v) / Math.log1p(max)).toFixed(2);
  w.tasteMatch = Math.max(w.tasteMatch || 0, t); written++;
}
writeFileSync(worksURL, JSON.stringify(works, null, 1));
console.log(`wrote CF baseline tasteMatch for ${written} works (dump is static ~2017; recent titles unaffected)`);
