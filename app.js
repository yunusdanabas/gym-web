import {bytesToB64, sealToken, deriveDeviceKey, sealWithKey, openWithKey} from "./crypto.js";
import {CONFIG} from "./config.js";
import {assertTopLevel, assertPathAllowed, clearCredentialFields, isFramed} from "./guard.js";
import {
  pendingReadbacks, upgradeDeviceDb, outboxOrder, isNetworkFailure, isAlreadyDelivered,
  isAuthFailure, DB_NAME, DB_VERSION, DEVICE_STORE, OUTBOX_STORE,
} from "./queue.js";

const OWNER = CONFIG.owner;
const REPO = CONFIG.repo;
const MAIN = CONFIG.mainBranch;
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const READ_PREFIXES = CONFIG.readPrefixes;
const WRITE_PREFIXES = CONFIG.writePrefixes;
const LOCK_AFTER_MS = 30 * 60 * 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let token = "";
// The passphrase-derived AES key, held only while unlocked and dropped with the token.
// It seals the offline outbox, so nothing readable waits on the device for signal.
let deviceKey = null;
let ledgerState = null;
let blockConfig = null;
let lockTimer = null;
let queuedCount = 0;
let outboxNote = "";
let draining = false;
// Set by Correct, and cleared the moment the entry it referred to stops being the one
// on screen. It used to be cleared only on a successful submit, so tapping Correct and
// then changing the date carried the flag onto a different day.
let correctionOf = "";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? "").replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
const b64ToBytes = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const clean = value => value === "" || value === undefined ? undefined : value;

