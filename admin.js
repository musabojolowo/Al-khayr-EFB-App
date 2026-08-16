/* =========================================================================
   AL-KHAYR EFB TOURNAMENT MANAGEMENT SYSTEM — admin.js
   ------------------------------------------------------------------------
   The full admin panel: authentication + route guard, shell/page
   navigation, Team Manager, Tournament Manager, Fixture Generator,
   Results, Standings, and Announcements & Rules. Merged from the
   phase-by-phase build into one file per the original file-list spec.
   Depends on firebase.js being loaded first (Firebase init, Paths,
   TOURNAMENT_FORMATS, Engine, export helpers, SEED_CONTENT).
   ========================================================================= */

/* =========================================================================
   js/admin.js — Admin panel logic (admin.html)
   Phase 1 scope: authentication only (login / logout / route guard).
   Team Manager, Tournament Manager, Fixtures, Results, Standings,
   Announcements, Rules and Settings are added in later phases as separate
   sections within this same file — the auth guard below will wrap all of
   them without changes.
   ========================================================================= */

function $(sel, root = document) { return root.querySelector(sel); }

function showToast(msg, type = "success") {
  const host = $("#toast-host");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function showView(view) {
  $("#loadingScreen").style.display = "none";
  $("#loginView").style.display = view === "login" ? "flex" : "none";
  $("#dashboardView").style.display = view === "dashboard" ? "block" : "none";
}

/* ---------------------------------------------------------------------
   PWA: service worker registration (same file as the public app — caches
   the admin panel's static assets too, offline-first for the app shell).
   --------------------------------------------------------------------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

/* ---------------------------------------------------------------------
   Login form
   --------------------------------------------------------------------- */
$("#loginForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const email = $("#email").value.trim();
  const password = $("#password").value;
  const btn = $("#loginBtn");
  const btnText = $("#loginBtnText");
  const errorEl = $("#loginError");

  errorEl.classList.remove("show");
  btn.disabled = true;
  btnText.innerHTML = '<span class="spinner"></span>';

  auth.signInWithEmailAndPassword(email, password)
    .catch((err) => {
      errorEl.textContent = friendlyAuthError(err);
      errorEl.classList.add("show");
    })
    .finally(() => {
      btn.disabled = false;
      btnText.textContent = "Log In";
    });
});

function friendlyAuthError(err) {
  switch (err.code) {
    case "auth/invalid-email": return "That email address doesn't look right.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential": return "Incorrect email or password.";
    case "auth/too-many-requests": return "Too many attempts. Please wait a moment and try again.";
    default: return "Couldn't log in. Please try again.";
  }
}

/* ---------------------------------------------------------------------
   Logout
   --------------------------------------------------------------------- */
$("#logoutBtn").addEventListener("click", () => {
  auth.signOut();
});

/* ---------------------------------------------------------------------
   Route guard: only users listed under /admins/{uid} may reach the
   dashboard. Anyone else — even with a valid Firebase Auth account — is
   signed back out and returned to the login screen.
   --------------------------------------------------------------------- */
let shellInitialized = false;

auth.onAuthStateChanged((user) => {
  if (!user) {
    showView("login");
    return;
  }
  db.ref(Paths.admin(user.uid)).once("value")
    .then((snap) => {
      if (snap.val() === true) {
        $("#adminEmail").textContent = user.email;
        $("#adminWelcomeName").textContent = user.email.split("@")[0];
        showView("dashboard");
        if (!shellInitialized) {
          shellInitialized = true;
          initAdminShell();
          if (typeof initTeamManager === "function") initTeamManager();
          if (typeof initTournamentManager === "function") initTournamentManager();
          if (typeof initFixtureManager === "function") initFixtureManager();
          if (typeof initResultsManager === "function") initResultsManager();
          if (typeof initStandingsManager === "function") initStandingsManager();
          if (typeof initKnockoutManager === "function") initKnockoutManager();
          if (typeof initAnnouncementsRulesManagers === "function") initAnnouncementsRulesManagers();
        }
      } else {
        auth.signOut();
        showView("login");
        showToast("This account is not authorized for admin access.", "error");
      }
    })
    .catch(() => {
      auth.signOut();
      showView("login");
      showToast("Couldn't verify admin access. Please try again.", "error");
    });
});

/* ---------------------------------------------------------------------
   Admin shell navigation — switches between admin-page sections. Every
   future phase (Tournament Manager, Fixtures, Results, ...) just adds a
   nav link + a matching #adminpage-{id} section; nothing here changes.
   --------------------------------------------------------------------- */
function goToAdminPage(page) {
  $$(".admin-page").forEach((el) => el.classList.remove("active"));
  const target = $(`#adminpage-${page}`);
  if (target) target.classList.add("active");

  $$("#adminNav a, #adminMobileNav .chip").forEach((el) => {
    el.classList.toggle("active", el.dataset.page === page);
  });

  const titles = { dashboard: "Dashboard", teams: "Team Manager", tournaments: "Tournament Manager", fixtures: "Fixtures", results: "Results", standings: "Standings", knockout: "Knockout", announcements: "Announcements", rules: "Rules" };
  $("#adminPageTitle").textContent = titles[page] || "Dashboard";
}

function initAdminShell() {
  $$("#adminNav a, #adminMobileNav .chip").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      goToAdminPage(el.dataset.page);
    });
  });
}

function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }


/* =========================================================================
   js/admin-teams.js — Team Manager (Phase 2)
   Teams are PERMANENT club records, independent of any tournament. They
   live under /teams/{teamId} forever and get referenced (never copied)
   by whichever tournament rosters them in — that wiring arrives in
   Phase 3 (Tournament Manager).
   ========================================================================= */

const teamsState = { all: {}, search: "" };

/* ---------------------------------------------------------------------
   Helpers
   --------------------------------------------------------------------- */
