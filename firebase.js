/* =========================================================================
   AL-KHAYR EFB TOURNAMENT MANAGEMENT SYSTEM — firebase.js
   ------------------------------------------------------------------------
   The shared core module, loaded first by both index.html and admin.html.
   Contains: Firebase init, the full DB schema map + path helpers, the
   tournament format registry, the fixture/standings engine, the branded
   print/PDF export engine, and the seed announcement/rules copy.
   Merged from the phase-by-phase build into one file per the original
   file-list spec (index.html / admin.html / style.css / script.js /
   firebase.js / admin.js / manifest.json / service-worker.js).
   ========================================================================= */

/* =========================================================================
   js/firebase.js
   Firebase initialization, shared across index.html (public) and
   admin.html (admin panel). Loaded after the Firebase compat SDK scripts.
   ========================================================================= */

// -----------------------------------------------------------------------
// 1. PASTE YOUR FIREBASE PROJECT CONFIG HERE
//    Firebase Console → Project Settings → General → Your apps → SDK config
// -----------------------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyA5DcPlkYTg90ztV9sF7TzIGLqb13L8aXk",
  authDomain: "al-khayr-efb-tournament-99aad.firebaseapp.com",
  databaseURL: "https://al-khayr-efb-tournament-99aad-default-rtdb.firebaseio.com",
  projectId: "al-khayr-efb-tournament-99aad",
  storageBucket: "al-khayr-efb-tournament-99aad.firebasestorage.app",
  messagingSenderId: "140575828282",
  appId: "1:140575828282:web:92e62f15895f7b9760c803"
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.database();

/* =========================================================================
   DATABASE SCHEMA (full map — built up progressively phase by phase)
   ------------------------------------------------------------------------
   /settings
        activeTournamentId : string | null      // the ONE live tournament

   /admins/{uid}            : true               // authorization allow-list

   /teams/{teamId}                                // PERMANENT club records
        name      : "Real Madrid"
        shortName : "RMA"
        logo      : "real-madrid.png"             // filename only —
                                                    // resolved to
                                                    // assets/logos/{logo}

   /tournaments/{tournamentId}                     // one doc per tournament
        format     : "league20_oneleg" | "league20_twoleg"
                     | "groups48" | "groups32" | "groups16"
        name       : "Al-Khayr EFB Tournament"
        prize      : "..."
        startDate  : "YYYY-MM-DD"
        endDate    : "YYYY-MM-DD"
        teamIds    : { teamId: true, ... }         // selected roster
        groups     : { A: { teamId:true, ... }, B: {...} }  // groups only
        status     : "active" | "archived"
        createdAt  : timestamp

   /announcements/{tournamentId} : "free text"      // one per tournament
   /rules/{tournamentId}         : "free text"      // one per tournament

   /fixtures/{tournamentId}/{matchId}
        home, away        : teamId
        round, leg, group : number|number|string|null
        date, time, venue : string
        homeGoals, awayGoals : number|null
        played             : boolean
        (this single node also IS the "results" data — a fixture with
         played:true and goals filled in doubles as its own result, so
         there is no separate /results node to keep back in sync)

   /standings — NOT stored. Always computed on the fly from
        /teams + /fixtures/{tournamentId}, so it can never drift out of
        sync with results. (See engine.js, added in Phase 4.)

   /knockout/{tournamentId}                        // knockout bracket (Phase 9)
        qualifiers  : [teamId, ...]                // ranked, best → worst
        rounds      : [
          { name: "Quarter-Finals",
            matches: {
              matchId: {
                seedHome, seedAway   : number        // bracket seed positions
                home, away           : teamId | null // null only for a bye slot
                homeGoals, awayGoals  : number | null
                etHomeGoals, etAwayGoals : number | null  // extra time, if played
                homePens, awayPens   : number | null      // penalties, if played
                bye                  : boolean       // true = auto-advance, no match
                played               : boolean
                winner               : teamId | null
                date, time, venue    : string
              }, ...
            }
          }, ...
        ]
        champion    : teamId | null
        generatedAt : timestamp
        (Round 1 is generated automatically the moment every league/group
         fixture is marked played. Each later round is generated
         automatically once every match in the round before it is played.
         See Engine.buildKnockoutRound1 / buildKnockoutNextRound below.)

   /archive/{tournamentId} — a frozen copy of a tournament's data, written
        when the admin resets/ends it, so history is never lost.
   ========================================================================= */

