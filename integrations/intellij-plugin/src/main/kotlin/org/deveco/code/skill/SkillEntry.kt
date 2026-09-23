package org.deveco.code.skill

import java.nio.file.Path

enum class SkillType(val sectionKey: String, val descriptionKey: String) {
    GLOBAL("skill.section.global", "skill.description.global"),
    PROJECT("skill.section.project", "skill.description.project"),
    BUILTIN("skill.section.builtin", "skill.description.builtin"),
}

data class SkillEntry(
    val name: String,
    val skillMdPath: Path,
    val type: SkillType,
    val enabled: Boolean,
    val description: String,
)

enum class ImportOutcome { SUCCESS, WRONG_TYPE, DUPLICATE_NAME, INVALID_CONTENT, IO_ERROR }

data class ImportResult(val outcome: ImportOutcome, val message: String = "")
