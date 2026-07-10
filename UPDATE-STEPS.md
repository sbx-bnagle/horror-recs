# Update steps

Files in this package mirror the repo structure. Extract from INSIDE the repo root
so files land in place (no wrapper folder this time):

    cd path/to/horror-recs
    unzip -o path/to/recommendotron-update.zip

Does NOT include worker/wrangler.toml or data/ - your database id and local data are safe.

## What each file is

- index.html                        - your Design frontend + author-grouped recs, filter fix, story markers
- worker/src/index.js               - English-only Google Books scan, describe endpoint
- worker/story-meta.sql             - one-time: tags ~40 touchstone stories/novellas with their collections
- scripts/fetch-bibliographies.mjs  - author-entity verification (kills homonyms), foreign-title filter
- scripts/clean-works.mjs           - junk/duplicate/foreign cleanup for existing data
- scripts/make-seed-sql.mjs         - has the --sync-works flag
- scripts/fetch-releases.mjs        - offline scan, English-restricted

## Order of operations

1. Frontend + worker

    git add -A && git commit -m "Update" && git push        # updates Pages
    cd worker
    npx wrangler deploy                                      # new scan + describe endpoint
    npx wrangler d1 execute recommendotron --remote --file=story-meta.sql
    npx wrangler d1 execute recommendotron --remote --command "DELETE FROM releases"
    cd ..

2. Rebuild the works catalog (from repo root)

    # purge unenriched openlibrary rows (ratings/classified/described/seed works survive)
    node -e "const fs=require('fs');const w=JSON.parse(fs.readFileSync('data/works.json'));let n=0;for(const a in w){const b=w[a].length;w[a]=w[a].filter(x=>x.source!=='openlibrary'||x.desc||Object.keys(x.dims||{}).length||x.signals||x.tasteMatch);n+=b-w[a].length;}fs.writeFileSync('data/works.json',JSON.stringify(w,null,1));console.log('removed',n)"

    node scripts/fetch-bibliographies.mjs --all              # 10-15 min; watch for "skipped" authors
    node scripts/clean-works.mjs --dry                       # preview
    node scripts/clean-works.mjs                             # apply
    node scripts/make-seed-sql.mjs --sync-works              # IMPORTANT: without this flag old junk survives
    cd worker
    npx wrangler d1 execute recommendotron --remote --file=seed.sql
    cd ..
    git add -A && git commit -m "Rebuilt works catalog" && git push

3. Verify

    - Hard-refresh the site (Cmd+Shift+R)
    - Recs tab: grouped by author, one cluster chip filters exactly
    - Tryon: brewing tracts gone; Nevill: El fin de los dias gone
    - Smoke Ghost row shows "· story" and its collection in the description
    - New tab scan: English-only books

If fetch-bibliographies logs "no candidate matched known works, skipped" for any author,
paste those names to Claude - their existing entries are untouched, they just did not expand.
