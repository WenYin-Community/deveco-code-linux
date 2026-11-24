package org.deveco.code.session.configuration

import org.deveco.code.session.model.ModelChoice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionModelSelectionTest {

    private fun model(id: String, name: String = id) = ModelChoice(
        id = id,
        name = name,
        providerId = id.substringBefore('/'),
        modelId = id.substringAfter('/'),
    )

    private val deveco = model("deveco/glm-5.3", "DevEco Code/GLM-5.3")
    private val alibaba = model("alibaba/glm-5.3")
    private val manual = model("manual/local", "Local")

    @Test
    fun `provider filters keep connected and manual models and drop blacklisted ids`() {
        val filtered = filterSessionModels(
            backendModels = listOf(deveco, alibaba, manual),
            connectedProviderIds = setOf("deveco"),
            manualProviderIds = setOf("manual"),
            blacklistedModelIds = setOf("manual/local"),
        )

        assertEquals(listOf(deveco), filtered)
    }

    @Test
    fun `without provider metadata only the blacklist is applied`() {
        val filtered = filterSessionModels(
            backendModels = listOf(deveco, alibaba),
            connectedProviderIds = emptySet(),
            manualProviderIds = emptySet(),
            blacklistedModelIds = setOf(alibaba.id),
        )

        assertEquals(listOf(deveco), filtered)
    }

    @Test
    fun `valid remembered manual pick wins over backend value`() {
        val plan = planModelSelection(
            models = listOf(deveco, alibaba),
            backendModelId = deveco.id,
            rememberedModelId = alibaba.id,
            manuallySelected = true,
            globalModelId = deveco.id,
            globalConfigured = true,
            catalogModelIds = setOf(deveco.id, alibaba.id),
            catalogEverFed = true,
        )

        assertEquals(alibaba.id, plan.selectedModelId)
        assertFalse(plan.correctedInvalidPick)
        assertEquals(ModelBackendWrite(alibaba.id, manualReassert = true), plan.backendWrite)
        assertNull(plan.defaultGlobalModelId)
    }

    @Test
    fun `manual remembered pick does not override a different visible selection`() {
        val plan = planModelSelection(
            models = listOf(deveco, alibaba),
            backendModelId = deveco.id,
            rememberedModelId = alibaba.id,
            manuallySelected = true,
            globalModelId = deveco.id,
            globalConfigured = true,
            catalogModelIds = setOf(deveco.id, alibaba.id),
            catalogEverFed = true,
            currentSelectedModelId = deveco.id,
        )

        assertEquals(deveco.id, plan.selectedModelId)
        assertTrue(plan.correctedInvalidPick)
        assertNull(plan.backendWrite)
    }

    @Test
    fun `missing remembered pick falls back to the backend without a correction`() {
        val plan = planModelSelection(
            models = listOf(deveco, alibaba),
            backendModelId = alibaba.id,
            rememberedModelId = "deleted/model",
            manuallySelected = true,
            globalModelId = "deleted/model",
            globalConfigured = true,
            catalogModelIds = setOf(deveco.id, alibaba.id, "deleted/model"),
            catalogEverFed = true,
        )

        assertEquals(alibaba.id, plan.selectedModelId)
        assertFalse(plan.correctedInvalidPick)
        assertNull(plan.backendWrite)
    }

    @Test
    fun `forgotten manual pick between reloads keeps a different visible selection`() {
        val plan = planModelSelection(
            models = listOf(deveco, alibaba),
            backendModelId = alibaba.id,
            rememberedModelId = null,
            manuallySelected = true,
            globalModelId = deveco.id,
            globalConfigured = true,
            catalogModelIds = setOf(deveco.id, alibaba.id),
            catalogEverFed = true,
            currentSelectedModelId = deveco.id,
        )

        assertEquals(deveco.id, plan.selectedModelId)
        assertTrue(plan.correctedInvalidPick)
        assertEquals(ModelBackendWrite(deveco.id, manualReassert = false), plan.backendWrite)
    }

    @Test
    fun `invalid remembered and backend model is corrected to the available default`() {
        val plan = planModelSelection(
            models = listOf(deveco, alibaba),
            backendModelId = "deleted/backend",
            rememberedModelId = "deleted/remembered",
            manuallySelected = true,
            globalModelId = "deleted/global",
            globalConfigured = true,
            catalogModelIds = setOf(deveco.id, alibaba.id),
            catalogEverFed = true,
        )

        assertEquals(deveco.id, plan.selectedModelId)
        assertTrue(plan.correctedInvalidPick)
        assertTrue(plan.clearGlobalPreference)
        assertEquals(ModelBackendWrite(deveco.id, manualReassert = false), plan.backendWrite)
    }

    @Test
    fun `stale global preference falls back and is cleared only after catalog load`() {
        val stale = planModelSelection(
            models = listOf(deveco),
            backendModelId = deveco.id,
            rememberedModelId = null,
            manuallySelected = false,
            globalModelId = "deleted/model",
            globalConfigured = true,
            catalogModelIds = setOf(deveco.id),
            catalogEverFed = true,
        )
        val coldStart = planModelSelection(
            models = listOf(deveco),
            backendModelId = deveco.id,
            rememberedModelId = null,
            manuallySelected = false,
            globalModelId = "deleted/model",
            globalConfigured = true,
            catalogModelIds = setOf(deveco.id),
            catalogEverFed = false,
        )

        assertTrue(stale.clearGlobalPreference)
        assertFalse(coldStart.clearGlobalPreference)
        assertEquals(deveco.id, stale.selectedModelId)
        assertEquals(deveco.id, coldStart.selectedModelId)
    }

    @Test
    fun `session filtered global preference is not cleared from the full catalog`() {
        val plan = planModelSelection(
            models = listOf(deveco),
            backendModelId = deveco.id,
            rememberedModelId = null,
            manuallySelected = false,
            globalModelId = alibaba.id,
            globalConfigured = true,
            catalogModelIds = setOf(deveco.id, alibaba.id),
            catalogEverFed = true,
        )

        assertFalse(plan.clearGlobalPreference)
        assertEquals(deveco.id, plan.selectedModelId)
        assertNull(plan.backendWrite)
    }

    @Test
    fun `first use promotes the built-in model as the default global preference`() {
        val plan = planModelSelection(
            models = listOf(alibaba, deveco),
            backendModelId = alibaba.id,
            rememberedModelId = null,
            manuallySelected = false,
            globalModelId = null,
            globalConfigured = false,
            catalogModelIds = setOf(alibaba.id, deveco.id),
            catalogEverFed = true,
        )

        assertEquals(deveco.id, plan.defaultGlobalModelId)
        assertEquals(deveco.id, plan.selectedModelId)
        assertEquals(ModelBackendWrite(deveco.id, manualReassert = false), plan.backendWrite)
    }

    @Test
    fun `configured no-global preference keeps the backend default`() {
        val plan = planModelSelection(
            models = listOf(deveco, alibaba),
            backendModelId = alibaba.id,
            rememberedModelId = null,
            manuallySelected = false,
            globalModelId = null,
            globalConfigured = true,
            catalogModelIds = setOf(deveco.id, alibaba.id),
            catalogEverFed = true,
        )

        assertNull(plan.defaultGlobalModelId)
        assertEquals(alibaba.id, plan.selectedModelId)
        assertNull(plan.backendWrite)
    }

    @Test
    fun `valid global preference wins over backend default`() {
        val plan = planModelSelection(
            models = listOf(deveco, alibaba),
            backendModelId = deveco.id,
            rememberedModelId = null,
            manuallySelected = false,
            globalModelId = alibaba.id,
            globalConfigured = true,
            catalogModelIds = setOf(deveco.id, alibaba.id),
            catalogEverFed = true,
        )

        assertEquals(alibaba.id, plan.selectedModelId)
        assertFalse(plan.correctedInvalidPick)
        assertEquals(ModelBackendWrite(alibaba.id, manualReassert = false), plan.backendWrite)
    }

    @Test
    fun `bare global name upgrades when the full catalog is unambiguous`() {
        val plan = planModelSelection(
            models = listOf(alibaba),
            backendModelId = deveco.id,
            rememberedModelId = null,
            manuallySelected = false,
            globalModelId = "glm-5.3",
            globalConfigured = true,
            catalogModelIds = setOf(alibaba.id),
            catalogEverFed = true,
        )

        assertEquals(alibaba.id, plan.selectedModelId)
        assertEquals(alibaba.id, plan.storedPreferenceUpgradeTo)
    }

    @Test
    fun `default model matches only the platform provider and name`() {
        assertTrue(isDefaultModelChoice(model("deveco/glm-5.3", "DevEco Code/GLM-5.3")))
        assertTrue(isDefaultModelChoice(model("deveco/glm-5.3", "DevEco Code\\glm-5.3")))
        assertFalse(isDefaultModelChoice(model("alibaba/glm-5.3", "Alibaba(China)/GLM-5.3")))
        assertFalse(isDefaultModelChoice(model("deveco/glm-5.3-preview", "DevEco Code/GLM-5.3-preview")))
    }

    @Test
    fun `provider filtering is case insensitive on the model provider id`() {
        val upperCaseProvider = ModelChoice(
            id = "DevEco/glm-5.3",
            name = "DevEco Code/GLM-5.3",
            providerId = "DevEco",
            modelId = "glm-5.3",
        )

        assertEquals(
            listOf(upperCaseProvider),
            filterSessionModels(
                backendModels = listOf(upperCaseProvider),
                connectedProviderIds = setOf("deveco"),
                manualProviderIds = emptySet(),
                blacklistedModelIds = emptySet(),
            ),
        )
    }

    @Test
    fun `empty model list selects nothing and plans no backend write`() {
        val plan = planModelSelection(
            models = emptyList(),
            backendModelId = "deveco/glm-5.3",
            rememberedModelId = null,
            manuallySelected = false,
            globalModelId = null,
            globalConfigured = true,
            catalogModelIds = setOf("deveco/glm-5.3"),
            catalogEverFed = true,
        )

        assertNull(plan.selectedModelId)
        assertNull(plan.backendWrite)
        assertNull(plan.defaultGlobalModelId)
    }
}
