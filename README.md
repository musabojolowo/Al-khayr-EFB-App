# Al-Khayr EFB Tournament Management System

A single Progressive Web App that runs **every** Al-Khayr EFB tournament format —
no new site needed per competition. Built with vanilla HTML/CSS/JS + Firebase
Auth + Realtime Database. No frameworks, no jQuery, no Bootstrap.

## Build plan & status

This project is being built in phases, each one fully working before the next
starts.

- [x] Phase 1 — Project structure, Firebase setup, authentication, Home page ✅
- [x] Phase 2 — Team Management System (permanent club database, local logos) ✅
- [x] Phase 3 — Tournament Manager (create tournament, pick format, select teams, set active tournament) ✅
- [x] Phase 4 — Fixture Generator (league + group round-robins) ✅
- [x] Phase 5 — Standings & Results (with downloadable, print-ready exports) ✅
- [x] Phase 6 — Announcements & Rules (per tournament) ✅
- [x] Phase 7 — Full public pages (Announcements, Rules, Fixtures, Results, Standings, About, Contact) ✅
- [x] **Phase 8 — PWA (manifest, service worker, icons, offline), polish & testing** ✅ *(this delivery — project complete)*

## Folder structure

Flattened back to the originally-requested file set — everything built
across the 8 phases is merged into these 8 files (plus assets and the
security rules, which don't appear in a browser but are required for the
app to run safely):

```
al-khayr-efb/
├─ index.html            # Public app — Home, Announcements, Rules, Fixtures, Results, Standings, About, Contact
├─ admin.html             # Admin login + full dashboard
├─ style.css              # Design system: tokens, glass cards, components, all pages
├─ firebase.js            # SHARED CORE — loaded first by both HTML files. Contains:
│                          #   Firebase init • DB schema map + path helpers • tournament
│                          #   format registry • fixture/standings engine • branded
│                          #   print/PDF export engine • seed announcement/rules text
├─ script.js              # Public app: routing, rendering, downloads, service worker registration
├─ admin.js               # Admin app: auth, nav, Team Manager, Tournament Manager,
│                          #   Fixtures, Results, Standings, Announcements & Rules,
│                          #   service worker registration — everything admin-side
├─ manifest.json          # PWA manifest (installable app metadata)
├─ service-worker.js      # Offline caching + app-shell install
├─ database.rules.json    # Firebase Realtime Database security rules
└─ assets/
   ├─ logos/               # Team crest images live here, e.g. real-madrid.png
   │                        # (the DB only ever stores the filename)
   └─ icons/                # Generated app icons (192/512/maskable/apple-touch/favicon) + team placeholder
```

`firebase.js` must load before `script.js`/`admin.js` in both HTML files —
that order is already set correctly in `index.html` and `admin.html`.

## What's live in Phase 1

- **Firebase setup** — `firebase.js` initializes Auth + Realtime Database
  and documents the complete schema every later phase will fill in.
- **Authentication** — `admin.html` / `admin.js`: email + password login,
  gated by an `/admins/{uid}` allow-list (a valid Firebase account alone is
  *not* enough — the uid must be explicitly listed as an admin).
- **Home page** — `index.html` shows the active tournament, or a clean
  "No Active Tournament" empty state until Phase 3 introduces tournament
  creation.
- **Hidden admin entry** — there is no visible "Admin" button anywhere on
  the public site. Tap the small football icon in the footer **5 times**
  within 3 seconds to open `admin.html`.

## What's live in Phase 2

- **Team Manager** (`admin.html` → Team Manager) — a permanent club
  database, completely independent of any tournament:
  - **Add / Edit / Delete** teams (Team Name, Short Name, Logo Filename).
  - **Search** filters the list live by name or short name.
  - **Logo preview** — type a filename and it previews from
    `assets/logos/{filename}`, falling back to a placeholder crest if the
    file isn't there yet (you still need to add the real image files
    yourself — see Phase 1 notes on logos).
  - **Load Starter Clubs** — one click adds the 48 clubs you supplied
    (Arsenal, Chelsea, Real Madrid, Bayern Munich, PSG, etc.), each with a
    sensible short code and an auto-generated logo filename
    (e.g. `real-madrid.png`). It's safe to click more than once — it skips
    any club that's already saved.
  - Teams are stored at `/teams/{teamId}` with a permanent, random id, so
    once a tournament (Phase 3) references a team by id, renaming that
    team later never breaks the link.

