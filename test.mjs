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
