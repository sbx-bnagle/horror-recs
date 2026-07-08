// Scan publisher sites (RSS where available) and award pages, write data/releases.json.
// Zero dependencies; Node 18+. Run: node scripts/fetch-releases.mjs
// Best-effort by design: sources that fail are logged and skipped.

import { readFileSync, writeFileSync } from "node:fs";

const CFG = JSON.parse(readFileSync(new URL("../data/publishers.json", import.meta.url)));
const OUT = new URL("../data/releases.json", import.meta.url);
const PREV = (() => { try { return JSON.parse(readFileSync(OUT)); } catch { return { items: [] }; } })();

const UA = { headers: { "user-agent": "influence-map/1.0 (personal reading tracker)" } };
const strip = s => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#8217;|&rsquo;/g, "\u2019")
  .replace(/&#8216;/g, "\u2018").replace(/&#821[12];|&mdash;|&ndash;/g, "-").replace(/&quot;/g, '"')
  .replace(/&#\d+;/g, "").replace(/\s+/g, " ").trim();

async function get(url) {
  const r = await fetch(url, UA);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

function parseFeed(xml, sourceName) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/g) || [];
  for (const b of blocks.slice(0, 20)) {
    const pick = tag => { const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return m ? strip(m[1]) : ""; };
    const linkAttr = b.match(/<link[^>]*href="([^"]+)"/);
    items.push({
      title: pick("title"),
      url: pick("link") || (linkAttr ? linkAttr[1] : ""),
      date: pick("pubDate") || pick("updated") || pick("published") || "",
      summary: pick("description").slice(0, 240) || pick("summary").slice(0, 240),
      source: sourceName, kind: "publisher"
    });
  }
  return items.filter(i => i.title);
}

async function findFeed(pageUrl) {
  const html = await get(pageUrl);
  const m = html.match(/<link[^>]+type="application\/(?:rss|atom)\+xml"[^>]+href="([^"]+)"/i)
        || html.match(/href="([^"]+(?:feed|rss)[^"]*)"/i);
  if (!m) return null;
  return new URL(m[1], pageUrl).href;
}

async function fetchPublisher(p) {
  let feed = p.type === "rss" ? p.url : await findFeed(p.url);
  if (!feed) { console.warn(`no feed found: ${p.name}`); return []; }
  return parseFeed(await get(feed), p.name);
}

async function fetchAward(a) {
  // Wikipedia REST HTML; grab list items that mention the current or previous year.
  const html = await get(`https://en.wikipedia.org/api/rest_v1/page/html/${a.page}`);
  const yr = new Date().getFullYear();
  const items = [];
  for (const li of html.match(/<li[\s>][\s\S]*?<\/li>/g) || []) {
    const text = strip(li);
    if ((text.includes(String(yr)) || text.includes(String(yr - 1))) && text.length > 15 && text.length < 220) {
      items.push({ title: text, url: `https://en.wikipedia.org/wiki/${a.page}`, date: "", summary: "", source: a.name, kind: "award" });
    }
  }
  return items.slice(0, 25);
}

const GRAPH = JSON.parse(readFileSync(new URL("../data/graph.json", import.meta.url)));
const AUTHORS = GRAPH.nodes.filter(n => n.type === "influence" || n.type === "rec")
  .map(n => ({ id: n.id, label: n.label.toLowerCase() }))
  .filter(a => a.label.length > 5);
const tagAuthor = it => {
  const hay = (it.title + " " + (it.summary || "")).toLowerCase();
  const hit = AUTHORS.find(a => hay.includes(a.label));
  if (hit) it.author = hit.id;
  return it;
};

const results = [];
for (const p of CFG.publishers) {
  try { results.push(...await fetchPublisher(p)); console.log(`ok: ${p.name}`); }
  catch (e) { console.warn(`skip ${p.name}: ${e.message}`); }
}
for (const a of CFG.awards) {
  try { results.push(...await fetchAward(a)); console.log(`ok: ${a.name}`); }
  catch (e) { console.warn(`skip ${a.name}: ${e.message}`); }
}

// merge with previous, dedupe on title+source, cap at 400
const seen = new Set();
const merged = [...results.map(tagAuthor), ...(PREV.items || [])].filter(i => {
  const k = (i.title + "|" + i.source).toLowerCase();
  if (seen.has(k)) return false; seen.add(k); return true;
}).slice(0, 400);

writeFileSync(OUT, JSON.stringify({ fetched: new Date().toISOString(), items: merged }, null, 1));
console.log(`wrote ${merged.length} items`);
