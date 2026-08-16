/* =========================================================================
   js/script.js — Public app (index.html)
   Phase 7 scope: the full public site. Home, Announcements, Rules,
   Fixtures, Results, Standings, About and Contact all read from whichever
   tournament is currently active — nothing else is ever shown, per the
   "only one active tournament" rule. The hidden 5-tap admin entry from
   Phase 1 is preserved untouched below.
   ========================================================================= */

const publicState = {
  tournamentId: null,
  tournament: null,     // {name, format, prize, startDate, endDate, teamIds, groups}
  announcement: "",
  rules: "",
  teams: {},            // global /teams — persists across tournaments
  fixtures: {},          // fixtures of the CURRENT tournament only
  knockout: null,        // knockout bracket of the CURRENT tournament, or null
  page: "home",
  filters: { fixtures: "all", results: "all", standings: "all" }
};

let tournamentRefs = []; // live refs on the current tournament, detached on switch

/* ---------------------------------------------------------------------
   DOM / formatting helpers
   --------------------------------------------------------------------- */
function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function teamName(id) { return (publicState.teams[id] || {}).name || "TBD"; }
function teamInitials(id) {
  const n = teamName(id);
  return n.split(" ").map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
}

/* ---------------------------------------------------------------------
   Team badge — uses the club logo saved in Team Manager wherever a team
   is shown on the public site (Home, Fixtures, Results, Standings,
   Knockout bracket, match cards). Falls back to the letter-initials
   badge automatically if no logo was uploaded, or if the saved logo
   file fails to load (image onerror swaps it for the fallback span).
   --------------------------------------------------------------------- */
function teamBadgeHTML(id, px, fontPx) {
  const team = publicState.teams[id] || {};
  const initials = teamInitials(id);
  if (!team.logo) {
    return `<span class="team-badge" style="width:${px}px;height:${px}px;font-size:${fontPx}px;">${initials}</span>`;
  }
  const src = `assets/logos/${team.logo}`;
  return `<span class="team-badge" style="width:${px}px;height:${px}px;font-size:${fontPx}px;padding:0;overflow:hidden;position:relative;">` +
    `<img src="${escapeHTML(src)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" ` +
    `onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />` +
    `<span style="display:none;position:absolute;inset:0;align-items:center;justify-content:center;">${initials}</span>` +
    `</span>`;
}
function fmtDate(d) {
  if (!d) return "Date TBC";
  const dt = new Date(d + "T00:00:00");
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short" });
}
function truncate(str, len) { return str.length > len ? str.slice(0, len).trim() + "…" : str; }
function sortByDateTime(a, b) { return (a.date || "9999").localeCompare(b.date || "9999") || (a.time || "").localeCompare(b.time || ""); }
function emptyState(glyph, text) { return `<div class="empty-state"><div class="glyph">${glyph}</div><div>${text}</div></div>`; }

function showToast(msg, type = "success") {
  const host = $("#toast-host");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function hideLoading() {
  const el = $("#loadingScreen");
  if (el && !el.classList.contains("hidden")) {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 400);
  }
}

/* ---------------------------------------------------------------------
   Routing
   --------------------------------------------------------------------- */
const VALID_PAGES = ["home", "announcements", "rules", "fixtures", "results", "standings", "knockout", "about", "contact"];

function navigateTo(page) {
  if (!VALID_PAGES.includes(page)) page = "home";
  publicState.page = page;
  $$(".page").forEach((p) => p.classList.remove("active"));
  const target = $(`#page-${page}`);
  if (target) target.classList.add("active");

  $$("#topNav a, #bottomNav a").forEach((a) => a.classList.toggle("active", a.dataset.page === page));
  window.scrollTo({ top: 0, behavior: "auto" });
  renderCurrentPage();
}

window.addEventListener("hashchange", () => navigateTo(location.hash.replace("#", "") || "home"));

