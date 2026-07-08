// Recommendotron worker: D1-backed API + weekly scan + Claude proxy.
// Secrets: ANTHROPIC_API_KEY, APP_TOKEN. Binding: DB (D1).

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-app-token",
  "access-control-allow-methods": "GET,PUT,POST,OPTIONS"
};
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", ...CORS } });

/* ---------------- sources ---------------- */
const SOURCES = [
  ["Valancourt Books", "https://www.valancourtbooks.com/"],
  ["Word Horde", "https://wordhorde.com/"],
  ["Cemetery Dance", "https://www.cemeterydance.com/"],
  ["Vintage Crime/Black Lizard", "https://knopfdoubleday.com/imprint/vintage-crime-black-lizard/"],
  ["Tartarus Press", "https://www.tartaruspress.com/"],
  ["Night Shade Books", "https://www.nightshadebooks.com/"],
  ["Creature Publishing", "https://creaturehorror.com/"],
  ["Dark Moon Books", "https://www.darkmoonbooks.com/"],
  ["Flame Tree Press", "https://www.flametreepublishing.com/"],
  ["Shortwave Publishing", "https://shortwavepublishing.com/"],
  ["Tor Nightfire", "https://tornightfire.com/"],
  ["Tenebrous Press", "https://www.tenebrouspress.com/"],
  ["Undertow Publications", "https://undertowpublications.com/"],
  ["Grimscribe Press", "https://grimscribepress.com/"],
  ["Subterranean Press", "https://subterraneanpress.com/"],
  ["Penguin Random House (horror)", "https://www.penguinrandomhouse.com/books/horror/"],
  ["Bloody Disgusting", "https://bloody-disgusting.com/feed/", true],
  ["CrimeReads", "https://crimereads.com/feed/", true],
  ["Reactor", "https://reactormag.com/feed/", true]
];
const AWARDS = [
  ["Bram Stoker Awards", "Bram_Stoker_Award"],
  ["Shirley Jackson Awards", "Shirley_Jackson_Award"],
  ["Booker Prize", "Booker_Prize"],
  ["Edgar Awards", "Edgar_Award"],
  ["Locus Award (horror)", "Locus_Award_for_Best_Horror_Novel"],
  ["Splatterpunk Awards", "Splatterpunk_Award"]
];

/* ---------------- scan ---------------- */
const UA = { headers: { "user-agent": "recommendotron/2.0 (personal reading tool)" } };
const strip = s => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#8217;|&rsquo;/g, "\u2019")
  .replace(/&#8216;/g, "\u2018").replace(/&#821[12];|&mdash;|&ndash;/g, "-").replace(/&quot;/g, '"')
  .replace(/&#\d+;/g, "").replace(/\s+/g, " ").trim();

async function get(url) {
  const r = await fetch(url, UA);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}
function parseFeed(xml, source) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/g) || [];
  return blocks.slice(0, 20).map(b => {
    const pick = t => { const m = b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? strip(m[1]) : ""; };
    const la = b.match(/<link[^>]*href="([^"]+)"/);
    return { title: pick("title"), url: pick("link") || (la ? la[1] : ""), date: pick("pubDate") || pick("updated") || "",
      summary: (pick("description") || pick("summary")).slice(0, 240), source, kind: "publisher" };
  }).filter(i => i.title);
}
async function findFeed(pageUrl) {
  const html = await get(pageUrl);
  const m = html.match(/<link[^>]+type="application\/(?:rss|atom)\+xml"[^>]+href="([^"]+)"/i)
        || html.match(/href="([^"]+(?:feed|rss)[^"]*)"/i);
  return m ? new URL(m[1], pageUrl).href : null;
}
async function scan(env) {
  const items = [];
  for (const [name, url, isFeed] of SOURCES) {
    try {
      const feed = isFeed ? url : await findFeed(url);
      if (!feed) continue;
      items.push(...parseFeed(await get(feed), name));
    } catch (e) { console.log(`skip ${name}: ${e.message}`); }
  }
  const yr = new Date().getFullYear();
  for (const [name, page] of AWARDS) {
    try {
      const html = await get(`https://en.wikipedia.org/api/rest_v1/page/html/${page}`);
      for (const li of html.match(/<li[\s>][\s\S]*?<\/li>/g) || []) {
        const text = strip(li);
        if ((text.includes(String(yr)) || text.includes(String(yr - 1))) && text.length > 15 && text.length < 220)
          items.push({ title: text, url: `https://en.wikipedia.org/wiki/${page}`, date: "", summary: "", source: name, kind: "award" });
      }
    } catch (e) { console.log(`skip ${name}: ${e.message}`); }
  }
  // tag known authors
  const nodes = (await env.DB.prepare("SELECT id,label FROM nodes WHERE type IN ('influence','rec')").all()).results;
  const authors = nodes.map(n => ({ id: n.id, label: n.label.toLowerCase() })).filter(a => a.label.length > 5);
  const now = new Date().toISOString();
  const stmt = env.DB.prepare(
    "INSERT OR IGNORE INTO releases(key,title,url,date,source,kind,author,summary,fetched) VALUES(?,?,?,?,?,?,?,?,?)");
  const batch = [];
  for (const it of items) {
    const hay = (it.title + " " + it.summary).toLowerCase();
    const hit = authors.find(a => hay.includes(a.label));
    batch.push(stmt.bind((it.title + "|" + it.source).toLowerCase().slice(0, 300),
      it.title, it.url, it.date, it.source, it.kind, hit ? hit.id : null, it.summary, now));
  }
  if (batch.length) await env.DB.batch(batch);
  await env.DB.prepare("INSERT INTO kv(key,value) VALUES('lastScan',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(now).run();
  return items.length;
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
  async scheduled(event, env) { await scan(env); },
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
      if (p === "/works" && req.method === "POST") {
        const b = await req.json();
        const id = b.author + "::" + slug(b.title);
        await env.DB.prepare("INSERT OR IGNORE INTO works(id,author,title,year,kind,desc,dims,source) VALUES(?,?,?,?,?,?,?,?)")
          .bind(id, b.author, b.title, b.year || null, b.kind || "novel", b.desc || "", "{}", "release").run();
        return J({ ok: true, id });
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
