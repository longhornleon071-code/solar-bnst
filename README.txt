SOLAR BNST — SERVER V2

Files:
- server.mjs: backend API server
- public/index.html: website frontend
- package.json: Render start command and Node version

Run locally:
1. Install Node.js 22.16.x.
2. Run: npm start
3. Open the URL printed in the logs.

Render:
- Runtime: Node
- Build command: npm install (no external dependencies are required)
- Start command: npm start
- Node version: 22.16.x (or a compatible Node 22 release)

Important:
- Keep server.mjs and public/index.html together in this folder structure.
- Persistent database file is controlled by DB_PATH; back up the database before replacing an existing server.
- First startup prints a one-time owner setup code in the server logs. Save it securely.
- Node may print an ExperimentalWarning for node:sqlite on Node 22.