function slugify(str) {
  return str
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")  // strip accents (é → e)
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function teamRowLogoSrc(logo) {
  return logo ? `assets/logos/${logo}` : "assets/icons/team-placeholder.svg";
}

/* ---------------------------------------------------------------------
   Rendering
   --------------------------------------------------------------------- */
function renderTeamsTable() {
  const rows = Object.entries(teamsState.all)
    .map(([id, t]) => ({ id, ...t }))
    .filter((t) => {
      if (!teamsState.search) return true;
      const q = teamsState.search.toLowerCase();
      return t.name.toLowerCase().includes(q) || (t.shortName || "").toLowerCase().includes(q);
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  $("#statTeamCount").textContent = Object.keys(teamsState.all).length;
  $("#teamCountLabel").textContent = `${rows.length} team${rows.length === 1 ? "" : "s"}${teamsState.search ? " matching" : " saved"}`;

  const body = $("#teamsTableBody");
  const emptyState = $("#teamsEmptyState");
  const tableWrap = $("#teamsTableWrap");

  if (!rows.length) {
    tableWrap.classList.add("hidden");
    emptyState.classList.remove("hidden");
    body.innerHTML = "";
    return;
  }
  tableWrap.classList.remove("hidden");
  emptyState.classList.add("hidden");

  body.innerHTML = rows.map((t) => `
    <tr>
      <td><img src="${teamRowLogoSrc(t.logo)}" onerror="this.src='assets/icons/team-placeholder.svg'"
               alt="" style="width:28px;height:28px;border-radius:50%;object-fit:cover;background:var(--ink-700);" /></td>
      <td>${escapeAdminHTML(t.name)}</td>
      <td class="mono">${escapeAdminHTML(t.shortName || "—")}</td>
      <td class="text-low" style="font-size:12px;">${escapeAdminHTML(t.logo || "not set")}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-outline btn-sm" data-edit="${t.id}">Edit</button>
          <button class="btn btn-danger btn-sm" data-delete="${t.id}">Delete</button>
        </div>
      </td>
    </tr>
  `).join("");

  $$("[data-edit]").forEach((btn) => btn.addEventListener("click", () => openTeamForm(btn.dataset.edit)));
  $$("[data-delete]").forEach((btn) => btn.addEventListener("click", () => deleteTeam(btn.dataset.delete)));
}

function escapeAdminHTML(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* ---------------------------------------------------------------------
   Add / Edit form
   --------------------------------------------------------------------- */
function openTeamForm(teamId) {
  const isEdit = !!teamId;
  const team = isEdit ? teamsState.all[teamId] : null;

  $("#teamFormTitle").textContent = isEdit ? "Edit Team" : "Add Team";
  $("#teamId").value = teamId || "";
  $("#teamName").value = team ? team.name : "";
  $("#teamShort").value = team ? team.shortName : "";
  $("#teamLogo").value = team ? team.logo || "" : "";
  updateLogoPreview();
  $("#teamFormError").classList.remove("show");
  $("#teamFormCard").classList.remove("hidden");
  $("#teamName").focus();
}

function closeTeamForm() {
  $("#teamForm").reset();
  $("#teamFormCard").classList.add("hidden");
}

function updateLogoPreview() {
  const logo = $("#teamLogo").value.trim();
  $("#teamLogoPreview").src = teamRowLogoSrc(logo);
}

/* ---------------------------------------------------------------------
   CRUD operations
   --------------------------------------------------------------------- */
function saveTeamFromForm(e) {
  e.preventDefault();
  const teamId = $("#teamId").value || db.ref().child("teams").push().key;
  const name = $("#teamName").value.trim();
  const shortName = $("#teamShort").value.trim().toUpperCase();
  const logo = $("#teamLogo").value.trim();
  const errorEl = $("#teamFormError");

  if (!name || !shortName) {
    errorEl.textContent = "Team name and short name are required.";
    errorEl.classList.add("show");
    return;
  }

  // Guard against duplicate names (case-insensitive), excluding the team being edited
  const isEditing = !!$("#teamId").value;
  const duplicate = Object.entries(teamsState.all).find(
    ([id, t]) => t.name.toLowerCase() === name.toLowerCase() && id !== teamId
  );
  if (duplicate && !isEditing) {
    errorEl.textContent = "A team with this name already exists.";
    errorEl.classList.add("show");
    return;
  }

  const saveBtn = $("#teamSaveBtn");
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";

  db.ref(Paths.teams(teamId)).set({ name, shortName, logo })
    .then(() => {
      showToast(`${name} saved.`, "success");
      closeTeamForm();
    })
    .catch(() => showToast("Couldn't save team. Please try again.", "error"))
    .finally(() => {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save Team";
    });
}

function deleteTeam(teamId) {
  const team = teamsState.all[teamId];
  if (!team) return;
  if (!confirm(`Delete "${team.name}"? This cannot be undone.`)) return;

  db.ref(Paths.teams(teamId)).remove()
    .then(() => showToast(`${team.name} deleted.`, "success"))
    .catch(() => showToast("Couldn't delete team. Please try again.", "error"));
}

/* ---------------------------------------------------------------------
   Starter clubs — one-click convenience seeder. Skips any club whose
   name already exists, so it's always safe to click again.
   --------------------------------------------------------------------- */
const STARTER_CLUBS = [
  ["Arsenal", "ARS"], ["Chelsea", "CHE"], ["Liverpool", "LIV"], ["Manchester City", "MCI"],
  ["Manchester United", "MUN"], ["Tottenham Hotspur", "TOT"], ["Newcastle United", "NEW"],
  ["Aston Villa", "AVL"], ["Brighton & Hove Albion", "BHA"], ["West Ham United", "WHU"],
  ["Real Madrid", "RMA"], ["Barcelona", "BAR"], ["Atletico Madrid", "ATM"], ["Sevilla", "SEV"],
  ["Real Betis", "BET"], ["Villarreal", "VIL"], ["Real Sociedad", "RSO"], ["Athletic Club", "ATH"],
  ["Inter Milan", "INT"], ["AC Milan", "ACM"], ["Juventus", "JUV"], ["Napoli", "NAP"],
  ["Roma", "ROM"], ["Lazio", "LAZ"], ["Atalanta", "ATA"], ["Fiorentina", "FIO"],
  ["Bayern Munich", "BAY"], ["Borussia Dortmund", "BVB"], ["Bayer Leverkusen", "B04"], ["RB Leipzig", "RBL"],
  ["Eintracht Frankfurt", "SGE"], ["VfB Stuttgart", "VFB"], ["Paris Saint-Germain", "PSG"], ["Marseille", "OM"],
  ["Monaco", "ASM"], ["Lyon", "OL"], ["Lille", "LOSC"], ["Benfica", "SLB"],
  ["Porto", "POR"], ["Sporting CP", "SCP"], ["Ajax", "AJA"], ["PSV Eindhoven", "PSV"],
  ["Feyenoord", "FEY"], ["Galatasaray", "GAL"], ["Fenerbahçe", "FB"], ["Club Brugge", "CLB"],
  ["Red Bull Salzburg", "RBS"], ["Celtic", "CEL"]
];

function seedStarterClubs() {
  const existingNames = new Set(Object.values(teamsState.all).map((t) => t.name.toLowerCase()));
  const toAdd = STARTER_CLUBS.filter(([name]) => !existingNames.has(name.toLowerCase()));

  if (!toAdd.length) {
    showToast("All starter clubs are already saved.", "success");
    return;
  }
  if (!confirm(`Add ${toAdd.length} starter club${toAdd.length === 1 ? "" : "s"} to the database?`)) return;

  const updates = {};
  toAdd.forEach(([name, shortName]) => {
    const id = db.ref().child("teams").push().key;
    updates[id] = { name, shortName, logo: `${slugify(name)}.png` };
  });

  db.ref(Paths.teams()).update(updates)
    .then(() => showToast(`${toAdd.length} club${toAdd.length === 1 ? "" : "s"} added.`, "success"))
    .catch(() => showToast("Couldn't add starter clubs. Please try again.", "error"));
}

/* ---------------------------------------------------------------------
   Wire-up
   --------------------------------------------------------------------- */
function initTeamManager() {
  db.ref(Paths.teams()).on("value", (snap) => {
    teamsState.all = snap.val() || {};
    renderTeamsTable();
  });

  $("#addTeamBtn").addEventListener("click", () => openTeamForm(null));
  $("#teamCancelBtn").addEventListener("click", closeTeamForm);
  $("#teamForm").addEventListener("submit", saveTeamFromForm);
  $("#teamLogo").addEventListener("input", updateLogoPreview);
  $("#seedClubsBtn").addEventListener("click", seedStarterClubs);

  $("#teamSearch").addEventListener("input", (e) => {
    teamsState.search = e.target.value.trim();
    renderTeamsTable();
  });

  // Auto-suggest a logo filename from the team name while adding a new team
  $("#teamName").addEventListener("input", () => {
    const isEditing = !!$("#teamId").value;
    if (isEditing) return;
    const logoField = $("#teamLogo");
    if (!logoField.value || logoField.dataset.autofilled === "true") {
      logoField.value = $("#teamName").value.trim() ? `${slugify($("#teamName").value)}.png` : "";
      logoField.dataset.autofilled = "true";
      updateLogoPreview();
    }
  });
  $("#teamLogo").addEventListener("input", () => { $("#teamLogo").dataset.autofilled = "false"; });
}


/* =========================================================================
   js/admin-tournaments.js — Tournament Manager (Phase 3)
   Handles: choosing a format, entering tournament details, selecting an
   exact-count roster from the permanent Team Manager database, creating
   the tournament, setting which one is active, and deleting (with an
   archived snapshot so history is never lost).
   ========================================================================= */

const tournamentAdminState = {
  teams: {},           // full /teams snapshot, for the Step-3 checklist
  tournaments: {},     // full /tournaments snapshot
  activeTournamentId: null,
  selectedFormat: null,
  selectedTeamIds: new Set(),
  teamSearch: ""
};

/* ---------------------------------------------------------------------
   Step 1 — format picker
   --------------------------------------------------------------------- */
function renderFormatOptions() {
  const host = $("#formatOptions");
  host.innerHTML = FORMAT_ORDER.map((id) => {
    const f = TOURNAMENT_FORMATS[id];
    const selected = tournamentAdminState.selectedFormat === id;
    return `
      <div class="format-option ${selected ? "selected" : ""}" data-format="${id}">
        <div class="fmt-title">${escapeAdminHTML(f.label)}</div>
        <div class="fmt-meta">${f.type === "groups" ? `${f.groupCount} groups × ${f.teamsPerGroup} teams` : `Single table · ${f.legs === 2 ? "2 legs" : "1 leg"}`}</div>
      </div>`;
  }).join("");

  $$("[data-format]", host).forEach((el) => {
    el.addEventListener("click", () => {
      tournamentAdminState.selectedFormat = el.dataset.format;
      renderFormatOptions();
      renderTeamSelectCount();
      updateCreateButtonState();
    });
  });
}

/* ---------------------------------------------------------------------
   Step 3 — team checklist
   --------------------------------------------------------------------- */
function renderTeamSelectList() {
  const rows = Object.entries(tournamentAdminState.teams)
    .map(([id, t]) => ({ id, ...t }))
    .filter((t) => {
      if (!tournamentAdminState.teamSearch) return true;
      const q = tournamentAdminState.teamSearch.toLowerCase();
      return t.name.toLowerCase().includes(q) || (t.shortName || "").toLowerCase().includes(q);
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const body = $("#teamSelectBody");
  const empty = $("#teamSelectEmpty");
  const wrap = $("#teamSelectTable").closest(".table-wrap");

  if (!Object.keys(tournamentAdminState.teams).length) {
    wrap.classList.add("hidden");
    empty.classList.remove("hidden");
    body.innerHTML = "";
    return;
  }
  wrap.classList.remove("hidden");
  empty.classList.add("hidden");

  body.innerHTML = rows.map((t) => `
    <tr>
      <td><input type="checkbox" data-team-select="${t.id}" ${tournamentAdminState.selectedTeamIds.has(t.id) ? "checked" : ""} /></td>
      <td><img src="${teamRowLogoSrc(t.logo)}" onerror="this.src='assets/icons/team-placeholder.svg'" alt=""
               style="width:24px;height:24px;border-radius:50%;object-fit:cover;background:var(--ink-700);" /></td>
      <td>${escapeAdminHTML(t.name)}</td>
      <td class="mono">${escapeAdminHTML(t.shortName || "—")}</td>
    </tr>
  `).join("");

  $$("[data-team-select]", body).forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) tournamentAdminState.selectedTeamIds.add(cb.dataset.teamSelect);
      else tournamentAdminState.selectedTeamIds.delete(cb.dataset.teamSelect);
      renderTeamSelectCount();
      updateCreateButtonState();
    });
  });
}

function renderTeamSelectCount() {
  const required = tournamentAdminState.selectedFormat
    ? TOURNAMENT_FORMATS[tournamentAdminState.selectedFormat].teamCount
    : 0;
  const count = tournamentAdminState.selectedTeamIds.size;
  const el = $("#teamSelectCount");
  el.textContent = `${count} / ${required || "?"} selected`;
  el.style.color = required && count === required ? "var(--win)" : "var(--gold-400)";
}

/* ---------------------------------------------------------------------
   Create-button gating: format chosen, name filled, EXACT team count
   --------------------------------------------------------------------- */
function updateCreateButtonState() {
  const btn = $("#createTournamentBtn");
  const format = tournamentAdminState.selectedFormat;
  const nameOk = $("#tName").value.trim().length > 0;
  const countOk = format && tournamentAdminState.selectedTeamIds.size === TOURNAMENT_FORMATS[format].teamCount;
  btn.disabled = !(format && nameOk && countOk);
}

/* ---------------------------------------------------------------------
   Create tournament
   --------------------------------------------------------------------- */
function createTournament() {
  const format = tournamentAdminState.selectedFormat;
  const def = TOURNAMENT_FORMATS[format];
  const name = $("#tName").value.trim();
  const prize = $("#tPrize").value.trim();
  const startDate = $("#tStart").value;
  const endDate = $("#tEnd").value;
  const errorEl = $("#tFormError");
  errorEl.classList.remove("show");

  if (!format) { errorEl.textContent = "Please choose a tournament format."; errorEl.classList.add("show"); return; }
  if (tournamentAdminState.selectedTeamIds.size !== def.teamCount) {
    errorEl.textContent = `${def.label} requires exactly ${def.teamCount} teams.`;
    errorEl.classList.add("show");
    return;
  }

  const teamIds = {};
  tournamentAdminState.selectedTeamIds.forEach((id) => { teamIds[id] = true; });

  const tournamentId = db.ref(Paths.tournaments()).push().key;
  const record = { format, name, prize, startDate, endDate, teamIds, createdAt: Date.now() };

  const btn = $("#createTournamentBtn");
  btn.disabled = true;
  btn.textContent = "Creating…";

  const updates = {};
  updates[`tournaments/${tournamentId}`] = record;
  // Pre-fill announcement & rules from the standard copy for this format —
  // fully editable later once Phase 6 (Announcements & Rules) ships.
  if (typeof SEED_CONTENT !== "undefined" && SEED_CONTENT[format]) {
    updates[`announcements/${tournamentId}`] = SEED_CONTENT[format].announcement;
    updates[`rules/${tournamentId}`] = SEED_CONTENT[format].rules;
  }

  db.ref().update(updates)
    .then(() => {
      showToast(`"${name}" created.`, "success");
      resetCreateForm();
    })
    .catch(() => showToast("Couldn't create tournament. Please try again.", "error"))
    .finally(() => {
      btn.disabled = false;
      btn.textContent = "Create Tournament";
    });
}

function resetCreateForm() {
  tournamentAdminState.selectedFormat = null;
  tournamentAdminState.selectedTeamIds = new Set();
  $("#tName").value = "Al-Khayr EFB Tournament";
  $("#tPrize").value = "";
  $("#tStart").value = "";
  $("#tEnd").value = "";
  $("#tTeamSearch").value = "";
  tournamentAdminState.teamSearch = "";
  renderFormatOptions();
  renderTeamSelectList();
  renderTeamSelectCount();
  updateCreateButtonState();
}

/* ---------------------------------------------------------------------
   Tournaments list — set active / delete
   --------------------------------------------------------------------- */
function renderTournamentsList() {
  const entries = Object.entries(tournamentAdminState.tournaments)
    .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

  const host = $("#tournamentsList");
  const empty = $("#tournamentsEmpty");

  if (!entries.length) {
    host.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  host.innerHTML = entries.map(([id, t]) => {
    const def = TOURNAMENT_FORMATS[t.format] || { label: t.format };
    const isActive = id === tournamentAdminState.activeTournamentId;
    const teamCount = t.teamIds ? Object.keys(t.teamIds).length : 0;
    return `
      <div class="card">
        <div class="flex-between">
          <div>
            <div class="fmt-title" style="font-weight:700;">${escapeAdminHTML(t.name)} ${isActive ? '<span class="active-tag">● ACTIVE</span>' : ""}</div>
            <div class="text-low" style="font-size:12.5px;margin-top:4px;">${escapeAdminHTML(def.label)} • ${teamCount} teams${t.prize ? ` • 🏆 ${escapeAdminHTML(t.prize)}` : ""}</div>
            <div class="text-low" style="font-size:12px;margin-top:2px;">${t.startDate ? `Starts ${t.startDate}` : "No start date"}${t.endDate ? ` → Ends ${t.endDate}` : ""}</div>
          </div>
          <div class="row-actions">
            ${isActive
              ? `<button class="btn btn-outline btn-sm" data-deactivate="${id}">Deactivate</button>`
              : `<button class="btn btn-primary btn-sm" data-activate="${id}">Set Active</button>`}
            <button class="btn btn-danger btn-sm" data-delete-tournament="${id}">Delete</button>
          </div>
        </div>
      </div>`;
  }).join("");

  $$("[data-activate]", host).forEach((btn) => btn.addEventListener("click", () => setActiveTournament(btn.dataset.activate)));
  $$("[data-deactivate]", host).forEach((btn) => btn.addEventListener("click", () => setActiveTournament(null)));
  $$("[data-delete-tournament]", host).forEach((btn) => btn.addEventListener("click", () => deleteTournament(btn.dataset.deleteTournament)));
}

function setActiveTournament(tournamentId) {
  db.ref(Paths.activeTournamentId()).set(tournamentId || null)
    .then(() => showToast(tournamentId ? "Tournament set as active." : "Tournament deactivated.", "success"))
    .catch(() => showToast("Couldn't update active tournament.", "error"));
}

function deleteTournament(tournamentId) {
  const t = tournamentAdminState.tournaments[tournamentId];
  if (!t) return;
  if (!confirm(`Delete "${t.name}"? It will be moved to the archive and removed from live data. This cannot be undone.`)) return;

  Promise.all([
    db.ref(Paths.announcement(tournamentId)).once("value"),
    db.ref(Paths.rules(tournamentId)).once("value"),
    db.ref(Paths.fixtures(tournamentId)).once("value")
  ]).then(([annSnap, rulesSnap, fixturesSnap]) => {
    const archiveRecord = {
      ...t,
      announcement: annSnap.val() || "",
      rules: rulesSnap.val() || "",
      fixtures: fixturesSnap.val() || null,
      archivedAt: Date.now()
    };
    const updates = {};
    updates[`archive/${tournamentId}`] = archiveRecord;
    updates[`tournaments/${tournamentId}`] = null;
    updates[`announcements/${tournamentId}`] = null;
    updates[`rules/${tournamentId}`] = null;
    updates[`fixtures/${tournamentId}`] = null;
    if (tournamentAdminState.activeTournamentId === tournamentId) {
      updates[`settings/activeTournamentId`] = null;
    }
    return db.ref().update(updates);
  })
    .then(() => showToast(`"${t.name}" archived and removed.`, "success"))
    .catch(() => showToast("Couldn't delete tournament. Please try again.", "error"));
}

/* ---------------------------------------------------------------------
   Dashboard stat sync
   --------------------------------------------------------------------- */
function updateDashboardActiveTournamentStat() {
  const el = $("#statActiveTournament");
  if (!el) return;
  const t = tournamentAdminState.activeTournamentId
    ? tournamentAdminState.tournaments[tournamentAdminState.activeTournamentId]
    : null;
  el.textContent = t ? t.name : "None yet";
  syncDashboardChampionStat();
}

/* ---------------------------------------------------------------------
   Dashboard "Champion" stat — mirrors /knockout/{activeTournamentId}/champion
   for whichever tournament is currently active, so a completed knockout
   stage's winner is visible the moment the Final is decided.
   --------------------------------------------------------------------- */
let dashboardChampionRef = null;
let dashboardChampionTournamentId = null;

function syncDashboardChampionStat() {
  const el = $("#statChampion");
  if (!el) return;
  const activeId = tournamentAdminState.activeTournamentId;

  if (activeId !== dashboardChampionTournamentId) {
    if (dashboardChampionRef) dashboardChampionRef.off();
    dashboardChampionTournamentId = activeId;
    dashboardChampionRef = activeId ? db.ref(Paths.knockout(activeId)) : null;

    if (dashboardChampionRef) {
      dashboardChampionRef.on("value", (snap) => {
        const ko = snap.val();
        const championId = ko && ko.champion;
        const team = championId ? tournamentAdminState.teams[championId] : null;
        el.textContent = team ? `🏆 ${team.name}` : "None yet";
      });
    } else {
      el.textContent = "None yet";
    }
  }
}

/* ---------------------------------------------------------------------
   Wire-up
   --------------------------------------------------------------------- */
function initTournamentManager() {
  renderFormatOptions();
  updateCreateButtonState();

  db.ref(Paths.teams()).on("value", (snap) => {
    tournamentAdminState.teams = snap.val() || {};
    renderTeamSelectList();
    renderTeamSelectCount();
    updateCreateButtonState();
    dashboardChampionTournamentId = null; // force the champion stat to re-resolve team names
    syncDashboardChampionStat();
  });

  db.ref(Paths.tournaments()).on("value", (snap) => {
    tournamentAdminState.tournaments = snap.val() || {};
    renderTournamentsList();
    updateDashboardActiveTournamentStat();
  });

  db.ref(Paths.activeTournamentId()).on("value", (snap) => {
    tournamentAdminState.activeTournamentId = snap.val() || null;
    renderTournamentsList();
    updateDashboardActiveTournamentStat();
  });

  $("#tName").addEventListener("input", updateCreateButtonState);
  $("#tTeamSearch").addEventListener("input", (e) => {
    tournamentAdminState.teamSearch = e.target.value.trim();
    renderTeamSelectList();
  });
  $("#createTournamentBtn").addEventListener("click", createTournament);
}


/* =========================================================================
   js/admin-fixtures.js — Fixture Generator (Phase 4)
   Lets the admin pick any tournament and auto-generate its full schedule:
     - league formats  → single or double round-robin (Engine.generateLeagueFixtures)
     - group formats   → shuffle roster, split into groups, round-robin each
                          group (Engine.splitIntoGroups + generateGroupFixtures)
   Regenerating wipes any existing fixtures/results for that tournament, so
   it's guarded by a clear confirmation.
   Entering scores is Phase 5 (Results) — this page is schedule-only.
   ========================================================================= */

const fixtureAdminState = {
  tournaments: {},
  teams: {},
  selectedTournamentId: null,
  fixtures: {},          // fixtures of the currently selected tournament
  fixturesRef: null,     // live Firebase ref, detached when switching tournaments
  filter: "all"
};

/* ---------------------------------------------------------------------
   Tournament selector
   --------------------------------------------------------------------- */
function renderFxTournamentSelect() {
  const select = $("#fxTournamentSelect");
  const entries = Object.entries(fixtureAdminState.tournaments)
    .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

  if (!entries.length) {
    $("#fxNoTournament").classList.remove("hidden");
    $("#fxContent").classList.add("hidden");
    select.parentElement.classList.add("hidden");
    return;
  }
  select.parentElement.classList.remove("hidden");
  $("#fxNoTournament").classList.add("hidden");
  $("#fxContent").classList.remove("hidden");

  const previousValue = fixtureAdminState.selectedTournamentId;
  select.innerHTML = entries.map(([id, t]) => `<option value="${id}">${escapeAdminHTML(t.name)}</option>`).join("");

  const stillExists = previousValue && fixtureAdminState.tournaments[previousValue];
  const toSelect = stillExists ? previousValue : entries[0][0];
  select.value = toSelect;
  if (toSelect !== fixtureAdminState.selectedTournamentId) {
    selectTournamentForFixtures(toSelect);
  } else {
    renderFxSummary();
  }
}

function selectTournamentForFixtures(tournamentId) {
  fixtureAdminState.selectedTournamentId = tournamentId;
  if (fixtureAdminState.fixturesRef) fixtureAdminState.fixturesRef.off();

  fixtureAdminState.fixturesRef = db.ref(Paths.fixtures(tournamentId));
  fixtureAdminState.fixturesRef.on("value", (snap) => {
    fixtureAdminState.fixtures = snap.val() || {};
    fixtureAdminState.filter = "all";
    renderFxSummary();
    renderFxGroups();
    renderFxFilters();
    renderFxList();
    renderFxDaySelect();
  });
}

/* ---------------------------------------------------------------------
   Match Day picker — narrows the fixtures download to a single date,
   built from whatever dates are actually set on this tournament's
   fixtures. Defaults back to "All Match Days" whenever the fixture list
   changes underneath it, so it never points at a stale date.
   --------------------------------------------------------------------- */
function renderFxDaySelect() {
  const select = $("#fxDownloadDaySelect");
  const mdSelect = $("#fxDownloadMatchdaySelect");
  if (!select || !mdSelect) return;

  const t = fixtureAdminState.tournaments[fixtureAdminState.selectedTournamentId];
  const def = t ? TOURNAMENT_FORMATS[t.format] : null;

  // League formats download by Matchday (round number — permanent on
  // every fixture, unaffected by whether a calendar date is set).
  // Group formats keep the original per-date picker, untouched.
  if (def && def.type === "league") {
    mdSelect.classList.remove("hidden");
    select.classList.add("hidden");
    const total = matchdayCountForFormat(def);
    let options = `<option value="all">All Matchdays</option>`;
    for (let m = 1; m <= total; m++) options += `<option value="${m}">Matchday ${m}</option>`;
    mdSelect.innerHTML = options;
  } else {
    mdSelect.classList.add("hidden");
    select.classList.remove("hidden");
    const days = matchDaysFromFixtures(Object.values(fixtureAdminState.fixtures));
    select.innerHTML = `<option value="all">All Match Days</option>` +
      days.map((d) => `<option value="${d}">${formatMatchDayLabel(d)}</option>`).join("");
  }
}

/* ---------------------------------------------------------------------
   Summary card + Generate/Regenerate button
   --------------------------------------------------------------------- */
function renderFxSummary() {
  const t = fixtureAdminState.tournaments[fixtureAdminState.selectedTournamentId];
  if (!t) return;
  const def = TOURNAMENT_FORMATS[t.format];
  const teamCount = t.teamIds ? Object.keys(t.teamIds).length : 0;
  const fixtureCount = Object.keys(fixtureAdminState.fixtures).length;

  $("#fxFormatLabel").textContent = `${t.name} — ${def.label}`;
  $("#fxSummary").textContent = fixtureCount
    ? `${teamCount} teams • ${fixtureCount} fixtures generated`
    : `${teamCount} teams • no fixtures generated yet`;

  const btn = $("#fxGenerateBtn");
  btn.textContent = fixtureCount ? "Regenerate Fixtures" : "Generate Fixtures";
  btn.className = fixtureCount ? "btn btn-danger" : "btn btn-primary";
  btn.disabled = teamCount !== def.teamCount;
  $("#fxError").classList.remove("show");
  if (teamCount !== def.teamCount) {
    $("#fxError").textContent = `This tournament has ${teamCount} teams but ${def.label} requires exactly ${def.teamCount}.`;
    $("#fxError").classList.add("show");
  }
}

/* ---------------------------------------------------------------------
   Generate fixtures
   --------------------------------------------------------------------- */
function generateFixturesForSelectedTournament() {
  const tournamentId = fixtureAdminState.selectedTournamentId;
  const t = fixtureAdminState.tournaments[tournamentId];
  if (!t) return;
  const def = TOURNAMENT_FORMATS[t.format];
  const teamIds = Object.keys(t.teamIds || {});

  const alreadyHasFixtures = Object.keys(fixtureAdminState.fixtures).length > 0;
  if (alreadyHasFixtures) {
    const ok = confirm("Regenerating will permanently erase all existing fixtures AND any results already entered for this tournament. Continue?");
    if (!ok) return;
  }

  let fixturesArr;
  let groups = null;

  if (def.type === "league") {
    fixturesArr = Engine.generateLeagueFixtures(teamIds, def.legs);
  } else {
    const shuffled = Engine.shuffle(teamIds);
    groups = Engine.splitIntoGroups(shuffled, def.groupCount, def.teamsPerGroup);
    fixturesArr = Engine.generateGroupFixtures(groups);
  }

  const fixturesObj = {};
  fixturesArr.forEach((f) => {
    const id = db.ref().child("fixtures").child(tournamentId).push().key;
    fixturesObj[id] = f;
  });

  const btn = $("#fxGenerateBtn");
  btn.disabled = true;
  btn.textContent = "Generating…";

  const updates = {};
  updates[`fixtures/${tournamentId}`] = fixturesObj;
  if (groups) updates[`tournaments/${tournamentId}/groups`] = groups;

  db.ref().update(updates)
    .then(() => showToast(`${fixturesArr.length} fixtures generated.`, "success"))
    .catch(() => showToast("Couldn't generate fixtures. Please try again.", "error"))
    .finally(() => {
      btn.disabled = false;
    });
}

/* ---------------------------------------------------------------------
   Groups summary (group formats only)
   --------------------------------------------------------------------- */
function renderFxGroups() {
  const t = fixtureAdminState.tournaments[fixtureAdminState.selectedTournamentId];
  const wrap = $("#fxGroupsWrap");
  if (!t || !t.groups) { wrap.classList.add("hidden"); wrap.innerHTML = ""; return; }

  wrap.classList.remove("hidden");
  wrap.innerHTML = Object.keys(t.groups).sort().map((letter) => `
    <div class="card">
      <div class="eyebrow" style="margin-bottom:10px;">Group ${letter}</div>
      ${t.groups[letter].map((teamId) => `
        <div class="flex" style="align-items:center;gap:8px;padding:5px 0;font-size:13.5px;">
          <img src="${teamRowLogoSrc((fixtureAdminState.teams[teamId] || {}).logo)}" onerror="this.src='assets/icons/team-placeholder.svg'"
               style="width:22px;height:22px;border-radius:50%;object-fit:cover;background:var(--ink-700);" alt="" />
          ${escapeAdminHTML((fixtureAdminState.teams[teamId] || {}).name || "Unknown team")}
        </div>
      `).join("")}
    </div>
  `).join("");
}

/* ---------------------------------------------------------------------
   Fixture list + filters (by group, or by leg for two-leg leagues)
   --------------------------------------------------------------------- */
function fxTeamName(id) { return (fixtureAdminState.teams[id] || {}).name || "TBD"; }
function fxTeamInitials(id) {
  const n = fxTeamName(id);
  return n.split(" ").map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
}

function renderFxFilters() {
  const t = fixtureAdminState.tournaments[fixtureAdminState.selectedTournamentId];
  const host = $("#fxFilterChips");
  if (!t) { host.innerHTML = ""; return; }
  const def = TOURNAMENT_FORMATS[t.format];

  let values = [];
  if (def.type === "groups" && t.groups) values = Object.keys(t.groups).sort().map((g) => ({ val: g, label: `Group ${g}` }));
  else if (def.legs === 2) values = [{ val: "1", label: "Leg 1" }, { val: "2", label: "Leg 2" }];

  if (!values.length) { host.innerHTML = ""; return; }

  host.innerHTML = [`<button class="chip ${fixtureAdminState.filter === "all" ? "active" : ""}" data-fx-filter="all">All</button>`]
    .concat(values.map((v) => `<button class="chip ${fixtureAdminState.filter === v.val ? "active" : ""}" data-fx-filter="${v.val}">${v.label}</button>`))
    .join("");

  $$("[data-fx-filter]", host).forEach((btn) => {
    btn.addEventListener("click", () => {
      fixtureAdminState.filter = btn.dataset.fxFilter;
      renderFxFilters();
      renderFxList();
    });
  });
}

function renderFxList() {
  const t = fixtureAdminState.tournaments[fixtureAdminState.selectedTournamentId];
  const list = $("#fxList");
  const empty = $("#fxEmptyState");
  if (!t) { list.innerHTML = ""; return; }
  const def = TOURNAMENT_FORMATS[t.format];

  let rows = Object.entries(fixtureAdminState.fixtures).map(([id, f]) => ({ id, ...f }));

  if (!rows.length) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  if (fixtureAdminState.filter !== "all") {
    rows = rows.filter((f) => (def.type === "groups" ? f.group === fixtureAdminState.filter : String(f.leg) === fixtureAdminState.filter));
  }
  rows.sort((a, b) => (a.group || "").localeCompare(b.group || "") || a.round - b.round);

  list.innerHTML = rows.map((f) => `
    <div class="card" style="padding:14px;">
      <div class="flex-between" style="gap:8px;">
        <div class="flex" style="align-items:center;gap:8px;font-weight:600;font-size:13.5px;">
          <span class="team-badge" style="width:24px;height:24px;font-size:10px;">${fxTeamInitials(f.home)}</span>
          ${escapeAdminHTML(fxTeamName(f.home))}
        </div>
        <span class="mono text-low" style="font-size:12px;">vs</span>
        <div class="flex" style="align-items:center;gap:8px;font-weight:600;font-size:13.5px;flex-direction:row-reverse;text-align:right;">
          <span class="team-badge" style="width:24px;height:24px;font-size:10px;">${fxTeamInitials(f.away)}</span>
          ${escapeAdminHTML(fxTeamName(f.away))}
        </div>
      </div>
      <div class="text-low mono" style="font-size:11px;margin-top:10px;border-top:1px dashed var(--ink-600);padding-top:8px;">
        ${f.group ? `Group ${f.group}` : `Matchday ${f.round}${f.leg === 2 ? " · Leg 2" : ""}`}
        &nbsp;•&nbsp; ${f.played ? "Played" : "Not played yet"}
      </div>
    </div>
  `).join("");
}

/* ---------------------------------------------------------------------
   Wire-up
   --------------------------------------------------------------------- */
function initFixtureManager() {
  db.ref(Paths.teams()).on("value", (snap) => {
    fixtureAdminState.teams = snap.val() || {};
    renderFxGroups();
    renderFxList();
  });

  db.ref(Paths.tournaments()).on("value", (snap) => {
    fixtureAdminState.tournaments = snap.val() || {};
    renderFxTournamentSelect();
  });

  $("#fxTournamentSelect").addEventListener("change", (e) => selectTournamentForFixtures(e.target.value));
  $("#fxGenerateBtn").addEventListener("click", generateFixturesForSelectedTournament);
  $("#fxDownloadBtn").addEventListener("click", downloadFixturesExport);
}

/* ---------------------------------------------------------------------
   Download — one PDF-ready document, one table per group (or a single
   table for league formats).
   --------------------------------------------------------------------- */
function downloadFixturesExport() {
  const t = fixtureAdminState.tournaments[fixtureAdminState.selectedTournamentId];
  if (!t) return;
  const def = TOURNAMENT_FORMATS[t.format];
  let rows = Object.values(fixtureAdminState.fixtures);

  if (def.type === "league") {
    // Matchday (round-number) download for the two league formats.
    const matchday = $("#fxDownloadMatchdaySelect") ? $("#fxDownloadMatchdaySelect").value : "all";
    if (matchday !== "all") rows = rows.filter((f) => f.round === parseInt(matchday, 10));

    if (!rows.length) {
      showToast(matchday === "all" ? "Generate fixtures before downloading." : "No fixtures found for that Matchday.", "error");
      return;
    }

    const titleSuffix = matchday !== "all" ? ` — Matchday ${matchday}` : "";
    const blocks = exportFixturesTableBlock(`Full Schedule${titleSuffix}`, rows.sort((a, b) => a.leg - b.leg || a.round - b.round), fxTeamName);

    openExportDocument({
      docTitle: matchday !== "all" ? `Matchday ${matchday} Fixtures` : "Fixtures",
      tournamentName: t.name,
      formatLabel: def.label,
      generatedNote: `${rows.length} fixtures`,
      tableBlocksHTML: blocks
    });
    return;
  }

  // Group formats — unchanged, original per-calendar-date download.
  const day = $("#fxDownloadDaySelect") ? $("#fxDownloadDaySelect").value : "all";
  if (day !== "all") rows = rows.filter((f) => f.date === day);

  if (!rows.length) {
    showToast(day === "all" ? "Generate fixtures before downloading." : "No fixtures scheduled for that match day.", "error");
    return;
  }

  const titleSuffix = day !== "all" ? ` — ${formatMatchDayLabel(day)}` : "";
  const groupKeys = Object.keys(t.groups || {}).sort();
  const blocks = groupKeys.map((g) =>
    exportFixturesTableBlock(`Group ${g}${titleSuffix}`, rows.filter((f) => f.group === g).sort((a, b) => a.round - b.round), fxTeamName)
  ).join("");

  openExportDocument({
    docTitle: day !== "all" ? `Fixtures — ${formatMatchDayLabel(day)}` : "Fixtures",
    tournamentName: t.name,
    formatLabel: def.label,
    generatedNote: `${rows.length} fixtures`,
    tableBlocksHTML: blocks
  });
}


/* =========================================================================
   js/admin-results.js — Results (Phase 5)
   Admin picks any generated fixture and records its score (+ optional
   date/time/venue). Saving marks the fixture played:true, which is the
   ONLY thing standings, results and public displays key off of — there is
   no separate "results" table to keep in sync (see js/firebase.js schema
   notes).
   ========================================================================= */

const resultsAdminState = {
  tournaments: {},
  teams: {},
  selectedTournamentId: null,
  fixtures: {},
  fixturesRef: null,
  filter: "all"
};

function resTeamName(id) { return (resultsAdminState.teams[id] || {}).name || "TBD"; }
function resTeamInitials(id) {
  const n = resTeamName(id);
  return n.split(" ").map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
}

/* ---------------------------------------------------------------------
   Tournament selector
   --------------------------------------------------------------------- */
function renderResTournamentSelect() {
  const select = $("#resTournamentSelect");
  const entries = Object.entries(resultsAdminState.tournaments).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

  if (!entries.length) {
    $("#resNoTournament").classList.remove("hidden");
    $("#resContent").classList.add("hidden");
    select.parentElement.classList.add("hidden");
    return;
  }
  select.parentElement.classList.remove("hidden");
  $("#resNoTournament").classList.add("hidden");
  $("#resContent").classList.remove("hidden");

  const previous = resultsAdminState.selectedTournamentId;
  select.innerHTML = entries.map(([id, t]) => `<option value="${id}">${escapeAdminHTML(t.name)}</option>`).join("");
  const stillExists = previous && resultsAdminState.tournaments[previous];
  const toSelect = stillExists ? previous : entries[0][0];
  select.value = toSelect;
  if (toSelect !== resultsAdminState.selectedTournamentId) selectTournamentForResults(toSelect);
  else renderResList();
}

function selectTournamentForResults(tournamentId) {
  resultsAdminState.selectedTournamentId = tournamentId;
  closeResultForm();
  if (resultsAdminState.fixturesRef) resultsAdminState.fixturesRef.off();
  resultsAdminState.fixturesRef = db.ref(Paths.fixtures(tournamentId));
  resultsAdminState.fixturesRef.on("value", (snap) => {
    resultsAdminState.fixtures = snap.val() || {};
    renderResList();
    renderResDaySelect();
  });
}

function renderResDaySelect() {
  const select = $("#resDownloadDaySelect");
  const mdSelect = $("#resDownloadMatchdaySelect");
  if (!select || !mdSelect) return;

  const t = resultsAdminState.tournaments[resultsAdminState.selectedTournamentId];
  const def = t ? TOURNAMENT_FORMATS[t.format] : null;

  if (def && def.type === "league") {
    mdSelect.classList.remove("hidden");
    select.classList.add("hidden");
    const total = matchdayCountForFormat(def);
    let options = `<option value="all">All Matchdays</option>`;
    for (let m = 1; m <= total; m++) options += `<option value="${m}">Matchday ${m}</option>`;
    mdSelect.innerHTML = options;
  } else {
    mdSelect.classList.add("hidden");
    select.classList.remove("hidden");
    const days = matchDaysFromFixtures(Object.values(resultsAdminState.fixtures).filter((f) => f.played));
    select.innerHTML = `<option value="all">All Match Days</option>` +
      days.map((d) => `<option value="${d}">${formatMatchDayLabel(d)}</option>`).join("");
  }
}

/* ---------------------------------------------------------------------
   Fixture list (click a card to enter/edit its result)
   --------------------------------------------------------------------- */
function renderResList() {
  const t = resultsAdminState.tournaments[resultsAdminState.selectedTournamentId];
  const list = $("#resList");
  const empty = $("#resEmptyState");
  if (!t) { list.innerHTML = ""; return; }

  let rows = Object.entries(resultsAdminState.fixtures).map(([id, f]) => ({ id, ...f }));
  if (!rows.length) { list.innerHTML = ""; empty.classList.remove("hidden"); return; }
  empty.classList.add("hidden");

  if (resultsAdminState.filter === "upcoming") rows = rows.filter((f) => !f.played);
  if (resultsAdminState.filter === "played") rows = rows.filter((f) => f.played);
  rows.sort((a, b) => (a.group || "").localeCompare(b.group || "") || a.round - b.round);

  list.innerHTML = rows.map((f) => `
    <div class="card" style="padding:14px;cursor:pointer;" data-open-result="${f.id}">
      <div class="flex-between" style="gap:8px;">
        <div class="flex" style="align-items:center;gap:8px;font-weight:600;font-size:13.5px;">
          <span class="team-badge" style="width:24px;height:24px;font-size:10px;">${resTeamInitials(f.home)}</span>
          ${escapeAdminHTML(resTeamName(f.home))}
        </div>
        ${f.played
          ? `<span class="mono" style="font-weight:800;font-size:15px;color:var(--gold-400);">${f.homeGoals}&ndash;${f.awayGoals}</span>`
          : `<span class="mono text-low" style="font-size:12px;">vs</span>`}
        <div class="flex" style="align-items:center;gap:8px;font-weight:600;font-size:13.5px;flex-direction:row-reverse;text-align:right;">
          <span class="team-badge" style="width:24px;height:24px;font-size:10px;">${resTeamInitials(f.away)}</span>
          ${escapeAdminHTML(resTeamName(f.away))}
        </div>
      </div>
      <div class="flex-between text-low mono" style="font-size:11px;margin-top:10px;border-top:1px dashed var(--ink-600);padding-top:8px;">
        <span>${f.group ? `Group ${f.group}` : `Matchday ${f.round}${f.leg === 2 ? " · Leg 2" : ""}`}</span>
        <span class="${f.played ? "" : ""}" style="color:${f.played ? "var(--win)" : "var(--gold-400)"};font-weight:700;">${f.played ? "Edit Result" : "Enter Result"}</span>
      </div>
    </div>
  `).join("");

  $$("[data-open-result]", list).forEach((card) => card.addEventListener("click", () => openResultForm(card.dataset.openResult)));
}

function renderResFilters() {
  $$("#resFilterChips [data-res-filter]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.resFilter === resultsAdminState.filter);
  });
}

/* ---------------------------------------------------------------------
   Score entry form
   --------------------------------------------------------------------- */
function openResultForm(fixtureId) {
  const f = resultsAdminState.fixtures[fixtureId];
  if (!f) return;
  $("#resFixtureId").value = fixtureId;
  $("#resFormTitle").textContent = f.played ? "Edit Result" : "Enter Result";
  $("#resFormTeams").textContent = `${resTeamName(f.home)} vs ${resTeamName(f.away)}`;
  $("#resHomeGoals").value = f.homeGoals ?? "";
  $("#resAwayGoals").value = f.awayGoals ?? "";
  $("#resDate").value = f.date || "";
  $("#resTime").value = f.time || "";
  $("#resVenue").value = f.venue || "";
  $("#resFormError").classList.remove("show");
  $("#resFormCard").classList.remove("hidden");
  $("#resFormCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeResultForm() {
  $("#resForm").reset();
  $("#resFormCard").classList.add("hidden");
}

function saveResultFromForm(e) {
  e.preventDefault();
  const tournamentId = resultsAdminState.selectedTournamentId;
  const fixtureId = $("#resFixtureId").value;
  const homeGoals = parseInt($("#resHomeGoals").value, 10);
  const awayGoals = parseInt($("#resAwayGoals").value, 10);
  const errorEl = $("#resFormError");

  if (isNaN(homeGoals) || isNaN(awayGoals) || homeGoals < 0 || awayGoals < 0) {
    errorEl.textContent = "Enter valid, non-negative scores for both teams.";
    errorEl.classList.add("show");
    return;
  }
  errorEl.classList.remove("show");

  const updates = {
    homeGoals, awayGoals, played: true,
    date: $("#resDate").value, time: $("#resTime").value, venue: $("#resVenue").value.trim()
  };

  const btn = $("#resSaveBtn");
  btn.disabled = true;
  btn.textContent = "Saving…";

  db.ref(Paths.fixtures(tournamentId, fixtureId)).update(updates)
    .then(() => {
      showToast("Result saved.", "success");
      closeResultForm();
      maybeAutoGenerateKnockout(tournamentId);
    })
    .catch(() => showToast("Couldn't save result. Please try again.", "error"))
    .finally(() => { btn.disabled = false; btn.textContent = "Save Result"; });
}

/* ---------------------------------------------------------------------
   Download — only played fixtures, one table per group (or one table
   for league formats).
   --------------------------------------------------------------------- */
function downloadResultsExport() {
  const t = resultsAdminState.tournaments[resultsAdminState.selectedTournamentId];
  if (!t) return;
  const def = TOURNAMENT_FORMATS[t.format];
  let played = Object.values(resultsAdminState.fixtures).filter((f) => f.played);

  if (def.type === "league") {
    // Matchday (round-number) results download for the two league formats.
    const matchday = $("#resDownloadMatchdaySelect") ? $("#resDownloadMatchdaySelect").value : "all";
    if (matchday !== "all") played = played.filter((f) => f.round === parseInt(matchday, 10));

    if (!played.length) {
      showToast(matchday === "all" ? "No results recorded yet for this tournament." : "No completed results for that Matchday yet.", "error");
      return;
    }

    const titleSuffix = matchday !== "all" ? ` — Matchday ${matchday}` : "";
    const blocks = exportResultsTableBlock(`All Results${titleSuffix}`, played.sort((a, b) => a.leg - b.leg || a.round - b.round), resTeamName);

    openExportDocument({
      docTitle: matchday !== "all" ? `Matchday ${matchday} Results` : "Results",
      tournamentName: t.name,
      formatLabel: def.label,
      generatedNote: `${played.length} results`,
      tableBlocksHTML: blocks
    });
    return;
  }

  // Group formats — unchanged, original per-calendar-date download.
  const day = $("#resDownloadDaySelect") ? $("#resDownloadDaySelect").value : "all";
  if (day !== "all") played = played.filter((f) => f.date === day);

  if (!played.length) {
    showToast(day === "all" ? "No results recorded yet for this tournament." : "No results recorded for that match day.", "error");
    return;
  }

  const titleSuffix = day !== "all" ? ` — ${formatMatchDayLabel(day)}` : "";
  const groupKeys = Object.keys(t.groups || {}).sort();
  const blocks = groupKeys.map((g) =>
    exportResultsTableBlock(`Group ${g}${titleSuffix}`, played.filter((f) => f.group === g).sort((a, b) => a.round - b.round), resTeamName)
  ).join("");

  openExportDocument({
    docTitle: day !== "all" ? `Results — ${formatMatchDayLabel(day)}` : "Results",
    tournamentName: t.name,
    formatLabel: def.label,
    generatedNote: `${played.length} results`,
    tableBlocksHTML: blocks
  });
}

/* ---------------------------------------------------------------------
   Wire-up
   --------------------------------------------------------------------- */
function initResultsManager() {
  db.ref(Paths.teams()).on("value", (snap) => { resultsAdminState.teams = snap.val() || {}; renderResList(); });
  db.ref(Paths.tournaments()).on("value", (snap) => { resultsAdminState.tournaments = snap.val() || {}; renderResTournamentSelect(); });

  $("#resTournamentSelect").addEventListener("change", (e) => selectTournamentForResults(e.target.value));
  $("#resForm").addEventListener("submit", saveResultFromForm);
  $("#resCancelBtn").addEventListener("click", closeResultForm);
  $("#resDownloadBtn").addEventListener("click", downloadResultsExport);

  $$("#resFilterChips [data-res-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      resultsAdminState.filter = btn.dataset.resFilter;
      renderResFilters();
      renderResList();
    });
  });
}


