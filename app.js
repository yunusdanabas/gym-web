import {bytesToB64, generateDeviceKey, sealWithKey, openWithKey} from "./crypto.js";
import {clockParts as clockFromValues, clockToHours, clockToMinutes, hoursToClock, minutesToClock} from "./clock.js";
import {CONFIG} from "./config.js";
import {assertTopLevel, assertPathAllowed, clearCredentialFields, isFramed} from "./guard.js";
import {
  pendingReadbacks, upgradeDeviceDb, outboxOrder, isNetworkFailure, isAlreadyDelivered,
  isAuthFailure, newerDraft, shouldPushDraft, DB_NAME, DB_VERSION, DEVICE_STORE,
  OUTBOX_STORE, DRAFT_STORE,
} from "./queue.js";

const OWNER = CONFIG.owner;
const REPO = CONFIG.repo;
const MAIN = CONFIG.mainBranch;
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const READ_PREFIXES = CONFIG.readPrefixes;
const WRITE_PREFIXES = CONFIG.writePrefixes;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let token = "";
// Device-generated AES key, stored in IndexedDB and held in memory while the app is open.
// It seals the token, the offline outbox and local drafts.
let deviceKey = null;
let ledgerState = null;
let queuedCount = 0;
// Today's saved draft, so Do next can say when the session text is already pasted.
let todayDraft = null;
let outboxNote = "";
let draining = false;
// Set by Correct, and cleared the moment the entry it referred to stops being the one
// on screen. It used to be cleared only on a successful submit, so tapping Correct and
// then changing the date carried the flag onto a different day.
let correctionOf = "";
let mealCatalog = [];
let chosenMealIds = [];

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
// it can be sent. Draining needs the token, and the token and the key are loaded
// together when the app opens. See "Device security" in docs/web-app.md.
async function queueSubmission(item) {
  if (!deviceKey) throw new Error("This device is not connected, so nothing can be queued.");
  const sealed = await sealWithKey(deviceKey, JSON.stringify(item));
  await withStore(OUTBOX_STORE, "readwrite", store => store.put({id:item.id, queued_at:chicagoTimestamp(), ...sealed}));
}

const outboxEntries = () => withStore(OUTBOX_STORE, "readonly", store => store.getAll());
const outboxCount = () => withStore(OUTBOX_STORE, "readonly", store => store.count());
const outboxDelete = id => withStore(OUTBOX_STORE, "readwrite", store => store.delete(id));
const outboxClear = () => withStore(OUTBOX_STORE, "readwrite", store => store.clear());
const draftPath = date => `queue/drafts/daily-${date}.json`;
const localDrafts = () => withStore(DRAFT_STORE, "readonly", store => store.getAll());
const deleteLocalDraft = date => withStore(DRAFT_STORE, "readwrite", store => store.delete(date));
const draftsClear = () => withStore(DRAFT_STORE, "readwrite", store => store.clear());

function makeDraft(date, payload) {
  return {schema:1, interface:"web_draft_v1", kind:"daily", date, updated_at:chicagoTimestamp(), timezone:"America/Chicago", payload};
}

async function putLocalDraft(draft) {
  if (!deviceKey) throw new Error("This device is not connected, so nothing can be saved.");
  const sealed = await sealWithKey(deviceKey, JSON.stringify(draft));
  await withStore(DRAFT_STORE, "readwrite", store => store.put({date:draft.date, queued_at:draft.updated_at, ...sealed}));
}

async function getLocalDraft(date) {
  if (!deviceKey) return null;
  try {
    const sealed = await withStore(DRAFT_STORE, "readonly", store => store.get(date));
    return sealed ? JSON.parse(await openWithKey(deviceKey, sealed)) : null;
  } catch (_) { return null; }
}

