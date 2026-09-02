import {bytesToB64, encryptToken, decryptToken} from "./crypto.js";

const OWNER = "yunusdanabas";
const REPO = "gym-ledger-private";
const MAIN = "main";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const LOCK_AFTER_MS = 30 * 60 * 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let token = "";
let ledgerState = null;
let blockConfig = null;
let lockTimer = null;
let correctionOf = "";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? "").replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
const b64ToBytes = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const textToB64 = value => bytesToB64(encoder.encode(value));
const b64ToText = value => decoder.decode(b64ToBytes(value.replace(/\s/g, "")));
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
    const request = indexedDB.open("gym-ledger", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("device");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function db(action, value) {
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("device", action === "get" ? "readonly" : "readwrite");
    const store = transaction.objectStore("device");
    const request = action === "get" ? store.get("secret") : action === "put" ? store.put(value, "secret") : store.delete("secret");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
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
    throw new Error(message);
  }
  return response.status === 204 ? null : response.json();
}

const apiPath = path => path.split("/").map(encodeURIComponent).join("/");

async function getJsonFile(path, ref = MAIN) {
  const value = await github(`/contents/${apiPath(path)}?ref=${encodeURIComponent(ref)}`);
  return JSON.parse(b64ToText(value.content));
}

async function putFile(path, bytes, message, branch = MAIN) {
  return github(`/contents/${apiPath(path)}`, {method:"PUT", body:JSON.stringify({message, branch, content:bytesToB64(bytes)})});
}

async function putJson(path, value, message, branch = MAIN) {
  return putFile(path, encoder.encode(JSON.stringify(value, null, 2) + "\n"), message, branch);
}

async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2,"0")).join("");
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

function renderExercises(dateText) {
  const container = $("#exercise-fields");
  const plan = plannedFor(dateText);
  const status=$("#daily-form [name=session_status]");
  if (plan.session === "Rest" && !status.value) status.value="rest";
  if (plan.session !== "Rest" && status.value === "rest") status.value="";
  if (!plan.exercises.length) { container.innerHTML = `<p class="hint">${esc(plan.session === "Rest" ? "Rest day" : "No approved training block covers this date.")}</p>`; return; }
  container.innerHTML = plan.exercises.map((exercise, index) => `
    <div class="exercise-row" data-index="${index}" data-plan-name="${esc(exercise.name)}" data-target="${esc(`${exercise.sets}x${exercise.reps}`)}" data-unit="${esc(exercise.unit || "lb")}">
      <label class="exercise-name">${esc(exercise.name)}<small>${exercise.sets} × ${esc(exercise.reps)} · one working load</small><input class="actual-name" aria-label="Actual exercise name, if substituted" placeholder="Substitution, if any"></label>
      <label>Load<input class="load" type="number" min="0" step="0.5" inputmode="decimal"></label>
      ${[1,2,3,4].map(set => `<label>S${set}<input class="set" type="number" min="0" step="1" inputmode="numeric"></label>`).join("")}
      <label>RIR<input class="rir" type="number" min="0" max="10" step="1" inputmode="numeric"></label>
    </div>`).join("");
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
  await putJson(`queue/submissions/${item.id}.json`, item, `web: submit ${item.id}`);
  if (item.supersedes) correctionOf = "";
  setStatus(form, "Sent. GitHub is preparing your readback.");
  form.reset();
  const dateInput=$("input[name=date]", form);
  if(dateInput)dateInput.value=chicagoDate();
  await refreshState();
}

async function refreshState() {
  try {
    ledgerState = await getJsonFile("derived/web.json");
    $("#mode-pill").textContent = ledgerState.mode;
    renderToday(); renderReview(); renderHistory();
  } catch (error) {
    if (!String(error.message).includes("404")) throw error;
    ledgerState = {mode:"staging", pending_count:0, readbacks:[], outcomes:[], history:[]};
    renderToday(); renderReview(); renderHistory();
  }
}