/* =========================================================================
   js/admin-standings.js — Standings (Phase 5)
   Standings are never stored — always computed on the fly from
   /teams + /fixtures via Engine.computeStandings, so they can never drift
   out of sync with results entered on the Results page.
   ========================================================================= */

const standingsAdminState = {
  tournaments: {},
  teams: {},
  selectedTournamentId: null,
  fixtures: {},
  fixturesRef: null,
  groupFilter: "all"
};

function stTeamName(id) { return (standingsAdminState.teams[id] || {}).name || "TBD"; }

/* ---------------------------------------------------------------------
   Tournament selector
   --------------------------------------------------------------------- */
function renderStTournamentSelect() {
  const select = $("#stTournamentSelect");
  const entries = Object.entries(standingsAdminState.tournaments).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

  if (!entries.length) {
    $("#stNoTournament").classList.remove("hidden");
    $("#stContent").classList.add("hidden");
    select.parentElement.classList.add("hidden");
    return;
  }
  select.parentElement.classList.remove("hidden");
  $("#stNoTournament").classList.add("hidden");
  $("#stContent").classList.remove("hidden");

  const previous = standingsAdminState.selectedTournamentId;
  select.innerHTML = entries.map(([id, t]) => `<option value="${id}">${escapeAdminHTML(t.name)}</option>`).join("");
  const stillExists = previous && standingsAdminState.tournaments[previous];
  const toSelect = stillExists ? previous : entries[0][0];
  select.value = toSelect;
  if (toSelect !== standingsAdminState.selectedTournamentId) selectTournamentForStandings(toSelect);
  else { renderStGroupChips(); renderStTables(); }
}

