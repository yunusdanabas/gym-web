// Client-side safety rails: frame blocking and credential hygiene.
// GitHub Pages cannot send X-Frame-Options, and a <meta> CSP cannot carry
// frame-ancestors, so framing has to be refused from inside the document.

export const FRAME_ERROR = "GYM Ledger refuses to run inside a frame.";
export const FRAME_ATTRIBUTE = "data-frame-check";
export const SENSITIVE_SELECTOR = "#setup-form input";

export function isFramed(view) {
  try {
    return view.top !== view.self;
  } catch (_) {
    // A cross-origin parent throws on access, which is itself proof of framing.
    return true;
  }
}

export function assertTopLevel(view = globalThis) {
  if (isFramed(view)) throw new Error(FRAME_ERROR);
}

// Marks the document as safe to paint. styles.css keeps <html> hidden until this
// attribute is set, so a framed page never renders anything at all.
export function applyFrameGuard(view = globalThis) {
  const root = view.document && view.document.documentElement;
  if (isFramed(view)) {
    if (root) root.removeAttribute(FRAME_ATTRIBUTE);
    try { view.top.location = view.self.location; } catch (_) {}
    return false;
  }
  if (root) root.setAttribute(FRAME_ATTRIBUTE, "ok");
  return true;
}

// Values must be blanked explicitly: form.reset() restores the default attribute
// value, which is not necessarily empty, and hidden inputs keep their value.
export function clearSensitiveInputs(inputs) {
  for (const input of inputs || []) {
    try { input.value = ""; } catch (_) {}
  }
}

export function clearCredentialFields(doc = globalThis.document) {
  if (!doc) return;
  clearSensitiveInputs([...doc.querySelectorAll(SENSITIVE_SELECTOR)]);
  for (const id of ["setup-form"]) {
    const form = doc.getElementById(id);
    if (form && typeof form.reset === "function") form.reset();
  }
  clearSensitiveInputs([...doc.querySelectorAll(SENSITIVE_SELECTOR)]);
}

// A repository path the browser is allowed to touch, checked before any request
// is made. This is defence in depth, not a substitute for a scoped token.
export function pathAllowed(path, prefixes) {
  if (typeof path !== "string" || !path || path.startsWith("/")) return false;
  if (path.split("/").includes("..") || path.includes("\\")) return false;
  return (prefixes || []).some(prefix => prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix);
}

export function assertPathAllowed(path, prefixes, action) {
  if (!pathAllowed(path, prefixes)) throw new Error(`This app may not ${action} ${path}.`);
}

if (typeof window !== "undefined" && typeof window.document !== "undefined") applyFrameGuard(window);
