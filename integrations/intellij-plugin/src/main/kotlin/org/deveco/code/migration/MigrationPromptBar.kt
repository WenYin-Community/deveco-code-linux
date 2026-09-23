package org.deveco.code.migration

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.deveco.code.acp.AcpClientService
import org.deveco.code.util.devecoStorageRoot
import org.deveco.code.util.hoverable
import org.jetbrains.jewel.ui.component.Text
import java.nio.file.Files

/**
 * Migration prompt bar for the DevEco Code tool window (requirements §5.1,
 * primary and only entry: main panel between Menu and Sessions).
 *
 * Visual spec (user-defined): deep-blue filled card, slightly brighter border,
 * white prompt text, a blue accent "Start Migration" button, plain
 * "Don't remind me" text button, and a close × in the top-right corner.
 *
 * Semantics unchanged: off-thread one-shot detection, marker-formula
 * visibility, three exits, migrating state blocks re-entry, settled
 * completion hides the bar.
 */
@Composable
fun MigrationPromptBar(project: Project) {
    var visible by remember { mutableStateOf(false) }
    /** Click guard while the (modal) confirm dialog is pending (review P3-10).
     *  SEPARATE from [migrating] (user feedback 2026-09-09): while the dialog
     *  is up nothing has started, so the bar keeps its buttons — "迁移中"
     *  only appears after the user confirms. */
    var confirming by remember { mutableStateOf(false) }
    var migrating by remember { mutableStateOf(false) }
    var inventory by remember { mutableStateOf<MigrationInventory?>(null) }

    val service = remember(project) { project.getService(AcpClientService::class.java) }
    val stateStore = remember {
        MigrationStateStore(devecoStorageRoot.resolve("config").resolve("codegenie-migration.json"))
    }

    // One read-only probe per composition (S4: off-thread, fail-soft, no files created).
    // No backend dependency: detection is pure filesystem (the service is only
    // passed for the DetectorFactory's backend-reported paths, which are null
    // when disconnected — the prompt shows immediately regardless).
    LaunchedEffect(Unit) {
        withContext(Dispatchers.IO) {
            runCatching {
                val inv = MigrationDetectorFactory.create(
                    service,
                    devecoStorageRoot.resolve("config"),
                ).detect()
                val key = MigrationDetectorFactory.resolveProjectKey(project)
                if (stateStore.shouldShowPrompt(inv, key)) inventory = inv
            }.onFailure { e ->
                LOG.warn("codegenie migration detection failed", e)
            }
        }
        visible = inventory != null
    }

    // "忽略失败项" in the report dialog marks the stateStore done and emits
    // here — hide the bar immediately instead of waiting for the next
    // tool-window recreation cycle. The event carries the project key so
    // other project windows' prompt bars are unaffected (review ❌2).
    LaunchedEffect(Unit) {
        val myKey = MigrationDetectorFactory.resolveProjectKey(project)
        MigrationEvents.dismissed.collect { dismissedKey ->
            if (dismissedKey == myKey) visible = false
        }
    }

    if (!visible) return

    // Source-version suffix (方案 B): appended to the prompt text when the
    // detected data comes from a different IDE version directory.
    val promptTextSuffix = inventory?.sourceVersion
        ?.let { MyMessageBundle.message("migration.prompt.source", it) }
        .orEmpty()

    Column(
        modifier = Modifier
            .padding(start = 16.dp, end = 16.dp, top = 8.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            // Deep-blue filled card (user spec), slightly brighter border line.
            .background(PromptColors.cardBackground)
            .border(1.dp, PromptColors.cardBorder, RoundedCornerShape(12.dp))
            .padding(start = 12.dp, top = 10.dp, end = 8.dp, bottom = 10.dp),
    ) {
        Box(modifier = Modifier.fillMaxWidth()) {
            Text(
                // Base text + source-version suffix when data comes from a
                // different IDE version (e.g. "(from DevEcoStudio 6.1)" —
                // 方案 B: annotate origin so the user understands why the
                // prompt appeared even though their current IDE's CodeGenie
                // looks clean).
                text = MyMessageBundle.message("migration.prompt.text") +
                    promptTextSuffix,
                fontSize = 12.sp,
                color = Color.White,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.align(Alignment.CenterStart).padding(end = 20.dp),
            )
            if (!migrating) {
                CloseButton(
                    modifier = Modifier.align(Alignment.TopEnd),
                ) { visible = false } // session-only hide, no marker (§5.1)
            }
        }
        Spacer(Modifier.height(8.dp))
        if (migrating) {
            Text(
                text = MyMessageBundle.message("migration.prompt.migrating"),
                fontSize = 12.sp,
                color = PromptColors.migratingText,
                // The 6dp VERTICAL padding matches the buttons' own padding
                // (same 12sp jewel Text → same line height), so the action
                // slot's height is IDENTICAL in both states and the card never
                // shrinks when the buttons swap for this text.
                modifier = Modifier.padding(top = 6.dp, bottom = 6.dp),
            )
        } else {
            Row {
                StartMigrationButton {
                    // Guard set synchronously at click (review P3-10): the
                    // confirm dialog opens later via invokeLater — without
                    // this, a second click in that window stacked a second
                    // dialog and task. Visual state is NOT touched here:
                    // §5.2 requires cancel/close = zero side effects, and the
                    // dialog being open means nothing has started yet.
                    if (confirming || migrating) return@StartMigrationButton
                    confirming = true
                    ApplicationManager.getApplication().invokeLater {
                        // Confirm dialog (§5.2): cancel/close = zero side effects.
                        val confirmed = MigrationConfirmDialog().showAndGet()
                        confirming = false
                        if (!confirmed) return@invokeLater
                        // "迁移中" from here until onFinished — which the v3.5
                        // widget fires WITH the done text no earlier than 1s
                        // after the first progress tick, so the migrating
                        // state dwells >= 1s in lock step with the status-bar
                        // progress phase (user spec 2026-09-09).
                        migrating = true
                        MigrationTask(project, service, stateStore) { report ->
                            ApplicationManager.getApplication().invokeLater {
                                when {
                                    // Aborted run (backend down / lock timeout /
                                    // internal error): back to the idle bar.
                                    report == null -> migrating = false
                                    report.allSettled -> visible = false
                                    else -> migrating = false
                                }
                            }
                        }.runInBackground()
                    }
                }
                Spacer(Modifier.width(10.dp))
                DontRemindButton {
                    visible = false
                    // Persist off the UI thread (review P2-3): the marker
                    // write is file IO under a cross-process lock — never on
                    // the EDT.
                    val key = MigrationDetectorFactory.resolveProjectKey(project)
                    ApplicationManager.getApplication().executeOnPooledThread {
                        stateStore.setSuppression(key)
                    }
                }
            }
        }
    }
}

/** User-specified palette: deep-blue card, brighter border, blue accent action. */
private object PromptColors {
    val cardBackground = Color(0xFF1E3A5F)
    val cardBorder = Color(0xFF3D5A80)
    val accentBlue = Color(0xFF4A9EFF)
    val accentBlueHover = Color(0xFF6BB3FF)
    val plainTextOnCard = Color(0xFFC0CEDE)
    val plainTextOnCardHover = Color.White
    val migratingText = Color(0xFFC0CEDE)
}

@Composable
private fun CloseButton(modifier: Modifier = Modifier, onClick: () -> Unit) {
    var hovered by remember { mutableStateOf(false) }
    Text(
        text = "×",
        fontSize = 15.sp,
        color = if (hovered) Color.White else PromptColors.plainTextOnCard,
        modifier = modifier
            .clip(RoundedCornerShape(4.dp))
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
            ) { onClick() }
            .hoverable { hovered = it }
            .padding(start = 4.dp, end = 2.dp, top = 0.dp, bottom = 0.dp),
    )
}

/** Accent action: blue filled pill with white text (user spec). */
@Composable
private fun StartMigrationButton(onClick: () -> Unit) {
    var hovered by remember { mutableStateOf(false) }
    Text(
        text = MyMessageBundle.message("migration.prompt.start"),
        fontSize = 12.sp,
        color = Color.White,
        fontWeight = FontWeight.Medium,
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(if (hovered) PromptColors.accentBlueHover else PromptColors.accentBlue)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
            ) { onClick() }
            .hoverable { hovered = it }
            .padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 6.dp),
    )
}

/** Plain text button on the deep-blue card. */
@Composable
private fun DontRemindButton(onClick: () -> Unit) {
    var hovered by remember { mutableStateOf(false) }
    Text(
        text = MyMessageBundle.message("migration.prompt.dontRemind"),
        fontSize = 12.sp,
        color = if (hovered) PromptColors.plainTextOnCardHover else PromptColors.plainTextOnCard,
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
            ) { onClick() }
            .hoverable { hovered = it }
            .padding(start = 4.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
    )
}


private val LOG = com.intellij.openapi.diagnostic.Logger.getInstance("deveco-migration")
