package org.deveco.code.skill

import java.io.BufferedInputStream
import java.io.IOException
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.FileAlreadyExistsException
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.BasicFileAttributes
import java.util.Locale
import java.util.UUID
import java.util.zip.ZipFile
import kotlin.io.path.pathString

/**
 * Validates and installs a Skill into a DevEco Code `skills/` directory.
 *
 * Ported from DevEcoGenie's `SkillImporter`. DevEco Code loads skills from a
 * `skills/<name>/SKILL.md` layout with YAML frontmatter. A folder or `.zip`
 * archive is validated for a root `SKILL.md` and copied atomically. The
 * destination root is supplied by the caller and is expected to be the
 * DevEco-Code-reported `config/skills` (global) or IDE-isolated project config
 * `skills` directory — that way the installed skill is picked up by the running
 * DevEco Code regardless of the DevEco Studio version's on-disk layout.
 */
internal object SkillInstaller {
    private const val MAX_MARKDOWN_BYTES = 1024 * 1024
    private const val MAX_ARCHIVE_BYTES = 100L * 1024 * 1024
    private const val MAX_ARCHIVE_ENTRIES = 2048
    private val SAFE_NAME = Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
    private val FRONTMATTER_FIELD = Regex("^([A-Za-z][A-Za-z0-9_-]*)\\s*:\\s*(.*)$")

    data class ImportedSkill(val name: String, val description: String, val location: Path)

    /** Result of validating a source without installing (name/description only). */
    data class SkillPreview(val name: String, val description: String)

    class SkillImportException(message: String) : Exception(message)

    /**
     * Validates [source] (folder or .zip with exactly one SKILL.md whose
     * frontmatter is well-formed) WITHOUT installing. Used at selection time so
     * validation failures surface immediately and the row is only added when
     * the source is valid; the actual install happens later on Apply.
     */
    fun preview(source: Path): SkillPreview {
        if (!Files.exists(source, LinkOption.NOFOLLOW_LINKS)) {
            throw SkillImportException("The selected Skill source does not exist")
        }
        val selected = source.toAbsolutePath().normalize()
        var extraction: Path? = null
        try {
            val metadata: SkillMetadata = when {
                Files.isDirectory(selected, LinkOption.NOFOLLOW_LINKS) -> {
                    val manifests = findSkillManifests(selected)
                    when {
                        manifests.isEmpty() -> throw SkillImportException(
                            "The selected folder does not contain a SKILL.md",
                        )

                        manifests.size > 1 -> throw SkillImportException(
                            "The selected folder must contain exactly one SKILL.md (found ${manifests.size})",
                        )

                        else -> {
                            val manifest = manifests[0]
                            validateTree(manifest.parent)
                            validateManifest(manifest)
                        }
                    }
                }

                isRegularFile(selected) && selected.fileName.toString().lowercase(Locale.ROOT).endsWith(".zip") -> {
                    extraction = Files.createTempDirectory("deveco-skill-preview-")
                    val root = extractArchive(selected, extraction)
                    validateTree(root)
                    validateManifest(root.resolve("SKILL.md"))
                }

                else -> throw SkillImportException("Only a Skill folder or .zip archive can be imported")
            }
            return SkillPreview(metadata.name, metadata.description)
        } finally {
            extraction?.let { deleteTree(it) }
        }
    }

    fun install(source: Path, destinationRoot: Path): ImportedSkill {
        if (!Files.exists(source, LinkOption.NOFOLLOW_LINKS)) {
            throw SkillImportException("The selected Skill source does not exist")
        }
        val selected = source.toAbsolutePath().normalize()
        val metadata: SkillMetadata
        val skillContent: () -> Path // sourceTreeRoot to copy
        var extraction: Path? = null
        try {
            when {
                Files.isDirectory(selected, LinkOption.NOFOLLOW_LINKS) -> {
                    val manifests = findSkillManifests(selected)
                    when {
                        manifests.isEmpty() -> throw SkillImportException(
                            "The selected folder does not contain a SKILL.md",
                        )

                        manifests.size > 1 -> throw SkillImportException(
                            "The selected folder must contain exactly one SKILL.md (found ${manifests.size})",
                        )

                        else -> {
                            val manifest = manifests[0]
                            val skillRoot = manifest.parent
                            metadata = validateManifest(manifest)
                            validateTree(skillRoot)
                            skillContent = { skillRoot }
                        }
                    }
                }

                isRegularFile(selected) && selected.fileName.toString().lowercase(Locale.ROOT).endsWith(".zip") -> {
                    extraction = Files.createTempDirectory("deveco-skill-import-")
                    val root = extractArchive(selected, extraction)
                    metadata = validateManifest(root.resolve("SKILL.md"))
                    validateTree(root)
                    skillContent = { root }
                }

                else -> throw SkillImportException("Only a Skill folder or .zip archive can be imported")
            }

            Files.createDirectories(destinationRoot)
            val destination = destinationRoot.resolve(metadata.name).normalize()
            if (!destination.parent.equals(destinationRoot.toAbsolutePath().normalize())) {
                throw SkillImportException("The Skill name resolves outside the destination directory")
            }
            if (Files.exists(destination, LinkOption.NOFOLLOW_LINKS)) {
                throw FileAlreadyExistsException("A Skill named '${metadata.name}' already exists in this scope")
            }

            val staging = destinationRoot.resolve(".${metadata.name}.import-${UUID.randomUUID()}").normalize()
            try {
                val root = skillContent()
                copyTree(root, staging)
                try {
                    Files.move(staging, destination, StandardCopyOption.ATOMIC_MOVE)
                } catch (_: AtomicMoveNotSupportedException) {
                    Files.move(staging, destination)
                }
            } finally {
                deleteTree(staging)
            }
            return ImportedSkill(metadata.name, metadata.description, destination.resolve("SKILL.md"))
        } finally {
            extraction?.let { deleteTree(it) }
        }
    }