function chicagoDate() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {timeZone:"America/Chicago", year:"numeric", month:"2-digit", day:"2-digit"}).formatToParts().map(item => [item.type, item.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function chicagoTimestamp() {
  const now = new Date();
  const local = new Intl.DateTimeFormat("sv-SE", {timeZone:"America/Chicago", year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(now).replace(" ", "T");
  const offsetMinutes = Math.round((new Date(local + "Z") - now) / 60000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `${local}${sign}${String(Math.floor(absolute / 60)).padStart(2,"0")}:${String(absolute % 60).padStart(2,"0")}`;
}

function isoWeek(dateText) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2,"0")}`;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    // Additive only — see upgradeDeviceDb. A version-1 database already holds the
    // encrypted token in "device"; recreating that store would destroy it and force a
    // re-setup with a newly issued GitHub token.
    request.onupgradeneeded = () => upgradeDeviceDb(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Another GYM Ledger tab is open. Close it and try again."));
  });
}

// One transaction, closed whether it completes or fails. The old helper closed the
// database only on oncomplete, so an aborted transaction leaked a handle and the next
// version upgrade would have been blocked by it.
async function withStore(storeName, mode, run) {
  const database = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
      const request = run(transaction.objectStore(storeName));
      if (request) request.onsuccess = () => { result = request.result; };
    });
  } finally {
    database.close();
  }
}

const deviceValue = (action, key, value) => withStore(DEVICE_STORE, action === "get" ? "readonly" : "readwrite",
  store => action === "get" ? store.get(key) : action === "put" ? store.put(value, key) : store.delete(key));

const db = (action, value) => deviceValue(action, "secret", value);

// ------------------------------------------------------------------ the outbox
// A submission typed with no signal is sealed with the device key and held here until
// it can be sent. Draining needs the token, and the token and the key arrive together
// at unlock, so the plaintext is available exactly when it is needed and at no other
// time. See "Device security" in docs/web-app.md.
async function queueSubmission(item) {
  if (!deviceKey) throw new Error("This device is locked, so nothing can be queued.");
  const sealed = await sealWithKey(deviceKey, JSON.stringify(item));
  await withStore(OUTBOX_STORE, "readwrite", store => store.put({id:item.id, queued_at:chicagoTimestamp(), ...sealed}));
}

const outboxEntries = () => withStore(OUTBOX_STORE, "readonly", store => store.getAll());
const outboxCount = () => withStore(OUTBOX_STORE, "readonly", store => store.count());
const outboxDelete = id => withStore(OUTBOX_STORE, "readwrite", store => store.delete(id));
const outboxClear = () => withStore(OUTBOX_STORE, "readwrite", store => store.clear());

// config/block.json is the one file the *write* path needs: without it there are no
// exercise rows, so a done or partial session could never clear its own guard offline.
// Sealed like everything else this device keeps, and refreshed at every online unlock.
async function cacheBlockConfig(value) {
  if (!deviceKey || !value) return;
  try { await deviceValue("put", "block", await sealWithKey(deviceKey, JSON.stringify(value))); } catch (_) {}
}

async function cachedBlockConfig() {
  if (!deviceKey) return null;
  try {
    const sealed = await deviceValue("get", "block");
    return sealed ? JSON.parse(await openWithKey(deviceKey, sealed)) : null;
  } catch (_) { return null; }
}

async function drainOutbox() {
  // Never while locked: the entries are sealed with the device key, and sending them
  // needs the token. Both arrive at unlock and both leave at lock.
  if (draining || !token || !deviceKey) return;
  draining = true;
  let sent = 0;
  outboxNote = "";
  try {
    for (const entry of outboxOrder(await outboxEntries())) {
      let item;
      try {
        item = JSON.parse(await openWithKey(deviceKey, entry));
      } catch (_) {
        // Unreadable is not deletable. Keep it and say so rather than discarding
        // something he actually typed.
        outboxNote = "An entry on this device could not be unsealed. It is kept, not discarded.";
        continue;
      }
      try {
        await putJson(`queue/submissions/${item.id}.json`, item, `web: submit ${item.id}`);
        await outboxDelete(entry.id);
        sent += 1;
      } catch (error) {
        if (isAlreadyDelivered(error)) { await outboxDelete(entry.id); sent += 1; continue; }
        if (isAuthFailure(error)) { outboxNote = "GitHub rejected this token, so sending is paused. Reconnect this device in Settings."; break; }
        // Still no signal: leave the rest queued and stay quiet about it.
        if (isNetworkFailure(error)) break;
        outboxNote = `Sending is paused: ${error.message}`;
        break;
      }
    }
  } finally {
    draining = false;
  }
  if (sent) { try { await refreshState(); } catch (_) {} }
  await renderOutbox();
}

async function renderOutbox() {
  try { queuedCount = await outboxCount(); } catch (_) { queuedCount = 0; }
  const label = queuedCount === 1 ? "1 entry queued on this device" : `${queuedCount} entries queued on this device`;
  const tail = outboxNote || (queuedCount === 1 ? "It will send when you have signal." : "They will send when you have signal.");
  $("#outbox-text").textContent = queuedCount ? `${label} — ${tail}` : outboxNote;
  $("#outbox-send").hidden = !queuedCount;
  $("#outbox-banner").hidden = !queuedCount && !outboxNote;
  const todayStat = $("#today-queued");
  if (todayStat) todayStat.textContent = queuedCount;
  $("#review-queued").textContent = queuedCount ? ` · ${queuedCount} queued here` : "";
}

async function github(path, options = {}) {
  if (!token) throw new Error("This device is locked.");
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers:{Accept:"application/vnd.github+json", Authorization:`Bearer ${token}`, "X-GitHub-Api-Version":"2022-11-28", ...(options.headers || {})},
  });
  const expiry = response.headers.get("github-authentication-token-expiration");
  if (expiry) $("#token-expiry").textContent = expiry;
  if (!response.ok) {
    let message = `GitHub returned ${response.status}`;
    try { message = (await response.json()).message || message; } catch (_) {}
    // The status travels with the error. Matching on the message text never worked:
    // GitHub says "Not Found", not "404", so the missing-state fallback was dead code
    // and every first run reported itself as a bad passphrase.
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

const apiPath = path => path.split("/").map(encodeURIComponent).join("/");

// Returns the parsed value *and* the bytes it was parsed from. The bytes are what a
// hash has to be taken over: re-serialising the parsed object cannot reproduce the file
// gym.py wrote, because Python renders the float 20.0 as "20.0" and JSON.stringify
// renders it "20", and cardio minutes and body weights are floats.
async function getJsonFile(path, ref = MAIN) {
  assertPathAllowed(path, READ_PREFIXES, "read");
  const file = await github(`/contents/${apiPath(path)}?ref=${encodeURIComponent(ref)}`);
  const bytes = b64ToBytes(String(file.content).replace(/\s/g, ""));
  return {value: JSON.parse(decoder.decode(bytes)), bytes};
}

const sha256Hex = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
  .map(byte => byte.toString(16).padStart(2, "0")).join("");

async function putFile(path, bytes, message, branch = MAIN) {
  assertPathAllowed(path, WRITE_PREFIXES, "write");
  return github(`/contents/${apiPath(path)}`, {method:"PUT", body:JSON.stringify({message, branch, content:bytesToB64(bytes)})});
}

async function putJson(path, value, message, branch = MAIN) {
  return putFile(path, encoder.encode(JSON.stringify(value, null, 2) + "\n"), message, branch);
}

function setStatus(form, message, error = false) {
  const output = $(".status", form);
  output.textContent = message;
  output.classList.toggle("error", error);
}

function numberValue(data, name, integer = false) {
  const raw = data.get(name);
  if (raw === null || raw === "") return undefined;
  return integer ? Number.parseInt(raw, 10) : Number(raw);
}

function section(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== ""));
}

function addSection(payload, name, values) {
  const present = section(values);
  if (Object.keys(present).length) payload[name] = present;
}

function makeSubmission(kind, target, payload, extra = {}) {
  const item = {schema:1, interface:"web_submission_v1", id:crypto.randomUUID(), kind, created_at:chicagoTimestamp(), timezone:"America/Chicago", payload, ...target, ...extra};
  if (!payload || (typeof payload === "object" && !Object.keys(payload).length)) delete item.payload;
  if (correctionOf) item.supersedes = correctionOf;
  return item;
}

function plannedFor(dateText) {
  if (!blockConfig) return {session:"Rest", exercises:[]};
  const date = new Date(`${dateText}T12:00:00Z`);
  const dayName = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][date.getUTCDay()];
  const entry = blockConfig.schedule[dayName];
  const session = typeof entry === "object" ? entry.session : entry;
  return {session, exercises:blockConfig.sessions[session] || []};
}

// A field counts as entered only when it differs from what the form shipped with, so
// the cardio type's "treadmill" default does not make Cardio look occupied.
function fieldHasValue(field) {
  if (field.disabled || field.type === "hidden" || field.name === "date") return false;
  if (field.tagName === "SELECT") return field.value !== "";
  return field.value !== "" && field.value !== field.defaultValue;
}

const countEntered = root => $$("input, select, textarea", root).filter(fieldHasValue).length;

// The form is one long scroll on a phone, so most of it is collapsed. A collapsed
// section may never hide something already entered: the summary carries a live count,
// and the summary is visible whether the section is open or shut.
function updateDisclosureCounts() {
  for (const details of $$("#daily-form details.disclosure")) {
    const count = countEntered(details);
    const badge = $(".disclosure-count", details);
    badge.textContent = count === 1 ? "1 entered" : `${count} entered`;
    badge.hidden = !count;
  }
}

// Opens a section, never closes one: a section holding a value stays open whatever the
// plan says.
function openDisclosure(details, wanted) {
  if (details && (wanted || countEntered(details))) details.open = true;
}

function renderExercises(dateText) {
  const container = $("#exercise-fields");
  const plan = plannedFor(dateText);
  // The session status is NOT pre-filled from the plan, and a status he chose is never
  // cleared when the date changes. Pre-filling `rest` on a planned rest day put a value
  // he had not stated into the record, and it was enough on its own to satisfy the "at
  // least one observed value" guard — so an untouched form submitted a rest day. Every
  // other plan-derived value in this form rides along with something he did enter (an
  // exercise row's name and target, the cardio type beside its minutes); this one rode
  // along with nothing. The summary below says what the plan expects instead.
  // The summary says what the day holds, so the section can stay shut without hiding
  // what is behind it. Opening it on a training day would put six rows and 2,000px back
  // in front of the three numbers he logs most days.
  $("#session-plan").textContent = plan.exercises.length
    ? `${plan.session} · ${plan.exercises.length} exercises`
    : (plan.session === "Rest" ? "rest day" : "not covered");
  if (!plan.exercises.length) {
    container.innerHTML = `<p class="hint">${esc(plan.session === "Rest" ? "Rest day" : "No approved training block covers this date.")}</p>`;
    openDisclosure($("#daily-session"), false);
    updateDisclosureCounts();
    return;
  }
  container.innerHTML = plan.exercises.map((exercise, index) => `
    <div class="exercise-row" data-index="${index}" data-plan-name="${esc(exercise.name)}" data-target="${esc(`${exercise.sets}x${exercise.reps}`)}" data-unit="${esc(exercise.unit || "lb")}">
      <label class="exercise-name">${esc(exercise.name)}<small>${exercise.sets} × ${esc(exercise.reps)} · one working load</small><input class="actual-name" aria-label="Actual exercise name, if substituted" placeholder="Substitution, if any"></label>
      <label>Load<input class="load" type="number" min="0" step="0.5" inputmode="decimal"></label>
      ${[1,2,3,4].map(set => `<label>S${set}<input class="set" type="number" min="0" step="1" inputmode="numeric"></label>`).join("")}
      <label>RIR<input class="rir" type="number" min="0" max="10" step="1" inputmode="numeric"></label>
    </div>`).join("");
  // Counted after the rows exist, not before.
  updateDisclosureCounts();
}

function dailyPayload(form) {
  const data = new FormData(form);
  const payload = {};
  addSection(payload, "body", {weight_kg:numberValue(data,"weight_kg")});
  addSection(payload, "sleep", {hours:numberValue(data,"sleep_hours")});
  addSection(payload, "readiness", {resting_hr:numberValue(data,"resting_hr",true)});
  addSection(payload, "nutrition", {
    kcal:numberValue(data,"kcal",true), protein_g:numberValue(data,"protein_g",true), carbs_g:numberValue(data,"carbs_g",true),
    fat_g:numberValue(data,"fat_g",true), fiber_g:numberValue(data,"fiber_g",true), water_ml:numberValue(data,"water_ml",true),
    unplanned_eating:clean(data.get("unplanned_eating")),
  });
  const cardio = section({type:clean(data.get("cardio_type")), min:numberValue(data,"cardio_min"), incline_pct:numberValue(data,"incline_pct"), speed:numberValue(data,"cardio_speed")});
  if (cardio.speed !== undefined) cardio.speed_unit = "mph";
  // Minutes are what the record is keyed on, so cardio without them cannot be sent.
  // Dropping it silently lost values he had actually observed — the exact thing the
  // read-back discipline exists to prevent, one layer earlier.
  if (cardio.min === undefined && Object.keys(cardio).some(key => key !== "type")) {
    throw new Error("Cardio needs its minutes. Add them, or clear the incline and speed.");
  }
  cardio.source = "typed";
  addSection(payload, "activity", {steps:numberValue(data,"steps",true), cardio:cardio.min === undefined ? undefined : [cardio]});
  const session = section({status:clean(data.get("session_status")), minutes:numberValue(data,"session_minutes",true), pain:data.get("pain") === "" ? undefined : data.get("pain") === "true"});
  const exercises = $$(".exercise-row", form).map(row => {
    const sets = $$(".set", row).map(input => input.value === "" ? undefined : Number.parseInt(input.value,10)).filter(value => value !== undefined);
    if (!sets.length) return null;
    const unit = row.dataset.unit;
    const exercise = {name:$(".actual-name",row).value.trim() || row.dataset.planName, target:row.dataset.target, unit, sets, notes:""};
    const load = $(".load", row).value;
    if (load !== "" && unit !== "bw" && unit !== "s") exercise.weight = Number(load);
    const rir = $(".rir", row).value;
    if (rir !== "") exercise.rir_last = Number.parseInt(rir,10);
    return exercise;
  }).filter(Boolean);
  if (exercises.length) session.exercises = exercises;
  if (Object.keys(session).length) payload.session = session;
  if (data.get("notes").trim()) payload.notes = data.get("notes").trim();
  return payload;
}

async function submitMain(item, form) {
  setStatus(form, "Sending privately…");
  let queued = false;
  try {
    await putJson(`queue/submissions/${item.id}.json`, item, `web: submit ${item.id}`);
  } catch (error) {
    // Only a transport failure is queued. A 4xx is GitHub refusing this submission,
    // and queueing that would replay the same refusal forever instead of showing it.
    if (!isNetworkFailure(error)) throw error;
    // If this throws, the form is not reset and nothing he typed is lost.
    await queueSubmission(item);
    queued = true;
  }
  if (item.supersedes) correctionOf = "";
  form.reset();
  const dateInput=$("input[name=date]", form);
  if(dateInput)dateInput.value=chicagoDate();
  // reset() fires no input event, so the counts have to be recomputed by hand.
  updateDisclosureCounts();
  setStatus(form, queued
    ? "Queued on this device — it will send when you have signal."
    : "Sent. GitHub is preparing your readback.");
  // The submission is safe either way by this point, so a failed state refresh must
  // not be reported back as a failed send.
  try { await refreshState(); } catch (_) { await renderOutbox(); }
}

function clearCorrection() {
  correctionOf = "";
}

async function refreshState() {
  await renderOutbox();
  try {
    ledgerState = (await getJsonFile(CONFIG.statePath)).value;
  } catch (error) {
    if (error.status !== 404) throw error;
    // No state file yet: a first run, not a failure.
    ledgerState = {pending_count:0, readbacks:[], outcomes:[], history:[]};
  }
  renderToday(); renderReview(); renderHistory();
}

function renderToday() {
  const brief = ledgerState?.brief;
  const target = $("#today-content");
  if (!brief) {
    target.innerHTML = `<article class="card"><p class="muted">${navigator.onLine
      ? "The first private summary has not been published yet."
      : "No signal, so the brief could not be loaded. You can still log — entries queue on this device and send when you reconnect."}</p></article>`;
    return;
  }
  $("#today-date").textContent = `${brief.date} · ${brief.week}`;
  const train = brief.train || {};
  const standing = brief.standing || {};
  target.innerHTML = `
    <article class="card wide"><p class="kicker">Train · ${esc(train.session || "Rest")}${train.time ? ` · ${esc(train.time)}` : ""}</p>
      <ul class="load-list">${(train.exercises || []).map(item => `<li><b class="load">${item.load == null ? "establish" : `${esc(item.load)}<i>${esc(item.unit)}</i>`}</b><span><strong>${esc(item.name)}</strong><small>${esc(item.target)} · ${esc(item.basis)}</small></span></li>`).join("") || "<li>Rest day</li>"}</ul>
      ${train.cardio ? `<p class="hint">Cardio: ${esc(train.cardio.min)} min ${esc(train.cardio.type)}</p>` : ""}</article>
    <article class="card"><p class="kicker">Standing</p><div class="stats"><div class="stat"><span>7-day avg</span><strong>${esc(standing.weight_avg_7d_kg ?? "—")} kg</strong></div><div class="stat"><span>14-day trend <abbr title="kilograms per week">kg/wk</abbr></span><strong>${esc(standing.trend_kg_per_week ?? "—")}</strong></div><div class="stat"><span>Sessions</span><strong>${esc(standing.sessions_done_this_week ?? 0)}/${esc(standing.sessions_planned_this_week ?? 0)}</strong></div><div class="stat"><span>Pending</span><strong>${esc(ledgerState.pending_count || 0)}</strong></div><div class="stat"><span>Queued here</span><strong id="today-queued">${esc(queuedCount)}</strong></div></div></article>
    <article class="card"><p class="kicker">Needs you</p><ul class="clean-list">${(brief.needs_you || []).map(item => `<li><span><strong>${esc(item.kind)}</strong><small>${esc(item.what)}</small></span></li>`).join("") || "<li>Nothing flagged.</li>"}</ul></article>`;
}

async function renderReview() {
  $("#pending-count").textContent = ledgerState?.pending_count || 0;
  const list = $("#review-list");
  const pending = pendingReadbacks(ledgerState);
  if (!pending.length) {
    list.innerHTML = `<article class="card"><p class="muted">Nothing is waiting for confirmation.</p></article>`;
    return;
  }
  list.innerHTML = pending.map(item => `<article class="card review-card" data-readback-path="${esc(item.path)}" data-id="${esc(item.id)}" data-kind="${esc(item.kind)}" data-target="${esc(item.date || item.week)}" data-hash="${esc(item.readback_sha256)}"><header><div><p class="kicker">${esc(item.date || item.week)}</p><h3>${esc(item.kind)} entry</h3></div><span class="state">${esc(item.state)}</span></header><div class="readback"><p class="muted">Open review to load the complete field-by-field readback.</p></div><div class="review-actions"><button class="correct" type="button">Open review</button></div></article>`).join("");
}

async function openReadback(card) {
  assertTopLevel();
  const {value: readback, bytes} = await getJsonFile(card.dataset.readbackPath);
  // The hash of exactly the bytes that produced what is about to be on screen. The
  // card's readback_sha256 came from derived/web.json; if the two ever disagree he read
  // one thing and confirmed another, and gym.py refuses rather than guessing which.
  card.dataset.renderedHash = await sha256Hex(bytes);
  const rows = readback.fields.map(row => `<div class="readback-row"><strong>${esc(row.field)}</strong><code class="${row.status === "unread" ? "unread" : ""}">${row.status === "unread" ? "UNREAD" : esc(JSON.stringify(row.value))}</code><span class="source">${esc(row.source || "—")}</span></div>`).join("");
  const notices = [...(readback.warnings || []), ...(readback.errors || [])].map(item => `<p class="status error">${esc(item)}</p>`).join("");
  const unread = readback.fields.filter(row => row.status === "unread").length;
  const summary = `<p class="hint">${unread ? `${esc(unread)} field${unread === 1 ? "" : "s"} unread — they stay absent, they are not guessed.` : "Every field was read."}</p>`;
  $(".readback", card).innerHTML = rows + notices + summary;
  $(".review-actions", card).innerHTML = readback.state === "ready" ? `<button class="confirm" type="button">Confirm readback</button><button class="correct" type="button">Correct</button>` : `<button class="correct" type="button">Correct</button>`;
}

function renderHistory() {
  const list = $("#history-list");
  const outcomes = ledgerState?.outcomes || [];
  const days = ledgerState?.history || [];
  list.innerHTML = `<article class="card"><p class="kicker">Outcomes</p><ul class="clean-list">${outcomes.map(item => `<li><span><strong>${esc(item.date || item.week || item.id)}</strong><small>${esc(item.kind)}</small></span><code>${esc(item.state)}</code></li>`).join("") || "<li>No web outcomes yet.</li>"}</ul></article><article class="card"><p class="kicker">Recent days</p><ul class="clean-list">${days.map(item => `<li><span><strong>${esc(item.date)}</strong><small>${esc(item.planned_session)}</small></span><code>${item.confirmed ? "confirmed" : "unconfirmed"}</code></li>`).join("") || "<li>No days yet.</li>"}</ul></article>`;
}

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function showView(name) {
  clearCorrection();
  $$(".view").forEach(view => view.classList.toggle("active", view.id === name));
  $$(".nav-item").forEach(button => {
    const active = button.dataset.view === name;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  window.scrollTo({top:0, behavior: prefersReducedMotion() ? "auto" : "smooth"});
  // Without this a keyboard or screen-reader user gets no signal that the view changed:
  // focus stays on the nav button and nothing is announced.
  const heading = $(`#${name} .view-head h2`);
  if (heading) {
    heading.setAttribute("tabindex", "-1");
    heading.focus({preventScroll:true});
  }
}

const ENTRY_TABS = ["daily","weekly","text"];

function showEntryTab(name, moveFocus = false) {
  clearCorrection();
  $$('[data-entry-tab]').forEach(item => {
    const active = item.dataset.entryTab === name;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", String(active));
    // Roving tabindex: the tablist is one stop, arrows move between the tabs inside it.
    item.tabIndex = active ? 0 : -1;
    if (active && moveFocus) item.focus();
  });
  for (const candidate of ENTRY_TABS) $(`#${candidate}-form`).hidden = candidate !== name;
}

function setNetworkState() {
  const output = $("#network-pill");
  output.textContent = navigator.onLine ? "online" : "offline";
  output.classList.toggle("offline", !navigator.onLine);
}

async function connectionTest() {
  const result = await github("");
  const user = await fetch("https://api.github.com/user", {headers:{Accept:"application/vnd.github+json",Authorization:`Bearer ${token}`,"X-GitHub-Api-Version":"2022-11-28"}});
  if (!user.ok) throw new Error("GitHub could not identify this token.");
  const profile = await user.json();
  $("#github-user").textContent = profile.login;
  return result.private === true && result.full_name === `${OWNER}/${REPO}`;
}

async function unlock(value, key) {
  assertTopLevel();
  token = value;
  deviceKey = key || null;
  let offline = false;
  try {
    if (!(await connectionTest())) throw new Error("The token cannot access the expected private repository.");
    blockConfig = (await getJsonFile(CONFIG.blockPath)).value;
    await cacheBlockConfig(blockConfig);
  } catch (error) {
    // The passphrase has already proved itself — it decrypted the token before any of
    // this ran. What fails here is only GitHub's liveness check, and refusing to open
    // the app over it is what made "no signal" mean "no ledger" in a basement gym.
    if (!isNetworkFailure(error)) throw error;
    offline = true;
    blockConfig = await cachedBlockConfig();
  }
  $("#locked").hidden = true; $("#app").hidden = false;
  renderExercises($("#daily-form [name=date]").value);
  resetLockTimer();
  if (offline) {
    ledgerState = null;
    await renderOutbox();
    renderToday(); renderReview(); renderHistory();
  } else {
    await refreshState();
    // Anything typed without signal goes out now that the token is in hand.
    await drainOutbox();
  }
}

function lock() {
  token = ""; deviceKey = null; ledgerState = null; blockConfig = null;
  clearTimeout(lockTimer);
  $("#app").hidden = true; $("#locked").hidden = false;
  $("#today-content").innerHTML = ""; $("#review-list").innerHTML = ""; $("#history-list").innerHTML = "";
  $("#unlock-form").hidden = false; $("#setup-form").hidden = true;
  clearCredentialFields(document);
  $("#gate-status").textContent = "";
}

function resetLockTimer() {
  if (!token) return;
  clearTimeout(lockTimer);
  lockTimer = setTimeout(lock, LOCK_AFTER_MS);
}

// Everything used to be reported as a wrong passphrase, so a dead spot in the gym, a
// GitHub outage or a rate limit all read as "you typed it wrong" — the error he is most
// likely to see, and the least likely to be true.
function unlockFailureMessage(error) {
  if (error.message === "GYM Ledger refuses to run inside a frame.") return error.message;
  if (!navigator.onLine) return "This device is offline. Unlock again when you have signal.";
  if (error.name === "OperationError" || error.name === "InvalidAccessError") return "That passphrase did not unlock this device.";
  if (error.status === 401 || error.status === 403) {
    return error.status === 403 && /rate limit/i.test(error.message)
      ? "GitHub is rate-limiting this token. Try again in a few minutes."
      : "GitHub rejected the stored token. It has probably expired — clear this device in Settings and connect again.";
  }
  if (error.status === 404) return "GitHub could not find the private repository or the file. Check the token's repository access.";
  if (error.status) return `GitHub returned ${error.status}: ${error.message}`;
  if (error instanceof TypeError) return "Could not reach GitHub. Check your connection and try again.";
  return error.message || "Unlock failed.";
}

async function initializeGate() {
  const saved = await db("get");
  clearCredentialFields(document);
  $("#unlock-form").hidden = !saved;
  $("#setup-form").hidden = Boolean(saved);
  $("#gate-copy").textContent = saved ? "Unlock this device to see or record anything." : "Connect this device once. Your GitHub token will be encrypted locally.";
}

$("#setup-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget, data = new FormData(form), passphrase = data.get("passphrase");
  if (passphrase !== data.get("repeat")) { clearCredentialFields(document); $("#gate-status").textContent = "Passphrases do not match."; return; }
  try {
    assertTopLevel();
    $("#gate-status").textContent = "Checking GitHub and encrypting…";
    token = data.get("token").trim();
    if (!(await connectionTest())) throw new Error("Use a token limited to the private GYM repository.");
    // sealToken hands back the derived key as well as the record, so setup pays the
    // 600,000 PBKDF2 iterations once rather than twice.
    const sealed = await sealToken(token, passphrase);
    await db("put", sealed.record);
    await unlock(token, sealed.key);
  } catch (error) { token = ""; deviceKey = null; $("#gate-status").textContent = error.message; }
  finally { clearCredentialFields(document); }
});

$("#unlock-form").addEventListener("submit", async event => {
  event.preventDefault();
  // Read the passphrase now, synchronously. After the first await the event has finished
  // dispatching and event.currentTarget is null, so reading it later threw
  // "Failed to construct 'FormData'" — a TypeError that unlockFailureMessage reported as
  // "Could not reach GitHub". Every unlock after the first lock failed, and blamed the
  // network for it.
  const passphrase = new FormData(event.currentTarget).get("passphrase");
  try {
    assertTopLevel();
    $("#gate-status").textContent = "Unlocking…";
    const saved = await db("get");
    if (!saved) throw new Error("This device is not connected yet.");
    // Derived once and kept: it decrypts the token and seals the offline outbox.
    const key = await deriveDeviceKey(saved, passphrase);
    await unlock(await openWithKey(key, saved), key);
  } catch (error) { token = ""; deviceKey = null; $("#gate-status").textContent = unlockFailureMessage(error); }
  finally { clearCredentialFields(document); }
});

$("#daily-form").addEventListener("submit", async event => {
  event.preventDefault();
  // Captured before the first await for the same reason: the catch below used
  // event.currentTarget, which is null by the time an error from submitMain arrives, so
  // setStatus threw and every failed submission reported nothing at all.
  const form = event.currentTarget;
  try {
    const date=new FormData(form).get("date"), payload=dailyPayload(form);
    if(!Object.keys(payload).length)throw new Error("Enter at least one observed value.");
    if(["done","partial"].includes(payload.session?.status) && !payload.session.exercises?.length)throw new Error("A done or partial session needs at least one exercise with recorded sets.");
    await submitMain(makeSubmission("manual", {date}, payload), form); renderExercises(chicagoDate());
  }
  catch (error) { setStatus(form, error.message, true); }
});

$("#weekly-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form=event.currentTarget, data=new FormData(form);
  const ratings=Object.fromEntries(["sleep_quality","energy","stress","hunger","soreness_worst","cardio_difficulty","motivation"].map(name => [name,numberValue(data,name,true)]));
  const payload={waist_cm:numberValue(data,"waist_cm"),ratings,restaurant_meals:numberValue(data,"restaurant_meals",true),alcohol_units:numberValue(data,"alcohol_units"),notes:data.get("notes").trim(),decisions:[]};
  try { await submitMain(makeSubmission("weekly", {week:data.get("week")}, payload), form); }
  catch (error) { setStatus(form,error.message,true); }
});

