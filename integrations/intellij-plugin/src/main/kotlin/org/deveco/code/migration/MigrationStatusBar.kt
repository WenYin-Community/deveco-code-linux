package org.deveco.code.migration

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.CustomStatusBarWidget
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.WindowManager
import com.intellij.util.Alarm
import org.deveco.code.MyMessageBundle
import java.awt.Dimension
import java.awt.FlowLayout
import java.util.concurrent.atomic.AtomicReference
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JProgressBar
import javax.swing.SwingConstants

/**
 * Unified two-mode status-bar widget (v3.5, user spec 2026-09-09):
 *
 *   progress mode  "配置迁移中 N/M" + determinate bar    (dwell >= 1s)
 *   done mode      "迁移完成 · 成功X · 跳过Y · 失败Z"     (text only, 3s hold)
 *
 * Both modes render in THIS one Swing widget. The platform's native progress
 * area cannot carry the pair: a running Task.Backgroundable always paints a
 * bar (no text-only mode) and the whole area is retracted the moment run()
 * returns — so a native-bar progress + custom-label done split (v3.4) could
 * never look unified. The custom bar is styled to sit next to the platform
 * look instead: thin 6px track, no border, LAF-themed colors.
 *
 * Timing: fast migrations settle in <100ms — far below the ~300ms the
 * platform needs to render anything — so the widget itself enforces the 1s
 * minimum progress dwell: the done text appears no earlier than 1s after the
 * first progress tick (delay = max(MIN_PROGRESS_MS - elapsed, 0)). Slow runs
 * are unaffected.
 *
 * Completion callback: [showDone] takes an [onShown] lambda fired from the
 * dwell alarm at the SAME moment the done text appears (user spec: 弹窗与
 * 完成态同时). If another run takes over the slot before the dwell elapses,
 * the pending callback is fired on takeover instead of being swallowed — the
 * balloon and the prompt-bar release must never be lost (cross-window safety).
 *
 * Hygiene from the adversarial review carries over: single addWidget per
 * mount (P3-11), project slot swap across windows (P2-4), immediate clear on
 * abort/cancel (P0-1), every Swing mutation on the EDT.
 */
internal object MigrationStatusBar {
    private var widget: MigrationStatusWidget? = null
    private var statusBar: StatusBar? = null

    /** Project owning the current widget slot (P2-4). */
    private var slotProject: Project? = null

    /** addWidget runs once per mounting, not on every tick (P3-11). */
    private var mounted = false
    private val alarm = Alarm(Alarm.ThreadToUse.SWING_THREAD)

    /** True from the first progress tick until [showDone] schedules the done text. */
    private var inRun = false

    /** Wall clock of the current run's first progress tick (dwell anchor). */
    private var progressShownAt = 0L

    /** Completion callback of the run currently holding the slot; fired once —
     *  from the dwell alarm (normal path) or on takeover/clear (safety path). */
    private val pendingOnShown = AtomicReference<(() -> Unit)?>(null)

    /** Progress mode: mounts the widget if absent, then updates text + bar. */
    fun showProgress(project: Project, done: Int, total: Int) {
        if (!inRun) {
            // A tick outside a run = a NEW run — typically a re-click while the
            // previous done text is still holding (3s): drop its pending
            // unmount so it cannot remove this run's widget mid-flight, and
            // fire the previous run's completion callback instead of
            // swallowing it (its balloon + prompt release must still happen).
            inRun = true
            progressShownAt = System.currentTimeMillis()
            alarm.cancelAllRequests()
            pendingOnShown.getAndSet(null)?.invoke()
        }
        val text = MyMessageBundle.message("migration.progress.text") + " $done/$total"
        update(project) { w ->
            w.label.text = text
            w.label.toolTipText = text
            // Determinate N/M on the bar; coerce so an empty run (total 0)
            // can never leave maximum < value.
            val max = total.coerceAtLeast(1)
            w.progress.maximum = max
            w.progress.value = done.coerceIn(0, max)
            w.progress.isVisible = true
        }
    }