async function drainOutbox() {
  // Never while the token is absent: the entries are sealed with the device key, and
  // sending them needs the token. Both are loaded when the app opens.
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
  if (!token) throw new Error("This device is not connected.");
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

async function upsertJson(path, value, message) {
  assertPathAllowed(path, WRITE_PREFIXES, "write");
  assertPathAllowed(path, READ_PREFIXES, "read");
  let sha;
  try {
    const file = await github(`/contents/${apiPath(path)}?ref=${encodeURIComponent(MAIN)}`);
    sha = file.sha;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  const body = {message, branch: MAIN, content: bytesToB64(encoder.encode(JSON.stringify(value, null, 2) + "\n"))};
  if (sha) body.sha = sha;
  return github(`/contents/${apiPath(path)}`, {method:"PUT", body:JSON.stringify(body)});
}

async function deleteRepoFile(path, message) {
  assertPathAllowed(path, WRITE_PREFIXES, "write");
  assertPathAllowed(path, READ_PREFIXES, "read");
  try {
    const file = await github(`/contents/${apiPath(path)}?ref=${encodeURIComponent(MAIN)}`);
    await github(`/contents/${apiPath(path)}`, {method:"DELETE", body:JSON.stringify({message, sha:file.sha, branch:MAIN})});
  } catch (error) {
    if (error.status === 404) return;
    throw error;
  }
}

async function getRemoteDraft(date) {
  try {
    return (await getJsonFile(draftPath(date))).value;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function drainDrafts() {
  if (!token || !deviceKey) return;
  for (const entry of await localDrafts()) {
    let draft;
    try { draft = JSON.parse(await openWithKey(deviceKey, entry)); }
    catch (_) { continue; }
    let remote = null;
    try { remote = await getRemoteDraft(draft.date); }
    catch (error) {
      if (isNetworkFailure(error) || isAuthFailure(error)) break;
      if (error.status !== 404) continue;
    }
    if (!shouldPushDraft(draft, remote)) continue;
    try { await upsertJson(draftPath(draft.date), draft, `web: save draft ${draft.date}`); }
    catch (error) {
      if (isNetworkFailure(error) || isAuthFailure(error)) break;
    }
  }
}

async function discardDraft(date) {
  try { await deleteLocalDraft(date); } catch (_) {}
  if (!token) return;
  try { await deleteRepoFile(draftPath(date), `web: clear draft ${date}`); }
  catch (error) {
    if (error.status !== 404 && !isNetworkFailure(error)) throw error;
  }
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

function clockParts(data, hoursName, minutesName) {
  return clockFromValues(numberValue(data, hoursName, true), numberValue(data, minutesName, true));
}

function applyClockHours(form, hoursName, minutesName, hoursValue) {
  const parts = hoursToClock(hoursValue);
  if (!parts) return;
  setNamed(form, hoursName, parts.hours);
  setNamed(form, minutesName, parts.minutes);
}

function applyClockMinutes(form, hoursName, minutesName, minutesValue) {
  const parts = minutesToClock(minutesValue);
  if (!parts) return;
  setNamed(form, hoursName, parts.hours);
  setNamed(form, minutesName, parts.minutes);
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

function dailyPayload(form) {
  const data = new FormData(form);
  const payload = {};
  addSection(payload, "body", {weight_kg:numberValue(data,"weight_kg")});
  addSection(payload, "sleep", {hours:clockToHours(clockParts(data,"sleep_hours","sleep_minutes"), 14)});
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
  const sessionMinutes = clockToMinutes(clockParts(data, "session_hours", "session_minutes"));
  if (sessionMinutes !== undefined) payload.session = {minutes: sessionMinutes};
  if (data.get("notes").trim()) payload.notes = data.get("notes").trim();
  const pastedRaw = data.get("pasted_text");
  if (pastedRaw && String(pastedRaw).trim()) payload.text = String(pastedRaw).trim();
  if (chosenMealIds.length) {
    payload.chosen_meals = [...chosenMealIds];
    const summed = sumMealMacros(chosenMealIds);
    if (payload.nutrition) {
      for (const key of ["kcal", "protein_g", "carbs_g", "fat_g"]) {
        if (payload.nutrition[key] === summed[key]) delete payload.nutrition[key];
      }
      if (!Object.keys(payload.nutrition).length) delete payload.nutrition;
    }
  }
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
  if (item.date) { try { await discardDraft(item.date); } catch (_) {} }
  form.reset();
  const dateInput=$("input[name=date]", form);
  if(dateInput)dateInput.value=chicagoDate();
  if (form.id === "daily-form") { chosenMealIds = []; renderMealChips(); }
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
  await refreshTodayDraft(ledgerState?.brief?.date);
  renderToday(); renderReview(); renderHistory();
}

// The Do next card ticks exercises he has already saved today. The draft is read once
// here rather than inside renderToday, which runs on every outbox change too.
async function refreshTodayDraft(date) {
  todayDraft = null;
  if (!date) return;
  let local = null;
  let remote = null;
  try { local = await getLocalDraft(date); } catch (_) {}
  if (token && navigator.onLine) {
    try { remote = await getRemoteDraft(date); } catch (_) {}
  }
  todayDraft = newerDraft(local, remote);
}

function fmtNum(value, digits) {
  if (value == null || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number.toFixed(digits);
}

function formatTarget(target) {
  return String(target || "").replace("x", "×");
}

function setNamed(form, name, value) {
  const field = form.querySelector(`[name="${name}"]`);
  if (!field || value === undefined || value === null) return;
  field.value = String(value);
}

function mealById(id) {
  return mealCatalog.find(meal => meal.id === id);
}

function sumMealMacros(ids) {
  const totals = {};
  for (const id of ids) {
    const meal = mealById(id);
    if (!meal) continue;
    for (const key of ["kcal", "protein_g", "carbs_g", "fat_g"]) {
      if (meal[key] == null) continue;
      totals[key] = (totals[key] || 0) + Number(meal[key]);
    }
  }
  return totals;
}

function applyMealDelta(form, meal, sign) {
  const names = {kcal: "kcal", protein_g: "protein_g", carbs_g: "carbs_g", fat_g: "fat_g"};
  for (const [fieldName, key] of Object.entries(names)) {
    if (meal[key] == null) continue;
    const field = form.querySelector(`[name="${fieldName}"]`);
    if (!field) continue;
    const current = field.value === "" ? 0 : Number(field.value);
    const next = current + sign * Number(meal[key]);
    field.value = next > 0 ? String(next) : "";
  }
  updateDisclosureCounts();
}

function renderMealChips() {
  const root = $("#meal-chips");
  if (!root) return;
  if (!mealCatalog.length) {
    root.innerHTML = `<p class="hint">No stored meals yet. Add one below with the kcal you actually measured.</p>`;
    return;
  }
  root.innerHTML = mealCatalog.map(meal => {
    const selected = chosenMealIds.includes(meal.id);
    const macros = [meal.kcal != null ? `${meal.kcal} kcal` : "", meal.protein_g != null ? `${meal.protein_g} g P` : ""]
      .filter(Boolean).join(" · ");
    return `<button type="button" class="chip${selected ? " active" : ""}" data-meal-id="${esc(meal.id)}">${esc(meal.name)}<small>${esc(macros)}</small></button>`;
  }).join("");
}

async function loadMealCatalog() {
  const byId = new Map();
  if (!token) {
    mealCatalog = [];
    renderMealChips();
    return;
  }
  try {
    const file = await getJsonFile(CONFIG.mealChoicesPath);
    for (const meal of file.value.meals || []) {
      if (meal && meal.id && meal.kcal != null) byId.set(meal.id, meal);
    }
  } catch (error) {
    if (error.status !== 404 && !isNetworkFailure(error)) throw error;
  }
  try {
    assertPathAllowed("queue/meals/", READ_PREFIXES, "read");
    const items = await github(`/contents/${apiPath("queue/meals")}?ref=${encodeURIComponent(MAIN)}`);
    if (Array.isArray(items)) {
      for (const item of items) {
        if (!item.name || !item.name.endsWith(".json")) continue;
        const meal = (await getJsonFile(`queue/meals/${item.name}`)).value;
        if (meal && meal.id && meal.kcal != null) byId.set(meal.id, meal);
      }
    }
  } catch (error) {
    if (error.status !== 404 && !isNetworkFailure(error)) throw error;
  }
  mealCatalog = [...byId.values()];
  renderMealChips();
}

function mealIdFromName(name) {
  return String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function applyDailyPayload(form, payload) {
  if (!payload || typeof payload !== "object") return;
  setNamed(form, "weight_kg", payload.body?.weight_kg);
  applyClockHours(form, "sleep_hours", "sleep_minutes", payload.sleep?.hours);
  setNamed(form, "resting_hr", payload.readiness?.resting_hr);
  setNamed(form, "kcal", payload.nutrition?.kcal);
  setNamed(form, "protein_g", payload.nutrition?.protein_g);
  setNamed(form, "carbs_g", payload.nutrition?.carbs_g);
  setNamed(form, "fat_g", payload.nutrition?.fat_g);
  setNamed(form, "fiber_g", payload.nutrition?.fiber_g);
  setNamed(form, "water_ml", payload.nutrition?.water_ml);
  setNamed(form, "unplanned_eating", payload.nutrition?.unplanned_eating);
  setNamed(form, "steps", payload.activity?.steps);
  const cardio = Array.isArray(payload.activity?.cardio) ? payload.activity.cardio[0] : payload.activity?.cardio;
  if (cardio) {
    setNamed(form, "cardio_min", cardio.min);
    if (cardio.type) setNamed(form, "cardio_type", cardio.type);
    setNamed(form, "incline_pct", cardio.incline_pct);
    setNamed(form, "cardio_speed", cardio.speed);
  }
  applyClockMinutes(form, "session_hours", "session_minutes", payload.session?.minutes);
  if (payload.notes) setNamed(form, "notes", payload.notes);
  if (payload.text) setNamed(form, "pasted_text", payload.text);
  if (Array.isArray(payload.chosen_meals)) {
    chosenMealIds = payload.chosen_meals.filter(id => mealById(id));
    renderMealChips();
  }
  updateDisclosureCounts();
  for (const details of $$("details.disclosure", form)) {
    if (countEntered(details)) details.open = true;
  }
}

function resetDailyForm(date) {
  const form = $("#daily-form");
  const dateInput = $("input[name=date]", form);
  form.reset();
  if (dateInput) dateInput.value = date;
  chosenMealIds = [];
  renderMealChips();
  updateDisclosureCounts();
}

async function loadDailyDraft(date) {
  resetDailyForm(date);
  let local = null;
  let remote = null;
  try { local = await getLocalDraft(date); } catch (_) {}
  if (token && navigator.onLine) {
    try { remote = await getRemoteDraft(date); }
    catch (error) { if (!isNetworkFailure(error)) throw error; }
  }
  const draft = newerDraft(local, remote);
  if (draft && remote && draft === remote) {
    try { await putLocalDraft(draft); } catch (_) {}
  }
  if (draft?.payload) applyDailyPayload($("#daily-form"), draft.payload);
}

function restoreDailyDraftIfEmpty() {
  const form = $("#daily-form");
  const date = $("input[name=date]", form).value;
  if (!date || countEntered(form)) return;
  loadDailyDraft(date).catch(error => setStatus(form, error.message, true));
}

// ---------------------------------------------------------------- the deck
// Four cards, one screen each, on the first page he opens. Horizontal scroll-snap in
// styles.css does the paging: a carousel library would be the only dependency in the
// app, and the platform already ships this.

function deckCard(kicker, body, label) {
  return `<article class="card deck-card" tabindex="0" role="group" aria-label="${esc(label)}"><p class="kicker">${esc(kicker)}</p>${body}</article>`;
}

function doNextCard(brief, train) {
  const items = train.exercises || [];
  if (!items.length) {
    const outstanding = (brief.needs_you || []).find(item => item.severity === "warn");
    return deckCard("Do next", `<p class="hero-line">Rest day</p><p class="muted">${outstanding
      ? esc(outstanding.what)
      : "Nothing outstanding. Log weight and steps when you have them."}</p>`, "Do next");
  }
  const pasted = Boolean(todayDraft?.payload?.text);
  const rows = items.map(item => {
    const load = item.load == null ? "establish" : `${item.load} ${item.unit || "lb"}`;
    return `<li><b class="tick" aria-hidden="true">\u00b7</b><span><strong>${esc(item.name)}</strong><small>${esc(formatTarget(item.target))} \u00b7 ${esc(load)}</small></span></li>`;
  }).join("");
  return deckCard(`Do next \u00b7 ${train.session || ""}${train.time ? ` \u00b7 ${train.time}` : ""}`,
    `<p class="hero-line">${pasted ? "Session pasted" : `${items.length} planned`}</p><ul class="load-list ticks">${rows}</ul>${train.cardio
      ? `<p class="hint">Cardio: ${esc(train.cardio.min)} min ${esc(train.cardio.type)}</p>` : ""}`,
    "Do next, today's session");
}

// A line, not a chart library: the meta-CSP is default-src 'self', so nothing external
// could load anyway, and 30 points need no more than a polyline.
function weightSparkline(history) {
  const points = (history || []).filter(item => typeof item.weight_kg === "number")
    .map(item => item.weight_kg).reverse();
  if (points.length < 2) return "";
  const low = Math.min(...points);
  const span = Math.max(...points) - low || 1;
  const coords = points.map((value, index) =>
    `${(index / (points.length - 1) * 100).toFixed(2)},${(100 - (value - low) / span * 100).toFixed(2)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Body weight across the last ${points.length} logged days, ${esc(fmtNum(points[0], 2))} to ${esc(fmtNum(points[points.length - 1], 2))} kg"><polyline points="${coords}"/></svg>`;
}

function standingCard(standing, history) {
  const trend = standing.trend_kg_per_week;
  // A rate needs its sign and its unit, or -1.35 reads as a weight.
  const trendText = trend == null ? "\u2014"
    : `${trend > 0 ? "+" : "\u2212"}${fmtNum(Math.abs(trend), 2)} kg/wk`;
  return deckCard("Where you stand", `
    <p class="hero-line">${esc(fmtNum(standing.weight_avg_7d_kg, 2))} kg</p>
    <p class="muted">7-day average \u00b7 ${esc(trendText)}${standing.trend_verdict ? ` \u00b7 ${esc(standing.trend_verdict)}` : ""}</p>
    ${weightSparkline(history)}
    <div class="stats">
      <div class="stat"><span>Records confirmed</span><strong>${esc(standing.records_confirmed ?? 0)}/${esc(standing.records_total ?? 0)}</strong></div>
      <div class="stat"><span>Steps yesterday</span><strong>${esc(standing.steps_yesterday ?? "\u2014")}${standing.steps_target ? ` / ${esc(standing.steps_target)}` : ""}</strong></div>
    </div>`, "Where you stand");
}

function adherenceCard(adherence) {
  const streak = adherence.logged_day_streak ?? 0;
  const lifting = adherence.lifting_adherence;
  return deckCard("Adherence", `
    <p class="hero-line">${lifting == null ? "\u2014" : `${esc(fmtNum(lifting, 0))}%`}</p>
    <p class="muted">Lifting this week \u00b7 ${esc(adherence.sessions_done ?? 0)} done${adherence.sessions_partial
      ? ` + ${esc(adherence.sessions_partial)} partial` : ""} of ${esc(adherence.sessions_planned ?? 0)}</p>
    <div class="stats">
      <div class="stat"><span>Cardio</span><strong>${esc(adherence.cardio_min ?? 0)}/${esc(adherence.cardio_planned ?? 0)} min</strong></div>
      <div class="stat"><span>Logged streak</span><strong>${esc(streak)} ${streak === 1 ? "day" : "days"}</strong></div>
      <div class="stat"><span>Working sets</span><strong>${esc(adherence.work_sets ?? 0)}</strong></div>
      <div class="stat"><span>Pending</span><strong>${esc(ledgerState.pending_count || 0)}</strong></div>
      ${queuedCount ? `<div class="stat"><span>Queued here</span><strong id="today-queued">${esc(queuedCount)}</strong></div>` : ""}
    </div>
    <p class="hint">Confirmed records only \u2014 an unconfirmed day counts for nothing here.</p>`,
    "Adherence this week");
}

function verdictCard(brief) {
  const parts = [];
  if (brief.review?.body) parts.push(`<p class="kicker sub">Last night</p><p class="lookback">${esc(brief.review.body)}</p>`);
  if (brief.lookback?.body) parts.push(`<p class="kicker sub">This morning</p><p class="lookback">${esc(brief.lookback.body)}</p>`);
  return deckCard("Verdict", parts.length ? `<div class="prose">${parts.join("")}</div>`
    : `<p class="muted">Nothing written yet. The 23:30 close-out and the 07:30 lookback fill this in; if both stay empty, the timers are not running.</p>`,
    "The coach's verdict");
}

function renderToday() {
  const brief = ledgerState?.brief;
  const target = $("#today-content");
  if (!brief) {
    target.innerHTML = `<article class="card"><p class="muted">${navigator.onLine
      ? "The first private summary has not been published yet."
      : "No signal, so the brief could not be loaded. You can still log \u2014 entries queue on this device and send when you reconnect."}</p></article>`;
    return;
  }
  $("#today-date").textContent = `${brief.date} \u00b7 ${brief.week}`;
  const train = brief.train || {};
  target.innerHTML = `
    <div class="deck" role="group" aria-label="Today at a glance">${doNextCard(brief, train)}${
      standingCard(brief.standing || {}, ledgerState.history)}${
      adherenceCard(brief.adherence || {})}${verdictCard(brief)}</div>
    <article class="card wide"><p class="kicker">Train \u00b7 ${esc(train.session || "Rest")}${train.time ? ` \u00b7 ${esc(train.time)}` : ""}</p>
      <ul class="load-list">${(train.exercises || []).map(item => {
        const load = item.load == null ? "establish" : `${item.load} ${item.unit || "lb"}`;
        return `<li><b class="sets">${esc(formatTarget(item.target))}</b><span><strong>${esc(item.name)}</strong><small>${esc(load)} \u00b7 ${esc(item.basis)}</small></span></li>`;
      }).join("") || "<li>Rest day</li>"}</ul>
      ${train.cardio ? `<p class="hint">Cardio: ${esc(train.cardio.min)} min ${esc(train.cardio.type)}</p>` : ""}</article>`;
}

async function renderReview() {
  $("#pending-count").textContent = ledgerState?.pending_count || 0;
  const list = $("#review-list");
  const pending = pendingReadbacks(ledgerState);
  // Needs you lives here, not on Today. This is already the "awaiting you" view — its
  // kicker counts exactly this — and on Today it competed with the day's program.
  const needs = ledgerState?.brief?.needs_you || [];
  const needsCard = `<article class="card"><p class="kicker">Needs you</p><ul class="clean-list">${needs.map(item =>
    `<li><span><strong>${esc(item.kind)}</strong><small>${esc(item.what)}</small></span>${item.action
      ? `<code>${esc(item.action)}</code>` : ""}</li>`).join("") || "<li>Nothing flagged.</li>"}</ul></article>`;
  if (!pending.length) {
    list.innerHTML = `<article class="card"><p class="muted">Nothing is waiting for confirmation.</p></article>${needsCard}`;
    return;
  }
  list.innerHTML = pending.map(item => `<article class="card review-card" data-readback-path="${esc(item.path)}" data-id="${esc(item.id)}" data-kind="${esc(item.kind)}" data-target="${esc(item.date || item.week)}" data-hash="${esc(item.readback_sha256)}"><header><div><p class="kicker">${esc(item.date || item.week)}</p><h3>${esc(item.kind)} entry</h3></div><span class="state">${esc(item.state)}</span></header><div class="readback"><p class="muted">Open review to load the complete field-by-field readback.</p></div><div class="review-actions"><button class="correct" type="button">Open review</button><button class="dismiss" type="button">Delete request</button></div></article>`).join("") + needsCard;
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
  $(".review-actions", card).innerHTML = readback.state === "ready"
    ? `<button class="confirm" type="button">Confirm readback</button><button class="correct" type="button">Correct</button><button class="dismiss" type="button">Delete request</button>`
    : `<button class="correct" type="button">Correct</button><button class="dismiss" type="button">Delete request</button>`;
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

const ENTRY_TABS = ["daily","weekly"];

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
    try { await loadMealCatalog(); } catch (_) {}
  } catch (error) {
    // The stored key has already opened the token. What fails here is only GitHub's
    // liveness check, and refusing to open the app over it is what made "no signal"
    // mean "no ledger" in a basement gym.
    if (!isNetworkFailure(error)) throw error;
    offline = true;
  }
  $("#locked").hidden = true; $("#app").hidden = false;
  if (offline) {
    ledgerState = null;
    await renderOutbox();
    renderToday(); renderReview(); renderHistory();
    if (!countEntered($("#daily-form"))) await loadDailyDraft($("#daily-form [name=date]").value).catch(() => {});
  } else {
    await refreshState();
    // Anything typed without signal goes out now that the token is in hand.
    await drainOutbox();
    await drainDrafts();
    if (!countEntered($("#daily-form"))) await loadDailyDraft($("#daily-form [name=date]").value).catch(() => {});
  }
}

function lock() {
  token = ""; deviceKey = null; ledgerState = null;
  $("#app").hidden = true; $("#locked").hidden = false;
  $("#today-content").innerHTML = ""; $("#review-list").innerHTML = ""; $("#history-list").innerHTML = "";
  $("#setup-form").hidden = false;
  clearCredentialFields(document);
  $("#gate-status").textContent = "";
}

function isLegacySecret(saved) {
  return Boolean(saved && (saved.schema === 1 || saved.kdf === "PBKDF2-SHA256"));
}

async function wipeDeviceStores() {
  await db("delete");
  await deviceValue("delete", "device-key");
  await deviceValue("delete", "block");
  await outboxClear();
  await draftsClear();
}

function showSetup(message = "") {
  $("#locked").hidden = false;
  $("#app").hidden = true;
  $("#setup-form").hidden = false;
  $("#gate-copy").textContent = "Connect this device once. Your GitHub token stays on this browser.";
  $("#gate-status").textContent = message;
  clearCredentialFields(document);
}

// A dead spot in the gym, a GitHub outage or a rate limit used to read as a wrong
// passphrase — the error he is most likely to see, and the least likely to be true.
function unlockFailureMessage(error) {
  if (error.message === "GYM Ledger refuses to run inside a frame.") return error.message;
  if (!navigator.onLine) return "This device is offline. It will open when you have signal, or stay offline if the token is already stored.";
  if (error.name === "OperationError" || error.name === "InvalidAccessError") return "This device could not be opened. Connect it again.";
  if (error.status === 401 || error.status === 403) {
    return error.status === 403 && /rate limit/i.test(error.message)
      ? "GitHub is rate-limiting this token. Try again in a few minutes."
      : "GitHub rejected the stored token. It has probably expired — clear this device in Settings and connect again.";
  }
  if (error.status === 404) return "GitHub could not find the private repository or the file. Check the token's repository access.";
  if (error.status) return `GitHub returned ${error.status}: ${error.message}`;
  if (error instanceof TypeError) return "Could not reach GitHub. Check your connection and try again.";
  return error.message || "Could not open this device.";
}

async function initializeGate() {
  clearCredentialFields(document);
  const saved = await db("get");
  if (isLegacySecret(saved)) {
    await wipeDeviceStores();
    showSetup("This device used a passphrase. Paste the inbox token again. Unsent entries from the old lock cannot be opened.");
    return;
  }
  const key = await deviceValue("get", "device-key");
  if (saved && key) {
    try {
      await unlock(await openWithKey(key, saved), key);
      return;
    } catch (error) {
      token = ""; deviceKey = null;
      showSetup(unlockFailureMessage(error));
      return;
    }
  }
  showSetup();
}

$("#setup-form").addEventListener("submit", async event => {
  event.preventDefault();
  const tokenValue = new FormData(event.currentTarget).get("token").trim();
  try {
    assertTopLevel();
    $("#gate-status").textContent = "Checking GitHub and encrypting…";
    token = tokenValue;
    if (!(await connectionTest())) throw new Error("Use a token limited to the private GYM repository.");
      const key = await deviceValue("get", "device-key") || await generateDeviceKey();
      const sealed = await sealWithKey(key, token);
      await db("put", {schema:2, kdf:"device-key", cipher:"AES-256-GCM", ...sealed});
      await deviceValue("put", "device-key", key);
    await unlock(token, key);
  } catch (error) { token = ""; deviceKey = null; $("#gate-status").textContent = error.message; }
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
    await submitMain(makeSubmission("manual", {date}, payload), form);
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

$("#meal-chips").addEventListener("click", event => {
  const button = event.target.closest("[data-meal-id]");
  if (!button) return;
  const meal = mealById(button.dataset.mealId);
  if (!meal) return;
  const form = $("#daily-form");
  const index = chosenMealIds.indexOf(meal.id);
  if (index >= 0) {
    chosenMealIds.splice(index, 1);
    applyMealDelta(form, meal, -1);
  } else {
    chosenMealIds.push(meal.id);
    applyMealDelta(form, meal, 1);
  }
  renderMealChips();
  $("#daily-meals").open = true;
});

$("#add-meal").addEventListener("click", async () => {
  const form = $("#daily-form");
  try {
    assertTopLevel();
    const name = $("#meal-name").value.trim();
    const kcal = $("#meal-kcal").value;
    if (!name) throw new Error("A stored meal needs a name.");
    if (kcal === "") throw new Error("A stored meal needs the exact kcal you measured.");
    const id = mealIdFromName(name);
    if (!id) throw new Error("That name does not make a usable meal id.");
    const meal = {id, name, kcal: Number.parseInt(kcal, 10)};
    const items = $("#meal-items").value.trim();
    if (items) meal.items = items;
    for (const [fieldId, key] of [["meal-protein", "protein_g"], ["meal-carbs", "carbs_g"], ["meal-fat", "fat_g"]]) {
      if ($(`#${fieldId}`).value !== "") meal[key] = Number.parseInt($(`#${fieldId}`).value, 10);
    }
    await upsertJson(`queue/meals/${id}.json`, meal, `web: store meal ${id}`);
    const existing = mealCatalog.findIndex(item => item.id === id);
    if (existing >= 0) mealCatalog[existing] = meal;
    else mealCatalog.push(meal);
    renderMealChips();
    for (const fieldId of ["meal-name", "meal-items", "meal-kcal", "meal-protein", "meal-carbs", "meal-fat"]) {
      $(`#${fieldId}`).value = "";
    }
    setStatus(form, `Stored ${name}. Tap it to add those macros.`);
    updateDisclosureCounts();
  } catch (error) { setStatus(form, error.message, true); }
});

$("#save-draft").addEventListener("click", async () => {
  const form = $("#daily-form");
  try {
    assertTopLevel();
    setStatus(form, "Saving…");
    const date = new FormData(form).get("date");
    const payload = dailyPayload(form);
    if (!payload || !Object.keys(payload).length) throw new Error("Enter at least one observed value.");
    const draft = makeDraft(date, payload);
    await putLocalDraft(draft);
    try {
      await upsertJson(draftPath(date), draft, `web: save draft ${date}`);
      setStatus(form, "Saved. Send for readback when the day is finished, or leave it for the night pull.");
    } catch (error) {
      if (!isNetworkFailure(error)) throw error;
      setStatus(form, "Saved on this device — it will reach the inbox when you have signal.");
    }
  } catch (error) { setStatus(form, error.message, true); }
});

// ---------------------------------------------------------------- photo evidence
// Photos go straight to `queue/evidence/` in the private inbox through the Contents
// API. No `upload-*` branch and no artifact: the branch scheme was removed because
// deleting a branch does not delete its Git objects, and the transport stays dead
// (webapp/test.mjs still forbids the ref API). What replaced it makes no deletion
// promise instead — `./gym web route` moves each file to the laptop and removes it from
// the inbox's `main`, but the blob remains in that private repository's history. A
// photo is evidence for `./gym ingest` to read, never a value: nothing here touches the
// submission payload, and no number reaches the record without a confirmed read-back.

const MAX_PHOTO_EDGE = 1600;
const uploadedPhotos = [];

// Downscaled in the browser because the Contents API carries base64: a 4 MB phone photo
// is ~5.5 MB on the wire and lands forever in the inbox's history at that size.
async function shrinkPhoto(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.82));
  if (!blob) throw new Error("This photo could not be read on this device.");
  return new Uint8Array(await blob.arrayBuffer());
}

function renderPhotoList() {
  $("#photo-list").innerHTML = uploadedPhotos.map(item =>
    `<li><span><strong>${esc(item.name)}</strong><small>${esc(item.path)}</small></span><code>${esc(item.state)}</code></li>`).join("");
}

$("#photo-input").addEventListener("change", async event => {
  const form = $("#daily-form");
  const input = event.currentTarget;
  const files = [...input.files];
  input.value = "";
  if (!files.length) return;
  const date = new FormData(form).get("date");
  try {
    assertTopLevel();
    if (!date) throw new Error("Set the date before adding photos.");
    for (const file of files) {
      const entry = {name: file.name, path: "", state: "sending"};
      uploadedPhotos.push(entry);
      renderPhotoList();
      try {
        const bytes = await shrinkPhoto(file);
        entry.path = `queue/evidence/${date}-${crypto.randomUUID()}.jpg`;
        await putFile(entry.path, bytes, `web: evidence ${date}`);
        entry.state = "sent";
      } catch (error) {
        // Kept in the list rather than dropped: a photo he believes he sent and did not
        // is worse than one he can see failed.
        entry.state = "failed";
        setStatus(form, `${file.name}: ${error.message}`, true);
      }
      renderPhotoList();
    }
    if (uploadedPhotos.every(item => item.state === "sent")) {
      setStatus(form, `${uploadedPhotos.length} photo(s) in the inbox. Read them on the laptop with ./gym ingest ${date}.`);
    }
  } catch (error) { setStatus(form, error.message, true); }
});

$("#review-list").addEventListener("click", async event => {
  const card=event.target.closest(".review-card"); if (!card) return;
  const button = event.target.closest("button");
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
    } else if (event.target.matches(".dismiss")) {
      assertTopLevel();
      const target = card.dataset.target || "this";
      if (!window.confirm(`Delete the ${target} request from Review? This does not change a confirmed day.`)) return;
      event.target.disabled=true; event.target.textContent="Deleting…";
      const marker={schema:1,interface:"web_dismissal_v1",id:card.dataset.id,readback_sha256:card.dataset.hash,dismissed_at:chicagoTimestamp(),client_id:localStorage.getItem("gym-client-id")};
      await putJson(`queue/dismissals/${marker.id}-${String(marker.readback_sha256).slice(0,16)}.json`,marker,`web: dismiss ${marker.id}`);
      event.target.textContent="Deleted · processing";
      await refreshState();
    } else if (event.target.matches(".correct") && $(".readback-row",card)) {
      const target=card.dataset.target, kind=card.dataset.kind;
      if (kind === "weekly") {
        showView("entry"); showEntryTab("weekly"); $("#weekly-form [name=week]").value=target;
      } else if (kind === "band" || kind === "upload") {
        throw new Error("Evidence entries are corrected from the laptop with ./gym ingest.");
      } else {
        showView("entry"); showEntryTab("daily"); $("#daily-form [name=date]").value=target;
      }
      // Set last: showView and showEntryTab both clear the flag on purpose.
      correctionOf=card.dataset.id;
    } else { await openReadback(card); }
  } catch (error) {
    // Appended, never substituted: replacing the card's contents wiped the readback he
    // was in the middle of reading and left a disabled button behind.
    if (button) {
      button.disabled = false;
      if (button.matches(".confirm")) button.textContent = "Confirm readback";
      if (button.matches(".dismiss")) button.textContent = "Delete request";
    }
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
$$('[data-view]').forEach(button=>button.addEventListener("click",()=>{
  showView(button.dataset.view);
  if (button.dataset.view === "entry") restoreDailyDraftIfEmpty();
}));
$("#daily-form [name=date]").addEventListener("change",event=>{
  clearCorrection();
  loadDailyDraft(event.target.value).catch(error=>setStatus($("#daily-form"), error.message, true));
});
for (const eventName of ["input","change"]) $("#daily-form").addEventListener(eventName, updateDisclosureCounts);
$("#weekly-form [name=week]").addEventListener("change",clearCorrection);
$("#refresh-button").addEventListener("click",()=>refreshState().catch(error=>alert(error.message)));
$("#review-refresh").addEventListener("click",()=>refreshState().catch(error=>alert(error.message)));
$("#connection-test").addEventListener("click",async()=>{try{$("#settings-status").textContent=(await connectionTest())?"Private connection is working.":"Unexpected repository."}catch(error){$("#settings-status").textContent=error.message}});
$("#clear-device").addEventListener("click",async()=>{
  // Name the queued entries: they are sealed with the device key, so clearing the
  // token makes them unreadable. Destroying something he typed without saying so
  // is exactly what this app must never do.
  const queued = queuedCount ? ` and ${queuedCount} unsent entr${queuedCount === 1 ? "y" : "ies"}` : "";
  if (!confirm(`Remove the encrypted GitHub token${queued} from this device?`)) return;
  await wipeDeviceStores();
  lock();
  outboxNote = "";
  await renderOutbox();
  await initializeGate();
});
$("#theme-toggle").addEventListener("click",()=>{const next=document.documentElement.dataset.theme==="dark"?"light":"dark";document.documentElement.dataset.theme=next;localStorage.setItem("gym-theme",next)});
window.addEventListener("online",()=>{setNetworkState(); drainOutbox().catch(()=>{}); drainDrafts().catch(()=>{});});
window.addEventListener("offline",setNetworkState);
$("#outbox-send").addEventListener("click",()=>{drainOutbox().catch(error=>{outboxNote=error.message; renderOutbox();});});
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
