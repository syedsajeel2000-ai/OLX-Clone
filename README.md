# Bazaarly — OLX-Inspired Online Marketplace

A **fully functional** buy-and-sell classifieds marketplace (buyers **and** sellers — one account can do both) built with **Node.js + Express + SQLite (better-sqlite3)**. Guests see a marketing **landing page**; signing up unlocks the full **marketplace** with **7,000 listings**, each with its **own unique image**, plus **Bazaarly AI** — an instant AI assistant (Google Gemini) living inside your chat inbox.

> Original project inspired by the general concept of classifieds platforms. No proprietary code, logos or assets from OLX are used.

---

## Bazaarly AI (Gemini)

The chat inbox has a pinned **✨ Bazaarly AI** assistant. Ask "is this price fair?", "how do I negotiate?", "how do I post an ad?" — replies stream in instantly (SSE) and **every question and answer is stored in SQLite** like any other conversation.

**AI price suggestions** (post-ad form): click **✨ Suggest Price with AI** after typing a title and the app pulls up to 8 keyword-scored comparable listings from SQLite for that category, asks Gemini for a fair PKR range grounded in those comps, and offers a one-tap **Use this price** button that fills the price field. Login required; the feature hides itself when no API key is configured.

Setup (optional — the app works without it):

1. Get a key at <https://aistudio.google.com/apikey>
2. Put it in `.env` (see `.env.example`): `GEMINI_API_KEY=...`
3. Restart — done.

Model: defaults to a fast flash model with `thinkingConfig.thinkingBudget = 0` (no thinking pause) and an automatic fallback chain if a model is unavailable. Override with `GEMINI_MODEL` in `.env`.

## Dark mode

A 🌙 toggle in the header (and Light/Dark options under **Account Settings → Appearance**) switches the whole app — landing page and marketplace alike. The choice **persists per user in SQLite** (`users.theme`), so it follows the account across devices and sessions; guests keep theirs in a 1-year cookie. Implementation is pure CSS design tokens: `[data-theme="dark"]` on `<html>` overrides the same `--bg`/`--surface`/`--text`/shadow variables the light theme uses, so every component adapts automatically.

## Unique images for 7,000 listings

`node scripts/fetch-images.js` harvests **~5,200 keyword-relevant CC-licensed photos** (Openverse/Flickr, no key, rate-limit friendly, resumable) into `data/image-pool.json`. The seeder then assigns:

- **primary image** — a unique photo per listing (used once app-wide), overflow covered by unique Unsplash transform variants (width/flip/hue/saturation params),
- **secondary image** — a distinct companion shot so galleries differ too.

Result: `COUNT(DISTINCT image_url)` on primary images = **7000 / 7000**.

---

## Quick Start

```bash
npm install              # install dependencies
npm run db:migrate       # create all SQLite tables, indexes, FTS5 search
node scripts/fetch-images.js   # harvest ~5,200 unique photos (one-time, ~10 min, resumable)
npm run db:seed          # load demo users, categories, 7000 listings, chats
npm start                # start the app on http://localhost:3000
```

**Demo login:** `sajeel@example.com` / `Password123` (also: `ayesha`, `bilal`, `hina` — same password)

On the very first start with an empty database the app **auto-migrates and auto-seeds**, so `npm install && npm start` alone is enough.

---

## 1. How SQLite Is Configured

- Driver: **`better-sqlite3`** (latest stable, synchronous, zero-config, file-based).
- Connection lives in **`db/db.js`** — a single shared connection opened on boot with:
  - `journal_mode = WAL` → fast, safe concurrent reads/writes,
  - `foreign_keys = ON` → enforced relational integrity,
  - `busy_timeout = 5000` → no SQLITE_BUSY crashes.
- The DB file path defaults to `data/bazaarly.db` and can be overridden with the `DB_PATH` env var.
- **All database access is server-side only.** The browser never touches SQLite — it talks to Express pages and JSON API routes (`/api/*`).
- Sessions are also stored in SQLite (`data/sessions.db`) via `connect-sqlite3`.

## 2. How to Initialize the Database

```bash
npm run db:migrate
```

Runs `scripts/migrate.js`, which executes `db/schema.sql` idempotently (`CREATE TABLE IF NOT EXISTS`). Safe to run any time — existing data is never dropped.

## 3. How to Run Migrations

Same command — `npm run db:migrate`. To change the schema, add statements to `db/schema.sql` (or a new migration file) and re-run it. The schema includes:

| Table | Purpose |
|---|---|
| `users` | accounts (full name, username, email, phone, bcrypt password hash, city/area, timestamps) |
| `categories` | the 12 browse categories |
| `listings` | ads (seller FK, category FK, price, condition, city/area, phone, status ACTIVE/SOLD/DELETED, timestamps) |
| `listing_images` | multi-image gallery per listing (FK + `ON DELETE CASCADE`, sort order) |
| `favorites` | user ↔ listing favorites (UNIQUE per user+listing) |
| `conversations` | chat thread per listing per buyer (UNIQUE per listing+buyer+seller) |
| `messages` | chat messages with sender/receiver FKs and read flags |
| `reports` | listing reports with reason + description |
| `password_resets` | demo reset tokens (30-minute expiry) |
| `listings_fts` | **FTS5 full-text index** over title/description/city kept in sync by SQL triggers |

Indexes cover every frequently filtered column: `title`, `category_id`, `city`, `price`, `status`, `created_at`, `seller_id`, plus favorites/conversations/messages/reports foreign keys.

