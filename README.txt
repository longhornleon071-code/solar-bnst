# Solar BNST — Christmas update

## Requirements
- Node.js 22.16.x (uses the built-in `node:sqlite` module).
- No third-party npm dependencies are required.

## Run locally
1. Keep `server.mjs`, `package.json`, `README.txt`, and the `public/` folder together.
2. Run `npm start` or `node server.mjs`.
3. Open `http://localhost:8787`.

## Included
- Christmas-themed Solar BNST interface from `public/index.html`.
- Adopt Me (ADM) and Murder Mystery 2 (MM2) value catalogues.
- WFL trade calculator and Normal / Neon / Mega Neon mutation choices for Adopt Me.
- Catalogue search, item images, editor endpoints, and Community Market API.
- Best-effort catalogue sync endpoint (`POST /api/items/sync-catalog`) for compatible public pages.

## Important notes
- The included ADM starter values are estimates, not guaranteed live market values. Check them before relying on them for trades.
- Catalogue images and values depend on saved database data. Syncing public community pages is best-effort and may fail when a source changes or blocks requests.
- The app uses a local SQLite database. Back up the database file before replacing server code or deploying changes.
- Keep `server.mjs` at the project root and the website file at `public/index.html`.
