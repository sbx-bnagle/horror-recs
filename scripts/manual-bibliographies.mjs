// Hand-curated bibliographies for authors Open Library couldn't verify.
// Run once from repo root: node scripts/manual-bibliographies.mjs
// Merges into data/works.json (skips titles already present); then reseed D1.

import { readFileSync, writeFileSync } from "node:fs";
const worksURL = new URL("../data/works.json", import.meta.url);
const works = JSON.parse(readFileSync(worksURL));

const slug = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const canon = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[:(].*$/, "").replace(/^(the|a|an)\s+/, "").replace(/[^a-z0-9]/g, "");

// [title, year, kind] — English-available principal works
const DATA = {
labatut: [["When We Cease to Understand the World", 2021, "novel"], ["The MANIAC", 2023, "novel"]],
duras: [["The Sea Wall", 1950, "novel"], ["The Square", 1955, "novel"], ["Moderato Cantabile", 1958, "novel"], ["Ten-Thirty on a Summer Night", 1960, "novel"], ["Hiroshima Mon Amour", 1960, "novel"], ["The Ravishing of Lol Stein", 1964, "novel"], ["The Vice-Consul", 1966, "novel"], ["Destroy, She Said", 1969, "novel"], ["The Malady of Death", 1982, "novel"], ["The Lover", 1984, "novel"], ["The War: A Memoir", 1985, "novel"], ["Blue Eyes, Black Hair", 1986, "novel"], ["Emily L.", 1987, "novel"], ["Summer Rain", 1990, "novel"], ["The North China Lover", 1991, "novel"], ["Writing", 1993, "novel"]],
enriquez: [["Things We Lost in the Fire", 2017, "collection"], ["The Dangers of Smoking in Bed", 2021, "collection"], ["Our Share of Night", 2023, "novel"], ["A Sunny Place for Shady People", 2024, "collection"]],
kubin: [["The Other Side", 1909, "novel"]],
manchette: [["Nada", 1972, "novel"], ["The Mad and the Bad", 1972, "novel"], ["No Room at the Morgue", 1973, "novel"], ["Three to Kill", 1976, "novel"], ["Fatale", 1977, "novel"], ["The Prone Gunman", 1981, "novel"], ["Ivory Pearl", 1996, "novel"], ["Skeletons in the Closet", 2024, "novel"]],
donoso: [["Coronation", 1957, "novel"], ["Hell Has No Limits", 1966, "novel"], ["The Obscene Bird of Night", 1970, "novel"], ["Sacred Families", 1973, "collection"], ["A House in the Country", 1978, "novel"], ["The Garden Next Door", 1981, "novel"], ["Curfew", 1986, "novel"], ["The Lizard's Tale", 2011, "novel"]],
schweblin: [["Fever Dream", 2017, "novel"], ["Mouthful of Birds", 2019, "collection"], ["Little Eyes", 2020, "novel"], ["Seven Empty Houses", 2022, "collection"]],
bazterrica: [["Tender Is the Flesh", 2020, "novel"], ["Nineteen Claws and a Black Bird", 2023, "collection"], ["The Unworthy", 2025, "novel"]],
quintana: [["The Bitch", 2020, "novel"], ["Abyss", 2023, "novel"]],
ranpo: [["Japanese Tales of Mystery and Imagination", 1956, "collection"], ["The Black Lizard and Beast in the Shadows", 2006, "novel"], ["The Edogawa Rampo Reader", 2008, "collection"], ["The Fiend with Twenty Faces", 2012, "novel"], ["Strange Tale of Panorama Island", 2013, "novel"], ["Moju: The Blind Beast", 1931, "novel"]],
aktolstoy: [["The Vampire", 1841, "novella"], ["Prince Serebrenni", 1862, "novel"], ["Vampires: Stories of the Supernatural", 1969, "collection"]],
blicher: [["The Diary of a Parish Clerk and Other Stories", 1824, "collection"], ["Twelve Stories", 1945, "collection"]],
wakefield: [["They Return at Evening", 1928, "collection"], ["Old Man's Beard", 1929, "collection"], ["Imagine a Man in a Box", 1931, "collection"], ["Ghost Stories", 1932, "collection"], ["A Ghostly Company", 1935, "collection"], ["The Clock Strikes Twelve", 1940, "collection"], ["Strayers from Sheol", 1961, "collection"], ["The Best Ghost Stories of H. Russell Wakefield", 1978, "collection"]],
wfharvey: [["Midnight House and Other Tales", 1910, "collection"], ["The Beast with Five Fingers", 1928, "collection"], ["Moods and Tenses", 1933, "collection"], ["Midnight Tales", 1946, "collection"]],
potocki: [["The Manuscript Found in Saragossa", 1815, "novel"]],
kyoka: [["Japanese Gothic Tales", 1996, "collection"], ["In Light of Shadows", 2005, "collection"]],
sologub: [["Bad Dreams", 1895, "novel"], ["The Petty Demon", 1907, "novel"], ["The Created Legend", 1913, "novel"], ["The Old House and Other Tales", 1915, "collection"], ["The Sweet-Scented Name", 1915, "collection"]],
panizza: [["The Council of Love", 1894, "novel"], ["The Operated Jew", 1893, "story"]],
tokarczuk: [["Primeval and Other Times", 2010, "novel"], ["House of Day, House of Night", 2002, "novel"], ["Flights", 2017, "novel"], ["Drive Your Plow Over the Bones of the Dead", 2018, "novel"], ["The Books of Jacob", 2021, "novel"], ["The Empusium", 2024, "novel"]],
couto: [["Under the Frangipani", 2001, "novel"], ["The Last Flight of the Flamingo", 2004, "novel"], ["Sleepwalking Land", 2006, "novel"], ["Confession of the Lioness", 2015, "novel"], ["Woman of the Ashes", 2018, "novel"], ["Rain and Other Stories", 2019, "collection"]],
tanizaki: [["Devils in Daylight", 1918, "novella"], ["Naomi", 1924, "novel"], ["Some Prefer Nettles", 1929, "novel"], ["Quicksand", 1930, "novel"], ["In Praise of Shadows", 1933, "novel"], ["The Secret History of the Lord of Musashi", 1935, "novel"], ["The Makioka Sisters", 1948, "novel"], ["The Key", 1956, "novel"], ["Diary of a Mad Old Man", 1961, "novel"], ["Seven Japanese Tales", 1963, "collection"]],
sabato: [["The Tunnel", 1948, "novel"], ["On Heroes and Tombs", 1961, "novel"], ["The Angel of Darkness", 1974, "novel"]]
};

let added = 0, skipped = 0;
for (const author in DATA) {
  works[author] = works[author] || [];
  const have = new Set(works[author].map(w => canon(w.title)));
  for (const [title, year, kind] of DATA[author]) {
    if (have.has(canon(title))) { skipped++; continue; }
    have.add(canon(title));
    works[author].push({ id: author + "::" + slug(title), title, year, kind,
      desc: "", dims: {}, signals: 0, source: "claude" });
    added++;
  }
  works[author].sort((a, b) => (a.year || 9999) - (b.year || 9999));
}
writeFileSync(worksURL, JSON.stringify(works, null, 1));
console.log(`added ${added} works, skipped ${skipped} already present, across ${Object.keys(DATA).length} authors`);