## 4. How to Seed Demo Data

```bash
npm run db:seed     # wipes + reseeds demo content
npm run db:reset    # migrate + seed in one step
```

Seeds 4 demo users, all 12 categories, **7,000 listings** (deterministic generator — phones, laptops, cars, property, furniture, fashion, jobs, services, books, sports and appliances across 10 cities) with multi-image galleries (Unsplash URLs), ~200 sold items, favorites, and two live conversations with messages.

## 5. How to Start the Application

```bash
npm start          # or: node server.js
```

Set environment variables optionally (copy `.env.example` → `.env`, or export them):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `SESSION_SECRET` | dev fallback | session signing secret — **set a long random string in production** |
| `DB_PATH` | `data/bazaarly.db` | SQLite file location |

## 6. Where the Database Is Stored

```
data/
├── bazaarly.db        ← the SQLite database (all app data)
├── bazaarly.db-wal    ← WAL journal (auto-managed)
├── bazaarly.db-shm    ← WAL shared memory (auto-managed)
└── sessions.db        ← session store (also SQLite)

uploads/              ← user-uploaded listing images (served at /uploads)
```

Both are git-ignored (databases and uploads are generated locally; the schema + seed scripts in the repo recreate them with `npm run db:reset`).

## 7. How the Application Connects to SQLite

```
Browser  ──HTTP──▶  Express server (server.js)
                      ├─ routes/pages.js   → server-rendered EJS pages
                      ├─ routes/api.js     → JSON API (fetch calls from the browser)
                      ├─ lib/listingQuery.js → the ONE SQL search/filter/sort builder
                      └─ db/db.js          → better-sqlite3 connection (WAL, FKs)
                                             │
                                             ▼
                                       data/bazaarly.db
```

**Search & filtering run entirely in SQL** (FTS5 MATCH + WHERE clauses + ORDER BY + LIMIT) — listings are never loaded into a JS array and filtered in the browser.

---

## Features (all functional)

- **Auth** — signup with full validation (unique username/email, strong password, confirm), login by email *or* username, logout, clearly-labelled **demo** forgot-password flow (generates a real 30-min reset token — no email is actually sent), change password in settings.
- **Search** — header + hero search, FTS5 full-text over title/description/city, "No listings found" empty state with **Clear Search**.
- **Filters** — price min/max, city, area, category, condition (New/Used), posted date (today/3/7/30 days) — all SQL-side.
- **Sort** — newest, oldest, price low→high, price high→low.
- **Pagination** — SQL `COUNT` + `LIMIT/OFFSET` (24 per page, 200+ pages of demo data) with page links that preserve active filters.
- **12 categories** with counts and dedicated category pages.
- **Listings** — post ad (multi-image upload with previews/remove, 8×5 MB, type-checked), edit ad (keep/replace images), delete (soft), mark Sold/Available, my-listings dashboard.
- **Product page** — image gallery (thumbnails + prev/next), description, condition/location/date, seller box with member-since, **Chat with Seller**, **Show Phone Number**, **Add to Favorites**, **Report Listing**, similar listings.
- **Chat** — conversation list with unread badges, message thread with 3-second polling, history persisted in SQLite, support inbox from the Help page.
- **Favorites** — one-click heart everywhere, favorites page.
- **Profile & settings** — stats, editable name/phone/city/area, password change.
- **Help/Support** — FAQ, safety tips, working contact-support form (opens a real chat).
- **16 routes** — `/`, `/login`, `/signup`, `/forgot-password`, `/reset-password/:token`, `/listings`, `/listing/:id`, `/post-ad`, `/edit-ad/:id`, `/my-listings`, `/favorites`, `/chat`, `/profile`, `/settings`, `/category/:id`, `/help`, plus a proper 404 page for anything else.

## Data Persistence Test (verified ✅)

All 19 steps verified end-to-end via HTTP + direct SQLite queries:

1–2. signup → user row exists in SQLite ✓
3–4. create listing (with image upload) → row + image row exist ✓
5–6. refresh → listing page renders ✓
7–9. logout, login again → listing still on My Listings ✓
10–12. send message → history survives refresh ✓
13–15. favorite → row survives refresh ✓
16–17. edit listing → SQLite contains updated title/price ✓
18–19. mark sold → `status = 'SOLD'` in SQLite ✓

## Project Structure

```
├── server.js              # Express app, uploads, session setup, ad form handlers
├── db/
│   ├── db.js              # SQLite connection (WAL, FKs) + migrate()
│   └── schema.sql         # all tables, indexes, FTS5 + triggers
├── scripts/
│   ├── migrate.js         # npm run db:migrate
│   ├── seed.js            # npm run db:seed (7000 listings, unique images)
│   └── fetch-images.js    # harvest unique CC photos into data/image-pool.json
├── lib/
│   ├── helpers.js         # validation, price/date formatting, enums
│   └── listingQuery.js    # SQL search/filter/sort builder
├── middleware/auth.js     # session auth, route guards
├── routes/
│   ├── pages.js           # all page routes
│   └── api.js             # JSON API
├── views/                 # EJS templates + partials
├── public/css/style.css   # stylesheet (custom fonts: Clash Display, Inter, Plus Jakarta Sans in public/fonts/)
├── public/js/motion.min.js # Framer Motion (vanilla engine) — powers load/scroll/hover animations
├── public/js/animations.js # animation wiring (staggered reveals, scroll-in-view, hero, hovers, heart pop)
├── data/                  # SQLite files (generated)
└── uploads/               # listing images (generated)
```
