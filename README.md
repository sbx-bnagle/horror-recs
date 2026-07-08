# Recommendotron

A personal network map of horror/noir influences and recommendations, with read tracking, ratings, a tunable recommendation model, and a scheduled new-release scan.

## Run locally

The app fetches JSON, so it needs a server rather than a `file://` open:

```
npx serve .
```

## Deploy

These steps assume the repo is already pushed to GitHub (as `sbx-bnagle/horror-recs` or similar) and you have Node 18+ installed locally.

### 1. Site (GitHub Pages)

1. On github.com, open the repo → **Settings → Pages**.
2. Under "Build and deployment", set **Source: Deploy from a branch**.
3. Branch: `main`, folder: `/ (root)`. Save.
4. GitHub builds and publishes in a minute or two; the URL appears at the top of that same Pages settings screen (`https://sbx-bnagle.github.io/horror-recs/`).
5. Open it. With no worker configured yet, the app reads the static files in `data/` — you should see the full map, but ratings/settings will only persist to this browser (localStorage) until the worker is connected.

### 2. Worker + database (Cloudflare)

**One-time setup**

1. If you don't have a Cloudflare account, create one (free tier) at cloudflare.com.
2. Install Wrangler (Cloudflare's CLI) as a one-off, no global install needed — the commands below use `npx` so this happens automatically. If you'd rather install it once: `npm install -g wrangler`.
3. Authenticate:
   ```
   cd worker
   npx wrangler login
   ```
   This opens a browser tab to authorize; approve it, return to the terminal.

**Create the database**

4. ```
   npx wrangler d1 create recommendotron
   ```
   This prints a block like:
   ```
   [[d1_databases]]
   binding = "DB"
   database_name = "recommendotron"
   database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
   ```
5. Open `worker/wrangler.toml` and replace `REPLACE_WITH_YOUR_D1_ID` with the `database_id` value from step 4. Save.

**Load the schema and your existing data**

6. ```
   npx wrangler d1 execute recommendotron --remote --file=schema.sql
   ```
   Creates the tables. You should see "Executed X commands" with no errors.
7. Regenerate the seed file from your current local data (skip this only if you haven't changed `data/*.json` since the zip was built):
   ```
   node ../scripts/make-seed-sql.mjs
   ```
8. ```
   npx wrangler d1 execute recommendotron --remote --file=seed.sql
   ```
   This loads your ~296 authors and ~383 works into the live database. It's a big file, so this can take a minute; occasional "already exists" notices are expected and harmless (the script uses `INSERT OR IGNORE`/`INSERT OR REPLACE`).

**Set secrets**

9. ```
   npx wrangler secret put ANTHROPIC_API_KEY
   ```
   Paste your Anthropic API key when prompted (from console.anthropic.com → API Keys). This powers the in-app "Ask Claude for author suggestions" button; skip this step if you don't want that feature yet, but leaving it unset means that one button will fail while everything else works.
10. ```
    npx wrangler secret put APP_TOKEN
    ```
    Make up any password-like string (e.g. generate one with `openssl rand -hex 16`). This is shared between the worker and the app to keep your database private — anyone with the worker URL but not this token gets a 401. Write it down; you'll enter it in the app in a moment.

**Deploy**

11. ```
    npx wrangler deploy
    ```
    Prints a URL like `https://recommendotron.YOUR-SUBDOMAIN.workers.dev`. That's your worker URL — copy it.

### 3. Connect the app to the worker

1. Open the Pages site from step 1.
2. Click the gear (⚙) icon in the sidebar to open Settings.
3. Under "Worker connection", paste the worker URL from step 11 into **Worker URL**, and the string you made up in step 10 into **App token**. The page reloads automatically after each field.
4. Status should change to "connected" (or "synced" after the first save). If it says "unavailable" or shows an error, see Troubleshooting below.

### 4. Verify

- Rate a work, close the tab, reopen the site (even in a different browser) — the rating should still be there. That confirms D1 is the source of truth, not just localStorage.
- In the **New** tab, click "Check for new releases" — should say "Scan complete" within ~10-20 seconds.
- Click "Ask Claude for author suggestions" — takes up to ~30 seconds; returns a short list with "Add to map" buttons (requires the `ANTHROPIC_API_KEY` secret from step 9).

### Troubleshooting

- **Settings shows "unavailable (401)"** — the App token in the app doesn't match the worker's `APP_TOKEN` secret. Re-run `npx wrangler secret put APP_TOKEN`, re-enter the same value in the app.
- **"unavailable (500)" on /catalog** — usually means schema or seed didn't load. Re-run steps 6 and 8; check for error output.
- **CORS error in the browser console** — confirm the worker URL in Settings has no trailing slash and starts with `https://`.
- **Claude suggestions fail with a 500** — `ANTHROPIC_API_KEY` secret missing or invalid; re-run step 9.
- **Scan finds nothing / "skip <source>" in `npx wrangler tail`** — a publisher changed its site structure and feed autodiscovery failed for that one source; this is expected occasionally and doesn't block the rest of the scan. Run `npx wrangler tail` in the worker folder while triggering a scan to see live logs.
- **Changes to `data/*.json` don't show up on the live site** — once the worker is connected, the app reads from D1, not the static files. Re-run the seed steps (6-8) to push local edits into D1, or use the in-app "Add to catalog" / "Add to map" actions instead.

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

### Running the bibliography script

From the repo root:

```
node scripts/fetch-bibliographies.mjs --all
```

Pulls full bibliographies from Open Library for every author. At a polite 600ms per request, ~300 authors takes 3-4 minutes, printing progress per author (`Laird Barron: +42 (44 total)`). To test first, or target specific authors:

```
node scripts/fetch-bibliographies.mjs barron tuttle mcdowell
```

It merges into `data/works.json` without touching existing descriptions, dims, or tasteMatch values.

**Then push the results into D1** — the live app reads from the database, not the JSON files:

```
node scripts/make-seed-sql.mjs
cd worker
npx wrangler d1 execute recommendotron --remote --file=seed.sql
```

The seed uses `INSERT OR IGNORE`, so new works are added without clobbering anything already in D1. Reload the app to see the expanded works lists.

Expectation to set: Open Library data is messy for prolific authors — duplicate-ish entries under variant titles, omnibus editions, occasional wrong attributions. Fine as raw material; prune oddities from the All tab as you notice them, or ask Claude for a cleanup pass on `works.json`.

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
