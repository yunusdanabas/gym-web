const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const bytesToB64 = bytes => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(binary);
};
const b64ToBytes = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));

async function keyFromPassphrase(passphrase, salt) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({name:"PBKDF2", hash:"SHA-256", salt, iterations:600000}, material, {name:"AES-GCM", length:256}, false, ["encrypt", "decrypt"]);
}

// The key that protects the token also protects the offline outbox, so a queued
// submission is sealed with something already tied to this passphrase and this device.
// It is derived once per unlock — 600,000 iterations is roughly a second on a phone,
// and deriving it twice would be felt.
export async function deriveDeviceKey(saved, passphrase) {
  return keyFromPassphrase(passphrase, b64ToBytes(saved.salt));
}

// The key is non-extractable: it can encrypt and decrypt in this tab and cannot be
// read out of it, and it is dropped on lock like the token.
export async function sealWithKey(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM", iv}, key, encoder.encode(text)));
  return {iv:bytesToB64(iv), ciphertext:bytesToB64(ciphertext)};
}

export async function openWithKey(key, sealed) {
  return decoder.decode(await crypto.subtle.decrypt({name:"AES-GCM", iv:b64ToBytes(sealed.iv)}, key, b64ToBytes(sealed.ciphertext)));
}

// Returns the record to store *and* the derived key, so setup does not pay for the
// derivation twice.
export async function sealToken(value, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await keyFromPassphrase(passphrase, salt);
  const sealed = await sealWithKey(key, value);
  return {key, record:{schema:1, kdf:"PBKDF2-SHA256", iterations:600000, cipher:"AES-256-GCM", salt:bytesToB64(salt), ...sealed}};
}

export async function encryptToken(value, passphrase) {
  return (await sealToken(value, passphrase)).record;
}

export async function decryptToken(saved, passphrase) {
  return openWithKey(await deriveDeviceKey(saved, passphrase), saved);
}
