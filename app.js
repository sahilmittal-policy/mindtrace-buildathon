/* MindTrace — application logic.
 *
 * Talks to the API in server.py. The only thing kept in localStorage is the
 * session token and the theme preference; everything else lives on the
 * account, so a person can sign in from any device and find their history.
 */

const E = window.MindTraceEngine;
const $ = (id) => document.getElementById(id);

const TOKEN_KEY = "mindtrace.token";
const THEME_KEY = "mindtrace.theme";

let token = localStorage.getItem(TOKEN_KEY) || null;
let account = null;              // {id, name, email, inviteCode, ...}
let sessions = [];               // this account's check-ins, oldest first
let pendingCheckin = null;
let gameResults = {};
let reviewingToday = false;
let dashboardRange = "day";
let dashboardGame = "all";

/* ------------------------------------------------------------- api */
async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", "X-MindTrace-Date": today() };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch (err) {
    throw new Error("Could not reach MindTrace. Check your connection and try again.");
  }
  let data = {};
  try { data = await response.json(); } catch (err) { /* empty body */ }
  if (!response.ok) {
    if (response.status === 401 && account) signOut(true);
    throw new Error(data.error || "Something went wrong. Please try again.");
  }
  return data;
}

/* ------------------------------------------------------------- theme */
function syncTimePalette() {
  const hour = new Date().getHours();
  const evening = hour >= 17 || hour < 7;
  document.body.classList.toggle("evening", evening && !document.body.classList.contains("dark"));
}

function applyTheme(theme) {
  const chosen = theme === "dark" ? "dark" : "light";
  document.body.classList.toggle("dark", chosen === "dark");
  localStorage.setItem(THEME_KEY, chosen);
  syncTimePalette();
  document.querySelectorAll(".theme-choice").forEach((button) =>
    button.classList.toggle("active", button.dataset.theme === chosen));
}

/* ------------------------------------------------------------- utils */
function today() { return E.toDateKey(new Date()); }
function dayLabel(date) {
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })
    .format(new Date(`${date}T12:00:00`));
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}
function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 4200);
}
function currentSession() { return sessions.find((session) => session.date === today()); }

function showScreen(name) {
  document.querySelectorAll(".screen").forEach((screen) =>
    screen.classList.toggle("active", screen.id === `screen-${name}`));
  const signedIn = Boolean(account);
  const isPublic = name === "landing" || name === "auth";
  $("signOutLink").hidden = !signedIn;
  $("showSignIn").hidden = signedIn;
  $("settingsLink").hidden = !signedIn;
  $("mainNav").classList.toggle("visible", signedIn && !isPublic);
  document.querySelectorAll(".nav-button").forEach((button) =>
    button.classList.toggle("active", button.dataset.nav === name));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ------------------------------------------------------------- auth */
function showAuth(mode) {
  const signup = mode === "signup";
  $("authHeading").textContent = signup ? "Let's get you started." : "Welcome back.";
  $("authSub").textContent = signup
    ? "A name, an email and a password is all it takes."
    : "Sign in to pick up where you left off.";
  $("signinForm").hidden = signup;
  $("signupForm").hidden = !signup;
  $("authError").hidden = true;
  document.querySelectorAll(".auth-tab").forEach((tab) =>
    tab.classList.toggle("active", (tab.dataset.authtab === "signup") === signup));
  showScreen("auth");
}

function authError(message) {
  const box = $("authError");
  box.textContent = message;
  box.hidden = false;
}

async function afterSignIn(data, greeting) {
  token = data.token;
  localStorage.setItem(TOKEN_KEY, token);
  account = data.user;
  sessions = data.sessions || [];
  applyTheme(account.theme || localStorage.getItem(THEME_KEY) || "light");
  if (greeting) showToast(greeting);
  if (currentSession()) {
    renderDashboard();
    showScreen("dashboard");
  } else {
    resetCheckin();
    showScreen("checkin");
  }
}

function signOut(expired) {
  const tokenToRevoke = token;
  if (!expired && tokenToRevoke) {
    fetch("/api/logout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${tokenToRevoke}`,
        "X-MindTrace-Date": today()
      }
    }).catch(() => { /* Local sign-out must still succeed if the network is down. */ });
  }
  token = null;
  account = null;
  sessions = [];
  pendingCheckin = null;
  gameResults = {};
  reviewingToday = false;
  localStorage.removeItem(TOKEN_KEY);
  showScreen("landing");
  if (expired) showToast("Your session expired. Please sign in again.");
}

/* ------------------------------------------------------------- check-in */
function setChoice(container, button) {
  container.querySelectorAll(".choice").forEach((item) => item.classList.remove("selected"));
  button.classList.add("selected");
}

function resetCheckin() {
  $("checkinForm").reset();
  document.querySelectorAll("[data-choice] .choice").forEach((button) => button.classList.remove("selected"));
  document.querySelector('[data-choice="sleepQuality"] .choice[data-value="3"]').classList.add("selected");
  document.querySelector('[data-choice="mood"] .choice[data-value="3"]').classList.add("selected");
  document.querySelector('[data-choice="stress"] .choice[data-value="1"]').classList.add("selected");
  document.querySelector('[data-choice="energy"] .choice[data-value="3"]').classList.add("selected");
  document.querySelector('[data-choice="caffeine"] .choice[data-value="no"]').classList.add("selected");
  $("sleepValue").textContent = "7 hours";
}

function selectedValue(key) {
  return Number(document.querySelector(`[data-choice="${key}"] .selected`).dataset.value);
}

function beginCheckin() {
  if (currentSession()) {
    renderDashboard();
    showScreen("dashboard");
    showToast("Today's check-in is complete. Here is your dashboard.");
    return;
  }
  reviewingToday = false;
  resetCheckin();
  showScreen("checkin");
}

