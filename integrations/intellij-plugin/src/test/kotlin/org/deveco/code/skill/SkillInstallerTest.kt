package org.deveco.code.skill

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * Unit tests for [SkillInstaller]: a Skill folder (or .zip) with exactly one
 * root SKILL.md carrying well-formed YAML frontmatter installs atomically
 * into `skills/<name>/`, while every deviation (missing/multiple manifests,
 * missing frontmatter or name, unsafe names, no instructions, wrong source
 * type, duplicate destination) is rejected with the matching exception.
 */
class SkillInstallerTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun skillFolder(
        manifest: String = "---\nname: my-skill\ndescription: \"Test skill\"\n---\n\nDo the thing.\n",
        extraFile: String? = null,
    ): Path {
        val dir = tmp.newFolder("src-${UUID.randomUUID()}").toPath()
        Files.writeString(dir.resolve("SKILL.md"), manifest)
        if (extraFile != null) Files.writeString(dir.resolve("helper.txt"), extraFile)
        return dir
    }

    private fun zipOf(vararg entries: Pair<String, String>): Path {
        val zip = tmp.newFile("arc-${UUID.randomUUID()}.zip").toPath()
        ZipOutputStream(Files.newOutputStream(zip)).use { out ->
            for ((path, content) in entries) {
                out.putNextEntry(ZipEntry(path))
                out.write(content.toByteArray())
                out.closeEntry()
            }
        }
        return zip
    }

    private fun newDestination(): Path = tmp.newFolder("dest-${UUID.randomUUID()}").toPath()

    private fun expectRejected(source: Path, messagePart: String) {
        try {
            SkillInstaller.preview(source)
            fail("Expected SkillImportException containing '$messagePart'")
        } catch (e: SkillInstaller.SkillImportException) {
            assertTrue("message '${e.message}' should contain '$messagePart'", e.message!!.contains(messagePart))
        }
    }

    @Test
    fun testFolderInstallCopiesSkillIntoDestination() {
        val src = skillFolder(extraFile = "helper body")

        val imported = SkillInstaller.install(src, newDestination())

        assertEquals("my-skill", imported.name)
        assertEquals("Test skill", imported.description)
        assertEquals("my-skill", imported.location.parent.fileName.toString())
        assertTrue(Files.isRegularFile(imported.location))
        assertEquals("helper body", Files.readString(imported.location.parent.resolve("helper.txt")))
    }

    @Test
    fun testInstallingTheSameSkillTwiceIsRejected() {
        val src = skillFolder()
        val dest = newDestination()

        SkillInstaller.install(src, dest)

        assertThrows(FileAlreadyExistsException::class.java) { SkillInstaller.install(src, dest) }
    }

    @Test
    fun testFolderWithoutManifestIsRejected() {
        expectRejected(tmp.newFolder("empty-${UUID.randomUUID()}").toPath(), "does not contain a SKILL.md")
    }

    @Test
    fun testFolderWithMultipleManifestsIsRejected() {
        val dir = skillFolder()
        Files.writeString(dir.resolve("nested").also { Files.createDirectories(it) }.resolve("SKILL.md"), "body")

        expectRejected(dir, "exactly one SKILL.md")
    }

    @Test
    fun testManifestWithoutFrontmatterIsRejected() {
        expectRejected(skillFolder(manifest = "Just plain instructions.\n"), "must start with YAML frontmatter")
    }

    @Test
    fun testFrontmatterWithoutNameIsRejected() {
        expectRejected(
            skillFolder(manifest = "---\ndescription: no name\n---\n\nbody\n"),
            "non-empty name",
        )
    }

    @Test
    fun testUnsafeNameIsRejected() {
        expectRejected(
            skillFolder(manifest = "---\nname: ../evil\n---\n\nbody\n"),
            "may only contain",
        )
    }

    @Test
    fun testMissingInstructionsAreRejected() {
        expectRejected(skillFolder(manifest = "---\nname: my-skill\n---\n\n\n"), "must contain instructions")
    }

    @Test
    fun testPlainFileSourceIsRejected() {
        expectRejected(tmp.newFile("plain-${UUID.randomUUID()}.md").toPath(), "Only a Skill folder or .zip archive")
    }

    @Test
    fun testZipInstallExtractsAndInstalls() {
        val zip = zipOf(
            "SKILL.md" to "---\nname: zipped-skill\ndescription: From zip\n---\n\nZipped body.\n",
            "notes.txt" to "extra",
        )

        val imported = SkillInstaller.install(zip, newDestination())

        assertEquals("zipped-skill", imported.name)
        assertEquals("From zip", imported.description)
        assertTrue(Files.isRegularFile(imported.location))
        assertEquals("extra", Files.readString(imported.location.parent.resolve("notes.txt")))
    }

    @Test
    fun testPreviewValidatesWithoutInstalling() {
        val preview = SkillInstaller.preview(skillFolder())

        assertEquals("my-skill", preview.name)
        assertEquals("Test skill", preview.description)
    }

    @Test
    fun testQuotedScalarsAndCommentsAreParsed() {
        val src = skillFolder(
            manifest = "---\nname: \"quoted-skill\"\ndescription: plain value # trailing comment\n---\n\nbody\n",
        )

        val imported = SkillInstaller.install(src, newDestination())

        assertEquals("quoted-skill", imported.name)
        assertEquals("plain value", imported.description)
    }
}