/* ---------------------------------------------------------------------
   Firebase data binding — active tournament → its own live data
   --------------------------------------------------------------------- */
function initDataBindings() {
  db.ref(Paths.teams()).on("value", (snap) => {
    publicState.teams = snap.val() || {};
    renderCurrentPage();
  });

  db.ref(Paths.activeTournamentId()).on("value", (snap) => {
    const id = snap.val();
    hideLoading();
    detachTournamentListeners();

    if (!id) {
      publicState.tournamentId = null;
      publicState.tournament = null;
      renderChrome();
      renderCurrentPage();
      return;
    }
    publicState.tournamentId = id;
    attachTournamentListeners(id);
  });
}

function detachTournamentListeners() {
  tournamentRefs.forEach((ref) => ref.off());
  tournamentRefs = [];
}

function attachTournamentListeners(id) {
  const tRef = db.ref(Paths.tournament(id));
  const annRef = db.ref(Paths.announcement(id));
  const rulesRef = db.ref(Paths.rules(id));
  const fxRef = db.ref(Paths.fixtures(id));
  const koRef = db.ref(Paths.knockout(id));

  tRef.on("value", (s) => { publicState.tournament = s.val() || null; renderChrome(); renderCurrentPage(); });
  annRef.on("value", (s) => { publicState.announcement = s.val() || ""; renderCurrentPage(); });
  rulesRef.on("value", (s) => { publicState.rules = s.val() || ""; renderCurrentPage(); });
  fxRef.on("value", (s) => { publicState.fixtures = s.val() || {}; renderCurrentPage(); renderDaySelects(); });
  koRef.on("value", (s) => { publicState.knockout = s.val() || null; renderCurrentPage(); });

  tournamentRefs = [tRef, annRef, rulesRef, fxRef, koRef];
}

/* ---------------------------------------------------------------------
   Match Day pickers — narrow the Fixtures/Results downloads to a single
   date, mirroring the same picker in the admin panel.
   --------------------------------------------------------------------- */
function renderDaySelects() {
  const days = matchDaysFromFixtures(fixturesArray());
  const options = `<option value="all">All Match Days</option>` + days.map((d) => `<option value="${d}">${formatMatchDayLabel(d)}</option>`).join("");
  const fxSelect = $("#fxPublicDaySelect");
  const resSelect = $("#resPublicDaySelect");
  if (fxSelect) fxSelect.innerHTML = options;
  if (resSelect) resSelect.innerHTML = options;
}

function renderChrome() {
  const t = publicState.tournament;
  const label = t ? (t.name || "Al-Khayr EFB Tournament") : "Al-Khayr EFB Tournament";
  document.title = `${label} — Al-Khayr EFB`;
  $("#footerText").textContent = t ? `${label} • Al-Khayr EFB Tournament Management System` : "Al-Khayr EFB Tournament";
}

/* ---------------------------------------------------------------------
   Fixture helpers
   --------------------------------------------------------------------- */
function fixturesArray() { return Object.entries(publicState.fixtures || {}).map(([id, f]) => ({ ...f, _id: id })); }
function formatDef() { return publicState.tournament ? TOURNAMENT_FORMATS[publicState.tournament.format] : null; }
function groupKeysUsed() {
  const t = publicState.tournament;
  if (!t || !t.groups) return [];
  return Object.keys(t.groups).sort();
}

