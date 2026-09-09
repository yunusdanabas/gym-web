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

// Created once at setup and stored in IndexedDB. Non-extractable: this tab can
// encrypt and decrypt with it, and it cannot be read out as key bits.
export async function generateDeviceKey() {
  return crypto.subtle.generateKey({name:"AES-GCM", length:256}, false, ["encrypt", "decrypt"]);
}

export async function sealWithKey(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM", iv}, key, encoder.encode(text)));
  return {iv:bytesToB64(iv), ciphertext:bytesToB64(ciphertext)};
}

export async function openWithKey(key, sealed) {
  return decoder.decode(await crypto.subtle.decrypt({name:"AES-GCM", iv:b64ToBytes(sealed.iv)}, key, b64ToBytes(sealed.ciphertext)));
}
