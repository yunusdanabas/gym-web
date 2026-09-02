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

export async function encryptToken(value, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFromPassphrase(passphrase, salt);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM", iv}, key, encoder.encode(value)));
  return {schema:1, kdf:"PBKDF2-SHA256", iterations:600000, cipher:"AES-256-GCM", salt:bytesToB64(salt), iv:bytesToB64(iv), ciphertext:bytesToB64(encrypted)};
}

export async function decryptToken(saved, passphrase) {
  const key = await keyFromPassphrase(passphrase, b64ToBytes(saved.salt));
  const clear = await crypto.subtle.decrypt({name:"AES-GCM", iv:b64ToBytes(saved.iv)}, key, b64ToBytes(saved.ciphertext));
  return decoder.decode(clear);
}
