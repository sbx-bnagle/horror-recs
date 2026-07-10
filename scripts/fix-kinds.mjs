// Curated kind corrections for known catalog works (collection / novella / anthology / other).
// Run from repo root: node scripts/fix-kinds.mjs
// Patches data/works.json AND writes worker/kind-fixes.sql for direct D1 application
// (needed because seed/claude rows aren't replaced by --sync-works reseeds).

import { readFileSync, writeFileSync } from "node:fs";
const worksURL = new URL("../data/works.json", import.meta.url);
const works = JSON.parse(readFileSync(worksURL));

// id -> kind. "collection" = single-author story collection; "novella"; "other" = play/essay/nonfiction.
const FIX = {
"klein::dark-gods":"collection","evenson::a-collapse-of-horses":"collection","tuttle::a-nest-of-nightmares":"collection",
"barron::the-imago-sequence":"collection","barron::occultation":"collection","lamsley::conference-with-the-dead":"collection",
"ballingrud::wounds":"collection","ballingrud::north-american-lake-monsters":"collection","link::get-in-trouble":"collection",
"machado::her-body-and-other-parties":"collection","enriquez::things-we-lost-in-the-fire":"collection",
"borachung::cursed-bunny":"collection","davila::the-houseguest":"collection","grabinski::the-dark-domain":"collection",
"aickman::cold-hand-in-mine":"collection","ligotti::songs-of-a-dead-dreamer":"collection",
"bradbury::the-october-country":"collection","etchison::the-dark-country":"collection","tem::city-fishing":"collection",
"barker::books-of-blood":"collection","barker::the-hellbound-heart":"novella",
"rcampbell::alone-with-the-horrors":"collection","chambers::the-king-in-yellow":"collection",
"saki::the-chronicles-of-clovis":"collection","onions::widdershins":"collection","borges::ficciones":"collection",
"schulz::the-street-of-crocodiles":"collection","strobl::lemuria":"collection","dunsany::the-gods-of-peg-na":"collection",
"schirach::crime":"collection","schirach::guilt":"collection","kis::a-tomb-for-boris-davidovich":"collection",
"wehunt::greener-pastures":"collection","llewellyn::furnace":"collection","samuels::the-white-hands":"collection",
"padgett::the-secret-of-ventriloquism":"collection","due::ghost-summer":"collection","tidbeck::jagannath":"collection",
"mjharrison::viriconium":"collection","sapkowski::the-last-wish":"collection","oconnor::a-good-man-is-hard-to-find":"collection",
"bass::the-watch":"collection","vann::legend-of-a-suicide":"collection","woodrell::the-outlaw-album":"collection",
"onoh::unhallowed-graves":"collection","akinari::ugetsu-monogatari":"collection","hearn::kwaidan":"collection",
"villiers::cruel-tales":"collection","otsuichi::zoo":"collection","grant::the-orchard":"collection",
"lavalle::the-ballad-of-black-tom":"novella","hjames::the-turn-of-the-screw":"novella",
"gotthelf::the-black-spider":"novella","kristof::the-notebook":"novella",
"macfarlane::underland":"other","tanizaki::in-praise-of-shadows":"other","duras::the-war-a-memoir":"other",
"panizza::the-council-of-love":"other","panizza::the-pig":"other","malet::nestor-burma-series":"other",
"bakker::the-second-apocalypse":"other","peake::gormenghast-trilogy":"other","erikson::malazan-book-of-the-fallen":"other",
"ito::tomie":"other","ito::uzumaki":"other"
};

const index = {};
for (const a in works) for (const w of works[a]) index[w.id] = w;
const esc = v => v.replace(/'/g, "''");
const sql = [];
let hit = 0, miss = [];
for (const id in FIX) {
  const w = index[id];
  if (!w) { miss.push(id); continue; }
  w.kind = FIX[id];
  sql.push(`UPDATE works SET kind='${FIX[id]}' WHERE id='${esc(id)}';`);
  hit++;
}
writeFileSync(worksURL, JSON.stringify(works, null, 1));
writeFileSync(new URL("../worker/kind-fixes.sql", import.meta.url), sql.join("\n"));
console.log(`fixed ${hit} kinds; wrote worker/kind-fixes.sql${miss.length ? "; not found (ok if not fetched yet): " + miss.join(", ") : ""}`);
