import { createCipheriv, createDecipheriv, randomBytes } from "crypto"

export const PREFIX = "v1."

const IV_LENGTH = 12
const TAG_LENGTH = 16

export type Key = Uint8Array

export function isSealed(value: string) {
  return value.startsWith(PREFIX)
}

export function seal(key: Key, aad: string, plaintext: string) {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(aad, "utf8"))
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  // iv | tag | ciphertext packed into one opaque base64 blob
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")
}

export function open(key: Key, aad: string, value: string) {
  const blob = Buffer.from(value.slice(PREFIX.length), "base64")
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, IV_LENGTH))
  decipher.setAAD(Buffer.from(aad, "utf8"))
  decipher.setAuthTag(blob.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH))
  return Buffer.concat([decipher.update(blob.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]).toString("utf8")
}
