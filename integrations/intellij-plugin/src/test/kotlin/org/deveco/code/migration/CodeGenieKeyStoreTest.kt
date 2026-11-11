package org.deveco.code.migration

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * Unit tests for [CodeGenieKeyStore]: end-to-end data-key derivation against a
 * synthetic `material/` directory built with the same layout the old CodeGenie
 * plugin wrote (fd/{0,1,2} XOR COMPONENT -> UTF-8 chars -> PBKDF2 -> AES-GCM
 * ce), plus the layout/hex failure modes of [CodeGenieKeyStore.gcmDecrypt].
 */
class CodeGenieKeyStoreTest {

    @get:Rule
    val tmp = TemporaryFolder()

    /** Fixed 16-byte ASCII password; fd components are 16B, so is the XOR. */
    private val password = "test-password-16"

    private fun component(): ByteArray = hexBytes("31f30973d6af5bb8d3beb1586583c077")

    private fun rootKeyFor(salt: ByteArray): ByteArray {
        val spec = PBEKeySpec(password.toCharArray(), salt, 10_000, 128)
        try {
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        } finally {
            spec.clearPassword()
        }
    }

    /** Builds a material/ directory whose derived data key is exactly [dataKey]. */
    private fun buildMaterialDir(dir: Path, salt: ByteArray, dataKey: ByteArray) {
        val passwordBytes = password.toByteArray(StandardCharsets.UTF_8)
        val fd0 = ByteArray(passwordBytes.size) { (passwordBytes[it].toInt() xor component()[it].toInt()).toByte() }
        writeComponent(dir.resolve("fd").resolve("0"), fd0)
        writeComponent(dir.resolve("fd").resolve("1"), ByteArray(16))
        writeComponent(dir.resolve("fd").resolve("2"), ByteArray(16))
        writeComponent(dir.resolve("ac"), salt)
        writeComponent(dir.resolve("ce"), gcmEncrypt(rootKeyFor(salt), dataKey))
    }

    private fun writeComponent(dir: Path, payload: ByteArray) {
        Files.createDirectories(dir)
        Files.write(dir.resolve("payload"), payload)
    }

    /** Same layout as AesGcmKit: BE32(cipher+tag len) + IV + cipher+tag. */
    private fun gcmEncrypt(
        key: ByteArray,
        plaintext: ByteArray,
        iv: ByteArray = ByteArray(12) { (it + 1).toByte() },
    ): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        val encrypted = cipher.doFinal(plaintext)
        val out = ByteArray(4 + iv.size + encrypted.size)
        out[0] = ((encrypted.size shr 24) and 0xFF).toByte()
        out[1] = ((encrypted.size shr 16) and 0xFF).toByte()
        out[2] = ((encrypted.size shr 8) and 0xFF).toByte()
        out[3] = (encrypted.size and 0xFF).toByte()
        iv.copyInto(out, 4)
        encrypted.copyInto(out, 4 + iv.size)
        return out
    }

    private fun hexBytes(value: String): ByteArray {
        val out = ByteArray(value.length / 2)
        for (i in out.indices) {
            out[i] = ((Character.digit(value[i * 2], 16) shl 4) or Character.digit(value[i * 2 + 1], 16)).toByte()
        }
        return out
    }

    private fun toHex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    @Test
    fun deriveDataKeyRoundTripsSyntheticMaterial() {
        val material = tmp.root.toPath().resolve("material")
        val salt = ByteArray(16) { it.toByte() }
        val expectedKey = ByteArray(16) { (it * 7).toByte() }
        buildMaterialDir(material, salt, expectedKey)

        val derived = CodeGenieKeyStore.deriveDataKey(material)

        assertArrayEquals(expectedKey, derived)
    }

    @Test
    fun deriveDataKeyFailsWhenMaterialDirectoryMissing() {
        val error = assertThrows(CodeGenieKeyStore.KeyMaterialException::class.java) {
            CodeGenieKeyStore.deriveDataKey(tmp.root.toPath().resolve("absent"))
        }

        assertTrue(error.message!!.contains("Key material directory missing"))
    }

    @Test
    fun deriveDataKeyFailsWhenComponentDirectoryHasExtraFiles() {
        val material = tmp.root.toPath().resolve("material")
        buildMaterialDir(material, ByteArray(16), ByteArray(16))
        Files.write(material.resolve("fd").resolve("0").resolve("second-file"), byteArrayOf(1))

        val error = assertThrows(CodeGenieKeyStore.KeyMaterialException::class.java) {
            CodeGenieKeyStore.deriveDataKey(material)
        }

        assertTrue(error.message!!.contains("exactly one file"))
    }

    @Test
    fun deriveDataKeyIgnoresDotFilesInComponentDirectories() {
        val material = tmp.root.toPath().resolve("material")
        buildMaterialDir(material, ByteArray(16) { 1 }, ByteArray(16) { 2 })
        // Finder-style pollution must not make the key unreadable (review D4).
        Files.write(material.resolve("fd").resolve("0").resolve(".DS_Store"), byteArrayOf(9))

        assertArrayEquals(ByteArray(16) { 2 }, CodeGenieKeyStore.deriveDataKey(material))
    }

    @Test
    fun deriveDataKeyFailsOnTamperedWorkMaterial() {
        val material = tmp.root.toPath().resolve("material")
        val salt = ByteArray(16) { 3 }
        buildMaterialDir(material, salt, ByteArray(16) { 5 })
        val ce = Files.readAllBytes(material.resolve("ce").resolve("payload"))
        ce[ce.size - 1] = (ce[ce.size - 1].toInt() xor 0x01).toByte()
        Files.write(material.resolve("ce").resolve("payload"), ce)

        val error = assertThrows(CodeGenieKeyStore.KeyMaterialException::class.java) {
            CodeGenieKeyStore.deriveDataKey(material)
        }

        assertEquals("AES-GCM decrypt failed", error.message)
    }

    @Test
    fun gcmDecryptRejectsDataShorterThanMinimum() {
        val error = assertThrows(CodeGenieKeyStore.KeyMaterialException::class.java) {
            CodeGenieKeyStore.gcmDecrypt(ByteArray(16), ByteArray(31))
        }

        assertTrue(error.message!!.contains("Illegal data: 31 bytes"))
    }

    @Test
    fun gcmDecryptRejectsIllegalLayout() {
        // All-zero layout: cipher length 0 fails the > 16B sanity check.
        val error = assertThrows(CodeGenieKeyStore.KeyMaterialException::class.java) {
            CodeGenieKeyStore.gcmDecrypt(ByteArray(16), ByteArray(48))
        }

        assertEquals("Illegal data layout", error.message)
    }

    @Test
    fun decryptInfoRoundTripsHexEncryptedPayload() {
        val dataKey = ByteArray(16) { (it + 3).toByte() }
        val plaintext = """{"command":"npx"}""".toByteArray(StandardCharsets.UTF_8)

        val decrypted = CodeGenieKeyStore.decryptInfo(dataKey, toHex(gcmEncrypt(dataKey, plaintext)))

        assertEquals(String(plaintext, StandardCharsets.UTF_8), String(decrypted, StandardCharsets.UTF_8))
    }

    @Test
    fun decryptInfoFailsLoudlyOnInvalidHex() {
        val error = assertThrows(CodeGenieKeyStore.KeyMaterialException::class.java) {
            CodeGenieKeyStore.decryptInfo(ByteArray(16), "zz-not-hex")
        }

        assertTrue(error.message!!.contains("Invalid hex data"))
    }
}
