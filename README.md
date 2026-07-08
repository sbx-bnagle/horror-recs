# Recommendotron

A personal network map of horror/noir influences and recommendations, with read tracking, ratings, a tunable recommendation model, and a scheduled new-release scan.

## Run locally

The app fetches JSON, so it needs a server rather than a `file://` open:

```
npx serve .
```

## Deploy

**Site:** push to GitHub, enable Pages (or any static host). The static `data/*.json` files serve as fallback when the worker isn't configured.

**Worker (Cloudflare):**

```
cd worker
npx wrangler d1 create recommendotron        # copy the id into wrangler.toml
npx wrangler d1 execute recommendotron --remote --file=schema.sql
node ../scripts/make-seed-sql.mjs            # regenerates seed.sql from data/*.json
npx wrangler d1 execute recommendotron --remote --file=seed.sql
npx wrangler secret put ANTHROPIC_API_KEY    # for in-app Claude suggestions
npx wrangler secret put APP_TOKEN            # any string; enter the same in the app
npx wrangler deploy
```

Then in the app's Settings: enter the worker URL and app token. The app loads catalog/releases/ratings from D1 and saves changes back automatically. The worker runs the release + award scan every Monday (cron) and on the "Check for new releases" button. Note: the scan makes ~45 outbound fetches; on Cloudflare's free tier (50 subrequests) this is near the limit, so a source or two may be skipped per run.

## Data files

- `data/graph.json` — nodes (authors, directors, publishers), links, clusters. Add new authors here.
- `data/works.json` — works per author. Grown by the bibliography script; `desc`, `dims`, and `signals` are hand- or Claude-enriched and never overwritten by the script.
- `data/scoring.json` — the scoring model defaults. Your in-app tuning is stored separately in user data.
- `data/publishers.json` — sources for the release scan.
- `data/releases.json` — scan output.

## Scripts

```
node scripts/fetch-releases.mjs            # publisher feeds + award pages → releases.json
node scripts/fetch-bibliographies.mjs --all         # full bibliographies via Open Library
node scripts/fetch-bibliographies.mjs barron tuttle # specific authors
```

Both are zero-dependency (Node 18+). The release scan is best-effort: sources without a discoverable feed are logged and skipped; correct or add feed URLs in `data/publishers.json`.

## Scoring model

Transparent and inspectable in the app (Settings tab, and "score breakdown" under any work):

```
score = base
      + clusterWeight × clusterAffinity(cluster)
      + authorWeight  × (typeAffinity + learnedAuthorDelta)
      + dimScale × Σ dimensionWeight[d] × workDims[d]
      + signalWeight × min(signals, signalCap)
```

Rating a work nudges dimension weights toward your judgment (simple gradient on the answered dimensions) and adjusts the author's affinity. The classification questions both place the work (its `dims`) and feed that learning.

`signals` is a count of independent external recommendations (Reddit, Letterboxd-adjacent lists, etc.) matched against your highly rated titles. This is research done at build time; to refresh it, ask Claude to re-run the research and update `works.json`.

## New-author loop

The scan covers the sixteen presses, Bloody Disgusting, CrimeReads, Reactor, and the six award pages (Stoker, Shirley Jackson, Booker, Edgar, Locus horror, Splatterpunk). Items naming a known author get an "Add to catalog" button. For everything else, "Ask Claude for author suggestions" in the New tab has the worker send your ratings plus unmatched items (including award citations) to Claude; suggested authors render with one-click "Add to map". The clipboard-prompt button and `scripts/merge-graph-additions.mjs` remain as the offline version of the same loop.

## Taste matching (tasteMatch)

Three sources feed a per-work `tasteMatch` (0-1), which the score weights via `tasteWeight` (Settings slider):

1. **Build-time research** — export your user data, give it to Claude in chat, and ask for a taste-research refresh. Merge the result: `node scripts/merge-taste-research.mjs taste-research.json`
2. **Co-occurrence** — `node scripts/fetch-taste.mjs recommendotron-userdata.json` searches r/horrorlit and r/weirdlit for your 4-5 star titles and counts which unread works appear alongside them, plus Open Library subject overlap. Hardcover's open API is stubbed as a third source.
3. **CF baseline** — `node scripts/cf-baseline.mjs <dump-dir> recommendotron-userdata.json` runs collaborative filtering against the UCSD Goodreads research dump (static ~2017): users whose ratings correlate with yours vote on your candidates.

All three merge into `works.json`, keeping the highest value per work.

## User data

Primary persistence is the worker's D1 database: every change saves automatically (debounced) in any browser, and the remote copy wins on load.

Fallbacks, in order: "Connect data file…" under Settings → Your data writes to a local JSON file (Chromium only, offline use); localStorage caches everything; Export/Import works everywhere.

## Growing the map

- New release worth adding: create the work under its author in `works.json` (or add the author to `graph.json` plus a link line).
- Full bibliographies: run the bibliography script; it merges without clobbering your edits.
- Score research refresh: ask Claude to re-run web research against your current ratings export.