function selectTournamentForStandings(tournamentId) {
  standingsAdminState.selectedTournamentId = tournamentId;
  standingsAdminState.groupFilter = "all";
  if (standingsAdminState.fixturesRef) standingsAdminState.fixturesRef.off();
  standingsAdminState.fixturesRef = db.ref(Paths.fixtures(tournamentId));
  standingsAdminState.fixturesRef.on("value", (snap) => {
    standingsAdminState.fixtures = snap.val() || {};
    renderStGroupChips();
    renderStTables();
  });
}

/* ---------------------------------------------------------------------
   Group filter chips (group formats only)
   --------------------------------------------------------------------- */
function renderStGroupChips() {
  const t = standingsAdminState.tournaments[standingsAdminState.selectedTournamentId];
  const host = $("#stGroupChips");
  if (!t) { host.innerHTML = ""; return; }
  const def = TOURNAMENT_FORMATS[t.format];

  if (def.type !== "groups" || !t.groups) { host.innerHTML = ""; return; }
  const groupKeys = Object.keys(t.groups).sort();

  host.innerHTML = [`<button class="chip ${standingsAdminState.groupFilter === "all" ? "active" : ""}" data-st-group="all">All Groups</button>`]
    .concat(groupKeys.map((g) => `<button class="chip ${standingsAdminState.groupFilter === g ? "active" : ""}" data-st-group="${g}">Group ${g}</button>`))
    .join("");

  $$("[data-st-group]", host).forEach((btn) => {
    btn.addEventListener("click", () => {
      standingsAdminState.groupFilter = btn.dataset.stGroup;
      renderStGroupChips();
      renderStTables();
    });
  });
}