const Paths = {
  activeTournamentId: () => "settings/activeTournamentId",
  admin: (uid) => `admins/${uid}`,

  teams: (teamId) => (teamId ? `teams/${teamId}` : "teams"),

  tournament: (id) => `tournaments/${id}`,
  tournaments: () => "tournaments",

  announcement: (tournamentId) => `announcements/${tournamentId}`,
  rules: (tournamentId) => `rules/${tournamentId}`,

  fixtures: (tournamentId, matchId) =>
    matchId ? `fixtures/${tournamentId}/${matchId}` : `fixtures/${tournamentId}`,

  knockout: (tournamentId) => `knockout/${tournamentId}`,

  archive: (tournamentId) => `archive/${tournamentId}`
};

// Resolves a stored logo filename to its on-disk path. Falls back to a
// generic placeholder crest if the team has no logo set yet.
function logoPath(filename) {
  return filename ? `assets/logos/${filename}` : "assets/icons/team-placeholder.svg";
}


/* =========================================================================
   js/formats.js
   The tournament format registry. Adding a brand-new format in the future
   is: add one entry here. Nothing else needs to change — Tournament
   Manager validation, fixture generation (Phase 4), and public display
   all read from this single object.
   ========================================================================= */

const TOURNAMENT_FORMATS = {
  league20_oneleg: {
    id: "league20_oneleg",
    label: "League (20 Teams, One Leg)",
    shortLabel: "20-Team League · One Leg",
    type: "league",       // "league" | "groups"
    teamCount: 20,
    legs: 1,
    knockoutQualifiers: 8   // top 8 in the final table advance to knockout
  },
  league20_twoleg: {
    id: "league20_twoleg",
    label: "League (20 Teams, Home & Away)",
    shortLabel: "20-Team League · Home & Away",
    type: "league",
    teamCount: 20,
    legs: 2,
    knockoutQualifiers: 8
  },
  groups48: {
    id: "groups48",
    label: "48 Teams (12 Groups of 4)",
    shortLabel: "48-Team Championship",
    type: "groups",
    teamCount: 48,
    groupCount: 12,
    teamsPerGroup: 4,
    qualifiersPerGroup: 2   // top 2 of each group → 24 qualifiers
  },
  groups32: {
    id: "groups32",
    label: "32 Teams (8 Groups of 4)",
    shortLabel: "32-Team Championship",
    type: "groups",
    teamCount: 32,
    groupCount: 8,
    teamsPerGroup: 4,
    qualifiersPerGroup: 2   // top 2 of each group → 16 qualifiers (clean Round of 16)
  },
  groups16: {
    id: "groups16",
    label: "16 Teams (4 Groups of 4)",
    shortLabel: "16-Team Championship",
    type: "groups",
    teamCount: 16,
    groupCount: 4,
    teamsPerGroup: 4,
    qualifiersPerGroup: 2   // top 2 of each group → 8 qualifiers (clean Quarter-Finals)
  }
};

const FORMAT_ORDER = ["league20_oneleg", "league20_twoleg", "groups48", "groups32", "groups16"];

/* ---------------------------------------------------------------------
   Matchday count for a league-type format — one round of fixtures =
   one Matchday. Leg 2 of a Home & Away league continues the numbering
   instead of restarting (Matchday 20-38 following Matchday 1-19), which
   is exactly how Engine.generateLeagueFixtures already numbers `round`
   on each fixture (see the `offset` used for leg 2 there). Only
   meaningful for def.type === "league" — group formats are unaffected
   and keep the existing per-date "Match Day" download picker.
   --------------------------------------------------------------------- */
function matchdayCountForFormat(def) {
  if (!def || def.type !== "league") return 0;
  const roundsPerLeg = def.teamCount % 2 === 0 ? def.teamCount - 1 : def.teamCount;
  return roundsPerLeg * (def.legs || 1);
}


/* =========================================================================
   js/engine.js — Fixture Generator (Phase 4)
   Pure logic, no DOM/Firebase — reusable from admin-fixtures.js and, in a
   later phase, from anywhere standings need to be recomputed from results.
   ========================================================================= */