function renderToday() {
  const brief = ledgerState?.brief;
  const target = $("#today-content");
  if (!brief) { target.innerHTML = `<article class="card"><p class="muted">The first private summary has not been published yet.</p></article>`; return; }
  $("#today-date").textContent = `${brief.date} · ${brief.week}`;
  const train = brief.train || {};
  const standing = brief.standing || {};
  target.innerHTML = `
    <article class="card wide"><p class="kicker">Train</p><p class="hero-line">${esc(train.session || "Rest")}${train.time ? ` · ${esc(train.time)}` : ""}</p>
      <ul class="clean-list">${(train.exercises || []).map(item => `<li><span><strong>${esc(item.name)}</strong><small>${esc(item.target)} · ${esc(item.basis)}</small></span><code>${item.load == null ? "establish" : `${esc(item.load)} ${esc(item.unit)}`}</code></li>`).join("") || "<li>Rest day</li>"}</ul></article>
    <article class="card"><p class="kicker">Standing</p><div class="stats"><div class="stat"><span>7-day avg</span><strong>${esc(standing.weight_avg_7d_kg ?? "—")} kg</strong></div><div class="stat"><span>14-day trend</span><strong>${esc(standing.trend_kg_per_week ?? "—")}</strong></div><div class="stat"><span>Sessions</span><strong>${esc(standing.sessions_done_this_week ?? 0)}/${esc(standing.sessions_planned_this_week ?? 0)}</strong></div><div class="stat"><span>Pending</span><strong>${esc(ledgerState.pending_count || 0)}</strong></div></div></article>
    <article class="card"><p class="kicker">Needs you</p><ul class="clean-list">${(brief.needs_you || []).map(item => `<li><span><strong>${esc(item.kind)}</strong><small>${esc(item.what)}</small></span></li>`).join("") || "<li>Nothing flagged.</li>"}</ul></article>`;
}

async function renderReview() {
  $("#pending-count").textContent = ledgerState?.pending_count || 0;
  const list = $("#review-list");
  const pending = (ledgerState?.readbacks || []).filter(item => !(ledgerState.outcomes || []).some(outcome => outcome.id === item.id));
  if (!pending.length) {
    const waiting=ledgerState?.awaiting_agent_count || 0;
    const urgent=(ledgerState?.evidence || []).filter(item=>item.status==="urgent" || item.status==="warning").length;
    list.innerHTML = `<article class="card"><p class="muted">${waiting ? `${esc(waiting)} upload${waiting===1?" is":"s are"} safely queued for the nightly agent.${urgent ? ` ${esc(urgent)} evidence item${urgent===1?" is":"s are"} close to expiry.` : ""}` : "Nothing is waiting for confirmation."}</p></article>`;
    return;
  }
  list.innerHTML = pending.map(item => `<article class="card review-card" data-readback-path="${esc(item.path)}" data-id="${esc(item.id)}" data-kind="${esc(item.kind)}" data-target="${esc(item.date || item.week)}" data-hash="${esc(item.readback_sha256)}"><header><div><p class="kicker">${esc(item.date || item.week)}</p><h3>${esc(item.kind)} entry</h3></div><span class="state">${esc(item.state)}</span></header><div class="readback"><p class="muted">Open review to load the complete field-by-field readback.</p></div><div class="review-actions"><button class="correct" type="button">Open review</button></div></article>`).join("");
}

async function openReadback(card) {
  const readback = await getJsonFile(card.dataset.readbackPath);
  const rows = readback.fields.map(row => `<div class="readback-row"><strong>${esc(row.field)}</strong><code class="${row.status === "unread" ? "unread" : ""}">${row.status === "unread" ? "UNREAD" : esc(JSON.stringify(row.value))}</code><span class="source">${esc(row.source || "—")}</span></div>`).join("");
  const notices = [...(readback.warnings || []), ...(readback.errors || [])].map(item => `<p class="status error">${esc(item)}</p>`).join("");
  $(".readback", card).innerHTML = rows + notices;
  $(".review-actions", card).innerHTML = readback.state === "ready" ? `<button class="confirm" type="button">Confirm readback</button><button class="correct" type="button">Correct</button>` : `<button class="correct" type="button">Correct</button>`;
}

function renderHistory() {
  const list = $("#history-list");
  const outcomes = ledgerState?.outcomes || [];
  const days = ledgerState?.history || [];
  list.innerHTML = `<article class="card"><p class="kicker">Outcomes</p><ul class="clean-list">${outcomes.map(item => `<li><span><strong>${esc(item.date || item.week || item.id)}</strong><small>${esc(item.kind)}</small></span><code>${esc(item.state)}</code></li>`).join("") || "<li>No web outcomes yet.</li>"}</ul></article><article class="card"><p class="kicker">Recent days</p><ul class="clean-list">${days.map(item => `<li><span><strong>${esc(item.date)}</strong><small>${esc(item.planned_session)}</small></span><code>${item.confirmed ? "confirmed" : "unconfirmed"}</code></li>`).join("") || "<li>No days yet.</li>"}</ul></article>`;
}