    /**
     * Done mode: waits out the remaining 1s dwell, then swaps to the bar-less
     * done text, holds it [DONE_HOLD_MS], unmounts — and fires [onShown] at
     * the same moment the text appears.
     */
    fun showDone(project: Project, migrated: Int, failed: Int, skipped: Int, onShown: (() -> Unit)? = null) {
        inRun = false
        // Symmetric with takeOver/clearNow (review ℹ️7): if a previous
        // showDone's callback is still pending (double zero-tick run), fire
        // it before replacing — never silently swallow it (the swallowed
        // onFinished would strand the prompt bar in "migrating").
        pendingOnShown.getAndSet(onShown)?.invoke()
        val delay = (progressShownAt + MIN_PROGRESS_MS - System.currentTimeMillis()).coerceAtLeast(0)
        val doneText = MyMessageBundle.message("migration.progress.done") + " · " +
            MyMessageBundle.message("migration.progress.doneDetail", migrated, skipped, failed)
        alarm.cancelAllRequests()
        alarm.addRequest({
            update(project) { w ->
                w.label.text = doneText
                w.label.toolTipText = doneText
                w.progress.isVisible = false
            }
            pendingOnShown.getAndSet(null)?.invoke()
            alarm.addRequest({ unmount() }, DONE_HOLD_MS)
        }, delay)
    }

    /** Immediate removal for aborted/cancelled runs (review P0-1): showDone is
     *  otherwise the only place arming removal — without this, a run that dies
     *  after its first tick would leave "配置迁移中 N/M" mounted forever. Any
     *  pending completion callback fires first (never swallowed). */
    fun clearNow() {
        inRun = false
        alarm.cancelAllRequests()
        pendingOnShown.getAndSet(null)?.invoke()
        ApplicationManager.getApplication().invokeLater { unmount() }
    }

    /** Mounts the widget on the EDT if absent, then applies [body] on the EDT —
     *  every Swing mutation in this class funnels through here. */
    private fun update(project: Project, body: (MigrationStatusWidget) -> Unit) {
        ApplicationManager.getApplication().invokeLater {
            // Cross-window slot swap (P2-4): a run from another project takes
            // the widget out of the old window's bar before mounting here.
            if (slotProject != null && slotProject !== project) unmount()
            slotProject = project
            val bar = statusBar ?: WindowManager.getInstance().getStatusBar(project)?.also { statusBar = it }
                ?: return@invokeLater
            val w = widget ?: MigrationStatusWidget().also { widget = it }
            if (!mounted) {
                bar.addWidget(w, "before Position")
                mounted = true
            }
            body(w)
        }
    }

    /** EDT only: takes the widget out of the bar and resets the whole slot. */
    private fun unmount() {
        val bar = statusBar
        val w = widget
        if (bar != null && w != null) bar.removeWidget(w.ID())
        w?.label?.text = ""
        widget = null
        statusBar = null
        slotProject = null
        mounted = false
        progressShownAt = 0L
    }

    private const val MIN_PROGRESS_MS = 1_000L

    /** User spec v3.4: "显示时间稍微长一点，三秒". */
    private const val DONE_HOLD_MS = 3_000L
}

internal class MigrationStatusWidget : CustomStatusBarWidget {
    internal val label = JLabel("", SwingConstants.CENTER)

    /** Determinate bar next to the label; hidden in the done mode. Plain Swing
     *  JProgressBar (JBProgressBar lives in a non-exported impl module) styled
     *  to sit next to the native platform progress (user spec: "进度条格式和
     *  平台原生进度条样式很接近"): thin 6px track, no border, LAF colors. */
    internal val progress = JProgressBar().apply {
        preferredSize = Dimension(BAR_WIDTH, BAR_HEIGHT)
        isStringPainted = false
        isBorderPainted = false
        isFocusable = false
    }

    /** Transparent so the status-bar background shows through (no boxed look). */
    private val panel = JPanel(FlowLayout(FlowLayout.LEFT, 4, 0)).apply {
        isOpaque = false
        add(label)
        add(progress)
    }

    override fun ID(): String = ID

    override fun getComponent(): JComponent = panel

    override fun install(statusBar: StatusBar) {}

    override fun dispose() {}

    companion object {
        const val ID = "org.deveco.code.migration.status"
        private const val BAR_WIDTH = 100
        private const val BAR_HEIGHT = 6
    }
}
