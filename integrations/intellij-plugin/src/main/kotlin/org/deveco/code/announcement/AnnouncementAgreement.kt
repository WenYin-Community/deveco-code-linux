package org.deveco.code.announcement

import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.project.Project
import java.nio.file.Files
import java.nio.file.Path

internal enum class AnnouncementAgreement {
    ACCEPTED,
    NOT_SIGNED,
    REVIEW_REQUIRED,
    UNAVAILABLE,
}

internal class StudioAnnouncementAgreement(private val file: Path) {
    private val host by lazy {
        runCatching {
            val plugin =
                checkNotNull(PluginManagerCore.getPlugin(PluginId.getId("com.huawei.deveco.intelligent-assistant")))
            checkNotNull(plugin.pluginClassLoader).loadClass("org.deveco.code.login.PrivacyUtil")
        }.mapCatching(::StudioAgreementApi)
            .onFailure { log.warn("DevEco Studio's agreement status API is unavailable", it) }
            .getOrNull()
    }

    fun status(project: Project): AnnouncementAgreement {
        if (!Files.isRegularFile(file)) return AnnouncementAgreement.NOT_SIGNED
        val api = host ?: return AnnouncementAgreement.UNAVAILABLE
        if (!hasAcceptedProductAgreement(file, api.version)) return AnnouncementAgreement.NOT_SIGNED
        val status = runCatching { api.status(project) }.getOrDefault(AnnouncementAgreement.UNAVAILABLE)
        return if (hasAcceptedProductAgreement(file, api.version)) status else AnnouncementAgreement.NOT_SIGNED
    }

    private class StudioAgreementApi(type: Class<*>) {
        // The public Studio entry point can submit a signature. Use only its
        // read-side query and the same IDs and version as the host writer.
        private val query = type.getDeclaredMethod(
            "queryAgreementFromRemoteStatus",
            Project::class.java,
            String::class.java,
        ).apply { isAccessible = true }
        private val userId = type.getDeclaredMethod("getUserId").apply { isAccessible = true }
        private val privacyId = constant(type, "PRIVACY_ID")
        private val termsId = constant(type, "TERMS_ID")
        val version = constant(type, "PRODUCT_AGREEMENT_VERSION")

        fun status(project: Project): AnnouncementAgreement {
            val account = userId.invoke(null) as? String
            if (account.isNullOrBlank()) return AnnouncementAgreement.NOT_SIGNED
            for (id in listOf(privacyId, termsId)) {
                when ((query.invoke(null, project, id) as? Enum<*>)?.name) {
                    "SIGNED" -> Unit
                    "NOT_SIGNED" -> return AnnouncementAgreement.REVIEW_REQUIRED
                    else -> return AnnouncementAgreement.UNAVAILABLE
                }
            }
            return if (account ==
                userId.invoke(null)
            ) {
                AnnouncementAgreement.ACCEPTED
            } else {
                AnnouncementAgreement.UNAVAILABLE
            }
        }

        private fun constant(type: Class<*>, name: String): String =
            type.getDeclaredField(name).apply { isAccessible = true }.get(null) as String
    }

    companion object {
        private val log = logger<StudioAnnouncementAgreement>()
    }
}

internal fun hasAcceptedProductAgreement(file: Path, version: String): Boolean = runCatching {
    JsonParser.parseString(Files.readString(file)).asJsonObject.get("version") == JsonPrimitive(version)
}.getOrDefault(false)