## What's live in Phase 3

- **Tournament Manager** (`admin.html` → Tournament Manager):
  - **Step 1 — Choose Format**: pick one of the 5 registered formats
    (the format registry (now inside `firebase.js`) is the single source of truth for labels & required
    team counts — adding a 6th format later means editing that one file).
  - **Step 2 — Details**: name (defaults to "Al-Khayr EFB Tournament"),
    prize information, start date, end date.
  - **Step 3 — Select Teams**: a searchable checklist of every team from
    Team Manager. A live counter shows `X / required selected`, and
    **Create Tournament stays disabled** until the count matches the
    format's exact requirement (20 / 48 / 32 / 16).
  - On create, the tournament is saved with a permanent id, and its
    announcement + rules are pre-filled from the copy you supplied
    (now inside `firebase.js`) — fully editable once Phase 6 ships.
  - **All Tournaments** list — every tournament ever created, each with
    **Set Active** / **Deactivate** and **Delete**. Only one tournament can
    be active at a time (`/settings/activeTournamentId`); the Home page
    always reflects whichever one that is.
  - **Delete** archives a full snapshot (tournament details + announcement
    + rules + any fixtures) to `/archive/{id}` before removing it from live
    data, so nothing is ever lost for good.

## What's live in Phase 4

- **Fixture Generator** (`admin.html` → Fixtures):
  - Pick any tournament from a dropdown (defaults to whichever exists).
  - **Generate Fixtures** — one click builds the full schedule:
    - League formats → a proper round-robin (circle method) where every
      team plays every other team once; two-leg leagues get a mirrored
      second leg automatically.
    - Group formats → the roster is shuffled for a fair draw, split into
      groups of 4, and each group gets its own single round-robin.
  - Group draws are shown as cards (Group A, B, C…) with each team's crest
    and name, and are saved on the tournament record so they don't
    reshuffle on every page reload.
  - The fixture list is filterable by leg (two-leg leagues) or by group,
    and clearly marks each match "Not played yet" — score entry is Phase 5.
  - **Regenerate** is available any time but requires confirmation, since
    it permanently erases existing fixtures and any results already
    recorded for that tournament.

## What's live in Phase 5

- **Results** (`admin.html` → Results): every generated fixture is listed
  (filterable by All / Upcoming / Played). Click any card to enter or edit
  its score, plus optional date, time and venue. Saving marks it played —
  there's no separate "results" table to fall out of sync, the fixture
  record *is* the result.
- **Standings** (`admin.html` → Standings): tables are never stored — they're
  computed live from results every time, so they can never drift out of
  date. League formats get one table; group formats get one table per
  group (filterable), sorted by **Points → Goal Difference → Goals Scored →
  Head-to-Head** among tied teams, exactly as specified.
- **Downloads, everywhere** — Fixtures, Results, and Standings each have a
  **⬇ Download** button. It opens a clean, branded, print-ready document
  (Al-Khayr crest, tournament name & format, generated timestamp, styled
  tables — one per group where relevant) and prompts the browser's print
  dialog, where **"Save as PDF"** produces a polished file. No PDF library,
  no server, no extra dependency — works fully offline.

## What's live in Phase 6

