import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {webcrypto} from "node:crypto";

Object.defineProperty(globalThis, "crypto", {value:webcrypto});
const {bytesToB64, encryptToken, decryptToken} = await import("./crypto.js");

const saved = await encryptToken("test-token-value", "a-long-test-passphrase");
assert.equal(saved.iterations, 600000);
assert.equal(await decryptToken(saved, "a-long-test-passphrase"), "test-token-value");
await assert.rejects(() => decryptToken(saved, "wrong-passphrase"));
const large = new Uint8Array(200000).map((_, index) => index % 251);
assert.equal(Buffer.from(bytesToB64(large), "base64").length, large.length);

const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
const app = await readFile(new URL("./app.js", import.meta.url), "utf8");
assert.match(html, /noindex,nofollow/);
assert.match(html, /connect-src https:\/\/api\.github\.com/);
assert.doesNotMatch(html, /https:\/\/(?!api\.github\.com)/);
assert.match(app, /LOCK_AFTER_MS = 30 \* 60 \* 1000/);
assert.match(app, /queue\/submissions/);
assert.match(app, /queue\/confirmations/);
assert.match(app, /readback_sha256\.slice\(0,16\)/);
assert.match(app, /setAttribute\("aria-current", "page"\)/);

console.log("webapp assertions passed");

// ---------------------------------------------------------------- regressions
const {
  isFramed, assertTopLevel, applyFrameGuard, clearCredentialFields,
  clearSensitiveInputs, pathAllowed, assertPathAllowed, FRAME_ATTRIBUTE,
} = await import("./guard.js");
const {pendingReadbacks, TERMINAL_OUTCOME_STATES} = await import("./queue.js");
const {CONFIG} = await import("./config.js");

// --- finding 3: the app must refuse to run inside a frame -------------------
function fakeDocument() {
  const attributes = new Map();
  const root = {
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name),
    getAttribute: name => (attributes.has(name) ? attributes.get(name) : null),
  };
  return {documentElement: root, attributes};
}

const topLevel = {document: fakeDocument(), location: "https://gym.example/"};
topLevel.self = topLevel; topLevel.top = topLevel;
assert.equal(isFramed(topLevel), false);
assert.equal(applyFrameGuard(topLevel), true);
assert.equal(topLevel.document.attributes.get(FRAME_ATTRIBUTE), "ok");
assert.doesNotThrow(() => assertTopLevel(topLevel));

const parent = {location: "https://evil.example/"};
const framed = {document: fakeDocument(), location: "https://gym.example/", top: parent};
framed.self = framed;
assert.equal(isFramed(framed), true);
assert.equal(applyFrameGuard(framed), false);
// The document is never marked safe to paint, and the app breaks out of the frame.
assert.equal(framed.document.attributes.has(FRAME_ATTRIBUTE), false);
assert.equal(parent.location, framed.location);
assert.throws(() => assertTopLevel(framed), /refuses to run inside a frame/);

// A cross-origin parent throws on access; that must be treated as framed, not safe.
const opaque = {document: fakeDocument(), location: "https://gym.example/"};
opaque.self = opaque;
Object.defineProperty(opaque, "top", {get() { throw new Error("cross-origin"); }});
assert.equal(isFramed(opaque), true);
assert.equal(applyFrameGuard(opaque), false);

// styles.css must keep a framed document from painting at all.
const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
assert.match(css, /html:not\(\[data-frame-check="ok"\]\)\s*\{\s*visibility:\s*hidden/);
assert.match(html, /<script type="module" src="guard\.js"><\/script>/);
// Setup, unlock, review and confirmation each refuse when framed.
assert.equal((app.match(/assertTopLevel\(\)/g) || []).length >= 5, true);

// --- finding 4: no credential may survive in the DOM -----------------------
function fakeInput(value) { return {value, reset: false}; }
const setupInputs = [fakeInput("github_pat_secret"), fakeInput("passphrase"), fakeInput("passphrase")];
clearSensitiveInputs(setupInputs);
assert.deepEqual(setupInputs.map(input => input.value), ["", "", ""]);

const credentialDoc = {
  inputs: [fakeInput("github_pat_secret"), fakeInput("a-long-passphrase"), fakeInput("a-long-passphrase")],
  resets: [],
  querySelectorAll() { return this.inputs; },
  getElementById(id) { const doc = this; return {reset() { doc.resets.push(id); }}; },
};
clearCredentialFields(credentialDoc);
assert.deepEqual(credentialDoc.inputs.map(input => input.value), ["", "", ""]);
assert.deepEqual(credentialDoc.resets.sort(), ["setup-form", "unlock-form"]);
// Clearing happens after setup (success and failure), after unlock, on lock and on gate init.
assert.equal((app.match(/clearCredentialFields\(document\)/g) || []).length >= 5, true);
assert.match(app, /\}\n  finally \{ clearCredentialFields\(document\); \}\n\}\);/);
// The old single-field clear must be gone.
assert.doesNotMatch(app, /\$\("#unlock-form input"\)\.value = ""/);
// Values are blanked even when reset\(\) does nothing, which is the case for hidden forms.
const resetlessDoc = {
  inputs: [fakeInput("github_pat_secret"), fakeInput("pass")],
  querySelectorAll() { return this.inputs; },
  getElementById() { return null; },
};
clearCredentialFields(resetlessDoc);
assert.deepEqual(resetlessDoc.inputs.map(input => input.value), ["", ""]);

