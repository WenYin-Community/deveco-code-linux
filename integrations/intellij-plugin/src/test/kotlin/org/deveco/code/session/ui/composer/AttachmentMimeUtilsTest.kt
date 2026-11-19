package org.deveco.code.session.ui.composer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the attachment MIME helpers of AttachmentMimeUtils.kt:
 * [isSupportedImageFile] extension matching, [isTextLikeMimeType] text-MIME
 * classification, [detectMimeType] extension mapping, the derived
 * text/chooser extension sets, and the combined [isSupportedTextFile] check.
 *
 * Documented behavior: svg is deliberately NOT a supported image (ImageIO
 * cannot rasterize it), so it is neither thumbnailed nor offered as an image
 * attachment.
 */
class AttachmentMimeUtilsTest {

    // --- isSupportedImageFile ---

    @Test
    fun testImageExtensionsAccepted() {
        for (ext in listOf("png", "jpg", "jpeg", "gif", "webp", "bmp")) {
            assertTrue(ext, isSupportedImageFile("photo.$ext"))
        }
    }

    @Test
    fun testImageExtensionMatchIsCaseInsensitive() {
        assertTrue(isSupportedImageFile("photo.PNG"))
        assertTrue(isSupportedImageFile("photo.JpG"))
    }

    @Test
    fun testSvgIsNotASupportedImage() {
        assertFalse(isSupportedImageFile("logo.svg"))
    }

    @Test
    fun testNonImageExtensionRejected() {
        assertFalse(isSupportedImageFile("archive.zip"))
        assertFalse(isSupportedImageFile("doc.pdf"))
    }

    @Test
    fun testNoOrLeadingDotExtensionRejected() {
        assertFalse(isSupportedImageFile("README"))
        assertFalse(isSupportedImageFile(".gitignore"))
        assertFalse(isSupportedImageFile("archive.tar.png.exe"))
    }

    // --- isTextLikeMimeType ---

    @Test
    fun testBlankMimeIsNotTextLike() {
        assertFalse(isTextLikeMimeType(""))
        assertFalse(isTextLikeMimeType("   "))
    }

    @Test
    fun testTextSlashPrefixIsTextLike() {
        assertTrue(isTextLikeMimeType("text/plain"))
        assertTrue(isTextLikeMimeType("text/x-arkts"))
        assertTrue(isTextLikeMimeType("text/x-anything"))
    }

    @Test
    fun testTextBasedApplicationPrefixes() {
        for (mime in listOf(
            "application/json",
            "application/json5",
            "application/xml",
            "application/xml-dtd",
            "application/javascript",
            "application/typescript",
            "application/sql",
            "application/vnd.dart",
            "application/toml",
        )) {
            assertTrue(mime, isTextLikeMimeType(mime))
        }
    }

    @Test
    fun testYamlIsExactMatchOnly() {
        assertTrue(isTextLikeMimeType("application/yaml"))
        assertFalse(isTextLikeMimeType("application/yamlx"))
        assertFalse(isTextLikeMimeType("application/yaml+json"))
    }

    @Test
    fun testBinaryApplicationMimesAreNotTextLike() {
        for (mime in listOf(
            "application/zip",
            "application/pdf",
            "application/octet-stream",
            "application/msword",
            "image/png",
        )) {
            assertFalse(mime, isTextLikeMimeType(mime))
        }
    }

    // --- detectMimeType ---

    @Test
    fun testKnownExtensionsMapToTheirMime() {
        assertEquals("image/png", detectMimeType("a.png"))
        assertEquals("image/svg+xml", detectMimeType("a.svg"))
        assertEquals("text/x-arkts", detectMimeType("a.ets"))
        assertEquals("application/json5", detectMimeType("a.json5"))
        assertEquals("text/x-kotlin", detectMimeType("a.kts"))
        assertEquals("text/x-c++", detectMimeType("a.hpp"))
        assertEquals("application/javascript", detectMimeType("a.mjs"))
        assertEquals("application/typescript", detectMimeType("a.cts"))
        assertEquals("text/x-objective-cpp", detectMimeType("a.mm"))
        assertEquals("text/markdown", detectMimeType("a.mdx"))
        assertEquals("text/plain", detectMimeType("a.log"))
        assertEquals("text/yaml", detectMimeType("a.yml"))
        assertEquals(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            detectMimeType("a.docx"),
        )
    }

    @Test
    fun testUnknownOrMissingExtensionFallsBackToOctetStream() {
        assertEquals("application/octet-stream", detectMimeType("a.xyzzy"))
        assertEquals("application/octet-stream", detectMimeType("noextension"))
        assertEquals("application/octet-stream", detectMimeType(".gitignore"))
    }

    @Test
    fun testDetectMimeIsCaseInsensitive() {
        assertEquals("image/png", detectMimeType("a.PNG"))
        assertEquals("application/json", detectMimeType("a.Json"))
    }

    @Test
    fun testDetectMimeUsesLastExtension() {
        assertEquals("application/gzip", detectMimeType("archive.tar.gz"))
        assertEquals("text/x-c", detectMimeType("a.cpp.bak.c"))
    }

    // --- isSupportedTextFile ---

    @Test
    fun testCodeAndTextFilesSupported() {
        assertTrue(isSupportedTextFile("MainViewModel.ets"))
        assertTrue(isSupportedTextFile("config.json5"))
        assertTrue(isSupportedTextFile("script.ts"))
        assertTrue(isSupportedTextFile("notes.md"))
    }

    @Test
    fun testImagesAreNotSupportedTextFiles() {
        assertFalse(isSupportedTextFile("photo.png"))
        assertFalse(isSupportedTextFile("logo.svg"))
    }

    @Test
    fun testBinaryFilesAreNotSupportedTextFiles() {
        assertFalse(isSupportedTextFile("archive.zip"))
        assertFalse(isSupportedTextFile("doc.pdf"))
        assertFalse(isSupportedTextFile("unknown.xyzzy"))
    }

    // --- derived extension sets ---

    @Test
    fun testSupportedTextExtensionsContainKeyCodeFormats() {
        for (ext in listOf("ets", "json5", "kt", "ts", "tsx", "md", "yaml", "sql", "sh", "c++")) {
            assertTrue(ext, ext in SUPPORTED_TEXT_EXTENSIONS)
        }
    }

    @Test
    fun testSupportedTextExtensionsExcludeBinaryFormats() {
        for (ext in listOf(
            "pdf", "zip", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "rtf",
            "odt", "ods", "odp", "tar", "gz", "rar", "7z", "png", "jpg", "svg",
        )) {
            assertFalse(ext, ext in SUPPORTED_TEXT_EXTENSIONS)
        }
    }

    @Test
    fun testFileChooserWhitelistAddsOnlyPdf() {
        assertEquals(SUPPORTED_TEXT_EXTENSIONS + setOf("pdf"), SUPPORTED_FILE_CHOOSER_EXTENSIONS)
    }

    @Test
    fun testEveryTextExtensionRoundTripsThroughTextLikeMime() {
        for (ext in SUPPORTED_TEXT_EXTENSIONS) {
            assertTrue(ext, isTextLikeMimeType(detectMimeType("f.$ext")))
        }
    }
}
