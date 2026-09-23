package org.deveco.code.migration

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.ui.table.JBTable
import com.intellij.openapi.ui.DialogWrapper
import org.deveco.code.MyMessageBundle
import org.deveco.code.acp.AcpClientService
import org.deveco.code.util.devecoStorageRoot
import java.awt.BorderLayout
import java.awt.Dimension
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.table.DefaultTableModel

/**
 * Cross-component migration UI events (Compose ↔ Swing bridge).
 * [dismissed] fires when the user clicks "忽略失败项" in the report dialog —
 * the prompt bar collects it to hide immediately without requiring a
 * tool-window collapse/expand cycle.
 *
 * The event carries the project key (same value as
 * [MigrationDetectorFactory.resolveProjectKey]) so collectors in other
 * project windows can filter it out — without the key, one project's
 * dismissal would hide another project's prompt bar (global singleton).
 *
 * Ordering contract: the emit site writes the state-store markers BEFORE
 * emitting. A late collector that misses the event (replay=0) is still
 * correct because the prompt bar's composition-time probe re-reads the
 * markers and hides on its own.
 */
object MigrationEvents {
    val dismissed = kotlinx.coroutines.flow.MutableSharedFlow<String>(extraBufferCapacity = 1)
}

/**
 * Background migration task (requirements §5.3): deterministic N/M progress in
 * the status bar via the custom Swing widget (MigrationStatusBar). Deliberately
 * NOT a Task.Backgroundable — the platform's ProgressManager always paints a
 * native progress bar in the status bar alongside the widget, which users
 * reported as a confusing duplicate. Runs on a pooled thread instead; the
 * cancel token is exposed for programmatic cancellation.
 */
private val LOG = com.intellij.openapi.diagnostic.Logger.getInstance("deveco-migration")

