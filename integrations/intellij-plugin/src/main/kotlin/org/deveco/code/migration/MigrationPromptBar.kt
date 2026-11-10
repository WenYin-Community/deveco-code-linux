package org.deveco.code.migration

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.ui.JBColor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.deveco.code.DevEcoIcons
import org.deveco.code.MyMessageBundle
import org.deveco.code.acp.AcpClientService
import org.deveco.code.util.devecoStorageRoot
import org.deveco.code.util.hoverable
import org.jetbrains.jewel.bridge.toComposeColor
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text

/**
 * Card layout metrics (task-7): the marker plus the gap on its right define
 * the x-origin of EVERY text column in the card, so the action area shares
 * that origin by reference instead of duplicating "22.dp" per call site.
 */
private val MarkerSize = 16.dp
private val MarkerGap = 6.dp

/** Left edge of every text column: the marker occupies [MarkerSize] + [MarkerGap]. */
private val TextColumnStart = MarkerSize + MarkerGap

/**
 * The two text buttons apply this start inset inside their own click target
 * (`padding(start = ActionButtonInset)` — see [StartMigrationButton] and
 * [DontRemindButton]), so insetting the action ROW by [TextColumnStart] would
 * leave the visible LABEL one [ActionButtonInset] right of the prompt text. Subtracting that
 * inset lands the label — not merely the click target — exactly on the text
 * column. Both sides of that equation reference this single constant, so
 * changing either cannot silently break the alignment (review F2).
 */
private val ActionButtonInset = 4.dp
private val ActionRowStart = TextColumnStart - ActionButtonInset