const Engine = (() => {
  /* ---------------------------------------------------------------------
     Round-robin generator (circle method).
     Returns rounds = [ [ {home, away}, ... ], [ {home, away}, ... ], ... ]
     Works for any even or odd number of teams (a null "bye" is dropped).
     --------------------------------------------------------------------- */
  function roundRobinRounds(teamIds) {
    const teams = [...teamIds];
    if (teams.length % 2 !== 0) teams.push(null); // BYE for odd counts

    const n = teams.length;
    const roundsCount = n - 1;
    const half = n / 2;
    const rounds = [];

    let arr = [...teams];
    for (let r = 0; r < roundsCount; r++) {
      const round = [];
      for (let i = 0; i < half; i++) {
        const home = arr[i];
        const away = arr[n - 1 - i];
        if (home !== null && away !== null) {
          // Alternate home/away across rounds so it isn't always the same side at home
          if (r % 2 === 0) round.push({ home, away });
          else round.push({ home: away, away: home });
        }
      }
      rounds.push(round);
      arr = [arr[0], arr[n - 1], ...arr.slice(1, n - 1)]; // rotate, keep first fixed
    }
    return rounds;
  }

  /* ---------------------------------------------------------------------
     League fixtures — single or double (home & away) round-robin.
     --------------------------------------------------------------------- */
  function generateLeagueFixtures(teamIds, legs) {
    const rounds = roundRobinRounds(teamIds);
    const fixtures = [];

    rounds.forEach((round, idx) => {
      round.forEach((m) => fixtures.push(blankFixture({ home: m.home, away: m.away, round: idx + 1, leg: 1 })));
    });

    if (legs === 2) {
      const offset = rounds.length;
      rounds.forEach((round, idx) => {
        round.forEach((m) => fixtures.push(blankFixture({ home: m.away, away: m.home, round: offset + idx + 1, leg: 2 })));
      });
    }
    return fixtures;
  }

  /* ---------------------------------------------------------------------
     Group-stage fixtures — each group plays a single round-robin.
     `groups` looks like { A: [teamId, teamId, teamId, teamId], B: [...] }
     --------------------------------------------------------------------- */
  function generateGroupFixtures(groups) {
    const fixtures = [];
    Object.keys(groups).forEach((groupKey) => {
      const rounds = roundRobinRounds(groups[groupKey]);
      rounds.forEach((round, idx) => {
        round.forEach((m) => fixtures.push(blankFixture({ home: m.home, away: m.away, round: idx + 1, leg: 1, group: groupKey })));
      });
    });
    return fixtures;
  }

  function blankFixture({ home, away, round, leg, group = null }) {
    return { home, away, round, leg, group, date: "", time: "", venue: "", homeGoals: null, awayGoals: null, played: false };
  }

  /* ---------------------------------------------------------------------
     Split a (typically shuffled) list of team ids into N groups of `size`,
     labelled A, B, C, ... in order.
     --------------------------------------------------------------------- */
  function splitIntoGroups(teamIds, groupCount, size) {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    const groups = {};
    for (let g = 0; g < groupCount; g++) {
      groups[letters[g]] = teamIds.slice(g * size, g * size + size);
    }
    return groups;
  }

  /* ---------------------------------------------------------------------
     Fisher-Yates shuffle — used to make each group draw fair/random
     rather than always grouping teams in the order they were selected.
     --------------------------------------------------------------------- */
  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* ---------------------------------------------------------------------
     Standings — compute a sorted table from a team list + fixtures list.
     Sort order: Points → Goal Difference → Goals Scored → Head-to-Head
     (points earned only in matches between the tied teams).
     --------------------------------------------------------------------- */
  const POINTS = { WIN: 3, DRAW: 1, LOSS: 0 };

  function computeStandings(teamIds, fixtures) {
    const table = {};
    teamIds.forEach((id) => {
      table[id] = { team: id, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, points: 0 };
    });

    fixtures.forEach((f) => {
      if (!f.played || f.homeGoals === null || f.homeGoals === undefined || f.awayGoals === null || f.awayGoals === undefined) return;
      if (!table[f.home] || !table[f.away]) return;

      const home = table[f.home];
      const away = table[f.away];
      home.played++; away.played++;
      home.gf += f.homeGoals; home.ga += f.awayGoals;
      away.gf += f.awayGoals; away.ga += f.homeGoals;

      if (f.homeGoals > f.awayGoals) { home.won++; home.points += POINTS.WIN; away.lost++; }
      else if (f.homeGoals < f.awayGoals) { away.won++; away.points += POINTS.WIN; home.lost++; }
      else { home.drawn++; away.drawn++; home.points += POINTS.DRAW; away.points += POINTS.DRAW; }
    });

    const rows = Object.values(table);
    rows.forEach((r) => (r.gd = r.gf - r.ga));

    function headToHeadPoints(teamId, tiedIds) {
      let pts = 0;
      fixtures.forEach((f) => {
        if (!f.played || f.homeGoals === null || f.awayGoals === null) return;
        if (!tiedIds.includes(f.home) || !tiedIds.includes(f.away)) return;
        if (f.home === teamId) {
          if (f.homeGoals > f.awayGoals) pts += POINTS.WIN;
          else if (f.homeGoals === f.awayGoals) pts += POINTS.DRAW;
        } else if (f.away === teamId) {
          if (f.awayGoals > f.homeGoals) pts += POINTS.WIN;
          else if (f.homeGoals === f.awayGoals) pts += POINTS.DRAW;
        }
      });
      return pts;
    }

    rows.sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf);

    // Resolve remaining exact ties (points+GD+GF all equal) with head-to-head
    let i = 0;
    while (i < rows.length) {
      let j = i + 1;
      while (j < rows.length && rows[j].points === rows[i].points && rows[j].gd === rows[i].gd && rows[j].gf === rows[i].gf) j++;
      if (j - i > 1) {
        const clusterIds = rows.slice(i, j).map((r) => r.team);
        const cluster = rows.slice(i, j);
        cluster.forEach((r) => { r._h2h = headToHeadPoints(r.team, clusterIds); });
        cluster.sort((a, b) => b._h2h - a._h2h);
        for (let k = i; k < j; k++) rows[k] = cluster[k - i];
      }
      i = j;
    }
    return rows;
  }

  /* =========================================================================
     Knockout bracket engine (Phase 9)
     ------------------------------------------------------------------------
     Pure logic — seeding, bracket construction, round progression and
     winner resolution all live here so admin-knockout.js just wires it up
     to Firebase and the DOM. Handles any qualifier count, including ones
     that aren't a power of two, by giving the strongest seeds a bye into
     round 2.
     ------------------------------------------------------------------------- */

  function nextPowerOfTwo(n) {
    let p = 1;
    while (p < n) p *= 2;
    return p;
  }

  /* ---------------------------------------------------------------------
     Standard tournament bracket seeding order, e.g. for size 8:
     [1, 8, 4, 5, 2, 7, 3, 6] — pairs (1,8) (4,5) (2,7) (3,6), guaranteeing
     the top two seeds can only meet in the final, seeds 1-4 only in the
     semis, etc.
     --------------------------------------------------------------------- */
  function seedBracketOrder(size) {
    let order = [1, 2];
    while (order.length < size) {
      const s = order.length * 2 + 1;
      const next = [];
      order.forEach((x) => { next.push(x); next.push(s - x); });
      order = next;
    }
    return order;
  }

  /* ---------------------------------------------------------------------
     Human-readable round name from the number of teams entering it.
     --------------------------------------------------------------------- */
  function knockoutRoundName(teamCount) {
    if (teamCount <= 2) return "Final";
    if (teamCount === 4) return "Semi-Finals";
    if (teamCount === 8) return "Quarter-Finals";
    return `Round of ${teamCount}`;
  }

  /* ---------------------------------------------------------------------
     Rank the qualifying teams for the knockout stage, best → worst.
       - League formats: straight off the final table (top N).
       - Group formats: every group's winner (rank 0) ranked against each
         other by points/GD/GF, then every group's runner-up (rank 1)
         ranked the same way, and so on for however many places per group
         qualify — the standard "group winners seeded above runners-up"
         approach.
     --------------------------------------------------------------------- */
  function computeQualifiers(def, teamIds, groups, fixtures) {
    if (def.type === "league") {
      const rows = computeStandings(teamIds, fixtures);
      return rows.slice(0, def.knockoutQualifiers || rows.length).map((r) => r.team);
    }

    const groupKeys = Object.keys(groups || {}).sort();
    const perGroupRows = {};
    groupKeys.forEach((g) => {
      perGroupRows[g] = computeStandings(groups[g] || [], fixtures.filter((f) => f.group === g));
    });

    const qualifiers = [];
    const places = def.qualifiersPerGroup || 2;
    for (let place = 0; place < places; place++) {
      const atThisPlace = groupKeys
        .map((g) => perGroupRows[g][place])
        .filter(Boolean);
      atThisPlace.sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf);
      atThisPlace.forEach((row) => qualifiers.push(row.team));
    }
    return qualifiers;
  }

  /* ---------------------------------------------------------------------
     Build Round 1 from a ranked qualifiers list. Missing (bye) slots are
     handed automatically to the higher seed, with bye:true and no score
     to enter.
     --------------------------------------------------------------------- */
  function buildKnockoutRound1(qualifierIds) {
    const n = qualifierIds.length;
    const bracketSize = nextPowerOfTwo(n);
    const order = seedBracketOrder(bracketSize);
    const matches = [];

    for (let i = 0; i < bracketSize / 2; i++) {
      const seedHome = order[i * 2];
      const seedAway = order[i * 2 + 1];
      const home = qualifierIds[seedHome - 1] || null;
      const away = qualifierIds[seedAway - 1] || null;
      const bye = !home || !away;
      const winner = bye ? (home || away || null) : null;
      matches.push({
        seedHome, seedAway, home, away,
        homeGoals: null, awayGoals: null,
        etHomeGoals: null, etAwayGoals: null,
        homePens: null, awayPens: null,
        bye, played: bye, winner,
        date: "", time: "", venue: ""
      });
    }
    return { name: knockoutRoundName(bracketSize), matches };
  }

  /* ---------------------------------------------------------------------
     Build the next round from the winners of the previous one, in bracket
     order (already correctly seeded — just pair consecutively).
     --------------------------------------------------------------------- */
  function buildKnockoutNextRound(previousRoundMatches) {
    const winners = previousRoundMatches.map((m) => m.winner);
    const matches = [];
    for (let i = 0; i < winners.length / 2; i++) {
      const home = winners[i * 2] || null;
      const away = winners[i * 2 + 1] || null;
      matches.push({
        seedHome: null, seedAway: null, home, away,
        homeGoals: null, awayGoals: null,
        etHomeGoals: null, etAwayGoals: null,
        homePens: null, awayPens: null,
        bye: false, played: false, winner: null,
        date: "", time: "", venue: ""
      });
    }
    return { name: knockoutRoundName(winners.length), matches };
  }

  /* ---------------------------------------------------------------------
     Resolve a match's winner from whatever scores have been entered:
     regulation first, then extra time (combined with regulation), then
     penalties. Returns null if the tie still isn't broken.
     --------------------------------------------------------------------- */
  function decideKnockoutWinner(m) {
    if (m.homeGoals === null || m.awayGoals === null) return null;
    if (m.homeGoals !== m.awayGoals) return m.homeGoals > m.awayGoals ? m.home : m.away;

    if (m.etHomeGoals !== null && m.etHomeGoals !== undefined && m.etAwayGoals !== null && m.etAwayGoals !== undefined) {
      const totalHome = m.homeGoals + m.etHomeGoals;
      const totalAway = m.awayGoals + m.etAwayGoals;
      if (totalHome !== totalAway) return totalHome > totalAway ? m.home : m.away;
    }

    if (m.homePens !== null && m.homePens !== undefined && m.awayPens !== null && m.awayPens !== undefined) {
      if (m.homePens !== m.awayPens) return m.homePens > m.awayPens ? m.home : m.away;
    }
    return null;
  }

  function isRoundComplete(matches) {
    return matches.every((m) => m.played && m.winner);
  }

  return {
    roundRobinRounds, generateLeagueFixtures, generateGroupFixtures, splitIntoGroups, shuffle, computeStandings,
    nextPowerOfTwo, seedBracketOrder, knockoutRoundName, computeQualifiers,
    buildKnockoutRound1, buildKnockoutNextRound, decideKnockoutWinner, isRoundComplete
  };
})();