/* ------------------------------------------------------------- hub */
function updateHub() {
  const keys = ["symbolMatch", "memory", "words"];
  const complete = keys.filter((key) => gameResults[key]);
  const nextKey = keys.find((key) => !gameResults[key]);
  const nextLabels = { symbolMatch: "Symbol Match", memory: "What's in a Symbol?", words: "Word Fill" };
  $("hubCount").textContent = `${complete.length} of 3 done`;
  keys.forEach((key, index) => {
    const tile = document.querySelector(`[data-game="${key}"]`);
    const done = Boolean(gameResults[key]);
    tile.classList.toggle("done", done);
    tile.querySelector(".done-label").hidden = !done;
    $("hubDot" + (index + 1)).classList.toggle("done", done);
  });
  $("finishSession").disabled = complete.length < 1;
  $("finishSession").textContent = reviewingToday ? "Save and view dashboard" : "Finish and see results";
  $("nextGameButton").hidden = !nextKey || !complete.length;
  if (nextKey) $("nextGameButton").textContent = `Play next: ${nextLabels[nextKey]}`;
  $("hubHint").textContent = reviewingToday
    ? complete.length < 3 ? "Choose another game, or save what you have and view your dashboard." : "Today's games are complete. Well done for showing up."
    : complete.length ? "Great start. You can finish now, or enjoy another game."
    : "Play at least one game to see your result.";
  $("gameMotivationTitle").textContent = reviewingToday
    ? "Today's games are complete."
    : complete.length ? "Nice work — that counts." : "Now for the fun part.";
  $("gameMotivationText").textContent = reviewingToday
    ? "Come back tomorrow for a fresh set. Your dashboard is ready whenever you are."
    : complete.length
      ? "Every game adds to your picture, but there is no need to do more than feels comfortable."
      : "Pick whichever game sounds good. One is enough, and all three make a fuller picture.";
}

function closeGame(showMessage) {
  $("gameModal").classList.remove("open");
  $("gameFrame").src = "about:blank";
  if (showMessage) showToast("Game closed. This unfinished round was not saved.");
}

function openGames() {
  const session = currentSession();
  if (pendingCheckin) { reviewingToday = false; updateHub(); showScreen("hub"); return; }
  if (session) {
    pendingCheckin = session.checkin;
    gameResults = session.games || {};
    reviewingToday = true;
    updateHub();
    showScreen("hub");
    return;
  }
  beginCheckin();
  showToast("Your quick daily check-in comes first. Then the games will open.");
}

async function finishSession() {
  if (!pendingCheckin || Object.keys(gameResults).length < 1) return;

  const domains = E.calculateDomains(gameResults);
  const existing = currentSession();
  const item = {
    id: existing ? existing.id : `session-${Date.now()}`,
    date: today(),
    checkin: pendingCheckin,
    games: gameResults,
    domains,
    composite: E.composite(domains),
    sleepScore: E.sleepScore(pendingCheckin.sleepHours, pendingCheckin.sleepQuality)
  };

  const before = new Set(E.badgesFor(sessions).filter((badge) => badge.unlocked).map((badge) => badge.key));
  $("finishSession").disabled = true;
  try {
    const data = await api("/api/sessions", { method: "POST", body: JSON.stringify({ session: item }) });
    sessions = data.sessions || [];
  } catch (err) {
    $("finishSession").disabled = false;
    showToast(err.message);
    return;
  }

  const after = E.badgesFor(sessions).filter((badge) => badge.unlocked);
  const unlocked = after.find((badge) => !before.has(badge.key));

  pendingCheckin = null;
  gameResults = {};
  reviewingToday = false;
  renderDashboard();
  showScreen("dashboard");
  showToast(unlocked
    ? `You earned the ${unlocked.name} badge!`
    : "Today's check-in is complete. Well done for showing up.");
}

function launchGame(key) {
  if (!key || gameResults[key]) return;
  const dark = document.body.classList.contains("dark") || document.body.classList.contains("evening");
  const theme = `theme=${dark ? "dark" : "light"}`;
  $("gameFrame").src = key === "words" ? `word_fill.html?${theme}` : `symbol_games.html?game=${key}&${theme}`;
  $("gameModal").classList.add("open");
}

/* ------------------------------------------------------------- dashboard data */
function filteredSessions() {
  if (dashboardRange === "lifetime") return sessions;
  const days = dashboardRange === "day" ? 1 : dashboardRange === "week" ? 7 : 30;
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  return sessions.filter((session) => new Date(`${session.date}T12:00:00`) >= cutoff);
}

const dashboardGameConfig = {
  all: { label: "All games", keys: ["speed", "focus", "memory", "words"] },
  symbolMatch: { label: "Symbol Match", keys: ["speed", "focus"] },
  memory: { label: "What's in a Symbol?", keys: ["memory"] },
  words: { label: "Word Fill", keys: ["words"] }
};
function gameViewConfig() { return dashboardGameConfig[dashboardGame] || dashboardGameConfig.all; }