$("#text-form").addEventListener("submit", async event => {
  event.preventDefault(); const form=event.currentTarget,data=new FormData(form);
  try { await submitMain(makeSubmission("text", {date:data.get("date")}, {text:data.get("text")}), form); }
  catch (error) { setStatus(form,error.message,true); }
});

// The Upload route is gone, not merely disabled. Evidence travelled on a temporary
// `upload-*` branch and deleting that branch does not delete its Git objects, so the
// app's 30-day deletion promise could not be kept. The scheduled evidence reader the
// tab pointed at was never built either, so an upload dead-ended. Screenshot ingest
// runs from the laptop (`./gym ingest`) until storage with real deletion exists.

$("#review-list").addEventListener("click", async event => {
  const card=event.target.closest(".review-card"); if (!card) return;
  try {
    if (event.target.matches(".confirm")) {
      assertTopLevel();
      event.target.disabled=true; event.target.textContent="Confirming…";
      const marker={schema:1,interface:"web_confirmation_v1",id:card.dataset.id,readback_sha256:card.dataset.hash,confirmed_at:chicagoTimestamp(),client_id:localStorage.getItem("gym-client-id")};
      // Optional on the wire, so a confirmation from an older client still finalizes.
      if (card.dataset.renderedHash) marker.rendered_sha256 = card.dataset.renderedHash;
      await putJson(`queue/confirmations/${marker.id}-${marker.readback_sha256.slice(0,16)}.json`,marker,`web: confirm ${marker.id}`);
      event.target.textContent="Confirmation sent · processing";
      // Without this the card sat on "processing" until a manual Refresh.
      await refreshState();
    } else if (event.target.matches(".correct") && $(".readback-row",card)) {
      const target=card.dataset.target, kind=card.dataset.kind;
      if (kind === "weekly") {
        showView("entry"); showEntryTab("weekly"); $("#weekly-form [name=week]").value=target;
      } else if (kind === "band" || kind === "upload") {
        throw new Error("Evidence entries are corrected from the laptop with ./gym ingest.");
      } else {
        showView("entry"); showEntryTab("daily"); $("#daily-form [name=date]").value=target; renderExercises(target);
      }
      // Set last: showView and showEntryTab both clear the flag on purpose.
      correctionOf=card.dataset.id;
    } else { await openReadback(card); }
  } catch (error) {
    // Appended, never substituted: replacing the card's contents wiped the readback he
    // was in the middle of reading and left a disabled button behind.
    const button = event.target.closest("button");
    if (button) { button.disabled = false; button.textContent = button.matches(".confirm") ? "Confirm readback" : button.textContent; }
    const notice = document.createElement("p");
    notice.className = "status error";
    notice.textContent = error.message;
    $(".readback", card).append(notice);
  }
});