function matchCardHTML(f) {
  const played = f.played && f.homeGoals !== null && f.homeGoals !== undefined;
  const statusBadge = played ? `<span class="badge-status played">Full-time</span>` : `<span class="badge-status upcoming">Upcoming</span>`;
  return `
  <div class="match-card">
    <div class="team home">${teamBadgeHTML(f.home, 28, 11)}<span>${escapeHTML(teamName(f.home))}</span></div>
    ${played
      ? `<div class="match-score"><span>${f.homeGoals}</span><span class="dash">&ndash;</span><span>${f.awayGoals}</span></div>`
      : `<div class="match-vs">VS</div>`}
    <div class="team away">${teamBadgeHTML(f.away, 28, 11)}<span>${escapeHTML(teamName(f.away))}</span></div>
    <div class="match-meta">
      ${f.group ? `<span>🏷 Group ${f.group}</span>` : `<span>🔁 Matchday ${f.round}${f.leg === 2 ? " · Leg 2" : ""}</span>`}
      <span>📅 ${fmtDate(f.date)}</span>
      ${f.time ? `<span>⏰ ${f.time}</span>` : ""}
      ${f.venue ? `<span>📍 ${escapeHTML(f.venue)}</span>` : ""}
      ${statusBadge}
    </div>
  </div>`;
}

/* ---------------------------------------------------------------------
   Standings table (public)
   --------------------------------------------------------------------- */
