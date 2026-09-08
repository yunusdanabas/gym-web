// Pure queue-state helpers shared by the app and its tests.

// Mirrors gym.py TERMINAL_OUTCOME_STATES. derived/web.json carries the authoritative
// copy in `terminal_outcome_states`; this is only the fallback for older state files.
export const TERMINAL_OUTCOME_STATES = ["confirmed", "re-upload-required"];

// A readback is finished only when its submission reached a terminal outcome.
// `stale-readback-refusal` and `validation-failed` are retryable: gym.py prepares a
// fresh readback after a stale refusal and that readback must stay confirmable.
export function pendingReadbacks(state) {
  const readbacks = state?.readbacks || [];
  const terminal = new Set(state?.terminal_outcome_states || TERMINAL_OUTCOME_STATES);
  const outcomes = state?.outcomes || [];
  return readbacks.filter(item => item.resolved === undefined
    ? !outcomes.some(outcome => outcome.id === item.id && terminal.has(outcome.state))
    : item.resolved !== true);
}

// `uploadsAllowed` is gone with the Upload route. The generated config still carries
// `uploadsEnabled: false` as a machine-readable statement that no browser path can write
// evidence; turning it back on means building the route again, deliberately.

// ------------------------------------------------------------------ the outbox
// A submission typed in a basement gym has to survive having no signal. It is sealed
// with the device key and held in IndexedDB until a drain can send it.

export const DB_NAME = "gym-ledger";
export const DB_VERSION = 3;
export const DEVICE_STORE = "device";
export const OUTBOX_STORE = "outbox";
export const DRAFT_STORE = "drafts";

// Additive, and only additive. Version 1 held the encrypted GitHub token under
// "device"; an upgrade that dropped or recreated that store would throw the token away
// and force a re-setup with a freshly issued fine-grained token — which is exactly the
// step this app exists to make rare. So every store is created only if it is absent,
// and nothing is ever deleted here.
export function upgradeDeviceDb(database) {
  const names = database.objectStoreNames;
  const created = [];
  if (!names.contains(DEVICE_STORE)) { database.createObjectStore(DEVICE_STORE); created.push(DEVICE_STORE); }
  if (!names.contains(OUTBOX_STORE)) { database.createObjectStore(OUTBOX_STORE, {keyPath:"id"}); created.push(OUTBOX_STORE); }
  if (!names.contains(DRAFT_STORE)) { database.createObjectStore(DRAFT_STORE, {keyPath:"date"}); created.push(DRAFT_STORE); }
  return created;
}

// Oldest first: the queue is drained in the order he typed it, so a correction that
// followed an entry never overtakes the entry it corrects.
export function outboxOrder(entries) {
  return [...(entries || [])].sort((a, b) =>
    String(a?.queued_at ?? "").localeCompare(String(b?.queued_at ?? "")) || String(a?.id ?? "").localeCompare(String(b?.id ?? "")));
}

// The request never reached GitHub. fetch() rejects with a TypeError when the network
// is unreachable; anything carrying a status is an answer from GitHub and is a real
// error that must surface, not something to queue and forget about.
export function isNetworkFailure(error) {
  if (!error || error.status !== undefined) return false;
  if (error.name === "NetworkError" || error.name === "AbortError") return true;
  // Strictly the transport. A plain Error — a refused repository path, a locked
  // device — is a fault in the app, and queueing it would hide it.
  return error instanceof TypeError;
}

// GitHub's contents API refuses a PUT to a path that already exists unless the caller
// supplies the file's sha. Every queued submission keeps its own uuid, so its path is
// unique to it: if the path is already there, an earlier attempt did land and only its
// response was lost. That is a delivery, not a failure — drop it and stop retrying.
export function isAlreadyDelivered(error) {
  if (!error || (error.status !== 422 && error.status !== 409)) return false;
  return /sha["']?\s+(?:wasn't|was not)\s+supplied|already exists|but expected/i.test(String(error.message || ""));
}

// A rejected or expired token will reject every remaining entry the same way. Stop and
// say so rather than walking the whole queue into the same wall.
export function isAuthFailure(error) {
  return Boolean(error) && (error.status === 401 || error.status === 403);
}

export function newerDraft(left, right) {
  if (!left) return right;
  if (!right) return left;
  return String(left.updated_at || "") >= String(right.updated_at || "") ? left : right;
}

// Push only when this device has a strictly newer updated_at. An older or equal
// local copy must not overwrite the inbox.
export function shouldPushDraft(local, remote) {
  if (!local) return false;
  if (!remote) return true;
  return String(local.updated_at || "") > String(remote.updated_at || "");
}