$$('[data-entry-tab]').forEach(button => button.addEventListener("click", () => showEntryTab(button.dataset.entryTab)));
$(".segmented").addEventListener("keydown", event => {
  const keys = {ArrowRight:1, ArrowLeft:-1, Home:"first", End:"last"};
  if (!(event.key in keys)) return;
  event.preventDefault();
  const current = ENTRY_TABS.indexOf($('[data-entry-tab][aria-selected="true"]').dataset.entryTab);
  const step = keys[event.key];
  const next = step === "first" ? 0 : step === "last" ? ENTRY_TABS.length - 1
    : (current + step + ENTRY_TABS.length) % ENTRY_TABS.length;
  showEntryTab(ENTRY_TABS[next], true);
});
$$('[data-view]').forEach(button=>button.addEventListener("click",()=>showView(button.dataset.view)));
$("#daily-form [name=date]").addEventListener("change",event=>{clearCorrection(); renderExercises(event.target.value);});
for (const eventName of ["input","change"]) $("#daily-form").addEventListener(eventName, updateDisclosureCounts);
$("#weekly-form [name=week]").addEventListener("change",clearCorrection);
$("#refresh-button").addEventListener("click",()=>refreshState().catch(error=>alert(error.message)));
$("#review-refresh").addEventListener("click",()=>refreshState().catch(error=>alert(error.message)));
$("#lock-button").addEventListener("click",lock);
$("#connection-test").addEventListener("click",async()=>{try{$("#settings-status").textContent=(await connectionTest())?"Private connection is working.":"Unexpected repository."}catch(error){$("#settings-status").textContent=error.message}});
$("#clear-device").addEventListener("click",async()=>{
  // Name the queued entries: they are sealed with the key this record carries the salt
  // for, so clearing the token makes them unreadable. Destroying something he typed
  // without saying so is exactly what this app must never do.
  const queued = queuedCount ? ` and ${queuedCount} unsent entr${queuedCount === 1 ? "y" : "ies"}` : "";
  if (!confirm(`Remove the encrypted GitHub token${queued} from this device?`)) return;
  await db("delete");
  await deviceValue("delete", "block");
  await outboxClear();
  lock();
  outboxNote = "";
  await renderOutbox();
  await initializeGate();
});
$("#theme-toggle").addEventListener("click",()=>{const next=document.documentElement.dataset.theme==="dark"?"light":"dark";document.documentElement.dataset.theme=next;localStorage.setItem("gym-theme",next)});
window.addEventListener("online",()=>{setNetworkState(); drainOutbox().catch(()=>{});});
window.addEventListener("offline",setNetworkState);
$("#outbox-send").addEventListener("click",()=>{drainOutbox().catch(error=>{outboxNote=error.message; renderOutbox();});});
for (const eventName of ["pointerdown","keydown","touchstart"]) document.addEventListener(eventName,resetLockTimer,{passive:true});
// A phone put in a pocket mid-session should not leave an unlocked token in memory for
// the rest of the idle window.
document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="hidden"&&token)lock(); });

// Installable, and able to open with no signal. Registered only from a top-level
// window, so a framed page cannot install a worker for this origin.
try {
  assertTopLevel();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
} catch (_) { /* framed: guard.js has already navigated the top window here */ }

const savedTheme=localStorage.getItem("gym-theme");
if(savedTheme)document.documentElement.dataset.theme=savedTheme;
setNetworkState(); showView("today"); showEntryTab("daily"); updateDisclosureCounts();
if (isFramed(window)) { throw new Error("GYM Ledger refuses to run inside a frame."); }
if(!localStorage.getItem("gym-client-id"))localStorage.setItem("gym-client-id",crypto.randomUUID());
const today=chicagoDate();
for(const input of $$("input[type=date]"))input.value=today;
$("#weekly-form [name=week]").value=isoWeek(today);
renderOutbox().catch(()=>{});
initializeGate().catch(error=>{$("#gate-status").textContent=error.message});