    private data class SkillMetadata(val name: String, val description: String)

    private fun validateManifest(manifest: Path, requireFrontmatter: Boolean = false): SkillMetadata {
        if (!Files.isRegularFile(manifest, LinkOption.NOFOLLOW_LINKS)) {
            throw SkillImportException("The selected Skill must contain SKILL.md at its root")
        }
        val size = Files.size(manifest)
        if (size <= 0 || size > MAX_MARKDOWN_BYTES) {
            throw SkillImportException("SKILL.md must be between 1 byte and 1 MB")
        }
        return parseMetadata(Files.readString(manifest, StandardCharsets.UTF_8))
    }

    /** Recursively collects every `SKILL.md` in [root], rejecting symlinks. */
    private fun findSkillManifests(root: Path): List<Path> {
        val result = mutableListOf<Path>()
        Files.walkFileTree(
            root,
            object : SimpleFileVisitor<Path>() {
                override fun preVisitDirectory(dir: Path, attrs: BasicFileAttributes): FileVisitResult {
                    if (Files.isSymbolicLink(
                            dir,
                        )
                    ) {
                        throw SkillImportException("Skill folders may not contain symbolic links")
                    }
                    return FileVisitResult.CONTINUE
                }

                override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                    if (Files.isSymbolicLink(
                            file,
                        )
                    ) {
                        throw SkillImportException("Skill folders may not contain symbolic links")
                    }
                    if (file.fileName?.pathString == "SKILL.md" && !file.toString().contains("__MACOSX")) {
                        result.add(file)
                    }
                    return FileVisitResult.CONTINUE
                }
            },
        )
        return result
    }

    private fun parseMetadata(text: String): SkillMetadata {
        var t = text
        if (t.startsWith("\uFEFF")) t = t.substring(1)
        val lines = t.replace("\r\n", "\n").replace('\r', '\n').split("\n")
        if (lines.size < 3 || lines[0].trim() != "---") {
            throw SkillImportException("SKILL.md must start with YAML frontmatter delimited by ---")
        }

        var name: String? = null
        var description = ""
        var closing = -1
        for (i in 1 until lines.size) {
            val line = lines[i]
            if (line.trim() == "---" || line.trim() == "...") {
                closing = i
                break
            }
            if (line.isBlank() || line.trimStart().startsWith("#") ||
                (line.isNotEmpty() && Character.isWhitespace(line[0]))
            ) {
                continue
            }
            val field = FRONTMATTER_FIELD.matchEntire(line) ?: continue
            val key = field.groupValues[1]
            val value = scalar(field.groupValues[2])
            if (key == "name") name = value
            if (key == "description") description = value
        }
        if (closing < 0) throw SkillImportException("SKILL.md YAML frontmatter has no closing delimiter")
        if (name.isNullOrBlank()) throw SkillImportException("SKILL.md frontmatter must define a non-empty name")
        if (!SAFE_NAME.matches(name) || name == "." || name == "..") {
            throw SkillImportException(
                "Skill name may only contain letters, numbers, '.', '_' and '-', and must start with a letter or number",
            )
        }
        var hasInstructions = false
        for (i in (closing + 1) until lines.size) {
            if (lines[i].isNotBlank()) {
                hasInstructions = true
                break
            }
        }
        if (!hasInstructions) throw SkillImportException("SKILL.md must contain instructions after its frontmatter")
        return SkillMetadata(name, description.ifBlank { "" })
    }

    private fun scalar(raw: String): String {
        var value = raw.trim()
        if (value.isEmpty()) return ""
        if (value == "|" || value == ">") return ""
        if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
            if (value.length < 2) throw SkillImportException("Invalid YAML scalar in SKILL.md")
            value = value.substring(1, value.length - 1)
        } else {
            val comment = value.indexOf(" #")
            if (comment >= 0) value = value.substring(0, comment).trim()
        }
        return value.replace("\\\"", "\"").replace("\\\\", "\\")
    }

    private fun extractArchive(archive: Path, extraction: Path): Path {
        val manifests = mutableListOf<Path>()
        var total = 0L
        var count = 0
        ZipFile(archive.toFile(), StandardCharsets.UTF_8).use { zip ->
            val entries = zip.entries()
            while (entries.hasMoreElements()) {
                val entry = entries.nextElement()
                if (++count > MAX_ARCHIVE_ENTRIES) throw SkillImportException("The Skill ZIP contains too many files")
                val entryName = entry.name.replace('\\', '/')
                if (entryName.isBlank() || entryName.startsWith("/") || entryName.indexOf('\u0000') >= 0) {
                    throw SkillImportException("The Skill ZIP contains an unsafe path")
                }
                val output = extraction.resolve(entryName).normalize()
                if (!output.startsWith(
                        extraction,
                    )
                ) {
                    throw SkillImportException("The Skill ZIP contains a path outside its root")
                }
                if (entry.isDirectory) {
                    Files.createDirectories(output)
                    continue
                }
                val declared = entry.size
                if (declared > MAX_ARCHIVE_BYTES || (declared >= 0 && total + declared > MAX_ARCHIVE_BYTES)) {
                    throw SkillImportException("The Skill ZIP is larger than 100 MB when extracted")
                }
                Files.createDirectories(output.parent)
                BufferedInputStream(zip.getInputStream(entry)).use { input ->
                    total += copyLimited(input, output, MAX_ARCHIVE_BYTES - total)
                }
                if (output.fileName.pathString == "SKILL.md" && !isMetadataPath(extraction.relativize(output))) {
                    manifests.add(output)
                }
            }
        }
        if (manifests.isEmpty()) throw SkillImportException("The Skill ZIP does not contain SKILL.md")
        if (manifests.size > 1) throw SkillImportException("The Skill ZIP must contain exactly one Skill")
        return manifests[0].parent
    }

    private fun copyLimited(input: InputStream, output: Path, remaining: Long): Long {
        var copied = 0L
        val buffer = ByteArray(8192)
        Files.newOutputStream(output).use { stream ->
            var read = input.read(buffer)
            while (read >= 0) {
                copied += read
                if (copied > remaining) throw SkillImportException("The Skill ZIP is larger than 100 MB when extracted")
                stream.write(buffer, 0, read)
                read = input.read(buffer)
            }
        }
        return copied
    }

    private fun isMetadataPath(path: Path): Boolean = path.nameCount > 0 && path.getName(0).pathString == "__MACOSX"

    private fun validateTree(root: Path) {
        Files.walkFileTree(
            root,
            object : SimpleFileVisitor<Path>() {
                override fun preVisitDirectory(dir: Path, attrs: BasicFileAttributes): FileVisitResult {
                    if (Files.isSymbolicLink(
                            dir,
                        )
                    ) {
                        throw SkillImportException("Skill folders may not contain symbolic links")
                    }
                    return FileVisitResult.CONTINUE
                }

                override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                    if (Files.isSymbolicLink(
                            file,
                        )
                    ) {
                        throw SkillImportException("Skill folders may not contain symbolic links")
                    }
                    if (!attrs.isRegularFile) throw SkillImportException("Skill folders may only contain regular files")
                    return FileVisitResult.CONTINUE
                }
            },
        )
    }

    private fun copyTree(source: Path, destination: Path) {
        Files.walkFileTree(
            source,
            object : SimpleFileVisitor<Path>() {
                override fun preVisitDirectory(dir: Path, attrs: BasicFileAttributes): FileVisitResult {
                    Files.createDirectories(destination.resolve(source.relativize(dir)))
                    return FileVisitResult.CONTINUE
                }

                override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                    Files.copy(file, destination.resolve(source.relativize(file)), StandardCopyOption.COPY_ATTRIBUTES)
                    return FileVisitResult.CONTINUE
                }
            },
        )
    }

    private fun deleteTree(root: Path) {
        if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) return
        Files.walk(root).use { paths ->
            for (path in paths.sorted(Comparator.reverseOrder())) Files.deleteIfExists(path)
        }
    }

    private fun isRegularFile(path: Path): Boolean = Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)
}
