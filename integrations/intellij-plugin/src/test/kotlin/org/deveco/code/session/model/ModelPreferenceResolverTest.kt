package org.deveco.code.session.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelPreferenceResolverTest {

    private fun choice(id: String, modelId: String = id.substringAfter('/')) =
        ModelChoice(id = id, name = id, providerId = id.substringBefore('/'), modelId = modelId)

    // Session view: both same-name models visible.
    private val bothVisible = listOf(
        choice("alibaba/glm-5.2"),
        choice("alibaba-cn/glm-5.2"),
    )

    // Session view: alibaba-cn filtered out (e.g. blacklisted), alibaba visible.
    private val oneVisible = listOf(choice("alibaba/glm-5.2"))

    // Full catalog: both same-name models exist globally.
    private val bothInCatalog = setOf("alibaba/glm-5.2", "alibaba-cn/glm-5.2")

    @Test
    fun `null and blank stored values resolve to nothing`() {
        assertNull(ModelPreferenceResolver.resolve(null, bothVisible, bothInCatalog).choice)
        assertNull(ModelPreferenceResolver.resolve("  ", bothVisible, bothInCatalog).choice)
        assertNull(ModelPreferenceResolver.resolve("", bothVisible, bothInCatalog).choice)
    }

    @Test
    fun `qualified id matches exactly and never upgrades`() {
        val result = ModelPreferenceResolver.resolve("alibaba-cn/glm-5.2", bothVisible, bothInCatalog)
        assertEquals("alibaba-cn/glm-5.2", result.choice?.id)
        assertNull(result.upgradeTo)
    }

    @Test
    fun `qualified id with no session match resolves to nothing even when same name exists`() {
        val result = ModelPreferenceResolver.resolve("zhipu/glm-5.2", bothVisible, bothInCatalog)
        assertNull(result.choice)
        assertNull(result.upgradeTo)
    }

    @Test
    fun `globally unique bare name upgrades to the qualified id`() {
        val models = listOf(choice("deveco/glm-5.1"), choice("alibaba/qwen-max"))
        val result = ModelPreferenceResolver.resolve("qwen-max", models, setOf("deveco/glm-5.1", "alibaba/qwen-max"))
        assertEquals("alibaba/qwen-max", result.choice?.id)
        assertEquals("alibaba/qwen-max", result.upgradeTo)
    }

    @Test
    fun `globally ambiguous bare name resolves by name but does not upgrade`() {
        val result = ModelPreferenceResolver.resolve("glm-5.2", bothVisible, bothInCatalog)
        assertEquals("alibaba/glm-5.2", result.choice?.id)
        assertNull(result.upgradeTo)
    }

    @Test
    fun `bare name unique in session view but ambiguous in catalog does not upgrade`() {
        // The session only sees alibaba/glm-5.2 (alibaba-cn filtered out), but
        // the full catalog still has both: a permanent pin must not be decided
        // from the transient session view.
        val result = ModelPreferenceResolver.resolve("glm-5.2", oneVisible, bothInCatalog)
        assertEquals("alibaba/glm-5.2", result.choice?.id)
        assertNull(result.upgradeTo)
    }

    @Test
    fun `bare name absent from session view resolves to nothing`() {
        val result = ModelPreferenceResolver.resolve("glm-5.2", emptyList(), bothInCatalog)
        assertNull(result.choice)
        assertNull(result.upgradeTo)
    }

    @Test
    fun `legacy bare value containing slash is indistinguishable from a qualified id`() {
        // Documented inherent ambiguity: exact match wins and pins the
        // provider-prefixed interpretation.
        val models = listOf(choice("anthropic/claude-x"))
        val result = ModelPreferenceResolver.resolve("anthropic/claude-x", models, setOf("anthropic/claude-x"))
        assertEquals("anthropic/claude-x", result.choice?.id)
        assertNull(result.upgradeTo)
    }

    @Test
    fun `model id containing slash matches by full name`() {
        // Openrouter-style aggregate id: provider "openrouter", model "openai/gpt-5".
        val models = listOf(choice("openrouter/openai/gpt-5", modelId = "openai/gpt-5"))
        val result = ModelPreferenceResolver.resolve("openai/gpt-5", models, setOf("openrouter/openai/gpt-5"))
        assertEquals("openrouter/openai/gpt-5", result.choice?.id)
        assertEquals("openrouter/openai/gpt-5", result.upgradeTo)
    }

    @Test
    fun `existsInCatalog matches qualified ids and bare names`() {
        assertTrue(ModelPreferenceResolver.existsInCatalog("alibaba-cn/glm-5.2", bothInCatalog))
        assertTrue(ModelPreferenceResolver.existsInCatalog("glm-5.2", bothInCatalog))
        assertFalse(ModelPreferenceResolver.existsInCatalog("zhipu/glm-5.2", bothInCatalog))
        assertFalse(ModelPreferenceResolver.existsInCatalog("nonexistent", bothInCatalog))
        assertFalse(ModelPreferenceResolver.existsInCatalog(null, bothInCatalog))
        assertFalse(ModelPreferenceResolver.existsInCatalog("  ", bothInCatalog))
    }

    @Test
    fun `existsInCatalog survives slash-containing model ids`() {
        val catalog = setOf("openrouter/openai/gpt-5")
        assertTrue(ModelPreferenceResolver.existsInCatalog("openrouter/openai/gpt-5", catalog))
        assertTrue(ModelPreferenceResolver.existsInCatalog("openai/gpt-5", catalog))
    }
}
