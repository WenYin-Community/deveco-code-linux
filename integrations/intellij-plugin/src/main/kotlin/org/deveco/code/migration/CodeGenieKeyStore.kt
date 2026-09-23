package org.deveco.code.migration

import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.Arrays
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * Replicates the old CodeGenie plugin's local key derivation, reverse-engineered
 * from `codegenie-infrastructure` / `hwlib` bytecode and verified end-to-end
 * against real user data (see requirements §3.1.2):
 *
 *  material/fd/{0,1,2}   3 × 16B components
 *  ⊕ COMPONENT constant  compile-time 16B salt baked into KeyManager
 *  → UTF-8 chars         ByteUtil.bytes2chars = String(bytes, UTF_8).toCharArray()
 *  → PBKDF2WithHmacSHA256(10000 iters, 128-bit) with material/ac (16B plaintext salt)
 *  → rootKey
 *  → AES-GCM-128 decrypt of material/ce (48B, layout: BE32 cipher len + IV + cipher+tag)
 *  → final 16B data key, used to decrypt Model_Management.db `mcp_config.info`
 *
 * Everything lives on the user's machine — no server secret involved.
 */
object CodeGenieKeyStore {

    class KeyMaterialException(message: String, cause: Throwable? = null) : Exception(message, cause)

    /** Compile-time COMPONENT from KeyManager's static initializer. */
    private val COMPONENT = hex("31f30973d6af5bb8d3beb1586583c077")

    /** Derives the data key from a `material/` directory. */
    fun deriveDataKey(materialDir: Path): ByteArray {
        val fd0 = readSingleComponent(materialDir.resolve("fd").resolve("0"))
        val fd1 = readSingleComponent(materialDir.resolve("fd").resolve("1"))
        val fd2 = readSingleComponent(materialDir.resolve("fd").resolve("2"))
        // Roles pinned from bytecode: readSalt -> index 1 = "ac" (plaintext),
        // readWorkMaterial -> index 2 = "ce" (encrypted work material).
        val salt = readSingleComponent(materialDir.resolve("ac"))
        val workEncrypted = readSingleComponent(materialDir.resolve("ce"))

        // getFullComponents: fd list + COMPONENT, then pairwise XOR.
        val xor = ByteArray(fd0.size)
        for (i in xor.indices) {
            xor[i] = (fd0[i].toInt() xor fd1[i].toInt() xor fd2[i].toInt() xor COMPONENT[i].toInt()).toByte()
        }
        // ByteUtil.bytes2chars is a UTF-8 string decode — NOT byte->char.
        val password = String(xor, Charsets.UTF_8).toCharArray()

        val rootKey = try {
            val spec = PBEKeySpec(password, salt, 10_000, 128)
            try {
                SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
            } finally {
                spec.clearPassword() // S1: key hygiene
                java.util.Arrays.fill(password, '\u0000')
            }
        } catch (e: Exception) {
            throw KeyMaterialException("Failed to derive root key", e)
        }
        val dataKey = gcmDecrypt(rootKey, workEncrypted)
        java.util.Arrays.fill(rootKey, 0) // S1: zero intermediate keys
        return dataKey
    }

    // ---------- AesGcmKit layout (self-evidenced by encrypt bytecode) ----------

    /**
     * Layout: `4B big-endian (cipher+tag length) + IV + cipher+tag`.
     * `data` must be >= 32 bytes; tag is the trailing 16 bytes of the cipher block.
     */
    fun gcmDecrypt(key: ByteArray, data: ByteArray): ByteArray {
        if (data.size < 32) throw KeyMaterialException("Illegal data: ${data.size} bytes")
        val cipherLen = ((data[0].toInt() and 0xFF) shl 24) or
            ((data[1].toInt() and 0xFF) shl 16) or
            ((data[2].toInt() and 0xFF) shl 8) or
            (data[3].toInt() and 0xFF)
        val ivLen = data.size - 4 - cipherLen
        if (cipherLen <= 16 || ivLen <= 0) throw KeyMaterialException("Illegal data layout")
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                SecretKeySpec(key, "AES"),
                GCMParameterSpec(128, data, 4, ivLen),
            )
            cipher.doFinal(data, 4 + ivLen, cipherLen)
        } catch (e: Exception) {
            throw KeyMaterialException("AES-GCM decrypt failed", e)
        }
    }

    /** `info` column is stored as hex text. */
    fun decryptInfo(dataKey: ByteArray, infoHex: String): ByteArray = gcmDecrypt(dataKey, hex(infoHex))

    // ---------- material directory helpers ----------

    /**
     * Each component dir contains exactly one payload file. Dotfiles (.DS_Store
     * etc.) are ignored — Finder browsing pollutes these dirs on macOS and a
     * strict count would make the whole key silently unreadable (review D4).
     */
    private fun readSingleComponent(dir: Path): ByteArray {
        if (!Files.isDirectory(dir)) {
            throw KeyMaterialException("Key material directory missing: $dir")
        }
        val files = Files.list(dir).use { stream ->
            stream.filter { f ->
                Files.isRegularFile(f) && !f.fileName.toString().startsWith(".")
            }.toList()
        }
        if (files.size != 1) {
            throw KeyMaterialException(
                "Key material directory must contain exactly one file: $dir (found ${files.size})",
            )
        }
        return Files.readAllBytes(files[0])
    }

    private fun hex(value: String): ByteArray {
        val clean = value.replace(" ", "").replace("\n", "")
        val out = ByteArray(clean.length / 2)
        for (i in out.indices) {
            val hi = Character.digit(clean[i * 2], 16)
            val lo = Character.digit(clean[i * 2 + 1], 16)
            // Fail loudly on non-hex input (review P3): Character.digit
            // returns -1, which silently became 0xFF bytes and surfaced as a
            // misleading "layout" error downstream instead of the real cause.
            if (hi < 0 || lo < 0) {
                val end = minOf(i * 2 + 2, clean.length)
                throw KeyMaterialException("Invalid hex data at offset ${i * 2}: '${clean.substring(i * 2, end)}'")
            }
            out[i] = ((hi shl 4) or lo).toByte()
        }
        return out
    }
}