function showView(name) {
  $$(".view").forEach(view => view.classList.toggle("active", view.id === name));
  $$(".nav-item").forEach(button => {
    const active = button.dataset.view === name;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  window.scrollTo({top:0, behavior:"smooth"});
}

function showEntryTab(name) {
  $$('[data-entry-tab]').forEach(item => {
    const active = item.dataset.entryTab === name;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", String(active));
  });
  for (const candidate of ["daily","weekly","text"]) $(`#${candidate}-form`).hidden = candidate !== name;
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

async function unlock(value) {
  token = value;
  if (!(await connectionTest())) throw new Error("The token cannot access the expected private repository.");
  blockConfig = await getJsonFile("config/block.json");
  $("#locked").hidden = true; $("#app").hidden = false;
  renderExercises($("#daily-form [name=date]").value);
  resetLockTimer();
  await refreshState();
}

function lock() {
  token = ""; ledgerState = null; blockConfig = null;
  clearTimeout(lockTimer);
  $("#app").hidden = true; $("#locked").hidden = false;
  $("#today-content").innerHTML = ""; $("#review-list").innerHTML = ""; $("#history-list").innerHTML = "";
  $("#unlock-form").hidden = false; $("#setup-form").hidden = true;
  $("#unlock-form input").value = ""; $("#gate-status").textContent = "";
}

function resetLockTimer() {
  if (!token) return;
  clearTimeout(lockTimer);
  lockTimer = setTimeout(lock, LOCK_AFTER_MS);
}

async function initializeGate() {
  const saved = await db("get");
  $("#unlock-form").hidden = !saved;
  $("#setup-form").hidden = Boolean(saved);
  $("#gate-copy").textContent = saved ? "Unlock this device to see or record anything." : "Connect this device once. Your GitHub token will be encrypted locally.";
}

$("#setup-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget, data = new FormData(form), passphrase = data.get("passphrase");
  if (passphrase !== data.get("repeat")) { $("#gate-status").textContent = "Passphrases do not match."; return; }
  try {
    $("#gate-status").textContent = "Checking GitHub and encrypting…";
    token = data.get("token").trim();
    if (!(await connectionTest())) throw new Error("Use a token limited to the private GYM repository.");
    await db("put", await encryptToken(token, passphrase));
    await unlock(token);
  } catch (error) { token = ""; $("#gate-status").textContent = error.message; }
});

$("#unlock-form").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    $("#gate-status").textContent = "Unlocking…";
    const saved = await db("get");
    await unlock(await decryptToken(saved, new FormData(event.currentTarget).get("passphrase")));
  } catch (_) { token = ""; $("#gate-status").textContent = "That passphrase did not unlock this device, or GitHub access has expired."; }
});

$("#daily-form").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const form=event.currentTarget, date=new FormData(form).get("date"), payload=dailyPayload(form);
    if(!Object.keys(payload).length)throw new Error("Enter at least one observed value.");
    if(["done","partial"].includes(payload.session?.status) && !payload.session.exercises?.length)throw new Error("A done or partial session needs at least one exercise with recorded sets.");
    await submitMain(makeSubmission("manual", {date}, payload), form); renderExercises(chicagoDate());
  }
  catch (error) { setStatus(event.currentTarget, error.message, true); }
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

$("#upload-form").addEventListener("submit", async event => {
  event.preventDefault(); const form=event.currentTarget,data=new FormData(form),files=[...data.getAll("files")];
  try {
    if (files.reduce((sum,file)=>sum+file.size,0) > 20*1024*1024) throw new Error("Keep one upload under 20 MB.");
    setStatus(form,"Creating a private upload…");
    const id=crypto.randomUUID(), branch=`upload-${id}`, ref=await github(`/git/ref/heads/${MAIN}`);
    await github("/git/refs",{method:"POST",body:JSON.stringify({ref:`refs/heads/${branch}`,sha:ref.object.sha})});
    const metadata=[];
    for (let index=0; index<files.length; index++) {
      const file=files[index], bytes=new Uint8Array(await file.arrayBuffer()), safeName=file.name.replace(/[^A-Za-z0-9._-]+/g,"_");
      const path=`queue/uploads/${id}/files/${String(index+1).padStart(2,"0")}-${safeName}`;
      await putFile(path,bytes,`web: upload ${id} file ${index+1}`,branch);
      metadata.push({name:file.name,mime:file.type||"application/octet-stream",source:data.get("source"),size:file.size,sha256:await sha256(bytes),path});
    }
    const isBand=data.get("source")==="mi-fitness";
    const target=isBand?{week:data.get("week")}:{date:data.get("date")};
    const manifest={schema:1,interface:"web_submission_v1",id,kind:isBand?"band":"upload",...target,created_at:chicagoTimestamp(),timezone:"America/Chicago",files:metadata};
    if (correctionOf) manifest.supersedes=correctionOf;
    await putJson(`queue/uploads/${id}/manifest.json`,manifest,`web: complete upload ${id}`,branch);
    if (manifest.supersedes) correctionOf="";
    setStatus(form,"Uploaded. The next nightly agent run will prepare the readback."); form.reset();
  } catch (error) { setStatus(form,`${error.message} Any completed private upload branch was kept so evidence is not lost.`,true); }
});

