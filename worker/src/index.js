// Recommendotron worker: D1-backed API + weekly scan + Claude proxy.
// Secrets: ANTHROPIC_API_KEY, APP_TOKEN. Binding: DB (D1).

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-app-token",
  "access-control-allow-methods": "GET,PUT,POST,OPTIONS"
};
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", ...CORS } });

/* ---------------- sources ---------------- */
const AWARDS = [
  ["Bram Stoker Awards", "Bram_Stoker_Award"],
  ["Shirley Jackson Awards", "Shirley_Jackson_Award"],
  ["Booker Prize", "Booker_Prize"],
  ["Edgar Awards", "Edgar_Award"],
  ["Locus Award (horror)", "Locus_Award_for_Best_Horror_Novel"],
  ["Splatterpunk Awards", "Splatterpunk_Award"]
];
const AUTHOR_BATCH = 25;      // authors checked per scan run (rotates; free tier caps 50 subrequests incl. D1 calls)
const MONTHS_BACK = 18;       // how recent a publication date counts as "new"

/* ---------------- scan ---------------- */
const UA = { headers: { "user-agent": "recommendotron/2.0 (personal reading tool)" } };
const strip = s => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#8217;|&rsquo;/g, "\u2019")
  .replace(/&#8216;/g, "\u2018").replace(/&#821[12];|&mdash;|&ndash;/g, "-").replace(/&quot;/g, '"')
  .replace(/&#\d+;/g, "").replace(/\s+/g, " ").trim();
const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function gbooks(q) {
  const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&orderBy=newest&maxResults=15&printType=books&langRestrict=en`, UA);
  if (!r.ok) throw new Error("gbooks " + r.status);
  return (await r.json()).items || [];
}

async function scan(env) {
  const now = new Date();
  const cutoff = new Date(now); cutoff.setMonth(cutoff.getMonth() - MONTHS_BACK);
  const isRecent = d => d && new Date(d.length === 4 ? d + "-06-15" : d) >= cutoff;

  const authors = (await env.DB.prepare("SELECT id,label FROM nodes WHERE type IN ('influence','rec') ORDER BY id").all()).results;
  const knownLabels = authors.map(a => a.label.toLowerCase());
  const wrows = (await env.DB.prepare("SELECT author,title FROM works").all()).results;
  const haveTitles = new Set(wrows.map(w => w.author + "|" + norm(w.title)));

  const stmt = env.DB.prepare(
    "INSERT OR IGNORE INTO releases(key,title,url,date,source,kind,author,summary,fetched) VALUES(?,?,?,?,?,?,?,?,?)");
  const batch = [];
  const nowISO = now.toISOString();
  const push = (key, title, url, date, source, kind, author, summary) =>
    batch.push(stmt.bind(key.toLowerCase().slice(0, 300), title, url || "", date || "", source || "", kind, author, (summary || "").slice(0, 240), nowISO));

  /* A. new books by collected authors (rotating batch) */
  const curRow = await env.DB.prepare("SELECT value FROM kv WHERE key='authorCursor'").first();
  let cur = curRow ? parseInt(curRow.value) : 0;
  if (cur >= authors.length) cur = 0;
  const slice = authors.slice(cur, cur + AUTHOR_BATCH);
  for (const a of slice) {
    try {
      for (const it of await gbooks(`inauthor:"${a.label}"`)) {
        const v = it.volumeInfo || {};
        if (!v.title || !isRecent(v.publishedDate)) continue;
        if (!(v.authors || []).some(x => x.toLowerCase().includes(a.label.toLowerCase()))) continue;
        if (haveTitles.has(a.id + "|" + norm(v.title))) continue;
        push(`book|${a.id}|${v.title}`, v.title, v.infoLink, v.publishedDate,
          v.publisher || "Google Books", "book", a.id, v.description);
      }
    } catch (e) { console.log(`skip ${a.label}: ${e.message}`); }
  }
  await env.DB.prepare("INSERT INTO kv(key,value) VALUES('authorCursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(String(cur + AUTHOR_BATCH >= authors.length ? 0 : cur + AUTHOR_BATCH)).run();

  /* B. discovery: recent horror by authors not yet collected */
  for (const q of ['subject:horror', 'subject:"horror fiction"']) {
    try {
      for (const it of await gbooks(q)) {
        const v = it.volumeInfo || {};
        if (!v.title || !v.authors || !isRecent(v.publishedDate)) continue;
        const names = v.authors.join(", ");
        if (v.authors.some(x => knownLabels.includes(x.toLowerCase()))) continue;
        push(`disc|${names}|${v.title}`, `${v.title} \u2014 ${names}`, v.infoLink, v.publishedDate,
          v.publisher || "Google Books", "discovery", null, v.description);
      }
    } catch (e) { console.log(`skip discovery: ${e.message}`); }
  }

  /* C. awards (current + previous year) */
  const yr = now.getFullYear();
  for (const [name, page] of AWARDS) {
    try {
      const html = await (await fetch(`https://en.wikipedia.org/api/rest_v1/page/html/${page}`, UA)).text();
      for (const li of html.match(/<li[\s>][\s\S]*?<\/li>/g) || []) {
        const text = strip(li);
        if ((text.includes(String(yr)) || text.includes(String(yr - 1))) && text.length > 15 && text.length < 220) {
          const hit = authors.find(a => a.label.length > 5 && text.toLowerCase().includes(a.label.toLowerCase()));
          push(`award|${text}|${name}`, text, `https://en.wikipedia.org/wiki/${page}`, "", name, "award", hit ? hit.id : null, "");
        }
      }
    } catch (e) { console.log(`skip ${name}: ${e.message}`); }
  }

  if (batch.length) await env.DB.batch(batch);
  await env.DB.prepare("INSERT INTO kv(key,value) VALUES('lastScan',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(nowISO).run();
  return batch.length;
}

/* ---------------- taste scan (Arctic Shift twins) ---------------- */
async function tasteScan(env) {
  const ud = await env.DB.prepare("SELECT value FROM kv WHERE key='userdata'").first();
  if (!ud) return 0;
  const U = JSON.parse(ud.value);
  const wrows = (await env.DB.prepare("SELECT id,title,kind FROM works").all()).results;
  const byId = Object.fromEntries(wrows.map(w => [w.id, w]));
  const seeds = Object.entries(U.ratings || {}).filter(([, v]) => v.r >= 4)
    .map(([id]) => byId[id]).filter(Boolean).slice(0, 8);
  if (!seeds.length) return 0;
  const candidates = wrows.filter(w => w.title.length > 6 && !(U.read || {})[w.id] && w.kind !== "story" && w.kind !== "anthology");

  const userSeeds = {}, userText = {};
  for (const seed of seeds) {
    for (const sub of ["horrorlit", "weirdlit"]) {
      try {
        const r = await fetch(`https://arctic-shift.photon-reddit.com/api/comments/search?body=${encodeURIComponent(seed.title)}&subreddit=${sub}&limit=100`, UA);
        if (!r.ok) continue;
        for (const c of (await r.json()).data || []) {
          if (!c.author || c.author === "[deleted]" || !c.body) continue;
          if (!c.body.toLowerCase().includes(seed.title.toLowerCase())) continue;
          (userSeeds[c.author] ||= new Set()).add(seed.id);
          userText[c.author] = (userText[c.author] || "") + " " + c.body.toLowerCase();
        }
      } catch (e) { console.log(`taste skip ${seed.title}/${sub}: ${e.message}`); }
    }
  }
  const counts = {}, pairs = {};
  for (const u in userSeeds) {
    const sim = userSeeds[u].size;
    if (sim < 2) continue;
    const mentioned = candidates.filter(c => userText[u].includes(c.title.toLowerCase()));
    for (const c of mentioned) {
      counts[c.id] = (counts[c.id] || 0) + sim;
      for (const sid of userSeeds[u]) {
        (pairs[sid] ||= {})[c.id] = (pairs[sid][c.id] || 0) + sim;
      }
    }
  }
  // normalize + write tasteMatch
  const max = Math.max(...Object.values(counts), 1);
  const batch = [];
  for (const id in counts) {
    const v = +(Math.log1p(counts[id]) / Math.log1p(max)).toFixed(2);
    batch.push(env.DB.prepare("UPDATE works SET tasteMatch = MAX(COALESCE(tasteMatch,0), ?) WHERE id=?").bind(v, id));
  }
  if (batch.length) await env.DB.batch(batch);
  // normalize affinity per seed, merge with stored map
  const stored = await env.DB.prepare("SELECT value FROM kv WHERE key='affinity'").first();
  const aff = stored ? JSON.parse(stored.value) : {};
  for (const sid in pairs) {
    const m = Math.max(...Object.values(pairs[sid]), 1);
    aff[sid] = aff[sid] || {};
    for (const cid in pairs[sid])
      aff[sid][cid] = Math.max(aff[sid][cid] || 0, +(Math.log1p(pairs[sid][cid]) / Math.log1p(m)).toFixed(2));
  }
  await env.DB.prepare("INSERT INTO kv(key,value) VALUES('affinity',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(JSON.stringify(aff)).run();
  await env.DB.prepare("INSERT INTO kv(key,value) VALUES('lastTasteScan',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(new Date().toISOString()).run();
  return Object.keys(counts).length;
}

/* ---------------- Claude ---------------- */
async function claudeSuggest(env) {
  const rel = (await env.DB.prepare("SELECT title,source FROM releases WHERE author IS NULL ORDER BY fetched DESC LIMIT 60").all()).results;
  const ud = await env.DB.prepare("SELECT value FROM kv WHERE key='userdata'").first();
  const ratings = ud ? Object.entries(JSON.parse(ud.value).ratings || {}).map(([k, v]) => `${k}: ${v.r}\u2605`).join("\n") : "none yet";
  const nodes = (await env.DB.prepare("SELECT id,cluster FROM nodes").all()).results;
  const clusters = [...new Set(nodes.map(n => n.cluster))].filter(c => c !== "meta").join(", ");
  const prompt = `You are updating a personal horror-literature influence map.
Taste profile: constant atmospheric dread; bleak worldview; concrete, inescapable antagonists; cosmic/supernatural taken seriously; visceral but never the point; no camp, no ironic distance, no genre-referential work.

My ratings so far:
${ratings}

Existing author ids (do not re-add): ${nodes.map(n => n.id).join(", ")}
Valid clusters: ${clusters}

Recent unmatched release and award items:
${rel.map(r => `- ${r.title} (${r.source})`).join("\n")}

From these items, identify authors genuinely worth adding. Extract author names from award citations where present. Respond ONLY with JSON, no prose, no code fences:
{"nodes":[{"id":"lowercase-id","label":"Author Name","type":"rec","cluster":"one of the valid clusters","note":"one short line","works":["Title"]}],"links":[["new-id","existing-id"]]}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 3000, messages: [{ role: "user", content: prompt }] })
  });
  if (!r.ok) throw new Error("anthropic " + r.status);
  const data = await r.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

/* ---------------- helpers ---------------- */
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
async function insertAuthor(env, node, links) {
  await env.DB.prepare("INSERT OR IGNORE INTO nodes(id,label,type,cluster,note) VALUES(?,?,?,?,?)")
    .bind(node.id, node.label, node.type || "rec", node.cluster, node.note || "").run();
  const batch = [];
  for (const t of node.works || [])
    batch.push(env.DB.prepare("INSERT OR IGNORE INTO works(id,author,title,kind,desc,dims,source) VALUES(?,?,?,?,?,?,?)")
      .bind(node.id + "::" + slug(t), node.id, t, "novel", "", "{}", "claude"));
  for (const [a, b] of links || [])
    batch.push(env.DB.prepare("INSERT OR IGNORE INTO links(a,b) VALUES(?,?)").bind(a, b));
  if (batch.length) await env.DB.batch(batch);
}

/* ---------------- router ---------------- */
export default {
  async scheduled(event, env) {
    if (event.cron === "0 6 * * *") await scanBooks(env);
    else await scan(env);
  },
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.headers.get("x-app-token") !== env.APP_TOKEN) return J({ error: "unauthorized" }, 401);
    const p = new URL(req.url).pathname;
    try {
      if (p === "/catalog" && req.method === "GET") {
        const nodes = (await env.DB.prepare("SELECT * FROM nodes").all()).results;
        const links = (await env.DB.prepare("SELECT a,b FROM links").all()).results.map(r => [r.a, r.b]);
        const wrows = (await env.DB.prepare("SELECT * FROM works").all()).results;
        const works = {};
        for (const w of wrows) (works[w.author] ||= []).push({
          id: w.id, title: w.title, year: w.year, kind: w.kind, desc: w.desc || "",
          dims: JSON.parse(w.dims || "{}"), signals: w.signals || 0,
          tasteMatch: w.tasteMatch || 0, source: w.source });
        const cl = await env.DB.prepare("SELECT value FROM kv WHERE key='clusters'").first();
        return J({ clusters: JSON.parse(cl.value), nodes, links, works });
      }
      if (p === "/userdata" && req.method === "GET") {
        const r = await env.DB.prepare("SELECT value FROM kv WHERE key='userdata'").first();
        return J(r ? JSON.parse(r.value) : null);
      }
      if (p === "/userdata" && req.method === "PUT") {
        await env.DB.prepare("INSERT INTO kv(key,value) VALUES('userdata',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .bind(await req.text()).run();
        return J({ ok: true });
      }
      if (p === "/releases" && req.method === "GET") {
        const items = (await env.DB.prepare("SELECT * FROM releases ORDER BY fetched DESC LIMIT 400").all()).results;
        const last = await env.DB.prepare("SELECT value FROM kv WHERE key='lastScan'").first();
        return J({ fetched: last ? last.value : null, items });
      }
      if (p === "/scan" && req.method === "POST") return J({ ok: true, found: await scan(env) });
      if (p === "/taste-scan" && req.method === "POST") return J({ ok: true, updated: await tasteScan(env) });
      if (p === "/affinity" && req.method === "GET") {
        const a = await env.DB.prepare("SELECT value FROM kv WHERE key='affinity'").first();
        return J(a ? JSON.parse(a.value) : {});
      }
      if (p === "/scan-books" && req.method === "POST") return J({ ok: true, found: await scanBooks(env) });
      if (p === "/works" && req.method === "POST") {
        const b = await req.json();
        const id = b.author + "::" + slug(b.title);
        await env.DB.prepare("INSERT OR IGNORE INTO works(id,author,title,year,kind,desc,dims,source) VALUES(?,?,?,?,?,?,?,?)")
          .bind(id, b.author, b.title, b.year || null, b.kind || "novel", b.desc || "", "{}", "release").run();
        return J({ ok: true, id });
      }
      if (p === "/works/describe" && req.method === "POST") {
        const { id } = await req.json();
        const w = await env.DB.prepare("SELECT * FROM works WHERE id=?").bind(id).first();
        if (!w) return J({ error: "unknown work" }, 404);
        const n = await env.DB.prepare("SELECT label FROM nodes WHERE id=?").bind(w.author).first();
        const items = await gbooks(`intitle:"${w.title}" inauthor:"${n ? n.label : ""}"`);
        const hit = items.map(i => i.volumeInfo || {}).find(v => v.description);
        if (!hit) return J({ desc: "" });
        const desc = hit.description.slice(0, 500);
        await env.DB.prepare("UPDATE works SET desc=?, year=COALESCE(year,?) WHERE id=?")
          .bind(desc, hit.publishedDate ? parseInt(hit.publishedDate) : null, id).run();
        return J({ desc, year: hit.publishedDate ? parseInt(hit.publishedDate) : null });
      }
      if (p === "/authors" && req.method === "POST") {
        const b = await req.json();
        await insertAuthor(env, b.node, b.links);
        return J({ ok: true });
      }
      if (p === "/claude/suggest" && req.method === "POST") return J(await claudeSuggest(env));
      return J({ error: "not found" }, 404);
    } catch (e) { return J({ error: e.message }, 500); }
  }
};