function projectDashboardSession(session) {
  const config = gameViewConfig(), domains = {};
  config.keys.forEach((key) => {
    if (session.domains && typeof session.domains[key] === "number") domains[key] = session.domains[key];
  });
  return { ...session, domains, composite: dashboardGame === "all" ? session.composite : E.composite(domains) };
}
function dashboardSessionApplies(session) {
  return dashboardGame === "all" || Boolean(session.games && session.games[dashboardGame]);
}
function dashboardBaseline() {
  const source = sessions.filter(dashboardSessionApplies);
  const full = E.getBaseline(source);
  if (dashboardGame === "all") return full;
  const config = gameViewConfig();
  const baselineSessions = source.slice(7, 14).map(projectDashboardSession);
  const domains = {};
  config.keys.forEach((key) => {
    const values = baselineSessions.map((s) => s.domains[key]).filter((v) => typeof v === "number");
    if (values.length) {
      const sd = E.standardDeviation(values);
      domains[key] = { mean: E.mean(values), sd, halfWidth: Math.max(3.5, sd) };
    }
  });
  const composites = baselineSessions.map((s) => s.composite).filter((v) => typeof v === "number");
  if (composites.length) {
    const sd = E.standardDeviation(composites);
    domains.composite = { mean: E.mean(composites), sd, halfWidth: Math.max(3.5, sd) };
  }
  return { ...full, domains };
}
function rangeLabel() {
  return dashboardRange === "day" ? "1 day ago"
    : dashboardRange === "week" ? "1 week ago"
    : dashboardRange === "month" ? "1 month ago" : "Lifetime";
}
function gameMetricSummary(session, key) {
  const metrics = session.games && session.games[key];
  if (!metrics) return null;
  const rounds = Math.max(0, metrics.rounds || 0);
  if (key === "symbolMatch") return {
    correct: typeof metrics.correct === "number" ? metrics.correct : Math.max(0, rounds - (metrics.skipped || 0)),
    incorrect: typeof metrics.incorrect === "number" ? metrics.incorrect : Math.max(0, metrics.wrongTaps || 0)
  };
  if (key === "memory") {
    const correct = typeof metrics.correct === "number" ? metrics.correct : Math.round((metrics.avgScore || 0) * rounds);
    return { correct, incorrect: typeof metrics.incorrect === "number" ? metrics.incorrect : Math.max(0, rounds - correct) };
  }
  return {
    correct: Math.max(0, metrics.correct || 0),
    incorrect: typeof metrics.incorrect === "number" ? metrics.incorrect : Math.max(0, metrics.mistakes || rounds - (metrics.correct || 0))
  };
}
function sessionGameKeys(session) {
  return (dashboardGame === "all" ? ["symbolMatch", "memory", "words"] : [dashboardGame])
    .filter((key) => session.games && session.games[key]);
}
function sessionAverageSeconds(session) {
  const values = sessionGameKeys(session).map((key) => session.games[key].avgSeconds).filter((v) => typeof v === "number");
  return values.length ? E.mean(values) : null;
}
function sessionAttemptSummary(session) {
  const summaries = sessionGameKeys(session).map((key) => gameMetricSummary(session, key)).filter(Boolean);
  if (!summaries.length) return null;
  return summaries.reduce((total, current) => ({
    correct: total.correct + current.correct, incorrect: total.incorrect + current.incorrect
  }), { correct: 0, incorrect: 0 });
}
function averageRoundSeconds(list) {
  const values = list.map(sessionAverageSeconds).filter((v) => typeof v === "number");
  return values.length ? Math.round(E.mean(values) * 10) / 10 : null;
}
function gameHighlight(key) {
  const rows = sessions.map((session) => ({
    time: session.games && session.games[key] && session.games[key].avgSeconds,
    attempts: gameMetricSummary(session, key)
  })).filter((row) => typeof row.time === "number" && row.attempts);
  if (!rows.length) return null;
  const total = rows.reduce((sum, row) => ({
    correct: sum.correct + row.attempts.correct, incorrect: sum.incorrect + row.attempts.incorrect
  }), { correct: 0, incorrect: 0 });
  return { time: E.mean(rows.map((row) => row.time)), accuracy: (total.correct / Math.max(1, total.correct + total.incorrect)) * 100 };
}
function dashboardPromptMarkup(list) {
  const latest = list[list.length - 1];
  if (!latest) return "Choose a time frame or game view to notice a little more of your own rhythm.";
  const prompts = [];
  const latestTime = sessionAverageSeconds(latest);
  const latestAttempts = sessionAttemptSummary(latest);
  const accuracy = latestAttempts ? latestAttempts.correct / Math.max(1, latestAttempts.correct + latestAttempts.incorrect) : null;
  const previous = list.slice(0, -1);
  const previousTime = previous.length ? sessionAverageSeconds(previous[previous.length - 1]) : null;
  const pace = averageRoundSeconds(list);
  if (latestTime !== null && accuracy !== null && accuracy >= .8 && previousTime !== null && latestTime > previousTime * 1.1)
    prompts.push("A more measured pace today, with strong accuracy. That's a fair trade.");
  else if (latestTime !== null && accuracy !== null && accuracy >= .8)
    prompts.push("Strong accuracy today. That's worth a little celebration.");
  if (dashboardRange === "week" && list.length)
    prompts.push(`This week: ${list.length} ${list.length === 1 ? "session" : "sessions"}, average round time ${pace === null ? "not available" : pace + " seconds"}.`);
  if (dashboardGame === "all") {
    const highlights = [["symbolMatch", "pattern matching"], ["memory", "memory"], ["words", "word fill"]]
      .map(([key, label]) => ({ key, label, summary: gameHighlight(key) })).filter((item) => item.summary);
    if (highlights.length >= 2) {
      const fastest = highlights.reduce((best, item) => item.summary.time < best.summary.time ? item : best);
      const accurate = highlights.reduce((best, item) => item.summary.accuracy > best.summary.accuracy ? item : best);
      prompts.push(`Fastest area: ${fastest.label}. Most accurate: ${accurate.label}.`);
    }
  }
  if (dashboardRange === "week") prompts.push("One small goal for next week: try a round at a different time of day.");
  return prompts.join(" ") || "Keep noticing what feels natural for you. Every check-in adds another useful point to your own picture.";
}
function dashboardInsight(list, b) {
  const config = gameViewConfig(), latest = list[list.length - 1];
  if (!latest) return {
    key: "building", title: "Your next encouraging moment is waiting.",
    explanation: `Choose another time frame, or start a check-in to add a ${config.label.toLowerCase()} result to your picture.`
  };
  const score = typeof latest.composite === "number" ? latest.composite : null;
  const band = b.domains.composite;
  const below = score !== null && band && score < band.mean - band.halfWidth;
  const pace = averageRoundSeconds(list);
  const dayWord = latest.date === today() ? "today" : "in this view";
  let title, key;
  if (dashboardRange === "week" && list.length >= 3) { title = "Strong week — you've kept showing up."; key = "good"; }
  else if (score !== null && score >= 85) { title = `Great round ${dayWord}! That's worth a little celebration. What sounds good?`; key = "good"; }
  else if (score !== null && score >= 70) { title = "A strong round with plenty to build on."; key = "good"; }
  else if (below) { title = "Some days your mind just isn't in it. It happens to everyone, and it doesn't erase your progress."; key = "context"; }
  else { title = "Some parts clicked and some didn't, which is normal. Showing up counts."; key = "note"; }
  const detail = list.length > 1 && dashboardRange === "week"
    ? `This week: ${list.length} sessions${pace === null ? "" : " with an average round time of " + pace + " seconds"}.`
    : `${config.label} · ${rangeLabel()}.`;
  return { key, title, explanation: `${detail} Your check-ins are here to help you notice your own rhythm, not to judge a single day.` };
}
function updateDashboardFilter() {
  document.querySelectorAll(".filter-button").forEach((button) => {
    const active = button.dataset.range === dashboardRange;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const select = $("dashboardGame");
  if (select) select.value = dashboardGame;
}

/* ------------------------------------------------------------- charts */
function calendarMarkup(list) {
  const done = new Set(list.map((item) => item.date));
  const date = new Date();
  date.setDate(date.getDate() - 13);
  return Array.from({ length: 14 }, () => {
    const key = E.toDateKey(date), label = date.getDate();
    const html = `<div class="calendar-day ${done.has(key) ? "done" : ""} ${key === today() ? "today" : ""}" title="${dayLabel(key)}">${label}</div>`;
    date.setDate(date.getDate() + 1);
    return html;
  }).join("");
}

function domainMarkup(key, latest, entry, label) {
  const value = latest && latest.domains[key] != null ? latest.domains[key] : null;
  const diff = value != null && entry ? value - entry.mean : null;
  const dot = value == null ? 50 : Math.max(3, Math.min(97, value));
  const band = entry ? Math.max(0, entry.mean - entry.halfWidth) : 35;
  const bandWidth = entry ? Math.min(100, entry.halfWidth * 2) : 30;
  const message = value == null ? "No result in this view yet"
    : diff == null ? "Your first result in this area"
    : diff >= 5 ? "A little ahead of your usual rhythm"
    : diff <= -5 ? "A gentler day in this area" : "Within your usual range";
  return `<div class="domain-card"><h3>${label}</h3><div class="domain-score">${message}</div><div class="domain-diff">${
    value == null ? "Try this game when it suits you."
    : diff == null ? "Your personal picture is still taking shape."
    : "Keep noticing the pattern, one day at a time."
  }</div><div class="gauge" aria-label="${label} position"><span class="gauge-band" style="left:${Math.max(0, band)}%;width:${bandWidth}%"></span><span class="gauge-dot" style="left:${dot}%"></span></div></div>`;
}

const CHART_INK = "#8C8074", CHART_RULE = "#E2D9CA", CHART_LINE = "#6A5580",
      CHART_SAGE = "#4B6A45", CHART_SAGE_SOFT = "#E4EBDC", CHART_CLAY = "#A2523A",
      CHART_LILAC = "#B6A6CC",
      CHART_SAGE_MID = "#9DB08F";

function trendChart(list, b, allSessions) {
  const w = 760, h = 240, p = 34;
  const values = list.map((s) => s.composite).filter((v) => typeof v === "number");
  if (!values.length) return '<p class="muted">No trend data in this time range yet.</p>';
  const max = Math.max(100, ...values), min = 0;
  const x = (i) => p + (i / Math.max(1, list.length - 1)) * (w - p * 2);
  const y = (v) => h - p - ((v - min) / (max - min)) * (h - p * 2);
  const line = list.map((s, i) => typeof s.composite === "number" ? `${i ? "L" : "M"} ${x(i).toFixed(1)} ${y(s.composite).toFixed(1)}` : "").join(" ");
  const band = b.domains.composite;
  const lower = band ? band.mean - band.halfWidth : null;
  const upper = band ? band.mean + band.halfWidth : null;
  const firstTracked = list.findIndex((session) => allSessions.findIndex((item) => item.id === session.id) >= 13);
  const markerIndex = list.findIndex((session) => session.id === (allSessions[13] && allSessions[13].id));
  const bandStart = firstTracked >= 0 ? x(firstTracked) : null;
  const bandRect = band && bandStart !== null
    ? `<rect x="${bandStart}" y="${y(upper)}" width="${Math.max(0, x(list.length - 1) - bandStart)}" height="${Math.max(0, y(lower) - y(upper))}" fill="${CHART_SAGE_SOFT}"/>` : "";
  const dots = list.map((s, i) => typeof s.composite === "number"
    ? `<circle cx="${x(i)}" cy="${y(s.composite)}" r="5" fill="${band && s.composite < band.mean - band.halfWidth ? CHART_CLAY : CHART_LINE}"/>` : "").join("");
  const marker = markerIndex >= 0
    ? `<line x1="${x(markerIndex)}" y1="${p}" x2="${x(markerIndex)}" y2="${h - p}" stroke="${CHART_LINE}" stroke-dasharray="7 6"/><text x="${x(markerIndex) + 8}" y="${p + 14}" font-size="12" fill="${CHART_INK}">Tracking starts</text>` : "";
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Your results over time">${bandRect}<line x1="${p}" y1="${h - p}" x2="${w - p}" y2="${h - p}" stroke="${CHART_RULE}"/><line x1="${p}" y1="${p}" x2="${p}" y2="${h - p}" stroke="${CHART_RULE}"/>${marker}<path d="${line}" fill="none" stroke="${CHART_LINE}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>${dots}<text x="${p}" y="${h - 8}" font-size="12" fill="${CHART_INK}">${list[0].date.slice(5)}</text><text x="${w - p - 28}" y="${h - 8}" font-size="12" fill="${CHART_INK}">${list[list.length - 1].date.slice(5)}</text></svg>`;
}

function timeTrendChart(list) {
  const w = 760, h = 225, p = 34;
  const points = list.map(sessionAverageSeconds);
  const values = points.filter((v) => typeof v === "number");
  if (!values.length) return '<p class="muted">No timing data in this view yet.</p>';
  const max = Math.max(5, ...values) * 1.15;
  const x = (i) => p + (i / Math.max(1, list.length - 1)) * (w - p * 2);
  const y = (v) => h - p - (v / max) * (h - p * 2);
  const valid = points.map((value, index) => ({ value, index })).filter((pt) => typeof pt.value === "number");
  const line = valid.map((pt, i) => `${i ? "L" : "M"} ${x(pt.index).toFixed(1)} ${y(pt.value).toFixed(1)}`).join(" ");
  const dots = valid.map((pt) => `<circle cx="${x(pt.index)}" cy="${y(pt.value)}" r="5" fill="${CHART_LINE}"/>`).join("");
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Average round time by session"><line x1="${p}" y1="${h - p}" x2="${w - p}" y2="${h - p}" stroke="${CHART_RULE}"/><line x1="${p}" y1="${p}" x2="${p}" y2="${h - p}" stroke="${CHART_RULE}"/><path d="${line}" fill="none" stroke="${CHART_LINE}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>${dots}<text x="${p}" y="${h - 8}" font-size="12" fill="${CHART_INK}">${list[0].date.slice(5)}</text><text x="${w - p - 28}" y="${h - 8}" font-size="12" fill="${CHART_INK}">${list[list.length - 1].date.slice(5)}</text></svg>`;
}

function attemptTrendChart(list) {
  const w = 760, h = 225, p = 34;
  const points = list.map(sessionAttemptSummary);
  const values = points.filter(Boolean).flatMap((s) => [s.correct, s.incorrect]);
  if (!values.length) return '<p class="muted">No attempt data in this view yet.</p>';
  const max = Math.max(1, ...values) * 1.15;
  const x = (i) => p + (i / Math.max(1, list.length - 1)) * (w - p * 2);
  const y = (v) => h - p - (v / max) * (h - p * 2);
  const groupWidth = (w - p * 2) / Math.max(1, list.length);
  const barWidth = Math.max(5, Math.min(18, (groupWidth - 6) / 2));
  const bars = points.map((summary, index) => {
    if (!summary) return "";
    const center = x(index);
    return `<rect x="${center - barWidth - 2}" y="${y(summary.correct)}" width="${barWidth}" height="${h - p - y(summary.correct)}" rx="3" fill="${CHART_SAGE}"/><rect x="${center + 2}" y="${y(summary.incorrect)}" width="${barWidth}" height="${h - p - y(summary.incorrect)}" rx="3" fill="${CHART_LILAC}"/>`;
  }).join("");
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Correct and incorrect attempts by session"><line x1="${p}" y1="${h - p}" x2="${w - p}" y2="${h - p}" stroke="${CHART_RULE}"/><line x1="${p}" y1="${p}" x2="${p}" y2="${h - p}" stroke="${CHART_RULE}"/>${bars}<text x="${p}" y="${h - 8}" font-size="12" fill="${CHART_INK}">${list[0].date.slice(5)}</text><text x="${w - p - 28}" y="${h - 8}" font-size="12" fill="${CHART_INK}">${list[list.length - 1].date.slice(5)}</text></svg>`;
}

function contextChart(list) {
  const w = 760, h = 225, p = 32;
  const recent = list.slice(-14);
  if (!recent.length) return '<p class="muted">No context data in this view yet.</p>';
  const x = (i) => p + (i / Math.max(1, recent.length - 1)) * (w - p * 2);
  const barW = Math.max(8, Math.min(28, (w - p * 2) / Math.max(1, recent.length) - 8));
  const y = (v) => h - p - (v / 12) * (h - p * 2);
  const bars = recent.map((s, i) => `<rect x="${x(i) - barW / 2}" y="${y(s.checkin.sleepHours)}" width="${barW}" height="${h - p - y(s.checkin.sleepHours)}" rx="4" fill="${CHART_SAGE_MID}"/>`).join("");
  const points = recent.map((s, i) => `${i ? "L" : "M"} ${x(i)} ${y(s.checkin.stress * 2.2)}`).join(" ");
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Sleep and stress context chart"><line x1="${p}" y1="${h - p}" x2="${w - p}" y2="${h - p}" stroke="${CHART_RULE}"/><line x1="${p}" y1="${p}" x2="${p}" y2="${h - p}" stroke="${CHART_RULE}"/>${bars}<path d="${points}" fill="none" stroke="${CHART_CLAY}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>${recent.map((s, i) => `<circle cx="${x(i)}" cy="${y(s.checkin.stress * 2.2)}" r="4" fill="${CHART_CLAY}"/>`).join("")}<text x="${p}" y="${h - 8}" font-size="12" fill="${CHART_INK}">${recent[0].date.slice(5)}</text><text x="${w - p - 28}" y="${h - 8}" font-size="12" fill="${CHART_INK}">${recent[recent.length - 1].date.slice(5)}</text></svg>`;
}

/* ------------------------------------------------------------- dashboard render */
function dashboardMarkup(insight, list, allSessions, b) {
  const latest = list[list.length - 1];
  const config = gameViewConfig();
  const labels = { speed: "Speed", focus: "Focus", memory: "Memory", words: "Words" };
  return `<section class="dashboard-hero ${insight.key}"><span class="eyebrow">${latest ? `${config.label} · ${rangeLabel()}` : "A fresh view"}</span><h2 class="affirmation">${insight.title}</h2><p class="hero-context">${insight.explanation}</p></section>
    <div class="stat-strip">
      <div class="stat"><div class="stat-value"><svg class="stat-icon fire" viewBox="0 0 24 24" aria-hidden="true"><path d="M13.2 2.5c.6 3.8-2.7 4.8-2.2 8.1.2 1.4 1.2 2.2 2.4 2.6-.2-1.8.8-3.2 2.3-4.5 2.5 2.1 4.1 4.6 3.4 7.5-.8 3.4-3.6 5.3-7.1 5.3-4.2 0-7.4-2.7-7.4-6.8 0-3.7 2.4-6.4 5.2-8.9.1 2 .6 3.1 1.4 3.8-.3-3 1.1-4.6 2-7.1Z"/></svg><strong>${E.currentStreak(list)}</strong></div><span>day streak</span></div>
      <div class="stat"><div class="stat-value"><svg class="stat-icon sessions" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1Z"/><path d="m8 14 2 2 5-5"/></svg><strong>${list.length}</strong></div><span>sessions in view</span></div>
      <div class="stat"><div class="stat-value"><svg class="stat-icon phase" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4L12 3Z"/><path d="m18.5 14 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"/></svg><strong class="text-left">${sessions.length < 15 ? "Building" : "Tracking"}</strong></div><span>your phase</span></div>
    </div>
    ${sessions.length < 15 ? `<div class="progress-wrap"><div class="progress-label"><strong>Building your personal picture</strong><span>${sessions.length} of 14 sessions</span></div><div class="progress-track"><span style="width:${Math.min(100, sessions.length / 14 * 100)}%"></span></div><p class="tiny" style="margin-top:10px">Your first 14 sessions are for learning your everyday rhythm. Comparisons begin after that.</p></div>` : ""}
    <div class="section-title"><h3>Last 14 days</h3><span class="muted tiny">check-in days</span></div><div class="calendar">${calendarMarkup(list)}</div>
    <div class="section-title"><h3>${config.label} areas</h3><span class="muted tiny">Compared with your usual mean</span></div><div class="domain-grid">${config.keys.map((key) => domainMarkup(key, latest, b.domains[key], labels[key])).join("")}</div>
    <div class="section-title"><h3>Trends over time</h3><span class="muted tiny">${config.label} · ${rangeLabel()}</span></div>
    <div class="trend-stack"><div class="chart-panel">${trendChart(list, b, allSessions)}<div class="chart-legend"><span class="legend-item"><i class="legend-swatch"></i> usual range</span><span class="legend-item"><i class="legend-swatch line"></i> ${config.label.toLowerCase()}</span><span class="legend-item"><i class="legend-swatch amber"></i> below range</span></div></div>
    <div class="trend-pair"><div class="chart-panel"><h3>Average round time</h3><p class="tiny">Your average time for each session in this view.</p>${timeTrendChart(list)}<div class="chart-legend"><span class="legend-item"><i class="legend-swatch line"></i> seconds per round</span></div></div><div class="chart-panel"><h3>Correct and incorrect attempts</h3><p class="tiny">A simple count for each session in this view.</p>${attemptTrendChart(list)}<div class="chart-legend"><span class="legend-item"><i class="legend-swatch" style="background:#E4EBDC;border-color:#4B6A45"></i> correct</span><span class="legend-item"><i class="legend-swatch lilac"></i> incorrect</span></div></div></div>
    <div class="panel soft trend-note"><span class="eyebrow">A note from this view</span><p>${dashboardPromptMarkup(list)}</p></div></div>
    <div class="section-title"><h3>Daily context</h3><span class="muted tiny">${rangeLabel()} · sleep and stress context</span></div><div class="chart-panel">${contextChart(list)}<div class="chart-legend"><span class="legend-item"><i class="legend-swatch" style="background:#9DB08F;border-color:#4B6A45"></i> sleep hours</span><span class="legend-item"><i class="legend-swatch amber"></i> stress</span></div></div>`;
}

function renderDashboard() {
  if (!account) return;
  const rawAll = sessions.filter(dashboardSessionApplies);
  const rawView = filteredSessions().filter(dashboardSessionApplies);
  const allSessions = rawAll.map(projectDashboardSession);
  const list = rawView.map(projectDashboardSession);
  const b = dashboardBaseline();
  const insight = dashboardInsight(list, b);
  $("dashGreeting").textContent = `Good to see you, ${account.name}.`;
  $("dashDate").textContent = dayLabel(today());
  $("startToday").disabled = Boolean(currentSession());
  $("startToday").textContent = currentSession() ? "Today's check-in is complete" : "Start today's check-in";
  updateDashboardFilter();
  $("dashboardContent").innerHTML = dashboardMarkup(insight, list, allSessions, b);
}

/* ------------------------------------------------------------- badges */
function badgeIcon(key) {
  const icons = {
    first: '<path d="M28 8l5.5 11.2L46 21l-9 8.8 2.2 12.4L28 36.4l-11.2 5.8L19 29.8 10 21l12.5-1.8z"/>',
    three: '<path d="M15 39l13-25 13 25"/><path d="M20 31h16"/><circle cx="28" cy="14" r="5"/>',
    week: '<rect x="10" y="13" width="36" height="34" rx="6"/><path d="M18 9v9M38 9v9M10 23h36"/><path d="M20 34l5 5 11-12"/>',
    baseline: '<path d="M11 42V28M22 42V19M33 42V12M44 42V24"/><path d="M8 42h40"/><path d="M12 18l10-7 11 3 11-8"/>',
    set: '<circle cx="20" cy="22" r="10"/><circle cx="36" cy="22" r="10"/><circle cx="28" cy="36" r="10"/>',
    rain: '<path d="M17 34h23a9 9 0 0 0 0-18 14 14 0 0 0-26-1 10 10 0 0 0 3 19z"/><path d="M19 41l-2 5M29 41l-2 5M39 41l-2 5"/>',
    thirty: '<circle cx="28" cy="28" r="19"/><path d="M20 22c1-4 5-6 9-4 5 3 1 9-4 9 6 0 10 7 4 11-5 3-10 0-10-4M36 18v20"/>',
    month: '<path d="M28 7l6 12 13 2-9.5 9 2.5 13-12-6-12 6 2.5-13L9 21l13-2z"/><circle cx="28" cy="28" r="5"/>'
  };
  return `<svg class="badge-icon" viewBox="0 0 56 56" aria-hidden="true">${icons[key] || icons.first}</svg>`;
}

function renderBadges() {
  const badges = E.badgesFor(sessions);
  const earned = badges.filter((badge) => badge.unlocked).length;
  const next = badges.find((badge) => !badge.unlocked);
  $("badgesContent").innerHTML = `<div class="badge-summary"><div><span class="eyebrow">Your collection</span><h3>${
    earned ? `You've earned ${earned} ${earned === 1 ? "badge" : "badges"}.` : "Your first badge is close."
  }</h3><p>${
    next ? `Next to aim for: ${next.name}. ${next.detail}.` : "You have collected every badge. That is wonderful consistency."
  }</p><div class="badge-progress" aria-label="${earned} of ${badges.length} badges earned"><span style="width:${earned / badges.length * 100}%"></span></div></div><div class="badge-count">${earned}/${badges.length}</div></div>
  <div class="badges">${badges.map((badge) => `<div class="badge ${badge.unlocked ? "unlocked" : ""}"><div class="badge-medallion">${badgeIcon(badge.key)}</div><strong>${badge.name}</strong><span class="tiny">${badge.detail}</span><span class="badge-status">${badge.unlocked ? "Earned" : "Still to come"}</span></div>`).join("")}</div>`;
}

/* ------------------------------------------------------------- friends */
async function renderFriends() {
  $("friendsList").innerHTML = '<p class="empty-note">Loading your circle…</p>';
  let data;
  try {
    data = await api("/api/friends");
  } catch (err) {
    $("friendsList").innerHTML = `<p class="empty-note">${escapeHtml(err.message)}</p>`;
    return;
  }
  $("inviteCode").textContent = data.inviteCode || "------";
  const friends = data.friends || [];
  if (!friends.length) {
    $("friendsList").innerHTML = '<p class="empty-note">No one here yet. Share your code above, or add a friend with theirs.</p>';
    return;
  }
  $("friendsList").innerHTML = friends.map((friend) => `<div class="friend-row">
    <div class="friend-avatar ${friend.checkedInToday ? "active" : ""}">${escapeHtml((friend.name[0] || "?").toUpperCase())}</div>
    <div class="friend-main"><strong class="friend-name">${escapeHtml(friend.name)}</strong><span class="friend-meta">${
      friend.sessions} ${friend.sessions === 1 ? "session" : "sessions"} · ${
      friend.checkedInToday ? "Checked in today" : friend.lastCheckIn ? `Last check-in ${dayLabel(friend.lastCheckIn)}` : "No check-ins yet"}</span></div>
    <div class="friend-streak" aria-label="${friend.streak} ${friend.streak === 1 ? "day" : "days"} streak">
      <svg class="streak-flame" viewBox="0 0 24 24" aria-hidden="true"><path d="M13.2 2.5c.6 3.8-2.7 4.8-2.2 8.1.2 1.4 1.2 2.2 2.4 2.6-.2-1.8.8-3.2 2.3-4.5 2.5 2.1 4.1 4.6 3.4 7.5-.8 3.4-3.6 5.3-7.1 5.3-4.2 0-7.4-2.7-7.4-6.8 0-3.7 2.4-6.4 5.2-8.9.1 2 .6 3.1 1.4 3.8-.3-3 1.1-4.6 2-7.1Z"/></svg>
      <strong>${friend.streak}</strong><span>${friend.streak === 1 ? "day" : "days"}</span>
    </div>
    <button class="friend-remove" data-remove="${friend.id}" type="button">Remove</button>
  </div>`).join("");
  $("friendsList").querySelectorAll("[data-remove]").forEach((button) =>
    button.addEventListener("click", async () => {
      try {
        await api("/api/friends", { method: "DELETE", body: JSON.stringify({ friendId: button.dataset.remove }) });
        renderFriends();
      } catch (err) { showToast(err.message); }
    }));
}

/* ------------------------------------------------------------- wiring */
document.querySelectorAll("[data-choice]").forEach((container) =>
  container.addEventListener("click", (event) => {
    const button = event.target.closest(".choice");
    if (button) setChoice(container, button);
  }));

$("sleepHours").addEventListener("input", (event) => {
  $("sleepValue").textContent = `${event.target.value} hours`;
});

$("checkinForm").addEventListener("submit", (event) => {
  event.preventDefault();
  pendingCheckin = {
    sleepHours: Number($("sleepHours").value),
    sleepQuality: selectedValue("sleepQuality"),
    mood: selectedValue("mood"),
    stress: selectedValue("stress"),
    energy: selectedValue("energy"),
    caffeine: document.querySelector('[data-choice="caffeine"] .selected').dataset.value === "yes",
    notes: $("notes").value.trim()
  };
  gameResults = {};
  reviewingToday = false;
  updateHub();
  showScreen("hub");
  showToast("Check-in saved. Choose a game when you're ready.");
});

document.querySelectorAll(".game-tile").forEach((tile) =>
  tile.addEventListener("click", () => launchGame(tile.dataset.game)));

$("nextGameButton").addEventListener("click", () => {
  const nextKey = ["symbolMatch", "memory", "words"].find((key) => !gameResults[key]);
  launchGame(nextKey);
});

window.addEventListener("message", (event) => {
  if (!event.data || event.data.source !== "mindtrace-game") return;
  if (event.data.game && event.data.payload) { gameResults[event.data.game] = event.data.payload; updateHub(); }
  if (event.data.game === "done") closeGame(false);
});

$("finishSession").addEventListener("click", finishSession);
$("closeGameModal").addEventListener("click", () => closeGame(true));

// Landing and auth
$("landingStart").addEventListener("click", () => showAuth("signup"));
$("landingSignIn").addEventListener("click", () => showAuth("signin"));
$("showSignIn").addEventListener("click", () => showAuth("signin"));
document.querySelectorAll(".auth-tab").forEach((tab) =>
  tab.addEventListener("click", () => showAuth(tab.dataset.authtab)));

$("signinForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("authError").hidden = true;
  try {
    const data = await api("/api/signin", {
      method: "POST",
      body: JSON.stringify({ email: $("signinEmail").value, password: $("signinPassword").value })
    });
    $("signinForm").reset();
    afterSignIn(data, `Welcome back, ${data.user.name}.`);
  } catch (err) { authError(err.message); }
});

$("signupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("authError").hidden = true;
  try {
    const data = await api("/api/signup", {
      method: "POST",
      body: JSON.stringify({
        name: $("signupName").value,
        email: $("signupEmail").value,
        password: $("signupPassword").value,
        birthYear: $("signupYear").value || null
      })
    });
    $("signupForm").reset();
    afterSignIn(data, `Welcome, ${data.user.name}. Let's start with today's quick check-in.`);
  } catch (err) { authError(err.message); }
});

$("signOutLink").addEventListener("click", () => signOut(false));
$("settingsLink").addEventListener("click", () => {
  applyTheme(localStorage.getItem(THEME_KEY) || "light");
  showScreen("settings");
});
$("brandHome").addEventListener("click", (event) => {
  event.preventDefault();
  if (account) { renderDashboard(); showScreen("dashboard"); } else showScreen("landing");
});

// Nav and back links
document.querySelectorAll(".nav-button").forEach((button) =>
  button.addEventListener("click", () => {
    const destination = button.dataset.nav;
    if (destination === "checkin") beginCheckin();
    else if (destination === "hub") openGames();
    else if (destination === "dashboard") { renderDashboard(); showScreen("dashboard"); }
    else if (destination === "badges") { renderBadges(); showScreen("badges"); }
    else if (destination === "friends") { showScreen("friends"); renderFriends(); }
    else if (destination === "settings") { applyTheme(localStorage.getItem(THEME_KEY) || "light"); showScreen("settings"); }
  }));

$("startToday").addEventListener("click", beginCheckin);
$("checkinBack").addEventListener("click", () => { renderDashboard(); showScreen("dashboard"); });
$("hubBack").addEventListener("click", () => {
  if (reviewingToday) { renderDashboard(); showScreen("dashboard"); } else showScreen("checkin");
});
$("badgesBack").addEventListener("click", () => { renderDashboard(); showScreen("dashboard"); });
$("friendsBack").addEventListener("click", () => { renderDashboard(); showScreen("dashboard"); });
$("settingsBack").addEventListener("click", () => { renderDashboard(); showScreen("dashboard"); });

document.querySelectorAll(".filter-button").forEach((button) =>
  button.addEventListener("click", () => { dashboardRange = button.dataset.range; renderDashboard(); }));
$("dashboardGame").addEventListener("change", (event) => { dashboardGame = event.target.value; renderDashboard(); });

document.querySelectorAll(".theme-choice").forEach((button) =>
  button.addEventListener("click", async () => {
    applyTheme(button.dataset.theme);
    showToast(button.dataset.theme === "dark" ? "Soft dark mode is on." : "Light mode is on.");
    if (account) { try { await api("/api/profile", { method: "PUT", body: JSON.stringify({ theme: button.dataset.theme }) }); } catch (err) { /* cosmetic only */ } }
  }));

// Friends
$("addFriendForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("friendError").hidden = true;
  const code = $("friendCode").value.trim().toUpperCase();
  if (!code) return;
  try {
    await api("/api/friends", { method: "POST", body: JSON.stringify({ code }) });
    $("friendCode").value = "";
    showToast("Added. You can both see each other's streaks now.");
    renderFriends();
  } catch (err) {
    $("friendError").textContent = err.message;
    $("friendError").hidden = false;
  }
});

$("copyInvite").addEventListener("click", async () => {
  const code = $("inviteCode").textContent.trim();
  try {
    await navigator.clipboard.writeText(code);
    showToast("Invite code copied.");
  } catch (err) {
    // Clipboard is blocked in some embedded previews; select it instead.
    const range = document.createRange();
    range.selectNodeContents($("inviteCode"));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    showToast("Copy the highlighted code.");
  }
});

// Export
$("exportData").addEventListener("click", () => {
  if (!account || !sessions.length) { showToast("Complete a session before exporting your information."); return; }
  const headers = ["date", "sleep_hours", "sleep_quality", "mood", "stress", "energy", "caffeine", "sleep_score", "composite", "speed", "focus", "memory", "words"];
  const lines = [headers.join(",")].concat(sessions.map((s) => [
    s.date, s.checkin.sleepHours, s.checkin.sleepQuality, s.checkin.mood, s.checkin.stress,
    s.checkin.energy, s.checkin.caffeine, s.sleepScore, s.composite,
    ...["speed", "focus", "memory", "words"].map((k) => (s.domains && s.domains[k] != null) ? s.domains[k] : "")
  ].join(",")));
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mindtrace-${account.name.toLowerCase()}-sessions.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

/* ------------------------------------------------------------- start */
applyTheme(localStorage.getItem(THEME_KEY) || "light");
setInterval(syncTimePalette, 60000);

(async function start() {
  if (!token) { showScreen("landing"); return; }
  try {
    const data = await api("/api/me");
    account = data.user;
    sessions = data.sessions || [];
    applyTheme(account.theme || localStorage.getItem(THEME_KEY) || "light");
    if (currentSession()) { renderDashboard(); showScreen("dashboard"); }
    else { resetCheckin(); showScreen("checkin"); }
  } catch (err) {
    token = null;
    localStorage.removeItem(TOKEN_KEY);
    showScreen("landing");
  }
})();