class MigrationTask(
    private val project: Project,
    private val service: AcpClientService,
    private val stateStore: MigrationStateStore,
    /**
     * Invoked on a background thread on EVERY exit path (D12 UI feedback):
     * the report on success/cancel, or null when the run aborted before one
     * existed (backend down, lock timeout, internal error). The prompt bar
     * relies on this to unstick its "migrating" state (review P0-1).
     */
    private val onFinished: (MigrationReport?) -> Unit = {},
) {

    private val cancelToken = MigrationExecutor.CancelToken()

    /** Stop scheduling new items; the in-flight one finishes atomically. */
    fun cancel() {
        cancelToken.cancelled = true
    }

    fun runInBackground() {
        ApplicationManager.getApplication().executeOnPooledThread {
            run()
        }
    }

    private fun run() {
        val report = try {
            executeMigration()
        } catch (e: FlockKit.LockTimeoutException) {
            MigrationNotifier.notifyError(project, MyMessageBundle.message("migration.error.lock.timeout"))
            finishAborted()
            return
        } catch (e: Exception) {
            MigrationNotifier.notifyError(project, e.message ?: e.javaClass.simpleName)
            finishAborted()
            return
        } catch (t: Throwable) {
            // Error (e.g. NoClassDefFoundError during plugin hot-reload) must
            // not silently kill the pooled thread — without this, the prompt
            // bar would be stuck in "migrating" until the next recomposition
            // (review ℹ️8). Log, notify, and release the migrating state.
            LOG.error("codegenie migration run died with Error", t)
            MigrationNotifier.notifyError(project, t.message ?: t.javaClass.simpleName)
            finishAborted()
            return
        }

        val summary = report.summary
        LOG.info(
            "codegenie migration finished: " +
                "migrated=${summary.migrated} skippedEquivalent=${summary.skippedEquivalent} " +
                "skippedConflict=${summary.skippedConflict} failed=${summary.failed} " +
                "notStarted=${summary.notStarted} cancelled=${report.cancelled} " +
                "refreshFailed=${report.refreshFailed} durationMs=${report.finishedAt - report.startedAt}",
        )

        if (!report.cancelled) {
            MigrationStatusBar.showDone(project, summary.migrated, summary.failed, summary.skippedTotal) {
                MigrationNotifier.notifyResult(project, report) {
                    // User chose to ignore failed items — mark the migration
                    // scope as done so the prompt bar stops re-appearing, and
                    // notify the UI layer so a mounted prompt bar hides
                    // immediately (no tool-window collapse/expand needed).
                    // This only affects migration tracking state; no user
                    // data is deleted (explicit design decision).
                    // Marker writes (blocking file lock + atomic rename) run
                    // OFF the EDT per review P2-3 — the same baseline the
                    // prompt bar's DontRemindButton follows.
                    val projectKey = resolveProjectId()
                    ApplicationManager.getApplication().executeOnPooledThread {
                        runCatching {
                            stateStore.markGlobalDone()
                            stateStore.markProjectDone(projectKey)
                            MigrationEvents.dismissed.tryEmit(projectKey)
                        }.onFailure { LOG.warn("ignore-failed marker write failed", it) }
                    }
                }
                // onFinished fires here (after the 1s status-bar dwell), not
                // at showDone call time — keeps the prompt bar's "迁移中"
                // state in lock step with the status-bar progress phase.
                onFinished(report)
            }
        } else {
            MigrationStatusBar.clearNow()
            onFinished(report)
        }
    }

    /**
     * No report exists (aborted before/at execution). The widget may already
     * be mounted from early ticks — clear it (review P0-1: showDone is
     * otherwise the only place arming removal) — and release the prompt bar's
     * migrating state.
     */
    private fun finishAborted() {
        MigrationStatusBar.clearNow()
        onFinished(null)
    }

    private fun executeMigration(): MigrationReport {
        // D4: connect FIRST so the detector sees the real projectConfig paths —
        // constructing it before connect leaves targetProjectConfigDir null and
        // every project skill fails on the typical first-run path.
        BackendAdapter(service).ensureConnected()
        val detector = MigrationDetectorFactory.create(service, devecoStorageRoot.resolve("config"))
        // Re-detect with the CONNECTED backend's paths (review P0-2): the
        // prompt bar captured its inventory at composition time, typically
        // before the backend subprocess finished spawning — the worktree root
        // is then unknown and project sources above the project dir are
        // invisible. Executing that stale list would record a false NOT_FOUND,
        // settle the PROJECT scope, and permanently mark the project done.
        val freshInventory = detector.detect()
        val executor = MigrationExecutor(
            detector = detector,
            stateStore = stateStore,
            projectId = resolveProjectId(),
            backend = BackendAdapter(service),
            storageRoot = devecoStorageRoot,
        )
        return executor.execute(freshInventory, ProgressAdapter(project), cancelToken)
    }

    /** Deterministic marker key: sanitized worktree path (shared with the PromptBar). */
    private fun resolveProjectId(): String =
        MigrationDetectorFactory.resolveProjectKey(project)

    /**
     * Sole progress display: pushes ticks to the custom Swing widget.
     * No native ProgressIndicator — see class doc.
     */
    private class ProgressAdapter(
        private val project: Project,
    ) : MigrationExecutor.Progress {
        private var total = 0
        private var done = 0
        override fun onTotal(total: Int) {
            this.total = total.coerceAtLeast(1)
        }

        override fun onTick() {
            done++
            MigrationStatusBar.showProgress(project, done, total)
        }
    }

    /** Bridges the executor's IDE-free seam onto DevEcoHttpApi (design A2/A5, AD2). */
    private class BackendAdapter(private val service: AcpClientService) : MigrationExecutor.Backend {
        override fun ensureConnected() {
            if (!service.connect()) {
                throw IllegalStateException(MyMessageBundle.message("migration.error.backend.unavailable"))
            }
        }

        override fun patchProjectConfig(patch: kotlinx.serialization.json.JsonObject) {
            service.migrationHttpApi().addMcpConfigPatch(patch, service.migrationWorkingDirectory())
        }

        override fun patchGlobalConfig(patch: kotlinx.serialization.json.JsonObject) {
            service.migrationHttpApi().updateGlobalConfig(patch)
        }

        override fun refreshInstance() {
            service.refreshInstance()
        }
    }
}

/** Right-bottom balloon notifications (requirements §5.4). */
object MigrationNotifier {
    private const val GROUP = "DevEco Code Migration"

    fun notifyResult(
        project: Project,
        report: MigrationReport,
        onIgnoreFailed: (() -> Unit)? = null,
    ) {
        val summary = report.summary
        val (title, body) = when {
            report.cancelled && summary.failed == 0 ->
                MyMessageBundle.message("migration.notification.cancelled.title") to
                    MyMessageBundle.message("migration.notification.cancelled.body")

            summary.failed > 0 -> {
                // Full counts, not just the failure number (user feedback
                // 2026-09-09): the total conveys how much data was processed.
                // NOT_FOUND scope annotations are not data and stay excluded.
                val total = summary.migrated + summary.skippedTotal + summary.failed + summary.notStarted
                MyMessageBundle.message("migration.notification.partial.title") to
                    MyMessageBundle.message(
                        "migration.notification.partial.body",
                        total, summary.migrated, summary.skippedTotal, summary.failed,
                    )
            }

            summary.migrated == 0 && summary.skippedTotal > 0 ->
                MyMessageBundle.message("migration.notification.success.title") to
                    MyMessageBundle.message("migration.notification.success.allSkipped.body", summary.skippedTotal)

            summary.skippedTotal > 0 ->
                MyMessageBundle.message("migration.notification.success.title") to
                    (
                        MyMessageBundle.message("migration.notification.success.body") + " " +
                            MyMessageBundle.message("migration.notification.success.skipped", summary.skippedTotal)
                        )

            else ->
                MyMessageBundle.message("migration.notification.success.title") to
                    MyMessageBundle.message("migration.notification.success.body")
        }

        val notification = NotificationGroupManager.getInstance()
            .getNotificationGroup(GROUP)
            .createNotification(title, body, NotificationType.INFORMATION)
        notification.addAction(
            com.intellij.notification.NotificationAction.createSimple(
                MyMessageBundle.message("migration.notification.details"),
            ) { MigrationReportDialog(project, report, onIgnoreFailed).show() },
        )
        notification.addAction(
            com.intellij.notification.NotificationAction.createSimple(
                MyMessageBundle.message("migration.notification.acknowledge"),
            ) { notification.expire() },
        )
        notification.notify(project)
    }