- **Announcements** and **Rules** (`admin.html` → each has its own nav
  item): pick any tournament, edit its announcement or rules in a
  full-width textarea, with a live **Public Preview** panel right next to
  it showing exactly how the text will read on the public site.
  - Every tournament already starts with the standard copy you provided
    (from Phase 3's auto-fill) — this page is where you customize it.
  - **Reset to Standard Copy** restores the original wording for that
    tournament's format at any time (still requires Save to take effect).
  - **Save** is disabled until something's actually changed, and a status
    indicator ("Unsaved changes" / "Saved") always shows where things
    stand. Switching tournaments mid-edit prompts to confirm before
    discarding unsaved changes.
  - Both pages share one reusable editor component internally
    (`makeContentEditor` inside `admin.js`) since they're identical
    in shape — no duplicated logic between them.

## What's live in Phase 7

- **The full public site** (`index.html`), all reading from whichever
  tournament is currently active — nothing else is ever shown:
  - **Home** — hero with tournament name/format/prize/dates, live stats,
    a preview of the latest announcement, next fixtures, and a standings
    snapshot (Group A for group formats), each linking to its full page.
  - **Announcements** / **Rules** — the full text you edit from the admin,
    formatted for reading.
  - **Fixtures** — every upcoming match, filterable by group (group
    formats) or by leg (two-leg leagues).
  - **Results** — every completed match with its score, same filtering.
  - **Standings** — the league table, or one table per group (filterable),
    computed live so it's always accurate.
  - **About** and **Contact** — Contact includes the admin phone number as
    a tappable `tel:` link.
  - **Downloads everywhere** — Fixtures, Results and Standings each carry
    the same branded ⬇ Download button as the admin panel, so visitors
    can save a clean PDF too, not just the admin.
  - Fully responsive: a top nav bar on desktop, a 5-item bottom nav on
    mobile (Home / Fixtures / Results / Standings / Rules), with
    Announcements / About / Contact reachable from the footer.
  - The hidden footer admin entry (5 taps on the football icon) works
    exactly as before — still no visible "Admin" link anywhere.
  - If no tournament is active, every page shows a clear, friendly empty
    state instead of breaking or showing stale data.

## What's live in Phase 8 — the app is now complete

- **Installable** — `manifest.json` makes the public app installable on
  Android ("Add to Home Screen"), desktop Chrome/Edge, and iOS (via Safari's
  Share → Add to Home Screen). It has a proper name, theme colors, a
  standalone display mode (opens without browser chrome), and three
  shortcuts (Fixtures / Standings / Results) available from a long-press
  on the installed icon.
- **Real app icons** — generated programmatically in the brand's own
  palette (pitch green, trophy gold, the "AK" monogram): standard 192px/512px
  icons, dedicated maskable versions (safe-zone content so Android's
  adaptive-icon shapes never crop the crest), an Apple touch icon, and a
  favicon. All in `assets/icons/`.
- **Offline support** — `service-worker.js` precaches the entire app shell
  (every HTML/CSS/JS file and icon) on first visit, so the app opens
  instantly and keeps working with no connection. It's deliberately
  network-only for Firebase Realtime Database / Auth traffic, so you're
  never shown stale scores or fixtures — only the app shell is cached,
  never live tournament data. If a navigation fails while fully offline,
  it falls back to the cached app shell instead of a browser error page.
  Updates: when a new version is deployed, a small toast offers an
  **Update** button rather than silently swapping versions under you.
- **Testing & polish pass**: every JS file was syntax-checked, every `id`
  referenced from JavaScript was cross-checked against the actual HTML
  (catching stale references before they'd ever surface as a runtime bug),
  `manifest.json` and `database.rules.json` were validated as proper JSON,
  and both HTML files were checked for duplicate ids.

## One-time setup to run this yourself

1. Create a Firebase project → enable **Authentication → Email/Password**
   and **Realtime Database**.
2. Paste your project's config into `firebase.js` (`firebaseConfig`).
3. Publish `database.rules.json` under **Realtime Database → Rules**.
4. Create your first admin user in **Authentication → Users → Add user**,
   copy their UID, then manually add `admins/{that-uid}: true` in the
   Realtime Database console. (Phase 3+ can add an "invite admin" flow if
   you want one — just ask.)
5. Open `index.html` for the public site, `admin.html` to log in.

## Design system

Dark "night match" theme: ink-navy + deep pitch-green background, a
trophy-gold accent, glassmorphism cards, `Space Grotesk` for display type,
`Inter` for body copy, and `JetBrains Mono` for scores/stats so numbers line
up like a real scoreboard. Mobile-first, fully responsive, `prefers-reduced-motion`
respected.

---
**All 8 phases are complete.** Al-Khayr EFB Tournament Management System is
a single app that runs every tournament format — league or group stage,
one leg or two — with a permanent club database, full admin control over
fixtures/results/standings/announcements/rules, branded PDF-style
downloads throughout, and an installable, offline-capable public site.

If you'd like anything refined, extended (a 6th format, knockout brackets
after the group stage, admin invite flow, etc.), or fixed, just ask.
