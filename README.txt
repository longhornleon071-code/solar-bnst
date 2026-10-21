Solar BNST — updated project

REQUIREMENTS
- Node.js 22 or newer (uses the built-in node:sqlite module)
- No npm packages required

RUN
1. Keep server.mjs and the public folder together.
2. In a terminal, run:  node server.mjs
3. Open:  http://localhost:8787
4. Optional: set PORT, DB_PATH, and GOOGLE_CLIENT_ID as environment variables.

FIRST RUN
- The owner setup code is printed in the terminal once. Enter it on the First-time setup screen.
- Do not open public/index.html as a file. The app needs the API server.
- Back up solar-bnst.db before updating an existing deployment. Updates add columns and tables; they never reset data.

WHAT'S IN THIS VERSION
- Account page (everyone): Profile with pictures and banner, Settings, About, your alerts, and your holds.
- Admin panel (Owner and Co-Owner only): revenue, staff, roles, ban and suspension, audit log, survey responses, and GC links.
  The server enforces this, not just the screen.
- Admins keep the queue: assigning MM/MW, moving deal statuses, disputes, and cancellations.
- Discovery survey for new users. Responses are visible only to the Owner and Co-Owner.
- Ban and suspension with a reason. Suspensions can last up to one year and lift automatically.
- Leaderboard: Daily, Weekly, and Monthly (Philippine time), ranked by estimated fees or completed deals.
- GC links: Mix GC1, MM2 GC2, and ADM GC3 are seeded on first start, then managed from the admin panel.
- Community Market: browse active ADM/MM2 listings, search by game/item, publish an asking price and optional notes/contact link, mark your own listings sold, or remove them. Listing permissions are enforced by the server.
- Item values: pick Adopt Me (ADM) or Murder Mystery 2 (MM2), then search items. The starter data is a seed, not a claim that the shipped database already contains every live item. Owner/Co-Owner and authorized value editors can add, edit, delete, import, and add pictures. Item values are game-trading points, NOT PHP. Each item can have an uploaded picture (JPG, PNG, WEBP, or GIF, up to 2 MB) or an HTTPS image URL.
  Owner and Co-Owner can edit values. They can also give the "value editor" privilege to any staff member in the admin panel.
  Bulk import: paste one item per line as "name,value" (or "name<TAB>value"). Existing names get their value updated. Editors can also use “Sync catalogue & pictures” to fetch publicly available catalogue data from community pages; parsing depends on what those pages expose and may leave some items without values or pictures. Confirm the returned sync counts.
  Sheets (tabs), ADM: Common, Uncommon, Rare, Ultra Rare, Legendary, then Pets, Food, Vehicles, Strollers, Gifts, Toys, Stickers, Pet Wear, Other.
  Sheets, MM2: Knife, Gun, Other. Each item belongs to one sheet. Search checks every sheet.
  Variants (Neon, Mega Neon, Fly, Ride) are written into the item name, for example "Neon Dragon" or "Fly Mega Neon Dragon".
  Every value change is recorded in the audit log.
- Trade calculator (WFL): pick ADM or MM2, add items to "You give" and "You get," adjust quantities, see each item picture and subtotal, and get WIN, FAIR, or LOSE. It uses the same game_items catalogue and numeric values as Item Values; unvalued items are excluded and warned about.
  The result is worked out from the values in this app. WIN means you get more than 5% over what you give.
  LOSE means you get more than 5% under. Anything in between is FAIR. The 5% band is set in the code as FAIR_BAND.
  Items with no value are shown with a warning and are not counted. WFL values are shown as points, not Philippine pesos. Item pictures appear in value cards and in WFL search/selected items whenever an image is available.
- Chat assistant: the Owner or Co-Owner pastes an https:// link in the admin panel. It appears on the Account page in a sandboxed frame. The site that hosts the assistant must allow being embedded.

ROLES
- Member, Trial Mod, Trial Admin, Mod, Admin, Head Mod, Head Admin, Co-Owner, Owner.
- Only the Owner and Co-Owner can change roles. The Owner can give any role, including Owner, with no limit.
- Nobody can change their own role. The last active Owner cannot be demoted or deactivated.

TESTS
- Backend suites (run against a running server):
    node tests/run.mjs <baseUrl> <dbPath> <setupCode>      # roles, moderation, images, survey, GC link
    node tests/regress.mjs <baseUrl> <dbPath>              # existing transaction workflow
    MODE=legacy node tests/run.mjs <baseUrl> <dbPath> ""   # migration from an older database
- Browser suites need Python with Playwright and Chromium:
    python3 tests/ui.py     and     python3 tests/ui2.py
    python3 tests/values.py (needs a server on port 8980 with a fresh database)
    python3 tests/smoke.py  (needs a server on port 8970 with a seeded database)
    python3 tests/trade.py  (needs a server on port 8985 with a fresh database)

KNOWN LIMITS
- Google sign-in needs GOOGLE_CLIENT_ID; it is not configured by default.
- Uploaded images are checked by file signature and size. Images are stored in the database.
- Periods on the leaderboard use Philippine time (UTC+8), hard-coded.
- Existing databases keep their items. The initial catalogue seeds are not a full catalogue. Authorized editors can add/import items or try the community-source sync button. Sync is best-effort and cannot guarantee that every item/value is present.
- Community values can change quickly and are not official Roblox prices. Verify the latest source before making a trade.
- Automatic posting to Messenger group chats is not supported by Meta for regular group chats.


MARKET SAFETY
- Market listings are community posts, not escrow or payment processing. Solar BNST does not guarantee trades. Contact links must be HTTPS Facebook/Messenger links. Never share passwords or login codes.
- Existing databases keep existing item values; starter ADM rows are inserted only when their exact names do not already exist.


Catalogue sync note

Use “Sync catalogue & pictures” from the ADM or MM2 Item Values screen while signed in as Owner, Co-Owner, or an authorized value editor. The sync now checks multiple category pages instead of relying only on a landing page. Adopt Me sources include pets, eggs, vehicles, strollers, toys, food, pet wear, gifts, stickers, houses, and Halloween pets. MM2 sources include knives, guns, pets, misc/sets, and rarity pages. When the server can access those pages and the source HTML exposes the rows, it imports names, community values, and image URLs into the same catalogue used by WFL.

Important limitations: this execution environment could not access the public internet, so the live import has not been run or verified here. Source websites may change their HTML, use client-rendered data, block requests, omit images, or have items with no numeric value. Check the sync report and item counts after deployment; do not treat the shipped seed data as the complete live catalogue. Community trading values are estimates, not official Roblox prices, and may differ between value lists. Always verify high-value trades.

Current reference sources:
- Adopt Me: https://adoptme.trading/values
- MM2: https://mm2calculator.com/mm2-values