/* =========================================================================
   js/export.js — Downloadable exports for Fixtures, Results & Standings
   ------------------------------------------------------------------------
   No PDF library needed: we open a new tab containing a fully self-styled,
   print-optimized HTML document (light background, crisp borders, the
   Al-Khayr gold/pitch-green brand marks) and trigger the browser's native
   print dialog, where "Save as PDF" produces a clean, good-looking file.
   Works completely offline, with zero dependencies.
   ========================================================================= */

/* ---------------------------------------------------------------------
   Distinct match days (YYYY-MM-DD) present across a list of fixtures,
   sorted chronologically. Fixtures with no date set are excluded — they
   can only be downloaded via "All Match Days". Shared by the admin
   Fixtures/Results pages and the public Fixtures/Results pages so both
   "download this match day only" pickers behave identically.
   --------------------------------------------------------------------- */
function matchDaysFromFixtures(fixtures) {
  const days = new Set();
  fixtures.forEach((f) => { if (f.date) days.add(f.date); });
  return [...days].sort();
}

function formatMatchDayLabel(dateStr) {
  const dt = new Date(dateStr + "T00:00:00");
  if (isNaN(dt)) return dateStr;
  return dt.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
}

function exportEscapeHTML(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* ---------------------------------------------------------------------
   Opens a new tab with a branded, print-ready document and invokes the
   print dialog once fonts/layout have settled.
   tableBlocksHTML: one or more pre-built <section> blocks (see builders
   below) — each renders as its own titled table.
   --------------------------------------------------------------------- */
function openExportDocument({ docTitle, tournamentName, formatLabel, generatedNote, tableBlocksHTML }) {
  const win = window.open("", "_blank");
  if (!win) {
    showToast("Please allow pop-ups to download this export.", "error");
    return;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${exportEscapeHTML(docTitle)} — ${exportEscapeHTML(tournamentName)}</title>
<style>
  @page { margin: 26mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', Arial, sans-serif; color: #16202e; margin: 0; padding: 28px 34px;
    background: #ffffff;
  }
  .export-header {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    border-bottom: 3px solid #d4a537; padding-bottom: 14px; margin-bottom: 18px;
  }
  .export-brand { display: flex; align-items: center; gap: 12px; }
  .export-crest {
    width: 42px; height: 42px; border-radius: 10px; flex-shrink: 0;
    background: linear-gradient(145deg, #12805a, #0d3d2c);
    color: #f2d488; font-weight: 800; font-size: 15px; font-family: Georgia, serif;
    display: flex; align-items: center; justify-content: center;
  }
  .export-brand-text .name { font-size: 17px; font-weight: 800; letter-spacing: -0.01em; }
  .export-brand-text .sub { font-size: 11.5px; color: #6b7688; margin-top: 1px; }
  .export-meta { text-align: right; font-size: 11px; color: #6b7688; line-height: 1.5; }
  .export-title-row { margin: 4px 0 22px; }
  .export-title-row h1 { font-size: 21px; margin: 0 0 3px; }
  .export-title-row .format { font-size: 12.5px; color: #a5822b; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; }
  .export-section { margin-bottom: 26px; page-break-inside: avoid; }
  .export-section h2 {
    font-size: 13.5px; text-transform: uppercase; letter-spacing: .06em; color: #0d3d2c;
    border-left: 4px solid #d4a537; padding-left: 8px; margin: 0 0 10px;
  }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 7px 8px; text-align: left; border-bottom: 1px solid #e4e7ee; }
  th {
    background: #0d3d2c; color: #f2d488; font-size: 10px; text-transform: uppercase;
    letter-spacing: .04em; font-weight: 700;
  }
  tr:nth-child(even) td { background: #f7f8fb; }
  td.num, th.num { text-align: center; font-variant-numeric: tabular-nums; }
  td.pts { font-weight: 800; color: #a5822b; text-align: center; }
  .status-played { color: #12805a; font-weight: 700; }
  .status-upcoming { color: #a5822b; font-weight: 700; }
  .export-footer { margin-top: 30px; font-size: 10.5px; color: #9aa3b2; border-top: 1px solid #e4e7ee; padding-top: 10px; text-align: center; }
  @media print {
    .no-print { display: none !important; }
  }
  .print-bar {
    position: sticky; top: 0; background: #0d3d2c; color: #fff; padding: 10px 16px; border-radius: 10px;
    display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; font-size: 13px;
  }
  .print-bar button {
    background: #d4a537; color: #1a1305; border: none; padding: 8px 16px; border-radius: 7px;
    font-weight: 700; font-size: 12.5px; cursor: pointer;
  }
</style>
</head>
<body>
  <div class="print-bar no-print">
    <span>Ready to download — use your browser's print dialog and choose "Save as PDF".</span>
    <button onclick="window.print()">🖨️ Print / Save as PDF</button>
  </div>

  <div class="export-header">
    <div class="export-brand">
      <div class="export-crest">AK</div>
      <div class="export-brand-text">
        <div class="name">Al-Khayr EFB Tournament</div>
        <div class="sub">Tournament Management System</div>
      </div>
    </div>
    <div class="export-meta">
      Generated ${exportEscapeHTML(new Date().toLocaleString())}<br/>
      ${exportEscapeHTML(generatedNote || "")}
    </div>
  </div>

  <div class="export-title-row">
    <h1>${exportEscapeHTML(docTitle)} — ${exportEscapeHTML(tournamentName)}</h1>
    <div class="format">${exportEscapeHTML(formatLabel || "")}</div>
  </div>

  ${tableBlocksHTML}

  <div class="export-footer">Al-Khayr EFB Tournament Management System • alkhayr-efb-tournament</div>
</body>
</html>`;

  win.document.open();
  win.document.write(html);
  win.document.close();
}

/* ---------------------------------------------------------------------
   Table block builders — each returns one <section> block. A caller can
   pass several to openExportDocument to stack multiple tables (e.g. one
   per group) in a single downloadable document.
   --------------------------------------------------------------------- */
function exportFixturesTableBlock(title, fixtures, teamName) {
  const rows = fixtures.map((f) => `
    <tr>
      <td>${f.group ? `Group ${exportEscapeHTML(f.group)}` : `Matchday ${f.round}${f.leg === 2 ? " (Leg 2)" : ""}`}</td>
      <td>${exportEscapeHTML(teamName(f.home))}</td>
      <td>${exportEscapeHTML(teamName(f.away))}</td>
      <td>${f.date || "TBC"}</td>
      <td>${f.time || "—"}</td>
      <td>${f.venue ? exportEscapeHTML(f.venue) : "—"}</td>
      <td class="${f.played ? "status-played" : "status-upcoming"}">${f.played ? "Played" : "Upcoming"}</td>
    </tr>`).join("");

  return `
  <section class="export-section">
    <h2>${exportEscapeHTML(title)}</h2>
    <table>
      <thead><tr><th>Matchday / Group</th><th>Home</th><th>Away</th><th>Date</th><th>Time</th><th>Venue</th><th>Status</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="7" style="text-align:center;color:#9aa3b2;">No fixtures</td></tr>`}</tbody>
    </table>
  </section>`;
}

function exportResultsTableBlock(title, fixtures, teamName) {
  const rows = fixtures.map((f) => `
    <tr>
      <td>${f.group ? `Group ${exportEscapeHTML(f.group)}` : `Matchday ${f.round}${f.leg === 2 ? " (Leg 2)" : ""}`}</td>
      <td>${exportEscapeHTML(teamName(f.home))}</td>
      <td class="num" style="font-weight:700;">${f.homeGoals} &ndash; ${f.awayGoals}</td>
      <td>${exportEscapeHTML(teamName(f.away))}</td>
      <td>${f.date || "—"}</td>
      <td>${f.venue ? exportEscapeHTML(f.venue) : "—"}</td>
    </tr>`).join("");

  return `
  <section class="export-section">
    <h2>${exportEscapeHTML(title)}</h2>
    <table>
      <thead><tr><th>Matchday / Group</th><th>Home</th><th class="num">Score</th><th>Away</th><th>Date</th><th>Venue</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" style="text-align:center;color:#9aa3b2;">No results yet</td></tr>`}</tbody>
    </table>
  </section>`;
}

function exportKnockoutRoundBlock(round, teamName) {
  const rows = round.matches.map((m) => {
    if (m.bye) {
      return `
    <tr>
      <td>${exportEscapeHTML(teamName(m.winner))}</td>
      <td colspan="2" style="text-align:center;color:#a5822b;font-weight:700;">BYE — advances automatically</td>
      <td>—</td>
    </tr>`;
    }
    const score = m.played
      ? `${m.homeGoals}&ndash;${m.awayGoals}${m.etHomeGoals !== null && m.etHomeGoals !== undefined ? ` (ET ${m.etHomeGoals}&ndash;${m.etAwayGoals})` : ""}${m.homePens !== null && m.homePens !== undefined ? ` (Pens ${m.homePens}&ndash;${m.awayPens})` : ""}`
      : "vs";
    return `
    <tr>
      <td>${exportEscapeHTML(teamName(m.home))}</td>
      <td class="num" style="font-weight:700;">${score}</td>
      <td>${exportEscapeHTML(teamName(m.away))}</td>
      <td>${m.played ? (m.winner ? exportEscapeHTML(teamName(m.winner)) : "—") : "Not played yet"}</td>
    </tr>`;
  }).join("");

  return `
  <section class="export-section">
    <h2>${exportEscapeHTML(round.name)}</h2>
    <table>
      <thead><tr><th>Home</th><th class="num">Score</th><th>Away</th><th>Winner</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" style="text-align:center;color:#9aa3b2;">No matches</td></tr>`}</tbody>
    </table>
  </section>`;
}

function exportStandingsTableBlock(title, rows, teamName) {
  const body = rows.map((r, i) => `
    <tr>
      <td class="num">${i + 1}</td>
      <td>${exportEscapeHTML(teamName(r.team))}</td>
      <td class="num">${r.played}</td>
      <td class="num">${r.won}</td>
      <td class="num">${r.drawn}</td>
      <td class="num">${r.lost}</td>
      <td class="num">${r.gf}</td>
      <td class="num">${r.ga}</td>
      <td class="num">${r.gd > 0 ? "+" : ""}${r.gd}</td>
      <td class="pts">${r.points}</td>
    </tr>`).join("");

  return `
  <section class="export-section">
    <h2>${exportEscapeHTML(title)}</h2>
    <table>
      <thead><tr><th>#</th><th>Team</th><th class="num">P</th><th class="num">W</th><th class="num">D</th><th class="num">L</th><th class="num">GF</th><th class="num">GA</th><th class="num">GD</th><th class="num">Pts</th></tr></thead>
      <tbody>${body || `<tr><td colspan="10" style="text-align:center;color:#9aa3b2;">No standings yet</td></tr>`}</tbody>
    </table>
  </section>`;
}


/* =========================================================================
   js/seed-content.js
   Not wired into the app yet — this just preserves the announcement/rules
   copy the admin supplied ahead of time, keyed by tournament format id
   (matching the ids used in js/firebase.js's schema). Phase 6 (Announcements
   & Rules) will read this to seed /announcements/{tournamentId} and
   /rules/{tournamentId} for each format, or the admin can paste/edit this
   copy directly in the dashboard once that phase is built.
   ========================================================================= */

const SEED_CONTENT = {
  league20_oneleg: {
    label: "League Format (20 Teams | One Leg)",
    announcement:
`🏆 AL-KHAYR EFB TOURNAMENT
LEAGUE FORMAT (20 TEAMS | ONE LEG)

Registration for the AL-KHAYR EFB Tournament is now open!
This tournament will feature 20 teams competing in a single-round league, where each team plays every other team once.
At the end of the league stage, the team with the highest points will be crowned the Champion.
Ensure you complete your registration before the deadline.
We wish every participant the very best.
Good luck to all teams!`,
    rules:
`LEAGUE RULES (20 TEAMS | ONE LEG)

1. The tournament consists of 20 teams.
2. Every team plays every other team once.
3. A win earns 3 points.
4. A draw earns 1 point.
5. A loss earns 0 points.
6. League standings are decided by:
   - Points
   - Goal Difference
   - Goals Scored
7. Teams must report at the scheduled match time.
8. Failure to appear may result in a walkover.
9. Unsporting behaviour may lead to disciplinary action.
10. The organizer's decision is final.`
  },

  league20_twoleg: {
    label: "League Format (20 Teams | Home & Away)",
    announcement:
`🏆 AL-KHAYR EFB TOURNAMENT
LEAGUE FORMAT (20 TEAMS | HOME & AWAY)

Welcome to another exciting edition of the AL-KHAYR EFB Tournament.
This edition uses the Home & Away League Format, where every team faces each opponent twice.
The team with the highest points after all matches will become the Champion.
Best of luck to every participant.`,
    rules:
`LEAGUE RULES (20 TEAMS | HOME & AWAY)

1. The tournament consists of 20 teams.
2. Every team plays every opponent twice.
3. Win = 3 points.
4. Draw = 1 point.
5. Loss = 0 points.
6. Standings are determined by:
   - Points
   - Goal Difference
   - Goals Scored
7. Late arrival may result in forfeiture.
8. Respect all opponents and officials.
9. The organizer's decision is final.`
  },

  groups48: {
    label: "48-Team Championship",
    announcement:
`🏆 AL-KHAYR EFB TOURNAMENT
48-TEAM CHAMPIONSHIP

Registration is now open for the 48-Team Championship.
The tournament features 48 teams divided into 12 groups of 4 teams.
Every team will battle for qualification to the knockout stage.
Prepare your squad and compete for glory.
Good luck to all participants.`,
    rules:
`48-TEAM TOURNAMENT RULES

1. The tournament consists of 48 teams.
2. Teams are divided into 12 groups of 4 teams.
3. Every team plays all other teams in its group once.
4. Win = 3 points.
5. Draw = 1 point.
6. Loss = 0 points.
7. Group standings are determined by:
   - Points
   - Goal Difference
   - Goals Scored
8. Qualified teams proceed to the knockout stage.
9. Knockout matches ending in a draw proceed according to the tournament settings.
10. The organizer's decision is final.`
  },

  groups32: {
    label: "32-Team Championship",
    announcement:
`🏆 AL-KHAYR EFB TOURNAMENT
32-TEAM CHAMPIONSHIP

Welcome to the AL-KHAYR EFB 32-Team Championship.
The tournament features 32 teams divided into 8 groups of 4 teams.
Only the best teams will advance to the knockout rounds.
We wish every participant success throughout the competition.`,
    rules:
`32-TEAM TOURNAMENT RULES

1. The tournament consists of 32 teams.
2. Teams are divided into 8 groups of 4 teams.
3. Each team plays every other team in its group once.
4. Win = 3 points.
5. Draw = 1 point.
6. Loss = 0 points.
7. Teams are ranked using:
   - Points
   - Goal Difference
   - Goals Scored
8. Qualified teams advance to the knockout stage.
9. The organizer's decision is final.`
  },

  groups16: {
    label: "16-Team Championship",
    announcement:
`🏆 AL-KHAYR EFB TOURNAMENT
16-TEAM CHAMPIONSHIP

The AL-KHAYR EFB 16-Team Championship is officially open.
This competition consists of 16 teams divided into 4 groups of 4 teams.
Fight for qualification and battle your way to the championship.
We wish all participants an exciting tournament.`,
    rules:
`16-TEAM TOURNAMENT RULES

1. The tournament consists of 16 teams.
2. Teams are divided into 4 groups of 4 teams.
3. Every team plays all other teams in its group once.
4. Win = 3 points.
5. Draw = 1 point.
6. Loss = 0 points.
7. Group standings are determined by:
   - Points
   - Goal Difference
   - Goals Scored
8. Qualified teams progress to the knockout stage.
9. The organizer's decision is final.`
  }
};