// --- finding 1: the browser credential may only touch the inbox ------------
assert.deepEqual(CONFIG.writePrefixes, ["queue/confirmations/", "queue/drafts/", "queue/evidence/", "queue/meals/", "queue/submissions/"]);
for (const prefix of CONFIG.writePrefixes) assert.equal(prefix.startsWith("queue/"), true);
assert.equal(pathAllowed("queue/submissions/abc.json", CONFIG.writePrefixes), true);
assert.equal(pathAllowed("queue/confirmations/abc.json", CONFIG.writePrefixes), true);
assert.equal(pathAllowed("queue/drafts/daily-2026-09-07.json", CONFIG.writePrefixes), true);
assert.equal(pathAllowed("queue/drafts/daily-2026-09-07.json", CONFIG.readPrefixes), true);
assert.equal(pathAllowed("queue/meals/snack-typical.json", CONFIG.writePrefixes), true);
assert.equal(pathAllowed("queue/meals/snack-typical.json", CONFIG.readPrefixes), true);
assert.equal(pathAllowed("queue/evidence/2026-09-07-abc.jpg", CONFIG.writePrefixes), true);
assert.equal(pathAllowed("config/meal-choices.json", CONFIG.readPrefixes), true);
assert.equal(CONFIG.mealChoicesPath, "config/meal-choices.json");
for (const forbidden of [
  "data/days/2026-09-01.json", "derived/web.json", "config/web.json", "gym.py",
  ".github/workflows/web-finalize.yml", "queue/uploads/x/manifest.json",
  "/queue/submissions/a.json", "queue/submissions/../../data/days/x.json",
]) {
  assert.equal(pathAllowed(forbidden, CONFIG.writePrefixes), false, forbidden);
}
assert.equal(pathAllowed("derived/web.json", CONFIG.readPrefixes), true);
assert.equal(pathAllowed("queue/readbacks/abc.json", CONFIG.readPrefixes), true);
assert.equal(pathAllowed("data/days/2026-09-01.json", CONFIG.readPrefixes), false);
assert.throws(() => assertPathAllowed("data/days/x.json", CONFIG.writePrefixes, "write"), /may not write/);
// Every repository write in the app goes through the allowlisted helper.
assert.match(app, /async function putFile\(path, bytes, message, branch = MAIN\) \{\n  assertPathAllowed\(path, WRITE_PREFIXES, "write"\);/);
assert.match(app, /async function getJsonFile\(path, ref = MAIN\) \{\n  assertPathAllowed\(path, READ_PREFIXES, "read"\);/);
assert.doesNotMatch(app, /"gym-ledger-private"/);

// --- finding 6: a fresh readback after a stale refusal stays visible -------
const staleState = {
  terminal_outcome_states: TERMINAL_OUTCOME_STATES,
  readbacks: [
    {id: "retry", state: "ready", resolved: false},
    {id: "done", state: "ready", resolved: true},
  ],
  outcomes: [
    {id: "retry", state: "stale-readback-refusal"},
    {id: "done", state: "confirmed"},
  ],
};
assert.deepEqual(pendingReadbacks(staleState).map(item => item.id), ["retry"]);
// validation-failed is retryable too.
assert.deepEqual(
  pendingReadbacks({readbacks: [{id: "a", resolved: false}], outcomes: [{id: "a", state: "validation-failed"}]}).map(item => item.id),
  ["a"],
);
// Older state files without `resolved` fall back to the shared terminal-state list.
const legacy = {readbacks: [{id: "a"}, {id: "b"}], outcomes: [{id: "a", state: "stale-readback-refusal"}, {id: "b", state: "confirmed"}]};
assert.deepEqual(pendingReadbacks(legacy).map(item => item.id), ["a"]);

// --- photo evidence: the Contents API, never a branch ---------------------
// The branch transport is what was unsafe. Deleting an `upload-*` branch does not
// delete its objects, so the app's 30-day deletion promise could not be kept. Photos
// now PUT straight to queue/evidence/ and no retention is promised at all.
assert.equal(CONFIG.uploadsEnabled, true);
assert.match(app, /queue\/evidence\//);
assert.match(html, /id="photo-input"/);
// The branch scheme stays dead, and so does the artifact the app used to promise.
assert.doesNotMatch(app, /queue\/uploads/);
assert.doesNotMatch(app, /git\/refs/);
assert.doesNotMatch(app, /refs\/heads\//);
assert.doesNotMatch(html, /id="upload-form"/);
assert.doesNotMatch(html, /data-view="upload"/);
assert.doesNotMatch(html, /private 30-day GitHub artifact/);
// ...and the app no longer promises a nightly agent that was never built.
assert.doesNotMatch(app, /nightly agent/);
// A photo is evidence, never a value: it must not enter the submission payload.
assert.doesNotMatch(app, /payload\.(photos|evidence)/);
// The form has to say the part that cannot be undone.
assert.match(html, /cannot be deleted/);

// --- confirmations write; no staging controls or misleading counters ------
assert.equal("mode" in CONFIG, false);
assert.equal("cutover_date" in CONFIG, false);
assert.doesNotMatch(html, /mode-pill|mode-banner|staging/i);
assert.doesNotMatch(app, /applyMode|CONFIG\.mode|ledgerState\??\.mode|cutover_date|staging|they read zero/i);
assert.doesNotMatch(css, /mode-pill|mode-banner|staging/i);
assert.match(css, /\.banner\{/); // The offline outbox still uses the shared notice style.
assert.deepEqual(TERMINAL_OUTCOME_STATES, ["confirmed", "re-upload-required"]);

// --- a confirmation says what is unread before it is given -----------------
assert.match(app, /field\$\{unread === 1 \? "" : "s"\} unread/);

// --- errors are not all reported as a wrong passphrase ---------------------
assert.match(app, /function unlockFailureMessage/);
assert.match(app, /error\.status = response\.status/);
// The dead 404 check is gone: GitHub says "Not Found", never "404".
assert.doesNotMatch(app, /includes\("404"\)/);
assert.match(app, /error\.status !== 404/);

// --- cardio without minutes is refused, never silently dropped -------------
assert.match(app, /Cardio needs its minutes/);

// --- a correction cannot follow you onto another entry ---------------------
assert.match(app, /function clearCorrection/);
for (const caller of [/function showView\(name\) \{\n  clearCorrection\(\);/,
                      /function showEntryTab\(name, moveFocus = false\) \{\n  clearCorrection\(\);/]) {
  assert.match(app, caller);
}
assert.match(app, /\$\("#weekly-form \[name=week\]"\)\.addEventListener\("change",clearCorrection\)/);

// --- accessibility --------------------------------------------------------
// Real tab semantics: every tab points at a panel, and every panel exists.
const tabs = [...html.matchAll(/role="tab"[^>]*aria-controls="([^"]+)"/g)].map(match => match[1]);
assert.deepEqual(tabs, ["daily-form", "weekly-form"]);
for (const panel of tabs) assert.match(html, new RegExp(`id="${panel}"[^>]*role="tabpanel"`));
assert.match(app, /event\.key in keys/);           // arrow-key movement
assert.match(app, /heading\.focus\(\{preventScroll:true\}\)/);  // focus follows the view
assert.match(app, /prefersReducedMotion\(\) \? "auto" : "smooth"/);
assert.match(app, /visibilityState==="hidden"&&token\)lock\(\)/);  // lock when backgrounded
// Tap targets reach the 44px floor.
assert.match(css, /\.segment,\.nav-item,\.quiet\{[^}]*min-height:44px/);
assert.match(css, /\.nav-item\{[^}]*min-height:48px/);
// Contrast: --muted must clear 4.5:1 on the page and on the stat tiles.
const contrast = (a, b) => {
  const lum = hex => {
    const parts = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
      .map(value => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
  };
  const [high, low] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};
const cssToken = name => css.match(new RegExp(`--${name}:(#[0-9a-f]{6})`))[1];
for (const background of ["bg", "sage-soft", "paper"]) {
  assert.ok(contrast(cssToken("muted"), cssToken(background)) >= 4.5,
    `--muted on --${background} is ${contrast(cssToken("muted"), cssToken(background)).toFixed(2)}:1`);
}

// --- anti-framing ----------------------------------------------------------
// `frame-ancestors` is ignored in a <meta> CSP, so claiming it in the markup would
// imply a protection that does not exist. GitHub Pages cannot send the header, so the
// document-level guard is the real control and must stay wired to every sensitive path.
assert.doesNotMatch(html, /frame-ancestors/);
assert.match(html, /data-frame-check|guard\.js/);
for (const guarded of [/assertTopLevel\(\);\n  const \{value: readback, bytes\} = await getJsonFile/,
                       /if \(event\.target\.matches\("\.confirm"\)\) \{\n      assertTopLevel\(\);/]) {
  assert.match(app, guarded);
}
// --- the browser chrome follows the viewer's theme -------------------------
assert.match(html, /theme-color" content="#101612" media="\(prefers-color-scheme: dark\)"/);

// --- task 1: the app installs, opens without signal, and never loses an entry ---
const manifestText = await readFile(new URL("./manifest.webmanifest", import.meta.url), "utf8");
const manifest = JSON.parse(manifestText);
assert.equal(manifest.start_url, ".");
assert.equal(manifest.scope, ".");
assert.equal(manifest.display, "standalone");
// The install colours must match the light theme the page actually paints.
const lightBg = css.match(/:root\{[^}]*--bg:(#[0-9a-f]{6})/)[1];
assert.equal(manifest.background_color, lightBg);
assert.equal(manifest.theme_color, lightBg);
assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
// Icons are files in this repository, not a CDN, and every one of them exists.
assert.ok(manifest.icons.length >= 2);
for (const icon of manifest.icons) {
  assert.doesNotMatch(icon.src, /^(https?:)?\/\//, icon.src);
  await readFile(new URL("./" + icon.src, import.meta.url));  // throws if it is missing
}
assert.ok(manifest.icons.some(icon => icon.purpose === "maskable"));

const sw = await readFile(new URL("./sw.js", import.meta.url), "utf8");
// The cache is keyed by the contents of the shell, and every other version is dropped on
// activate. Cache-first means a phone serves what it installed until this string changes,
// so a shipped fix with a stale revision would simply never arrive.
assert.match(sw, /const CACHE = `gym-ledger-shell-\$\{SHELL_REVISION\}`;/);
assert.match(sw, /for \(const name of await caches\.keys\(\)\) \{\n      if \(name !== CACHE\) await caches\.delete\(name\);/);
// The precached shell is exactly the app's own files, and each one is really there.
const shell = [...sw.matchAll(/^\s*"(\.\/[^"]*)",$/gm)].map(match => match[1]);
for (const asset of shell) {
  if (asset === "./") continue;
  await readFile(new URL(asset, import.meta.url));
}
// The revision must actually match the files, or the phone keeps the old client.
{
  const {createHash} = await import("node:crypto");
  const digest = createHash("sha256");
  for (const asset of shell) {
    if (asset === "./") continue;
    digest.update(await readFile(new URL(asset, import.meta.url)));
  }
  const revision = digest.digest("hex").slice(0, 16);
  assert.equal(sw.match(/const SHELL_REVISION = "([0-9a-f]+)"/)[1], revision,
    `the app shell changed: set SHELL_REVISION in webapp/sw.js to "${revision}", or installed phones will keep serving the old client`);
}
for (const required of ["./index.html", "./app.js", "./styles.css", "./crypto.js", "./guard.js",
                        "./queue.js", "./config.js", "./manifest.webmanifest"]) {
  assert.ok(shell.includes(required), `${required} is missing from the cached shell`);
}
assert.ok(shell.some(asset => asset.startsWith("./fonts/")));
assert.ok(shell.some(asset => asset.startsWith("./icons/")));
// api.github.com must never be cached: those responses are authenticated and carry body
// weight, waist, sleep and resting heart rate. Cross-origin requests are handed straight
// back to the network before respondWith is ever reached...
const fetchHandler = sw.slice(sw.indexOf('addEventListener("fetch"'));
assert.match(fetchHandler, /if \(url\.origin !== self\.location\.origin\) return;/);
assert.ok(fetchHandler.indexOf("url.origin !== self.location.origin") < fetchHandler.indexOf("respondWith"));
// ...and nothing is ever written to the cache outside the install list.
assert.doesNotMatch(fetchHandler, /cache\.put|caches\.open|cache\.add/);
// GitHub is named only in the comment that explains the rule, never in the code.
const swCode = sw.split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
assert.doesNotMatch(swCode, /api\.github\.com/);
for (const asset of shell) assert.doesNotMatch(asset, /^(https?:)?\/\//);

// The worker is installed only from a top-level window: a framed page must not be able
// to register one for this origin.
assert.match(app, /assertTopLevel\(\);\n  if \("serviceWorker" in navigator\) navigator\.serviceWorker\.register\("sw\.js"\)/);

// --- the version-2 upgrade must not destroy the version-1 token --------------
const {
  upgradeDeviceDb, outboxOrder, isNetworkFailure, isAlreadyDelivered, isAuthFailure,
  newerDraft, shouldPushDraft,
  DB_VERSION, DEVICE_STORE, OUTBOX_STORE, DRAFT_STORE,
} = await import("./queue.js");
assert.equal(DB_VERSION, 3);
const older = {date: "2026-09-06", updated_at: "2026-09-06T20:00:00-05:00", payload: {body: {weight_kg: 89}}};
const newer = {date: "2026-09-06", updated_at: "2026-09-06T22:00:00-05:00", payload: {body: {weight_kg: 90.4}}};
assert.equal(newerDraft(older, newer), newer);
assert.equal(newerDraft(newer, older), newer);
assert.equal(shouldPushDraft(older, newer), false, "stale local must not overwrite remote");
assert.equal(shouldPushDraft(newer, older), true);
assert.equal(shouldPushDraft(newer, newer), false);
assert.equal(shouldPushDraft(newer, null), true);
assert.equal(shouldPushDraft(null, newer), false);
assert.match(app, /if \(draft && remote && draft === remote\) \{\n    try \{ await putLocalDraft\(draft\); \}/);
assert.match(app, /if \(!shouldPushDraft\(draft, remote\)\) continue;/);

function fakeDatabase(existing) {
  const names = new Set(existing);
  const created = [];
  return {
    names, created,
    objectStoreNames: {contains: name => names.has(name)},
    createObjectStore(name, options) { names.add(name); created.push([name, options]); },
  };
}
// A real version-1 database: it already holds the encrypted GitHub token in "device".
const version1 = fakeDatabase([DEVICE_STORE]);
assert.deepEqual(upgradeDeviceDb(version1).sort(), [OUTBOX_STORE, DRAFT_STORE].sort());
assert.deepEqual(version1.created.map(([name]) => name).sort(), [OUTBOX_STORE, DRAFT_STORE].sort());
assert.equal(version1.names.has(DEVICE_STORE), true);
// Running it again changes nothing, so a repeated or interrupted upgrade is harmless.
assert.deepEqual(upgradeDeviceDb(version1), []);
// A fresh install gets every store.
const version0 = fakeDatabase([]);
assert.deepEqual(upgradeDeviceDb(version0).sort(), [DEVICE_STORE, OUTBOX_STORE, DRAFT_STORE].sort());
assert.deepEqual(version0.created.find(([name]) => name === OUTBOX_STORE)[1], {keyPath: "id"});
assert.deepEqual(version0.created.find(([name]) => name === DRAFT_STORE)[1], {keyPath: "date"});
// Nothing anywhere in the upgrade path deletes a store.
const queueSource = await readFile(new URL("./queue.js", import.meta.url), "utf8");
assert.doesNotMatch(queueSource, /deleteObjectStore/);
assert.doesNotMatch(app, /deleteObjectStore/);

// --- what may be queued, and what must surface instead -----------------------
// A transport failure is queued...
assert.equal(isNetworkFailure(new TypeError("Failed to fetch")), true);
// ...and anything GitHub actually answered is a real error that has to be shown.
const withStatus = (status, message = "nope") => Object.assign(new Error(message), {status});
assert.equal(isNetworkFailure(withStatus(422)), false);
assert.equal(isNetworkFailure(withStatus(404)), false);
assert.equal(isNetworkFailure(withStatus(401)), false);
// A plain Error — a refused path, a locked device — is a fault, not a network failure.
assert.equal(isNetworkFailure(new Error("This app may not write data/days/x.json.")), false);
assert.equal(isNetworkFailure(new Error("This device is locked.")), false);

// "already exists" means an earlier attempt landed and only its response was lost.
assert.equal(isAlreadyDelivered(withStatus(422, 'Invalid request.\n\n"sha" wasn\'t supplied.')), true);
assert.equal(isAlreadyDelivered(withStatus(409, "b1946ac9 but expected 0a0a9f2a")), true);
assert.equal(isAlreadyDelivered(withStatus(422, "Validation failed: date is not covered")), false);
assert.equal(isAlreadyDelivered(withStatus(404, "Not Found")), false);
assert.equal(isAuthFailure(withStatus(401)), true);
assert.equal(isAuthFailure(withStatus(403)), true);
assert.equal(isAuthFailure(withStatus(422)), false);

// The queue drains in the order he typed it, so a correction never overtakes the entry
// it corrects.
assert.deepEqual(
  outboxOrder([{id: "c", queued_at: "2026-09-03T08:00:00-05:00"},
               {id: "a", queued_at: "2026-09-01T08:00:00-05:00"},
               {id: "b", queued_at: "2026-09-02T08:00:00-05:00"}]).map(item => item.id),
  ["a", "b", "c"],
);

// --- a queued submission is sealed, not left in the clear --------------------
const {deriveDeviceKey, sealWithKey, openWithKey, sealToken} = await import("./crypto.js");
const device = await sealToken("github_pat_secret", "a-long-test-passphrase");
assert.equal(await decryptToken(device.record, "a-long-test-passphrase"), "github_pat_secret");
const outboxKey = await deriveDeviceKey(device.record, "a-long-test-passphrase");
const sealedEntry = await sealWithKey(outboxKey, JSON.stringify({payload: {body: {weight_kg: 91.4}}}));
// Nothing readable reaches storage: not the field names, not the values.
const rawEntry = Buffer.from(sealedEntry.ciphertext, "base64");
assert.equal(rawEntry.includes(Buffer.from("weight_kg")), false);
assert.equal(rawEntry.includes(Buffer.from("91.4")), false);
assert.equal(JSON.parse(await openWithKey(outboxKey, sealedEntry)).payload.body.weight_kg, 91.4);
// A different passphrase cannot open it.
const wrongKey = await deriveDeviceKey(device.record, "a-different-passphrase");
await assert.rejects(() => openWithKey(wrongKey, sealedEntry));

// --- the queue is wired the way the contract requires ------------------------
// Queued, never "Sent", and never confirmed on his behalf.
assert.match(app, /"Queued on this device — it will send when you have signal\."/);
assert.match(app, /if \(!isNetworkFailure\(error\)\) throw error;\n    \/\/ If this throws, the form is not reset and nothing he typed is lost\.\n    await queueSubmission\(item\);/);
// Draining needs the token, so it can never run while locked.
assert.match(app, /if \(draining \|\| !token \|\| !deviceKey\) return;/);
assert.match(app, /window\.addEventListener\("online",\(\)=>\{setNetworkState\(\); drainOutbox\(\)\.catch\(\(\)=>\{\}\); drainDrafts\(\)/);
assert.match(app, /await refreshState\(\);\n    \/\/ Anything typed without signal goes out now that the token is in hand\.\n    await drainOutbox\(\);\n    await drainDrafts\(\);/);
assert.match(app, /if \(button\.dataset\.view === "entry"\) restoreDailyDraftIfEmpty\(\);/);
assert.match(app, /function resetDailyForm\(date\) \{\n  const form = \$\("#daily-form"\);\n  const dateInput = \$\("input\[name=date\]", form\);\n  form\.reset\(\);/);
// 401/403 stops the drain instead of looping it.
assert.match(app, /if \(isAuthFailure\(error\)\) \{ outboxNote = /);
// The key lives and dies with the token.
assert.match(app, /token = ""; deviceKey = null; ledgerState = null;/);
// Clear this device empties the outbox and the cached plan, not just the token.
assert.match(app, /await db\("delete"\);\n  await deviceValue\("delete", "block"\);\n  await outboxClear\(\);\n  await draftsClear\(\);/);
// ...and says so first, because those entries have not been sent anywhere.
assert.match(app, /unsent entr\$\{queuedCount === 1 \? "y" : "ies"\}/);
// The count is visible on Today and on Review.
assert.match(app, /id="today-queued"/);
assert.match(html, /id="review-queued"/);
assert.match(html, /id="outbox-banner"/);

// --- every submit handler reads its form before the first await -------------
// event.currentTarget is null once the event has finished dispatching, so an async
// handler that reads it after an await gets null. That is how unlock came to throw a
// TypeError on every attempt and report it as "Could not reach GitHub".
assert.match(app, /\$\("#unlock-form"\)\.addEventListener\("submit", async event => \{\n  event\.preventDefault\(\);\n(?:  \/\/[^\n]*\n)*  const passphrase = new FormData\(event\.currentTarget\)\.get\("passphrase"\);/);
assert.match(app, /const key = await deriveDeviceKey\(saved, passphrase\);/);
// The daily form's error path reports through the captured form, not a dead reference.
assert.doesNotMatch(app, /catch \(error\) \{ setStatus\(event\.currentTarget/);
// No handler may touch event.currentTarget after an await: the reads that remain are
// all on the first line of their handler.
for (const handler of app.split('addEventListener("submit"').slice(1)) {
  const body = handler.slice(0, handler.indexOf("\n});"))
    .split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
  const firstAwait = body.indexOf("await ");
  const lastTarget = body.lastIndexOf("event.currentTarget");
  if (firstAwait !== -1 && lastTarget !== -1) {
    assert.ok(lastTarget < firstAwait, `a submit handler reads event.currentTarget after an await:\n${body.slice(0, 400)}`);
  }
}

// --- task 2: the daily form is usable on a phone, and reads the same ---------
const dailyForm = html.slice(html.indexOf('<form id="daily-form"'), html.indexOf("</form>", html.indexOf('<form id="daily-form"')));
const formNames = [...dailyForm.matchAll(/\sname="([^"]+)"/g)].map(match => match[1]);
const payloadFn = app.slice(app.indexOf("function dailyPayload"), app.indexOf("\n}", app.indexOf("return payload;")));
const payloadReads = new Set([...payloadFn.matchAll(/data\.get\("([^"]+)"\)|numberValue\(data,\s*"([^"]+)"/g)]
  .map(match => match[1] || match[2]));

// Every input in the form is one dailyPayload reads...
for (const name of formNames) {
  assert.ok(payloadReads.has(name) || name === "date", `#daily-form has an input dailyPayload never reads: ${name}`);
}
// ...and every field dailyPayload reads still has an input to read it from.
for (const name of payloadReads) {
  assert.ok(formNames.includes(name), `dailyPayload reads ${name} but the form no longer has it`);
}
// Pinned: dailyPayload must produce byte-identical JSON for the same inputs, so not one
// of these names may be renamed, removed or added without changing the record too.
assert.deepEqual([...formNames].sort(), [
  "cardio_min", "cardio_speed", "cardio_type", "carbs_g", "date", "fat_g", "fiber_g",
  "incline_pct", "kcal", "notes", "pain", "pasted_text", "protein_g", "resting_hr",
  "session_minutes", "session_status", "sleep_hours", "steps", "unplanned_eating",
  "water_ml", "weight_kg",
].sort());

// The plan never fills the session status on his behalf: that value rode along with
// nothing entered, and was enough on its own to pass the "at least one observed value"
// guard, so an untouched form on a rest day submitted a rest day.
assert.doesNotMatch(app, /status\.value\s*=\s*"rest"/);
assert.doesNotMatch(app, /\[name=session_status\]"\)\s*;\n\s*if \(plan\.session/);
// The plan is shown instead, on the summary of the section it belongs to.
assert.match(app, /\$\("#session-plan"\)\.textContent = plan\.exercises\.length/);

// Both submit guards are still wired.
assert.match(app, /if\(!Object\.keys\(payload\)\.length\)throw new Error\("Enter at least one observed value\."\)/);
assert.match(app, /\["done","partial"\]\.includes\(payload\.session\?\.status\) && !payload\.session\.exercises\?\.length\)throw new Error\("A done or partial session needs at least one exercise with recorded sets\."\)/);

// The three numbers he logs most days are in front of every disclosure.
const leadFields = dailyForm.slice(0, dailyForm.indexOf("<details"));
for (const name of ["weight_kg", "steps", "kcal"]) {
  assert.match(leadFields, new RegExp(`name="${name}"`), `${name} must be visible before any disclosure`);
}
// Nutrition detail, Cardio and the Session extras are disclosed, natively.
for (const id of ["daily-paste", "daily-photos", "daily-meals", "daily-nutrition", "daily-cardio", "daily-session", "daily-recovery", "daily-notes"]) {
  assert.match(dailyForm, new RegExp(`<details class="disclosure" id="${id}">`));
}
assert.equal((dailyForm.match(/<summary>/g) || []).length, 8);
// Writing the session and photographing it sit together, right above Session itself.
assert.ok(dailyForm.indexOf('id="daily-paste"') < dailyForm.indexOf('id="daily-photos"'));
assert.ok(dailyForm.indexOf('id="daily-photos"') < dailyForm.indexOf('id="daily-session"'));
// The exercise rows live inside the session disclosure.
assert.ok(dailyForm.indexOf('id="daily-session"') < dailyForm.indexOf('id="exercise-fields"'));

// A collapsed section may not hide an entered value: every summary carries a live count.
assert.equal((dailyForm.match(/class="disclosure-count" hidden/g) || []).length, 8);
assert.match(app, /function updateDisclosureCounts\(\)/);
assert.match(app, /for \(const eventName of \["input","change"\]\) \$\("#daily-form"\)\.addEventListener\(eventName, updateDisclosureCounts\)/);
// reset() fires no input event, so the counts are recomputed explicitly after a submit.
assert.match(app, /if\(dateInput\)dateInput\.value=chicagoDate\(\);\n  if \(form\.id === "daily-form"\) \{ chosenMealIds = \[\]; renderMealChips\(\); \}\n  \/\/ reset\(\) fires no input event[^\n]*\n  updateDisclosureCounts\(\);/);
// openDisclosure only ever opens, so a section holding a value is never shut on him.
assert.match(app, /function openDisclosure\(details, wanted\) \{\n  if \(details && \(wanted \|\| countEntered\(details\)\)\) details\.open = true;\n\}/);
// The cardio type ships with a default, which must not read as an entered value.
assert.match(app, /return field\.value !== "" && field\.value !== field\.defaultValue;/);

// What the last pass established stays: 44px targets, unit hints, tablist semantics.
assert.match(css, /\.disclosure>summary\{[^}]*min-height:44px/);
for (const hint of ["<small>kg</small>", "<small>kcal</small>", "<small>g</small>", "<small>bpm</small>", "<small>hours</small>", "<small>%</small>", "<small>mph</small>", "<small>ml</small>", "<small>minutes</small>"]) {
  assert.ok(dailyForm.includes(hint), `the unit hint ${hint} is gone`);
}
assert.match(dailyForm, /role="tabpanel" aria-labelledby="tab-daily"/);
// Only the date is required, so no required field can be trapped inside a shut section.
assert.equal((dailyForm.match(/\srequired/g) || []).length, 1);
assert.match(leadFields, /<input name="date" type="date" required>/);

// --- task 3: the bytes he read are the bytes he confirmed --------------------
// getJsonFile keeps the raw decoded bytes beside the parsed value...
assert.match(app, /const bytes = b64ToBytes\(String\(file\.content\)\.replace\(\/\\s\/g, ""\)\);\n  return \{value: JSON\.parse\(decoder\.decode\(bytes\)\), bytes\};/);
// ...and openReadback hashes exactly those bytes, not a re-serialisation of the object.
assert.match(app, /const \{value: readback, bytes\} = await getJsonFile\(card\.dataset\.readbackPath\);/);
assert.match(app, /card\.dataset\.renderedHash = await sha256Hex\(bytes\);/);
assert.match(app, /crypto\.subtle\.digest\("SHA-256", bytes\)/);
// Re-serialising in JavaScript cannot reproduce gym.py's bytes — Python writes 20.0 and
// JSON.stringify writes 20 — so the client must never try.
assert.doesNotMatch(app, /JSON\.stringify\(readback/);
// The marker carries it, and only when there is one to carry, so an older client still
// finalizes.
assert.match(app, /if \(card\.dataset\.renderedHash\) marker\.rendered_sha256 = card\.dataset\.renderedHash;/);
assert.match(app, /readback_sha256:card\.dataset\.hash/);   // unchanged meaning

assert.match(html, /id="save-draft"/);
assert.doesNotMatch(html, /id="text-form"|id="tab-text"/);
assert.match(app, /async function upsertJson/);
assert.match(app, /queue\/drafts\/daily-/);
assert.match(app, /class="sets"/);
assert.match(app, /function fmtNum/);
// The flashcard deck is the landing page. Four cards, and the agent's prose is one of
// them — the Lookback card was renamed, not dropped, so match the field it reads.
assert.match(app, /brief\.lookback\?\.body/);
assert.match(app, /brief\.review\?\.body/);
for (const card of ["doNextCard", "standingCard", "adherenceCard", "verdictCard"]) {
  assert.match(app, new RegExp(`function ${card}\\(`));
}
assert.match(app, /class="deck"/);
// Paging is native scroll-snap; a carousel dependency would be the app's only one.
assert.match(css, /scroll-snap-type:x mandatory/);
assert.match(css, /\.deck-card\{scroll-snap-align:center/);
// Needs you moved off Today and onto Review, where the awaiting-you count already is.
assert.ok(app.indexOf('function renderToday') < app.indexOf('needsCard'));
assert.match(app, /const needsCard = /);
assert.doesNotMatch(app.slice(app.indexOf("function renderToday"), app.indexOf("async function renderReview")), /needs_you/);
// A rate needs its sign and unit, and a raw float must never reach a tile.
assert.match(app, /kg\/wk/);
assert.match(app, /fmtNum\(Math\.abs\(trend\), 2\)/);
assert.match(app, /fmtNum\(standing\.weight_avg_7d_kg, 2\)/);
assert.match(css, /@media\(max-width:760px\)\{\.dashboard-grid\{grid-template-columns:1fr\}/);
assert.match(html, /id="meal-chips"/);
assert.match(html, /id="add-meal"/);
assert.match(app, /chosen_meals/);
assert.match(app, /function applyMealDelta/);
assert.match(app, /queue\/meals\//);
assert.match(app, /\$\("#add-meal"\)\.addEventListener/);
assert.doesNotMatch(app, /nutrition\.json/);
assert.doesNotMatch(html, />550</);

// gym.py accepts the field, and checks it when it is there.
const gym = await readFile(new URL("../gym.py", import.meta.url), "utf8");
assert.match(gym, /check_keys\(confirmation, "confirmation", required \| \{"rendered_sha256"\}, required, errors\)/);
assert.match(gym, /rendered != hashlib\.sha256\(record_bytes\(readback\)\)\.hexdigest\(\)/);
assert.match(gym, /confirmation\.rendered_sha256: the readback on screen was not the one on main/);
// It stays optional: it is not added to the required set.
assert.match(gym, /required = \{"schema", "interface", "id", "readback_sha256", "confirmed_at", "client_id"\}/);

console.log("webapp offline-queue assertions passed");

console.log("webapp regression assertions passed");