    fun notifyError(project: Project, detail: String) {
        // Pre-start errors (lock timeout, backend down) never reached execution —
        // "迁移完成（含失败项）" would contradict the body. Dedicated title.
        NotificationGroupManager.getInstance()
            .getNotificationGroup(GROUP)
            .createNotification(
                MyMessageBundle.message("migration.notification.error.title"),
                detail,
                NotificationType.ERROR,
            )
            .notify(project)
    }
}

/** Read-only report dialog opened via "查看详情" (design A6: modal table). */
class MigrationReportDialog(
    project: Project,
    private val report: MigrationReport,
    private val onIgnoreFailed: (() -> Unit)? = null,
) : DialogWrapper(project) {
    init {
        title = MyMessageBundle.message("migration.report.title")
        // Read-only report: a single OK button suffices (user feedback: the
        // cancel button was redundant — both closed the dialog).
        init()
    }

    override fun createActions(): Array<javax.swing.Action> {
        val actions = mutableListOf<javax.swing.Action>(okAction)
        // "Ignore Failed Items" only appears when the report has failures AND
        // the caller provided a handler (MigrationTask passes one that marks
        // the migration scope as done in the state store — the prompt bar
        // then stops re-appearing for these items on the next check).
        if (report.summary.failed > 0 && onIgnoreFailed != null) {
            actions.add(
                object : javax.swing.AbstractAction(
                    MyMessageBundle.message("migration.report.ignoreFailed"),
                ) {
                    override fun actionPerformed(e: java.awt.event.ActionEvent) {
                        // Close FIRST: the callback's marker writes run on a
                        // pooled thread (P2-3), so any IO exception there
                        // must not leave the dialog stuck open (review ⚠️4).
                        close(OK_EXIT_CODE)
                        onIgnoreFailed.invoke()
                    }
                },
            )
        }
        return actions.toTypedArray()
    }

    override fun createCenterPanel(): JComponent {
        val columnKeys = listOf(
            "migration.report.column.kind",
            "migration.report.column.scope",
            "migration.report.column.item",
            "migration.report.column.status",
            "migration.report.column.detail",
        )
        val model = DefaultTableModel(
            columnKeys.map { MyMessageBundle.message(it) }.toTypedArray(),
            0,
        )
        for (item in report.items) {
            model.addRow(
                arrayOf(
                    MyMessageBundle.message("migration.report.kind.${item.kind.name.lowercase()}"),
                    MyMessageBundle.message("migration.report.scope.${item.scope.name.lowercase()}"),
                    item.name,
                    MyMessageBundle.message("migration.report.status.${statusKey(item.status)}"),
                    item.detail ?: "",
                ),
            )
        }
        // JBTable is non-editable by default unless made editable; keep it read-only.
        val table = object : JBTable(model) {
            override fun isCellEditable(row: Int, column: Int): Boolean = false
        }
        val scroll = JScrollPane(table)
        scroll.preferredSize = Dimension(720, 360)

        val notes = buildList {
            if (report.cancelled) add(MyMessageBundle.message("migration.report.cancelled"))
            if (report.refreshFailed) add(MyMessageBundle.message("migration.report.refreshFailed"))
        }
        val panel = JPanel(BorderLayout(0, 8))
        panel.add(scroll, BorderLayout.CENTER)
        if (notes.isNotEmpty()) {
            panel.add(JBLabel(notes.joinToString("  ")), BorderLayout.SOUTH)
        }
        return panel
    }

    private fun statusKey(status: ReportStatus): String = when (status) {
        ReportStatus.MIGRATED -> "migrated"
        ReportStatus.SKIPPED_EQUIVALENT -> "skippedEquivalent"
        ReportStatus.SKIPPED_CONFLICT -> "skippedConflict"
        ReportStatus.FAILED -> "failed"
        ReportStatus.NOT_STARTED -> "notStarted"
    }
}