function buildStandingsTableHTML(teamIds, fixtures, title) {
  const rows = Engine.computeStandings(teamIds, fixtures);
  if (!teamIds.length) return "";
  return `
  <div>
    ${title ? `<div class="eyebrow" style="margin-bottom:10px;">${escapeHTML(title)}</div>` : ""}
    <div class="table-wrap">
      <table class="standings-table">
        <thead><tr><th class="team-cell">#</th><th class="team-cell">Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th><th>Pts</th></tr></thead>
        <tbody>
          ${rows.map((r, i) => `
            <tr>
              <td class="team-cell"><span class="rank-pill ${i < 1 ? "top" : ""}">${i + 1}</span></td>
              <td class="team-cell"><span style="display:inline-flex;align-items:center;gap:8px;">${teamBadgeHTML(r.team, 22, 9)}${escapeHTML(teamName(r.team))}</span></td>
              <td>${r.played}</td><td>${r.won}</td><td>${r.drawn}</td><td>${r.lost}</td>
              <td>${r.gf}</td><td>${r.ga}</td><td>${r.gd > 0 ? "+" : ""}${r.gd}</td>
              <td class="pts">${r.points}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
  </div>`;
}

function standingsForActiveTournament(groupFilter) {
  const t = publicState.tournament;
  const def = formatDef();
  if (!t || !def) return "";
  const fixtures = fixturesArray();

  if (def.type === "league") {
    return buildStandingsTableHTML(Object.keys(t.teamIds || {}), fixtures, null);
  }
  const keys = groupKeysUsed();
  const filtered = groupFilter === "all" ? keys : keys.filter((k) => k === groupFilter);
  if (!filtered.length) return emptyState("📊", "No groups yet.");
  return `<div class="grid grid-2">${filtered.map((g) =>
    `<div class="card">${buildStandingsTableHTML(t.groups[g] || [], fixtures.filter((f) => f.group === g), `Group ${g}`)}</div>`
  ).join("")}</div>`;
}

/* ---------------------------------------------------------------------
   Page renderers
   --------------------------------------------------------------------- */
function renderCurrentPage() {
  switch (publicState.page) {
    case "home": return renderHome();
    case "announcements": return renderAnnouncements();
    case "rules": return renderRules();
    case "fixtures": return renderFixturesPage();
    case "results": return renderResultsPage();
    case "standings": return renderStandingsPage();
    case "knockout": return renderKnockoutPage();
    default: return; // about/contact are static
  }
}

function renderHome() {
  const t = publicState.tournament;
  if (!t) {
    $("#hero").style.display = "none";
    $("#emptyStateWrap").style.display = "block";
    $("#homePreviewSections").style.display = "none";
    return;
  }
  $("#hero").style.display = "block";
  $("#emptyStateWrap").style.display = "none";
  $("#homePreviewSections").style.display = "block";

  $("#tournamentName").textContent = t.name || "Al-Khayr EFB Tournament";
  const def = formatDef();
  $("#tournamentSub").textContent = [def ? def.label : "", t.prize ? `Prize: ${t.prize}` : "", t.startDate ? `Starts ${t.startDate}` : ""].filter(Boolean).join(" • ");

  const fixtures = fixturesArray();
  const playedCount = fixtures.filter((f) => f.played).length;
  const teamCount = t.teamIds ? Object.keys(t.teamIds).length : 0;
  $("#heroStats").innerHTML = `
    <div class="stat"><div class="num mono">${teamCount}</div><div class="lbl">Teams</div></div>
    <div class="stat"><div class="num mono">${playedCount}</div><div class="lbl">Played</div></div>
    <div class="stat"><div class="num mono">${fixtures.length - playedCount}</div><div class="lbl">Remaining</div></div>
  `;

  $("#homeAnnouncementPreview").innerHTML = publicState.announcement
    ? `<div class="card announcement-card"><div class="meta">${escapeHTML(t.name || "")}</div><div class="rules-body">${escapeHTML(truncate(publicState.announcement, 280))}</div></div>`
    : emptyState("📣", "No announcements yet.");

  const upcoming = fixtures.filter((f) => !f.played).sort(sortByDateTime).slice(0, 4);
  $("#homeNextFixtures").innerHTML = upcoming.length ? upcoming.map(matchCardHTML).join("") : emptyState("📅", "No upcoming fixtures scheduled.");

  let snapIds = Object.keys(t.teamIds || {});
  let snapFixtures = fixtures;
  let snapTitle = null;
  if (def && def.type === "groups") {
    const firstGroup = groupKeysUsed()[0];
    snapIds = firstGroup ? (t.groups[firstGroup] || []) : [];
    snapFixtures = fixtures.filter((f) => f.group === firstGroup);
    snapTitle = firstGroup ? `Group ${firstGroup}` : null;
  }
  $("#homeStandingsSnapshot").innerHTML = snapIds.length
    ? buildStandingsTableHTML(snapIds, snapFixtures, snapTitle)
    : emptyState("📊", "Standings will appear once the tournament is underway.");
}

function renderAnnouncements() {
  const t = publicState.tournament;
  $("#annEyebrow").textContent = formatDef() ? formatDef().label : "Announcement";
  $("#annTitle").textContent = t ? `${t.name} — Announcements` : "Announcements";
  $("#announcementFull").innerHTML = !t
    ? emptyState("🏆", "No active tournament right now.")
    : (publicState.announcement
        ? `<div class="card announcement-card"><div class="meta">${escapeHTML(t.name)}${t.startDate ? ` • Starts ${t.startDate}` : ""}</div><div class="rules-body">${escapeHTML(publicState.announcement)}</div></div>`
        : emptyState("📣", "No announcement has been posted for this tournament yet."));
}

function renderRules() {
  const t = publicState.tournament;
  $("#rulesTitle").textContent = t ? `${t.name} — Rules & Regulations` : "Rules & Regulations";
  $("#rulesBody").innerHTML = !t
    ? "No active tournament right now."
    : (publicState.rules ? escapeHTML(publicState.rules) : "No rules have been published for this tournament yet.");
}

function renderFilterChips(hostId, values, activeVal, onSelect, includeAll, prefix = "") {
  const host = $("#" + hostId);
  if (!host) return;
  if (!values.length) { host.innerHTML = ""; return; }
  const chips = [];
  if (includeAll) chips.push(`<button class="chip ${activeVal === "all" ? "active" : ""}" data-val="all">All</button>`);
  values.forEach((v) => chips.push(`<button class="chip ${activeVal === v ? "active" : ""}" data-val="${v}">${prefix}${escapeHTML(v)}</button>`));
  host.innerHTML = chips.join("");
  $$("button", host).forEach((btn) => btn.addEventListener("click", () => onSelect(btn.dataset.val)));
}

function renderFixturesPage() {
  if (!publicState.tournament) {
    $("#fxPublicFilterChips").innerHTML = "";
    $("#fxPublicList").innerHTML = emptyState("🏆", "No active tournament right now.");
    return;
  }
  const def = formatDef();
  const all = fixturesArray().filter((f) => !f.played);

  if (def.type === "groups") {
    renderFilterChips("fxPublicFilterChips", groupKeysUsed(), publicState.filters.fixtures, (val) => {
      publicState.filters.fixtures = val;
      renderFixturesPage();
    }, true, "Group ");
  } else if (def.legs === 2) {
    renderFilterChips("fxPublicFilterChips", ["1", "2"], publicState.filters.fixtures, (val) => {
      publicState.filters.fixtures = val;
      renderFixturesPage();
    }, true, "Leg ");
  } else {
    $("#fxPublicFilterChips").innerHTML = "";
  }

  let list = all;
  if (publicState.filters.fixtures !== "all") {
    list = def.type === "groups"
      ? all.filter((f) => f.group === publicState.filters.fixtures)
      : all.filter((f) => String(f.leg) === publicState.filters.fixtures);
  }
  list.sort(sortByDateTime);
  $("#fxPublicList").innerHTML = list.length ? list.map(matchCardHTML).join("") : emptyState("📅", "No upcoming fixtures right now.");
}

function renderResultsPage() {
  if (!publicState.tournament) {
    $("#resPublicFilterChips").innerHTML = "";
    $("#resPublicList").innerHTML = emptyState("🏆", "No active tournament right now.");
    return;
  }
  const def = formatDef();
  const all = fixturesArray().filter((f) => f.played);

  if (def.type === "groups") {
    renderFilterChips("resPublicFilterChips", groupKeysUsed(), publicState.filters.results, (val) => {
      publicState.filters.results = val;
      renderResultsPage();
    }, true, "Group ");
  } else if (def.legs === 2) {
    renderFilterChips("resPublicFilterChips", ["1", "2"], publicState.filters.results, (val) => {
      publicState.filters.results = val;
      renderResultsPage();
    }, true, "Leg ");
  } else {
    $("#resPublicFilterChips").innerHTML = "";
  }

  let list = all;
  if (publicState.filters.results !== "all") {
    list = def.type === "groups"
      ? all.filter((f) => f.group === publicState.filters.results)
      : all.filter((f) => String(f.leg) === publicState.filters.results);
  }
  list.sort((a, b) => sortByDateTime(b, a));
  $("#resPublicList").innerHTML = list.length ? list.map(matchCardHTML).join("") : emptyState("⚽", "No results recorded yet.");
}

function renderStandingsPage() {
  if (!publicState.tournament) {
    $("#stPublicFilterChips").innerHTML = "";
    $("#stPublicTables").innerHTML = emptyState("🏆", "No active tournament right now.");
    return;
  }
  const def = formatDef();
  if (def.type === "groups") {
    renderFilterChips("stPublicFilterChips", groupKeysUsed(), publicState.filters.standings, (val) => {
      publicState.filters.standings = val;
      renderStandingsPage();
    }, true, "Group ");
  } else {
    $("#stPublicFilterChips").innerHTML = "";
  }
  $("#stPublicTables").innerHTML = standingsForActiveTournament(publicState.filters.standings);
}

/* ---------------------------------------------------------------------
   Knockout page — read-only bracket, mirrors the admin layout.
   --------------------------------------------------------------------- */
function renderKnockoutPage() {
  const ko = publicState.knockout;
  const banner = $("#koPublicChampionBanner");
  const dlBtn = $("#koPublicDownloadBtn");

  if (!publicState.tournament) {
    banner.style.display = "none";
    dlBtn.classList.add("hidden");
    $("#koPublicRounds").innerHTML = emptyState("🏆", "No active tournament right now.");
    return;
  }

  if (!ko) {
    banner.style.display = "none";
    dlBtn.classList.add("hidden");
    $("#koPublicRounds").innerHTML = emptyState("🏁", "The knockout stage hasn't started yet — it kicks off automatically once the league/group stage wraps up.");
    return;
  }

  if (ko.champion) {
    banner.style.display = "block";
    banner.innerHTML = `<div class="card" style="padding:16px;text-align:center;font-weight:800;font-size:18px;">🏆 Champion: ${escapeHTML(teamName(ko.champion))}</div>`;
  } else {
    banner.style.display = "none";
    banner.innerHTML = "";
  }
  dlBtn.classList.remove("hidden");

  $("#koPublicRounds").innerHTML = ko.rounds.map((round) => `
    <div class="mt-16">
      <div class="eyebrow" style="margin-bottom:10px;">${escapeHTML(round.name)}</div>
      <div class="grid grid-2">
        ${round.matches.map((m) => koPublicMatchCardHTML(m)).join("")}
      </div>
    </div>`).join("");
}

function koPublicMatchCardHTML(m) {
  if (m.bye) {
    return `
      <div class="card" style="padding:14px;">
        <div class="flex-between" style="gap:8px;">
          <div class="flex" style="align-items:center;gap:8px;font-weight:600;font-size:13.5px;">
            ${teamBadgeHTML(m.winner, 26, 10)}
            ${escapeHTML(teamName(m.winner))}
          </div>
          <span class="mono" style="font-size:11px;color:var(--gold-400);font-weight:700;">BYE</span>
        </div>
      </div>`;
  }
  const hadEt = m.etHomeGoals !== null && m.etHomeGoals !== undefined;
  const hadPens = m.homePens !== null && m.homePens !== undefined;
  const scoreDisplay = m.played
    ? `<span class="mono" style="font-weight:800;font-size:15px;color:var(--gold-400);">${m.homeGoals}&ndash;${m.awayGoals}</span>`
    : `<span class="mono text-low" style="font-size:12px;">vs</span>`;
  return `
    <div class="card" style="padding:14px;">
      <div class="flex-between" style="gap:8px;">
        <div class="flex" style="align-items:center;gap:8px;font-weight:600;font-size:13.5px;">
          ${teamBadgeHTML(m.home, 26, 10)}
          ${escapeHTML(teamName(m.home))}
        </div>
        ${scoreDisplay}
        <div class="flex" style="align-items:center;gap:8px;font-weight:600;font-size:13.5px;flex-direction:row-reverse;text-align:right;">
          ${teamBadgeHTML(m.away, 26, 10)}
          ${escapeHTML(teamName(m.away))}
        </div>
      </div>
      ${hadEt || hadPens ? `
      <div class="text-low mono" style="font-size:11px;margin-top:6px;text-align:center;">
        ${hadEt ? `ET ${m.etHomeGoals}&ndash;${m.etAwayGoals}` : ""}${hadPens ? ` &nbsp; Pens ${m.homePens}&ndash;${m.awayPens}` : ""}
      </div>` : ""}
      ${m.date ? `<div class="text-low mono" style="font-size:11px;margin-top:8px;">${escapeHTML(m.date)}${m.time ? ` • ${escapeHTML(m.time)}` : ""}${m.venue ? ` • ${escapeHTML(m.venue)}` : ""}</div>` : ""}
    </div>`;
}

/* ---------------------------------------------------------------------
   Downloads — same branded export engine the admin uses. Fixtures and
   Results both respect the Match Day picker next to their button;
   "All Match Days" keeps the original full-tournament export.
   --------------------------------------------------------------------- */
function initDownloadButtons() {
  $("#fxPublicDownloadBtn").addEventListener("click", () => {
    const t = publicState.tournament;
    if (!t) { showToast("No active tournament to download.", "error"); return; }
    const def = formatDef();
    const day = $("#fxPublicDaySelect") ? $("#fxPublicDaySelect").value : "all";
    let all = fixturesArray().filter((f) => !f.played);
    if (day !== "all") all = all.filter((f) => f.date === day);
    if (!all.length) { showToast(day === "all" ? "No upcoming fixtures to download." : "No fixtures scheduled for that match day.", "error"); return; }
    const titleSuffix = day !== "all" ? ` — ${formatMatchDayLabel(day)}` : "";
    const blocks = def.type === "groups"
      ? groupKeysUsed().map((g) => exportFixturesTableBlock(`Group ${g}${titleSuffix}`, all.filter((f) => f.group === g).sort((a, b) => a.round - b.round), teamName)).join("")
      : exportFixturesTableBlock(`Upcoming Fixtures${titleSuffix}`, all.sort(sortByDateTime), teamName);
    openExportDocument({ docTitle: day !== "all" ? `Fixtures — ${formatMatchDayLabel(day)}` : "Fixtures", tournamentName: t.name, formatLabel: def.label, generatedNote: `${all.length} fixtures`, tableBlocksHTML: blocks });
  });

  $("#resPublicDownloadBtn").addEventListener("click", () => {
    const t = publicState.tournament;
    if (!t) { showToast("No active tournament to download.", "error"); return; }
    const def = formatDef();
    const day = $("#resPublicDaySelect") ? $("#resPublicDaySelect").value : "all";
    let played = fixturesArray().filter((f) => f.played);
    if (day !== "all") played = played.filter((f) => f.date === day);
    if (!played.length) { showToast(day === "all" ? "No results to download yet." : "No results for that match day.", "error"); return; }
    const titleSuffix = day !== "all" ? ` — ${formatMatchDayLabel(day)}` : "";
    const blocks = def.type === "groups"
      ? groupKeysUsed().map((g) => exportResultsTableBlock(`Group ${g}${titleSuffix}`, played.filter((f) => f.group === g).sort((a, b) => a.round - b.round), teamName)).join("")
      : exportResultsTableBlock(`All Results${titleSuffix}`, played.sort((a, b) => sortByDateTime(b, a)), teamName);
    openExportDocument({ docTitle: day !== "all" ? `Results — ${formatMatchDayLabel(day)}` : "Results", tournamentName: t.name, formatLabel: def.label, generatedNote: `${played.length} results`, tableBlocksHTML: blocks });
  });

  $("#stPublicDownloadBtn").addEventListener("click", () => {
    const t = publicState.tournament;
    if (!t) { showToast("No active tournament to download.", "error"); return; }
    const def = formatDef();
    const fixtures = fixturesArray();
    let blocks;
    if (def.type === "league") {
      blocks = exportStandingsTableBlock("League Table", Engine.computeStandings(Object.keys(t.teamIds || {}), fixtures), teamName);
    } else {
      blocks = groupKeysUsed().map((g) =>
        exportStandingsTableBlock(`Group ${g}`, Engine.computeStandings(t.groups[g] || [], fixtures.filter((f) => f.group === g)), teamName)
      ).join("");
    }
    openExportDocument({ docTitle: "Standings", tournamentName: t.name, formatLabel: def.label, generatedNote: `${fixtures.filter((f) => f.played).length} of ${fixtures.length} matches played`, tableBlocksHTML: blocks });
  });

  $("#koPublicDownloadBtn").addEventListener("click", () => {
    const t = publicState.tournament;
    const ko = publicState.knockout;
    if (!t || !ko) { showToast("No knockout bracket to download yet.", "error"); return; }
    const def = formatDef();
    const blocks = ko.rounds.map((round) => exportKnockoutRoundBlock(round, teamName)).join("");
    openExportDocument({ docTitle: "Knockout Bracket", tournamentName: t.name, formatLabel: def.label, generatedNote: ko.champion ? `Champion: ${teamName(ko.champion)}` : `${ko.rounds.length} round${ko.rounds.length === 1 ? "" : "s"} so far`, tableBlocksHTML: blocks });
  });
}

/* ---------------------------------------------------------------------
   Hidden admin access: tap the football icon in the footer 5 times
   within 3 seconds to open the admin login page. No visible "Admin"
   button anywhere on the public site, as required.
   --------------------------------------------------------------------- */
function initSecretAdminEntry() {
  const crest = $("#secretCrest");
  if (!crest) return;
  let tapCount = 0;
  let resetTimer = null;

  crest.addEventListener("click", () => {
    tapCount++;
    clearTimeout(resetTimer);
    if (tapCount >= 5) {
      tapCount = 0;
      window.location.href = "admin.html";
      return;
    }
    resetTimer = setTimeout(() => { tapCount = 0; }, 3000);
  });
}

/* ---------------------------------------------------------------------
   Offline detection
   --------------------------------------------------------------------- */
function updateOnlineStatus() { document.body.classList.toggle("offline", !navigator.onLine); }
window.addEventListener("online", updateOnlineStatus);
window.addEventListener("offline", updateOnlineStatus);

/* ---------------------------------------------------------------------
   PWA: service worker registration + "update available" prompt
   --------------------------------------------------------------------- */
function initServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").then((reg) => {
      reg.addEventListener("updatefound", () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            showUpdateToast(reg);
          }
        });
      });
    }).catch(() => {});
  });

  // Reload once the new service worker actually takes control, so the
  // refreshed tab runs the new app shell rather than a half-updated one.
  let refreshed = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshed) return;
    refreshed = true;
    window.location.reload();
  });
}

function showUpdateToast(reg) {
  const host = $("#toast-host");
  if (!host) return;
  const el = document.createElement("div");
  el.className = "toast success";
  el.innerHTML = `A new version is ready. <button id="updateNowBtn" style="margin-left:8px;background:var(--gold-500);color:#1a1305;border:none;padding:4px 10px;border-radius:6px;font-weight:700;cursor:pointer;">Update</button>`;
  host.appendChild(el);
  $("#updateNowBtn", el).addEventListener("click", () => {
    if (reg.waiting) reg.waiting.postMessage("SKIP_WAITING");
  });
}

/* ---------------------------------------------------------------------
   PWA: install prompt
   ------------------------------------------------------------------------
   Chrome/Edge/Android fire `beforeinstallprompt` when the app qualifies
   (valid manifest, service worker, HTTPS). We capture that event instead
   of letting the browser show its own address-bar-only UI, and surface a
   clearly visible "Install App" button in the footer instead — much
   easier to notice than a small icon.
   iOS Safari never fires this event and has no install API at all, so we
   show a manual "Add to Home Screen" hint there instead.
   --------------------------------------------------------------------- */
let deferredInstallPrompt = null;

function isRunningStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function initInstallPrompt() {
  const btn = $("#installAppBtn");
  const iosHint = $("#iosInstallHint");
  if (isRunningStandalone()) return; // already installed — show neither

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    btn.classList.remove("hidden");
  });

  btn.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    btn.disabled = true;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    btn.classList.add("hidden");
    btn.disabled = false;
    if (outcome === "accepted") showToast("App installed!", "success");
  });

  window.addEventListener("appinstalled", () => {
    btn.classList.add("hidden");
    deferredInstallPrompt = null;
  });

  // iOS never fires beforeinstallprompt — show the manual steps instead.
  if (isIOS()) iosHint.classList.remove("hidden");
}

/* ---------------------------------------------------------------------
   Boot
   --------------------------------------------------------------------- */
document.addEventListener("DOMContentLoaded", () => {
  updateOnlineStatus();
  initSecretAdminEntry();
  initDownloadButtons();
  initServiceWorker();
  initInstallPrompt();
  navigateTo(location.hash.replace("#", "") || "home");
  initDataBindings();
  setTimeout(hideLoading, 6000); // safety net if the DB is unreachable
});