/* ---------------------------------------------------------------------
   Render tables
   --------------------------------------------------------------------- */
function buildStandingsTableHTML(rows) {
  return `
    <div class="table-wrap">
      <table class="admin-table">
        <thead>
          <tr><th>#</th><th>Team</th><th class="num">P</th><th class="num">W</th><th class="num">D</th><th class="num">L</th><th class="num">GF</th><th class="num">GA</th><th class="num">GD</th><th class="num" style="color:var(--gold-400);">Pts</th></tr>
        </thead>
        <tbody>
          ${rows.map((r, i) => `
            <tr>
              <td class="mono">${i + 1}</td>
              <td>${escapeAdminHTML(stTeamName(r.team))}</td>
              <td class="mono">${r.played}</td>
              <td class="mono">${r.won}</td>
              <td class="mono">${r.drawn}</td>
              <td class="mono">${r.lost}</td>
              <td class="mono">${r.gf}</td>
              <td class="mono">${r.ga}</td>
              <td class="mono">${r.gd > 0 ? "+" : ""}${r.gd}</td>
              <td class="mono" style="font-weight:800;color:var(--gold-400);">${r.points}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

function renderStTables() {
  const t = standingsAdminState.tournaments[standingsAdminState.selectedTournamentId];
  const host = $("#stTables");
  if (!t) { host.innerHTML = ""; return; }
  const def = TOURNAMENT_FORMATS[t.format];
  const fixtures = Object.values(standingsAdminState.fixtures);
  const teamIds = Object.keys(t.teamIds || {});

  if (def.type === "league") {
    const rows = Engine.computeStandings(teamIds, fixtures);
    host.innerHTML = `<div class="card">${buildStandingsTableHTML(rows)}</div>`;
    return;
  }

  // groups
  const groupKeys = Object.keys(t.groups || {}).sort();
  const filtered = standingsAdminState.groupFilter === "all" ? groupKeys : groupKeys.filter((g) => g === standingsAdminState.groupFilter);
  host.innerHTML = `<div class="grid grid-2">${filtered.map((g) => {
    const groupTeamIds = t.groups[g] || [];
    const groupFixtures = fixtures.filter((f) => f.group === g);
    const rows = Engine.computeStandings(groupTeamIds, groupFixtures);
    return `<div class="card"><div class="eyebrow" style="margin-bottom:10px;">Group ${g}</div>${buildStandingsTableHTML(rows)}</div>`;
  }).join("")}</div>`;
}

/* ---------------------------------------------------------------------
   Download
   --------------------------------------------------------------------- */
function downloadStandingsExport() {
  const t = standingsAdminState.tournaments[standingsAdminState.selectedTournamentId];
  if (!t) return;
  const def = TOURNAMENT_FORMATS[t.format];
  const fixtures = Object.values(standingsAdminState.fixtures);
  const teamIds = Object.keys(t.teamIds || {});

  let blocks;
  if (def.type === "league") {
    const rows = Engine.computeStandings(teamIds, fixtures);
    blocks = exportStandingsTableBlock("League Table", rows, stTeamName);
  } else {
    const groupKeys = Object.keys(t.groups || {}).sort();
    blocks = groupKeys.map((g) => {
      const rows = Engine.computeStandings(t.groups[g] || [], fixtures.filter((f) => f.group === g));
      return exportStandingsTableBlock(`Group ${g}`, rows, stTeamName);
    }).join("");
  }

  openExportDocument({
    docTitle: "Standings",
    tournamentName: t.name,
    formatLabel: def.label,
    generatedNote: `${fixtures.filter((f) => f.played).length} of ${fixtures.length} matches played`,
    tableBlocksHTML: blocks
  });
}

/* ---------------------------------------------------------------------
   Wire-up
   --------------------------------------------------------------------- */
function initStandingsManager() {
  db.ref(Paths.teams()).on("value", (snap) => { standingsAdminState.teams = snap.val() || {}; renderStTables(); });
  db.ref(Paths.tournaments()).on("value", (snap) => { standingsAdminState.tournaments = snap.val() || {}; renderStTournamentSelect(); });

  $("#stTournamentSelect").addEventListener("change", (e) => selectTournamentForStandings(e.target.value));
  $("#stDownloadBtn").addEventListener("click", downloadStandingsExport);
}


/* =========================================================================
   js/admin-knockout.js — Knockout (Phase 9)
   ------------------------------------------------------------------------
   Round 1 is seeded automatically the instant every league/group fixture
   for a tournament is marked played (see maybeAutoGenerateKnockout, called
   from admin-results.js's saveResultFromForm). Each later round is built
   automatically the instant every match in the round before it has a
   result. Only formats with knockoutQualifiers (leagues) or
   qualifiersPerGroup (group formats) set in TOURNAMENT_FORMATS get a
   knockout stage at all.
   ========================================================================= */

const knockoutAdminState = {
  tournaments: {},
  teams: {},
  selectedTournamentId: null,
  fixtures: {},
  fixturesRef: null,
  knockout: null,
  knockoutRef: null
};

function koTeamName(id) { return (knockoutAdminState.teams[id] || {}).name || "TBD"; }
function koTeamInitials(id) {
  const n = koTeamName(id);
  return n.split(" ").map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
}

/* ---------------------------------------------------------------------
   Tournament selector
   --------------------------------------------------------------------- */
function renderKoTournamentSelect() {
  const select = $("#koTournamentSelect");
  const entries = Object.entries(knockoutAdminState.tournaments).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

  if (!entries.length) {
    $("#koNoTournament").classList.remove("hidden");
    $("#koContent").classList.add("hidden");
    select.parentElement.classList.add("hidden");
    return;
  }
  select.parentElement.classList.remove("hidden");
  $("#koNoTournament").classList.add("hidden");
  $("#koContent").classList.remove("hidden");

  const previous = knockoutAdminState.selectedTournamentId;
  select.innerHTML = entries.map(([id, t]) => `<option value="${id}">${escapeAdminHTML(t.name)}</option>`).join("");
  const stillExists = previous && knockoutAdminState.tournaments[previous];
  const toSelect = stillExists ? previous : entries[0][0];
  select.value = toSelect;
  if (toSelect !== knockoutAdminState.selectedTournamentId) selectTournamentForKnockout(toSelect);
  else renderKoContent();
}

function selectTournamentForKnockout(tournamentId) {
  knockoutAdminState.selectedTournamentId = tournamentId;
  closeKoResultForm();
  if (knockoutAdminState.fixturesRef) knockoutAdminState.fixturesRef.off();
  if (knockoutAdminState.knockoutRef) knockoutAdminState.knockoutRef.off();

  knockoutAdminState.fixturesRef = db.ref(Paths.fixtures(tournamentId));
  knockoutAdminState.fixturesRef.on("value", (snap) => {
    knockoutAdminState.fixtures = snap.val() || {};
    renderKoContent();
  });

  knockoutAdminState.knockoutRef = db.ref(Paths.knockout(tournamentId));
  knockoutAdminState.knockoutRef.on("value", (snap) => {
    knockoutAdminState.knockout = snap.val() || null;
    renderKoContent();
  });
}

/* ---------------------------------------------------------------------
   Rendering
   --------------------------------------------------------------------- */
function renderKoContent() {
  const t = knockoutAdminState.tournaments[knockoutAdminState.selectedTournamentId];
  if (!t) return;
  const def = TOURNAMENT_FORMATS[t.format];
  const hasKnockoutRule = !!(def.knockoutQualifiers || def.qualifiersPerGroup);
  const fixturesList = Object.values(knockoutAdminState.fixtures);
  const stageComplete = fixturesList.length > 0 && fixturesList.every((f) => f.played);
  const ko = knockoutAdminState.knockout;

  const champBanner = $("#koChampionBanner");
  if (ko && ko.champion) {
    champBanner.style.display = "block";
    champBanner.innerHTML = `<div class="fmt-title" style="font-weight:800;font-size:18px;">🏆 Champion: ${escapeAdminHTML(koTeamName(ko.champion))}</div>`;
  } else {
    champBanner.style.display = "none";
    champBanner.innerHTML = "";
  }

  const notGenCard = $("#koNotGenerated");
  const genBtn = $("#koGenerateBtn");
  const regenBtn = $("#koRegenerateBtn");
  const dlBtn = $("#koDownloadBtn");

  if (!hasKnockoutRule) {
    notGenCard.classList.remove("hidden");
    $("#koNotGeneratedNote").textContent = "This tournament's format doesn't have a knockout stage configured.";
    genBtn.disabled = true;
    regenBtn.classList.add("hidden");
    dlBtn.classList.add("hidden");
    $("#koRounds").innerHTML = "";
    return;
  }

  if (!ko) {
    notGenCard.classList.remove("hidden");
    genBtn.disabled = !stageComplete;
    $("#koNotGeneratedNote").textContent = stageComplete
      ? "The league/group stage is complete — you can generate the bracket now, or it'll build itself automatically the next time a result is saved."
      : "The bracket is seeded automatically the moment every league/group fixture for this tournament is marked played — nothing to do here until then.";
    regenBtn.classList.add("hidden");
    dlBtn.classList.add("hidden");
    $("#koRounds").innerHTML = "";
    return;
  }

  notGenCard.classList.add("hidden");
  regenBtn.classList.remove("hidden");
  dlBtn.classList.remove("hidden");

  $("#koRounds").innerHTML = ko.rounds.map((round, ri) => `
    <div class="mt-16">
      <div class="eyebrow" style="margin-bottom:10px;">${escapeAdminHTML(round.name)}</div>
      <div class="grid grid-2">
        ${round.matches.map((m, mi) => koMatchCardHTML(m, ri, mi)).join("")}
      </div>
    </div>`).join("");

  $$("[data-open-ko]", $("#koRounds")).forEach((card) => {
    card.addEventListener("click", () => openKoResultForm(parseInt(card.dataset.roundIdx, 10), parseInt(card.dataset.openKo, 10)));
  });
}

function koMatchCardHTML(m, roundIndex, matchIndex) {
  if (m.bye) {
    return `
      <div class="card" style="padding:14px;">
        <div class="flex-between" style="gap:8px;">
          <div class="flex" style="align-items:center;gap:8px;font-weight:600;font-size:13.5px;">
            <span class="team-badge" style="width:24px;height:24px;font-size:10px;">${koTeamInitials(m.winner)}</span>
            ${escapeAdminHTML(koTeamName(m.winner))}
          </div>
          <span class="mono" style="font-size:11px;color:var(--gold-400);font-weight:700;">BYE</span>
        </div>
        <div class="text-low mono" style="font-size:11px;margin-top:10px;border-top:1px dashed var(--ink-600);padding-top:8px;">Advances automatically</div>
      </div>`;
  }

  const scoreDisplay = m.played
    ? `<span class="mono" style="font-weight:800;font-size:15px;color:var(--gold-400);">${m.homeGoals}&ndash;${m.awayGoals}</span>`
    : `<span class="mono text-low" style="font-size:12px;">vs</span>`;

  const hadEt = m.etHomeGoals !== null && m.etHomeGoals !== undefined;
  const hadPens = m.homePens !== null && m.homePens !== undefined;

  return `
    <div class="card" style="padding:14px;cursor:pointer;" data-open-ko="${matchIndex}" data-round-idx="${roundIndex}">
      <div class="flex-between" style="gap:8px;">
        <div class="flex" style="align-items:center;gap:8px;font-weight:600;font-size:13.5px;">
          <span class="team-badge" style="width:24px;height:24px;font-size:10px;">${koTeamInitials(m.home)}</span>
          ${escapeAdminHTML(koTeamName(m.home))}
        </div>
        ${scoreDisplay}
        <div class="flex" style="align-items:center;gap:8px;font-weight:600;font-size:13.5px;flex-direction:row-reverse;text-align:right;">
          <span class="team-badge" style="width:24px;height:24px;font-size:10px;">${koTeamInitials(m.away)}</span>
          ${escapeAdminHTML(koTeamName(m.away))}
        </div>
      </div>
      ${hadEt || hadPens ? `
      <div class="text-low mono" style="font-size:11px;margin-top:6px;text-align:center;">
        ${hadEt ? `ET ${m.etHomeGoals}&ndash;${m.etAwayGoals}` : ""}${hadPens ? ` &nbsp; Pens ${m.homePens}&ndash;${m.awayPens}` : ""}
      </div>` : ""}
      <div class="flex-between text-low mono" style="font-size:11px;margin-top:10px;border-top:1px dashed var(--ink-600);padding-top:8px;">
        <span>${m.winner ? `Winner: ${escapeAdminHTML(koTeamName(m.winner))}` : "Not played yet"}</span>
        <span style="color:${m.played ? "var(--win)" : "var(--gold-400)"};font-weight:700;">${m.played ? "Edit Result" : "Enter Result"}</span>
      </div>
    </div>`;
}

/* ---------------------------------------------------------------------
   Score entry form — extra time / penalties fields only need filling in
   if the admin ticks "Match went to extra time / penalties" (shown
   whenever a match is being re-opened that already has them saved, too).
   --------------------------------------------------------------------- */
function openKoResultForm(roundIndex, matchIndex) {
  const ko = knockoutAdminState.knockout;
  if (!ko) return;
  const m = ko.rounds[roundIndex].matches[matchIndex];
  if (!m || m.bye) return;

  $("#koRoundIndex").value = roundIndex;
  $("#koMatchId").value = matchIndex;
  $("#koFormTitle").textContent = m.played ? "Edit Result" : "Enter Result";
  $("#koFormTeams").textContent = `${koTeamName(m.home)} vs ${koTeamName(m.away)}`;
  $("#koHomeGoals").value = m.homeGoals ?? "";
  $("#koAwayGoals").value = m.awayGoals ?? "";

  const hadEt = m.etHomeGoals !== null && m.etHomeGoals !== undefined;
  const hadPens = m.homePens !== null && m.homePens !== undefined;
  $("#koWentToEt").checked = hadEt || hadPens;
  $("#koEtPensFields").classList.toggle("hidden", !(hadEt || hadPens));
  $("#koEtHomeGoals").value = m.etHomeGoals ?? "";
  $("#koEtAwayGoals").value = m.etAwayGoals ?? "";
  $("#koHomePens").value = m.homePens ?? "";
  $("#koAwayPens").value = m.awayPens ?? "";

  $("#koDate").value = m.date || "";
  $("#koTime").value = m.time || "";
  $("#koVenue").value = m.venue || "";
  $("#koFormError").classList.remove("show");
  $("#koFormCard").classList.remove("hidden");
  $("#koFormCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeKoResultForm() {
  $("#koForm").reset();
  $("#koEtPensFields").classList.add("hidden");
  $("#koFormCard").classList.add("hidden");
}

function saveKoResultFromForm(e) {
  e.preventDefault();
  const tournamentId = knockoutAdminState.selectedTournamentId;
  const roundIndex = parseInt($("#koRoundIndex").value, 10);
  const matchIndex = parseInt($("#koMatchId").value, 10);
  const homeGoals = parseInt($("#koHomeGoals").value, 10);
  const awayGoals = parseInt($("#koAwayGoals").value, 10);
  const errorEl = $("#koFormError");

  if (isNaN(homeGoals) || isNaN(awayGoals) || homeGoals < 0 || awayGoals < 0) {
    errorEl.textContent = "Enter valid, non-negative scores for both teams.";
    errorEl.classList.add("show");
    return;
  }

  const wentToEt = $("#koWentToEt").checked;
  const etHomeGoals = wentToEt && $("#koEtHomeGoals").value !== "" ? parseInt($("#koEtHomeGoals").value, 10) : null;
  const etAwayGoals = wentToEt && $("#koEtAwayGoals").value !== "" ? parseInt($("#koEtAwayGoals").value, 10) : null;
  const homePens = wentToEt && $("#koHomePens").value !== "" ? parseInt($("#koHomePens").value, 10) : null;
  const awayPens = wentToEt && $("#koAwayPens").value !== "" ? parseInt($("#koAwayPens").value, 10) : null;

  const ko = knockoutAdminState.knockout;
  const match = ko.rounds[roundIndex].matches[matchIndex];
  const candidate = { ...match, homeGoals, awayGoals, etHomeGoals, etAwayGoals, homePens, awayPens };
  const winner = Engine.decideKnockoutWinner(candidate);

  if (homeGoals === awayGoals && !winner) {
    errorEl.textContent = "This match can't end level — tick the extra time box above and add extra time and/or penalty scores to decide a winner.";
    errorEl.classList.add("show");
    return;
  }
  errorEl.classList.remove("show");

  candidate.played = true;
  candidate.winner = winner;
  candidate.date = $("#koDate").value;
  candidate.time = $("#koTime").value;
  candidate.venue = $("#koVenue").value.trim();

  const btn = $("#koSaveBtn");
  btn.disabled = true;
  btn.textContent = "Saving…";

  // Apply the edit to a local copy so round-progression can be resolved
  // synchronously, then write the whole bracket back in one update.
  const updated = JSON.parse(JSON.stringify(ko));
  updated.rounds[roundIndex].matches[matchIndex] = candidate;
  advanceKnockoutIfRoundComplete(updated, roundIndex);

  db.ref(Paths.knockout(tournamentId)).set(updated)
    .then(() => {
      showToast("Result saved.", "success");
      closeKoResultForm();
      if (updated.champion && !ko.champion) showToast(`🏆 ${koTeamName(updated.champion)} are the champions!`, "success");
    })
    .catch(() => showToast("Couldn't save result. Please try again.", "error"))
    .finally(() => { btn.disabled = false; btn.textContent = "Save Result"; });
}

/* ---------------------------------------------------------------------
   Round progression — if every match in this round now has a winner
   (played or bye), either crown the champion (this was the final) or
   build and append the next round from the winners, in bracket order.
   Never rebuilds a round that already exists, so re-editing a historical
   score never wipes out later rounds.
   --------------------------------------------------------------------- */
function advanceKnockoutIfRoundComplete(koRecord, roundIndex) {
  const round = koRecord.rounds[roundIndex];
  if (!Engine.isRoundComplete(round.matches)) return;

  if (round.matches.length === 1) {
    koRecord.champion = round.matches[0].winner;
    return;
  }
  if (koRecord.rounds[roundIndex + 1]) return; // already built — don't overwrite

  const nextRound = Engine.buildKnockoutNextRound(round.matches);
  koRecord.rounds.push(nextRound);
  advanceKnockoutIfRoundComplete(koRecord, roundIndex + 1);
}

/* ---------------------------------------------------------------------
   Automatic generation — called after every league/group result is
   saved. Silently does nothing unless this was the fixture that
   completed the stage.
   --------------------------------------------------------------------- */
function maybeAutoGenerateKnockout(tournamentId) {
  db.ref(Paths.tournament(tournamentId)).once("value").then((tSnap) => {
    const t = tSnap.val();
    if (!t) return;
    const def = TOURNAMENT_FORMATS[t.format];
    if (!def || !(def.knockoutQualifiers || def.qualifiersPerGroup)) return;

    return db.ref(Paths.knockout(tournamentId)).once("value").then((koSnap) => {
      if (koSnap.exists()) return; // already generated

      return db.ref(Paths.fixtures(tournamentId)).once("value").then((fxSnap) => {
        const fixtures = fxSnap.val() || {};
        const list = Object.values(fixtures);
        if (!list.length || !list.every((f) => f.played)) return; // stage not finished yet

        const teamIds = Object.keys(t.teamIds || {});
        const qualifiers = Engine.computeQualifiers(def, teamIds, t.groups, list);
        const round1 = Engine.buildKnockoutRound1(qualifiers);
        const koRecord = { qualifiers, rounds: [round1], champion: null, generatedAt: Date.now() };
        advanceKnockoutIfRoundComplete(koRecord, 0);

        return db.ref(Paths.knockout(tournamentId)).set(koRecord).then(() => {
          showToast("🏆 League stage complete — knockout stage generated!", "success");
        });
      });
    });
  }).catch(() => {}); // best-effort — never let this block the result save itself
}

/* ---------------------------------------------------------------------
   Manual generate / regenerate
   --------------------------------------------------------------------- */
function generateKnockoutManually() {
  const tournamentId = knockoutAdminState.selectedTournamentId;
  const t = knockoutAdminState.tournaments[tournamentId];
  if (!t) return;
  const def = TOURNAMENT_FORMATS[t.format];
  const fixtures = Object.values(knockoutAdminState.fixtures);

  if (!fixtures.length || !fixtures.every((f) => f.played)) {
    showToast("Every league/group fixture must be played before generating the knockout stage.", "error");
    return;
  }
  if (knockoutAdminState.knockout && !confirm("A bracket already exists for this tournament. Regenerating will discard all knockout results entered so far. Continue?")) return;

  const teamIds = Object.keys(t.teamIds || {});
  const qualifiers = Engine.computeQualifiers(def, teamIds, t.groups, fixtures);
  const round1 = Engine.buildKnockoutRound1(qualifiers);
  const koRecord = { qualifiers, rounds: [round1], champion: null, generatedAt: Date.now() };
  advanceKnockoutIfRoundComplete(koRecord, 0);

  const btn = $("#koGenerateBtn");
  btn.disabled = true;
  btn.textContent = "Generating…";

  db.ref(Paths.knockout(tournamentId)).set(koRecord)
    .then(() => showToast("Knockout stage generated.", "success"))
    .catch(() => showToast("Couldn't generate the bracket. Please try again.", "error"))
    .finally(() => { btn.disabled = false; btn.textContent = "Generate Knockout Stage Now"; });
}

/* ---------------------------------------------------------------------
   Download — one table per round.
   --------------------------------------------------------------------- */
function downloadKnockoutExport() {
  const t = knockoutAdminState.tournaments[knockoutAdminState.selectedTournamentId];
  const ko = knockoutAdminState.knockout;
  if (!t || !ko) return;
  const def = TOURNAMENT_FORMATS[t.format];
  const blocks = ko.rounds.map((round) => exportKnockoutRoundBlock(round, koTeamName)).join("");

  openExportDocument({
    docTitle: "Knockout Bracket",
    tournamentName: t.name,
    formatLabel: def.label,
    generatedNote: ko.champion ? `Champion: ${koTeamName(ko.champion)}` : `${ko.rounds.length} round${ko.rounds.length === 1 ? "" : "s"} so far`,
    tableBlocksHTML: blocks
  });
}

/* ---------------------------------------------------------------------
   Wire-up
   --------------------------------------------------------------------- */
function initKnockoutManager() {
  db.ref(Paths.teams()).on("value", (snap) => { knockoutAdminState.teams = snap.val() || {}; renderKoContent(); });
  db.ref(Paths.tournaments()).on("value", (snap) => { knockoutAdminState.tournaments = snap.val() || {}; renderKoTournamentSelect(); });

  $("#koTournamentSelect").addEventListener("change", (e) => selectTournamentForKnockout(e.target.value));
  $("#koGenerateBtn").addEventListener("click", generateKnockoutManually);
  $("#koRegenerateBtn").addEventListener("click", generateKnockoutManually);
  $("#koDownloadBtn").addEventListener("click", downloadKnockoutExport);
  $("#koForm").addEventListener("submit", saveKoResultFromForm);
  $("#koCancelBtn").addEventListener("click", closeKoResultForm);
  $("#koWentToEt").addEventListener("change", (e) => $("#koEtPensFields").classList.toggle("hidden", !e.target.checked));
}


/* =========================================================================
   js/admin-content.js — Announcements & Rules (Phase 6)
   One factory (makeContentEditor) drives both pages, since they're
   identical in shape: pick a tournament, edit its text, see a live
   preview, save, or reset to the standard copy for that format. Avoids
   writing the same logic twice for two near-identical admin pages.
   ========================================================================= */

function makeContentEditor(cfg) {
  const state = { tournaments: {}, selectedTournamentId: null, valueRef: null, dirty: false };

  function renderSelect() {
    const select = $(cfg.selectId);
    const entries = Object.entries(state.tournaments).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

    if (!entries.length) {
      $(cfg.noTournamentId).classList.remove("hidden");
      $(cfg.contentId).classList.add("hidden");
      select.parentElement.classList.add("hidden");
      return;
    }
    select.parentElement.classList.remove("hidden");
    $(cfg.noTournamentId).classList.add("hidden");
    $(cfg.contentId).classList.remove("hidden");

    const previous = state.selectedTournamentId;
    select.innerHTML = entries.map(([id, t]) => `<option value="${id}">${escapeAdminHTML(t.name)}</option>`).join("");
    const stillExists = previous && state.tournaments[previous];
    const toSelect = stillExists ? previous : entries[0][0];
    select.value = toSelect;
    if (toSelect !== state.selectedTournamentId) selectTournament(toSelect);
  }

  function selectTournament(tournamentId) {
    if (state.dirty && !confirm(`Discard unsaved ${cfg.label.toLowerCase()} changes for the current tournament?`)) {
      $(cfg.selectId).value = state.selectedTournamentId; // revert dropdown to the tournament still being edited
      return;
    }
    state.selectedTournamentId = tournamentId;
    if (state.valueRef) state.valueRef.off();
    state.valueRef = db.ref(cfg.pathFn(tournamentId));
    state.valueRef.on("value", (snap) => {
      $(cfg.textareaId).value = snap.val() || "";
      updatePreview();
      setDirty(false);
    });
  }

  function updatePreview() {
    $(cfg.previewId).textContent = $(cfg.textareaId).value;
  }

  function setDirty(isDirty) {
    state.dirty = isDirty;
    $(cfg.saveBtnId).disabled = !isDirty;
    const statusEl = $(cfg.statusId);
    statusEl.textContent = isDirty ? "Unsaved changes" : "Saved";
    statusEl.style.color = isDirty ? "var(--gold-400)" : "var(--win)";
  }

  function save() {
    const tournamentId = state.selectedTournamentId;
    const value = $(cfg.textareaId).value;
    const btn = $(cfg.saveBtnId);
    btn.disabled = true;
    btn.textContent = `Saving…`;

    db.ref(cfg.pathFn(tournamentId)).set(value)
      .then(() => { showToast(`${cfg.label} saved.`, "success"); setDirty(false); })
      .catch(() => { showToast(`Couldn't save ${cfg.label.toLowerCase()}. Please try again.`, "error"); btn.disabled = false; })
      .finally(() => { btn.textContent = cfg.saveLabel; });
  }

  function resetToStandard() {
    const t = state.tournaments[state.selectedTournamentId];
    if (!t) return;
    const seed = typeof SEED_CONTENT !== "undefined" ? SEED_CONTENT[t.format] : null;
    if (!seed) { showToast("No standard copy is available for this format.", "error"); return; }

    const formatLabel = (typeof TOURNAMENT_FORMATS !== "undefined" && TOURNAMENT_FORMATS[t.format]) ? TOURNAMENT_FORMATS[t.format].label : t.format;
    if (!confirm(`Replace the current text with the standard ${formatLabel} copy? You'll still need to click Save to make it live.`)) return;

    $(cfg.textareaId).value = cfg.key === "announcements" ? seed.announcement : seed.rules;
    updatePreview();
    setDirty(true);
  }

  return {
    init() {
      db.ref(Paths.tournaments()).on("value", (snap) => {
        state.tournaments = snap.val() || {};
        renderSelect();
      });
      $(cfg.selectId).addEventListener("change", (e) => selectTournament(e.target.value));
      $(cfg.textareaId).addEventListener("input", () => { updatePreview(); setDirty(true); });
      $(cfg.saveBtnId).addEventListener("click", save);
      $(cfg.resetBtnId).addEventListener("click", resetToStandard);
    }
  };
}

/* ---------------------------------------------------------------------
   Wire-up: one editor instance per page
   --------------------------------------------------------------------- */
function initAnnouncementsRulesManagers() {
  makeContentEditor({
    key: "announcements",
    label: "Announcement",
    saveLabel: "Save Announcement",
    selectId: "#annTournamentSelect",
    noTournamentId: "#annNoTournament",
    contentId: "#annContent",
    textareaId: "#annTextarea",
    previewId: "#annPreview",
    saveBtnId: "#annSaveBtn",
    resetBtnId: "#annResetBtn",
    statusId: "#annStatus",
    pathFn: (id) => Paths.announcement(id)
  }).init();

  makeContentEditor({
    key: "rules",
    label: "Rules",
    saveLabel: "Save Rules",
    selectId: "#rulesTournamentSelect",
    noTournamentId: "#rulesNoTournament",
    contentId: "#rulesContent",
    textareaId: "#rulesTextarea",
    previewId: "#rulesPreview",
    saveBtnId: "#rulesSaveBtn",
    resetBtnId: "#rulesResetBtn",
    statusId: "#rulesStatus",
    pathFn: (id) => Paths.rules(id)
  }).init();
}