/**
 * Migration prompt bar for the DevEco Code tool window (requirements §5.1,
 * primary and only entry: main panel between Menu and Sessions).
 *
 * Visual spec (R1-R5, F1/F2 2026-10-13): pale-blue / deep-blue theme-aware
 * card, an info marker sharing the FIRST TEXT LINE (left of the text, which
 * is width-constrained so wrapped lines never flow back under it), and two
 * plain link-style text actions of IDENTICAL typography — "Start Migration"
 * (or "Retry Migration" after a partial run) and "Don't remind me" — plus a
 * close × pinned to the top-right corner. PromptColors holds the theme-aware
 * palette for both themes.
 *
 * Semantics unchanged: off-thread one-shot detection, marker-formula
 * visibility, three exits, migrating state blocks re-entry, settled
 * completion hides the bar. Source annotation (方案 B): the prompt text
 * names the detected global data's origin only while that origin is foreign
 * to the running IDE AND the GLOBAL scope is still pending — see the
 * suffix block in the body for the exact rule.
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
    /** Rule 2 probe result: is the GLOBAL origin still annotation-worthy?
     *  Read off-thread in the detection block below, never on the EDT. */
    var annotateGlobal by remember { mutableStateOf(false) }
    /** R5: did the last finished run leave items unsettled? Read off-thread
     *  with the detection probe, set in-session by the report callback. */
    var retryNeeded by remember { mutableStateOf(false) }
    /** Running IDE's own version-dir name ("6.1" for .../DevEcoStudio6.1), or
     *  null when it cannot be determined (config path at the "Huawei" vendor
     *  root, or a dir not named DevEcoStudio*). Null must fail safe toward
     *  ANNOTATING origins — see [noForeignSource] below. */
    val configVersion = remember { MigrationDetectorFactory.currentVersionName() }

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
                if (stateStore.shouldShowPrompt(inv, key)) {
                    inventory = inv
                    // Marker probes, same off-thread block (the marker file is
                    // tiny, so one read serves both): the global-origin
                    // annotation rule, and the R5 retry label — a partial run
                    // from a previous tool-window generation must still read
                    // as "Retry Migration". Never on the EDT.
                    val state = stateStore.read()
                    annotateGlobal = inv.hasGlobalSource && !state.globalDone
                    retryNeeded = state.retryNeeded(key)
                }
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

    // Source-version suffix (方案 B, revised 2026-10-08): annotate FOREIGN
    // sources only. skillsVer/mcpVer are the raw origins of the two global
    // kinds (null = that kind contributed nothing); configVersion is the
    // running IDE's own config-dir version. A kind whose origin equals the
    // running IDE's is not annotation-worthy on its own — but as soon as
    // EITHER kind is foreign, both kinds are spelled out (the pair is never
    // half-hidden, so foreign-vs-current renders as "both" too).
    // A null configVersion (unknown current version) makes both equalities
    // false, so the suffix is still built — never suppressed (fail safe
    // toward annotating rather than silently dropping the origin).
    val skillsVer = inventory?.skillsSourceVersion
    val mcpVer = inventory?.mcpSourceVersion
    val noForeignSource = (skillsVer == null || skillsVer == configVersion) &&
        (mcpVer == null || mcpVer == configVersion)
    val promptTextSuffix = when {
        // Rule 2 first: once the GLOBAL scope is done, the bar (if still up)
        // stands for project-level work only — a global origin annotation
        // would misattribute it.
        !annotateGlobal || noForeignSource -> ""
        // Exactly one kind carries data: name that kind explicitly. The
        // all-null case can never reach here (it is caught above), so mcpVer
        // is non-null in this arm.
        skillsVer == null -> MyMessageBundle.message("migration.prompt.source.mcp", mcpVer)
        // skillsVer != null here, mcpVer == null.
        mcpVer == null -> MyMessageBundle.message("migration.prompt.source.skill", skillsVer)
        // Both kinds carry data; equal origins collapse into one annotation,
        // differing origins are spelled out per kind.
        skillsVer == mcpVer -> MyMessageBundle.message("migration.prompt.source", skillsVer)
        else -> MyMessageBundle.message("migration.prompt.source.both", skillsVer, mcpVer)
    }

    Column(
        modifier = Modifier
            .padding(start = 16.dp, end = 16.dp, top = 8.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            // Pale-blue / deep-blue filled card, slightly brighter border line.
            .background(PromptColors.cardBackground)
            .border(1.dp, PromptColors.cardBorder, RoundedCornerShape(12.dp))
            // Visible vertical spec (user, 2026-10-13): the prompt text line sits
            // 12dp below the top border, the action line 12dp above the bottom
            // border, and the two lines are 8dp apart. `top` is direct (the text
            // row carries no vertical padding of its own); `bottom` is COMPENSATED
            // because both action buttons carry their own 6dp vertical hit padding
            // (6 + 6 = 12dp). Do not "round" these values to symmetric 12/12.
            .padding(start = 12.dp, top = 12.dp, end = 8.dp, bottom = 6.dp),
    ) {
        // F1 (user feedback 2026-10-13, replaces the stacked R1/R2 layout):
        // the info marker shares the TEXT's line — it sits to the LEFT of the
        // first text line, not on a line of its own above it.
        //
        // `weight(1f)` on the text is what makes that safe: it pins the text
        // column's x-range to [after the spacer, before the ×], so a wrapped
        // second line starts at the text's own x and can never flow back
        // under the marker — the exact failure mode of a bare inline icon.
        //
        // Top alignment puts the marker on the first text line. NO vertical
        // nudge is applied: the marker box and the first line are close enough
        // in height that their centers read as aligned, and any padding tuned
        // to one font scale would be wrong for another. (No dp figure is given
        // on purpose — Jewel leaves lineHeight Unspecified, so the line box is
        // font-metric driven, not a constant that can be asserted here.)
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.Top,
        ) {
            Icon(
                key = DevEcoIcons.iconKey("migration-info"),
                contentDescription = null,
                modifier = Modifier.size(MarkerSize),
                // Unspecified preserves the asset's own fills exactly as
                // authored. There is no per-theme variant to choose here: the
                // light and dark migration-info SVGs are byte-identical (a
                // constant #3574F0 dot). SystemMessageItem.kt reuses the same
                // asset with the same Unspecified rule.
                tint = Color.Unspecified,
            )
            Spacer(Modifier.width(MarkerGap))
            Text(
                // Base text + foreign-source suffix: e.g. "(from DevEco
                // Studio 6.1)", or "(Skill from DevEco Studio 6.1, MCP from
                // DevEco Studio 7.0)" when the two kinds come from different
                // roots — 方案 B: annotate the origin so the user understands
                // why the prompt appeared even though their current IDE's
                // CodeGenie looks clean. Empty when both kinds match the
                // running IDE's version, or once the GLOBAL scope is done.
                text = MyMessageBundle.message("migration.prompt.text") +
                    promptTextSuffix,
                fontSize = 13.sp,
                color = PromptColors.promptText,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.weight(1f).padding(end = 4.dp),
            )
            // F1: ALWAYS composed. Pulling the × out of this row while
            // migrating would (a) hand the weighted text the freed width and
            // re-wrap the prompt, and (b) drop the row's height below this
            // 15.sp glyph. `enabled` only makes it invisible + inert.
            CloseButton(enabled = !migrating) { visible = false } // session-only hide, no marker (§5.1)
        }
        // Visible gap between the prompt line and the action line is 8dp: this
        // Spacer contributes 2dp and the action's own 6dp vertical hit padding
        // (buttons and the "migrating" Text alike) supplies the remaining 6dp.
        // COMPENSATED — do not "round" it up to 8, that would render 14dp.
        Spacer(Modifier.height(2.dp))
        if (migrating) {
            Text(
                text = MyMessageBundle.message("migration.prompt.migrating"),
                fontSize = 13.sp,
                color = PromptColors.migratingText,
                // The 6dp VERTICAL padding matches the buttons' own padding
                // (same 13sp jewel Text → same line height), so the ACTION slot
                // is identical in both states. The FIRST ROW is identical too:
                // the × is always composed (F1), so this state swap changes
                // neither the card's height nor the text's wrap. task-7: the
                // START inset moves this line's left edge onto the text column
                // (this Text has no inset of its own, so it takes the full
                // TextColumnStart).
                modifier = Modifier.padding(start = TextColumnStart, top = 6.dp, bottom = 6.dp),
            )
        } else {
            // task-7: same left edge as the prompt text. ActionRowStart (not
            // TextColumnStart) because each button carries one ActionButtonInset
            // inside its click target — inset the row by the full column start
            // and the LABEL would sit one ActionButtonInset too far right.
            // NO vertical padding here: the 6dp top/bottom lives inside each
            // button, so adding it to the row too would double the action
            // area's height and break the state-swap invariant above.
            Row(modifier = Modifier.padding(start = ActionRowStart)) {
                StartMigrationButton(retryNeeded) {
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
                                    report.allSettled -> {
                                        visible = false
                                        // R5: nothing is left unsettled, so the
                                        // retry label must not survive into the
                                        // next tool-window generation. Marker
                                        // write runs off the EDT (file lock +
                                        // rename, same baseline as below).
                                        val key = MigrationDetectorFactory.resolveProjectKey(project)
                                        ApplicationManager.getApplication().executeOnPooledThread {
                                            runCatching { stateStore.clearFailed(key) }
                                                .onFailure { LOG.warn("failed to clear migration failure marker", it) }
                                        }
                                    }
                                    else -> {
                                        migrating = false
                                        // R5: a partial run labels the action
                                        // "Retry Migration" right away, and the
                                        // marker keeps that label after a
                                        // tool-window rebuild (the report itself
                                        // is not persisted anywhere).
                                        retryNeeded = true
                                        val key = MigrationDetectorFactory.resolveProjectKey(project)
                                        // Only unsettled GLOBAL items count as a
                                        // global failure — a global failure is
                                        // visible to every project's bar.
                                        val globalFailed = report.items.any {
                                            it.scope == MigrationScope.GLOBAL &&
                                                (it.status == ReportStatus.FAILED ||
                                                    it.status == ReportStatus.NOT_STARTED)
                                        }
                                        ApplicationManager.getApplication().executeOnPooledThread {
                                            runCatching { stateStore.markFailed(key, globalFailed) }
                                                .onFailure { LOG.warn("failed to write migration failure marker", it) }
                                            // Rule 2 refresh (review NIT-3): a partial
                                            // run may have just settled the GLOBAL scope
                                            // while the bar stays up for the project
                                            // part — re-read the marker off the EDT so
                                            // the stale global origin suffix disappears
                                            // without waiting for a tool-window rebuild.
                                            val inv = inventory
                                            val annotate = inv?.hasGlobalSource == true && !stateStore.read().globalDone
                                            ApplicationManager.getApplication().invokeLater {
                                                annotateGlobal = annotate
                                            }
                                        }
                                    }
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

/**
 * Theme-aware palette (R4): JBColor resolves the light/dark variant from the
 * current IDE theme at composition time; the constructor order is
 * JBColor(light, dark). The colors are plain conversions, not snapshot
 * state — a live theme switch may leave the previous variant until the tool
 * window recomposes for another reason (same staleness profile as the
 * committed DevEcoTheme tokens).
 */
private object PromptColors {
    val cardBackground: Color get() = JBColor(0xF5F8FE, 0x25324D).toComposeColor()
    val cardBorder: Color get() = JBColor(0xC2D6FC, 0x35538F).toComposeColor()
    val promptText: Color get() = JBColor(0x16324F, 0xFFFFFF).toComposeColor()
    /** Link-styled actions: "Start/Retry Migration" and "Don't remind me". */
    val linkAction: Color get() = JBColor(0x315FBD, 0x6B9BFA).toComposeColor()
    val plainTextOnCard: Color get() = JBColor(0x4A6FA5, 0xC0CEDE).toComposeColor()
    val plainTextOnCardHover: Color get() = JBColor(0x16324F, 0xFFFFFF).toComposeColor()
    val migratingText: Color get() = JBColor(0x4A6FA5, 0xC0CEDE).toComposeColor()
}

/**
 * Close × (session-only hide, no marker — §5.1).
 *
 * F1 (independent review 2026-10-13): the call site composes this in BOTH
 * states and passes `enabled = false` while migrating. It must NOT be pulled
 * out of the layout: as a flow child of the first row it would otherwise
 * change the text's available width (re-wrapping the prompt) and let the row
 * shrink under this 15.sp glyph. Hidden here = alpha 0, which keeps the
 * measured size — hence both of those — identical to the idle state.
 */
@Composable
private fun CloseButton(
    /** False while migrating: invisible and inert, but still laid out. */
    enabled: Boolean = true,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    var hovered by remember { mutableStateOf(false) }
    Text(
        text = "×",
        fontSize = 15.sp,
        color = if (hovered) PromptColors.plainTextOnCardHover else PromptColors.plainTextOnCard,
        modifier = modifier
            // Draw-only: alpha 0 hides the glyph while it keeps occupying its
            // intrinsic size in the row.
            .alpha(if (enabled) 1f else 0f)
            .clip(RoundedCornerShape(4.dp))
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                // `enabled = false` shuts the pointer path, drops the focusable
                // node and adds a Disabled flag — but it does NOT remove the
                // click semantics action: bytecode shows
                // AbstractClickableNode.applySemantics registers OnClick
                // unconditionally (disabled() only sets the Disabled property)
                // and the action body performs no enabled check. The lambda
                // therefore keeps its own guard, or a client that invokes the
                // semantics action could hide a mid-migration bar.
                // Measurement-neutral (clickable carries no LayoutModifierNode).
                enabled = enabled,
            ) { if (enabled) onClick() }
            .hoverable { if (enabled) hovered = it }
            .padding(start = 4.dp, end = 2.dp, top = 0.dp, bottom = 0.dp),
    )
}

/**
 * Primary action, as a plain text button (R3): the filled blue pill is gone —
 * no background fill, and `.clip` only shapes the click target, exactly like
 * [DontRemindButton]. Hover is an UNDERLINE in the same color (R4 forbids
 * inventing a hover color value).
 *
 * F2 (user feedback 2026-10-13): NO fontWeight override. The pill-era
 * `FontWeight.Medium` survived the background removal and left this button
 * visibly bolder than "Don't remind me"; every style argument below is now
 * identical to [DontRemindButton]'s.
 *
 * Label (R5): "Retry Migration" while the previous run left items unsettled,
 * otherwise "Start Migration"; both come from the message bundle (R6).
 */
@Composable
private fun StartMigrationButton(retry: Boolean, onClick: () -> Unit) {
    var hovered by remember { mutableStateOf(false) }
    Text(
        text = MyMessageBundle.message(
            if (retry) "migration.prompt.retry" else "migration.prompt.start",
        ),
        fontSize = 13.sp,
        color = PromptColors.linkAction,
        textDecoration = if (hovered) TextDecoration.Underline else null,
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
            ) { onClick() }
            .hoverable { hovered = it }
            .padding(start = ActionButtonInset, end = 4.dp, top = 6.dp, bottom = 6.dp),
    )
}

/** Plain text button on the card; same link treatment as the primary action. */
@Composable
private fun DontRemindButton(onClick: () -> Unit) {
    var hovered by remember { mutableStateOf(false) }
    Text(
        text = MyMessageBundle.message("migration.prompt.dontRemind"),
        fontSize = 13.sp,
        color = PromptColors.linkAction,
        textDecoration = if (hovered) TextDecoration.Underline else null,
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
            ) { onClick() }
            .hoverable { hovered = it }
            .padding(start = ActionButtonInset, end = 4.dp, top = 6.dp, bottom = 6.dp),
    )
}


private val LOG = com.intellij.openapi.diagnostic.Logger.getInstance("deveco-migration")