$("#review-list").addEventListener("click", async event => {
  const card=event.target.closest(".review-card"); if (!card) return;
  try {
    if (event.target.matches(".confirm")) {
      event.target.disabled=true; event.target.textContent="Confirming…";
      const marker={schema:1,interface:"web_confirmation_v1",id:card.dataset.id,readback_sha256:card.dataset.hash,confirmed_at:chicagoTimestamp(),client_id:localStorage.getItem("gym-client-id")};
      await putJson(`queue/confirmations/${marker.id}-${marker.readback_sha256.slice(0,16)}.json`,marker,`web: confirm ${marker.id}`);
      event.target.textContent="Confirmation sent · processing";
    } else if (event.target.matches(".correct") && $(".readback-row",card)) {
      correctionOf=card.dataset.id;
      const target=card.dataset.target, kind=card.dataset.kind;
      if (kind === "weekly") {
        showView("entry"); showEntryTab("weekly"); $("#weekly-form [name=week]").value=target;
      } else if (kind === "band" || kind === "upload") {
        showView("upload");
        $("#upload-form [name=source]").value=kind === "band" ? "mi-fitness" : "fitnotes";
        $("#upload-form [name=source]").dispatchEvent(new Event("change"));
        const targetInput=$(kind === "band" ? "#upload-form [name=week]" : "#upload-form [name=date]");
        targetInput.value=target;
      } else {
        showView("entry"); showEntryTab("daily"); $("#daily-form [name=date]").value=target; renderExercises(target);
      }
    } else { await openReadback(card); }
  } catch (error) { $(".readback",card).innerHTML=`<p class="status error">${esc(error.message)}</p>`; }
});

$$('[data-entry-tab]').forEach(button => button.addEventListener("click", () => showEntryTab(button.dataset.entryTab)));
$$('[data-view]').forEach(button=>button.addEventListener("click",()=>showView(button.dataset.view)));
$("#daily-form [name=date]").addEventListener("change",event=>renderExercises(event.target.value));
$("#upload-form [name=source]").addEventListener("change",event=>{
  const band=event.target.value==="mi-fitness";
  $("#upload-date-field").hidden=band; $("#upload-week-field").hidden=!band;
  $("#upload-form [name=date]").required=!band; $("#upload-form [name=week]").required=band;
});
$("#refresh-button").addEventListener("click",()=>refreshState().catch(error=>alert(error.message)));
$("#review-refresh").addEventListener("click",()=>refreshState().catch(error=>alert(error.message)));
$("#lock-button").addEventListener("click",lock);
$("#connection-test").addEventListener("click",async()=>{try{$("#settings-status").textContent=(await connectionTest())?"Private connection is working.":"Unexpected repository."}catch(error){$("#settings-status").textContent=error.message}});
$("#clear-device").addEventListener("click",async()=>{if(confirm("Remove the encrypted GitHub token from this device?")){await db("delete");lock();await initializeGate()}});
$("#theme-toggle").addEventListener("click",()=>{const next=document.documentElement.dataset.theme==="dark"?"light":"dark";document.documentElement.dataset.theme=next;localStorage.setItem("gym-theme",next)});
window.addEventListener("online",setNetworkState); window.addEventListener("offline",setNetworkState);
for (const eventName of ["pointerdown","keydown","touchstart"]) document.addEventListener(eventName,resetLockTimer,{passive:true});

const savedTheme=localStorage.getItem("gym-theme");
if(savedTheme)document.documentElement.dataset.theme=savedTheme;
setNetworkState(); showView("today"); showEntryTab("daily");
if(!localStorage.getItem("gym-client-id"))localStorage.setItem("gym-client-id",crypto.randomUUID());
const today=chicagoDate();
for(const input of $$("input[type=date]"))input.value=today;
$("#weekly-form [name=week]").value=isoWeek(today);
$("#upload-form [name=week]").value=isoWeek(today);
initializeGate().catch(error=>{$("#gate-status").textContent=error.message});
