package org.deveco.code.announcement

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.project.ProjectManagerListener
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.startup.StartupManager
import com.intellij.openapi.wm.IdeFocusManager
import com.intellij.openapi.wm.WindowManager
import com.intellij.ui.BalloonLayoutImpl
import org.deveco.code.util.PluginStateFiles
import org.deveco.code.util.devecoStorageRoot
import java.io.IOException
import java.nio.file.ClosedWatchServiceException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardWatchEventKinds
import java.nio.file.WatchService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import javax.swing.SwingUtilities
import kotlin.random.Random

class AnnouncementStartup : ProjectActivity {
    override suspend fun execute(project: Project) {
        AnnouncementService.instance().projectOpened(project)
    }
}

class AnnouncementService internal constructor(
    private val agreementFile: Path,
    private val store: AnnouncementStore,
    private val http: AnnouncementHttp,
    private val agreementStatus: (
        Project,
    ) -> AnnouncementAgreement = StudioAnnouncementAgreement(agreementFile)::status,
) : Disposable {
    constructor() : this(
        devecoStorageRoot.resolve("state/product-agreement.json"),
        AnnouncementStore(PluginStateFiles.globalPath("announcements")),
        AnnouncementHttp(AnnouncementHttp::endpoint, lazy(AnnouncementHttp::installedVersion)::value),
    )

    private val worker = ScheduledThreadPoolExecutor(1, { task ->
        Thread(task, "DevEco announcements").apply { isDaemon = true }
    }).apply {
        setExecuteExistingDelayedTasksAfterShutdownPolicy(false)
        removeOnCancelPolicy = true
    }
    private val network = Executors.newSingleThreadExecutor { task ->
        Thread(task, "DevEco announcement HTTP").apply { isDaemon = true }
    }
    private var watcher: WatchService? = null
    private var started = false
    private var agreementGeneration = 0L
    private var inFlight: Future<*>? = null
    private var scheduled: ScheduledFuture<*>? = null
    private var failures = 0
    private val dismissing = mutableSetOf<AnnouncementKey>()
    private var balloons: AnnouncementBalloons? = null

    @Volatile private var disposed = false

    @Volatile private var agreement: AnnouncementAgreement? = null

    @Volatile private var state = AnnouncementState()

    init {
        ApplicationManager.getApplication().messageBus.connect(this).subscribe(
            ProjectManager.TOPIC,
            object : ProjectManagerListener {
                override fun projectClosed(project: Project) {
                    submit { checkAgreement() }
                    onEdt(::render)
                }
            },
        )
    }

    @Synchronized
    internal fun projectOpened(project: Project) {
        if (disposed) return
        if (!started) {
            started = true
            worker.execute { startWatching() }
            // Studio can require a new signature without rewriting the local marker.
            worker.scheduleWithFixedDelay({ checkAgreement() }, 5L, 5L, TimeUnit.MINUTES)
        }
        worker.execute { checkAgreement(project) }
        StartupManager.getInstance(project).runAfterOpened { onEdt(::render) }
    }

    private fun startWatching() {
        val service = agreementFile.fileSystem.newWatchService()
        try {
            Files.createDirectories(agreementFile.parent).register(
                service,
                StandardWatchEventKinds.ENTRY_CREATE,
                StandardWatchEventKinds.ENTRY_DELETE,
                StandardWatchEventKinds.ENTRY_MODIFY,
            )
        } catch (e: IOException) {
            service.close()
            log.warn("Could not watch the Studio agreement marker", e)
            return
        }
        synchronized(this) {
            if (disposed) {
                service.close()
                return
            }
            watcher = service
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                while (true) {
                    val key = service.take()
                    val changed = key.pollEvents().any {
                        it.kind() == StandardWatchEventKinds.OVERFLOW || it.context() == agreementFile.fileName
                    }
                    if (changed || !key.isValid) submit { checkAgreement() }
                    if (!key.reset()) break
                }
            } catch (_: ClosedWatchServiceException) {
                // Disposal closes the watcher and releases take().
            } finally {
                service.close()
            }
        }
    }

    private fun checkAgreement(openedProject: Project? = null) {
        if (disposed) return
        val project = openedProject?.takeUnless { it.isDisposed }
            ?: ProjectManager.getInstance().openProjects.firstOrNull { !it.isDisposed }
        val next = project?.let(agreementStatus) ?: AnnouncementAgreement.NOT_SIGNED
        if (disposed || agreement == next) return
        log.info("Announcement agreement: ${agreement ?: "UNCHECKED"} -> $next")
        agreement = next
        agreementGeneration++
        if (next != AnnouncementAgreement.ACCEPTED) {
            scheduled?.cancel(false)
            inFlight?.cancel(true)
            inFlight = null
            onEdt(::render)
            return
        }
        failures = 0
        publish(runCatching { store.load() }.getOrElse { AnnouncementState() })
        refresh()
    }

    private fun refresh() {
        if (agreement != AnnouncementAgreement.ACCEPTED || inFlight != null) return
        val generation = agreementGeneration
        synchronized(this) {
            if (disposed) return
            inFlight = network.submit {
                val response = runCatching { http.fetch() }
                submit { completeRefresh(generation, response) }
            }
        }
    }

    private fun completeRefresh(generation: Long, response: Result<AnnouncementResponse>) {
        if (disposed || agreementGeneration != generation) return
        inFlight = null
        try {
            publish(store.save(response.getOrThrow()))
            failures = 0
        } catch (_: Exception) {
            failures++
        }
        val delay = if (failures == 0) {
            1800000L
        } else {
            val delay = (30000L * (1L shl (failures - 1).coerceAtMost(4))).coerceAtMost(300000L)
            (delay * Random.nextDouble(0.8, 1.2)).toLong().coerceAtMost(300000L)
        }
        synchronized(this) {
            if (disposed) return
            scheduled = worker.schedule({
                checkAgreement()
                refresh()
            }, delay, TimeUnit.MILLISECONDS)
        }
    }

    @Synchronized
    private fun dismiss(key: AnnouncementKey) {
        if (disposed || agreement != AnnouncementAgreement.ACCEPTED || !dismissing.add(key)) return
        onEdt(::render)
        worker.execute {
            try {
                if (agreement == AnnouncementAgreement.ACCEPTED) state = store.markRead(key)
            } catch (_: Exception) {
                // Keep the announcement unread if the dismissal could not be saved.
            } finally {
                onEdt {
                    dismissing.remove(key)
                    render()
                }
            }
        }
    }

    private fun publish(next: AnnouncementState) {
        if (disposed) return
        state = next
        onEdt(::render)
    }

    private fun render() {
        if (agreement != AnnouncementAgreement.ACCEPTED) {
            balloons?.detach()
            balloons = null
            return
        }
        val unread = state.unread.filterKeys { it !in dismissing }
        val windows = WindowManager.getInstance()
        val frames = ProjectManager.getInstance().openProjects
            .filter { !it.isDisposed }
            .mapNotNull { windows.getIdeFrame(it) }
            .filter { it.balloonLayout is BalloonLayoutImpl }
        val current = balloons
        if (unread.isNotEmpty() && current != null && current.frame in frames) {
            current.show(unread)
            return
        }
        current?.detach()
        balloons = null
        if (unread.isEmpty()) return

        val focused = IdeFocusManager.getGlobalInstance().lastFocusedFrame
        val frame = focused?.takeIf { it in frames } ?: frames.firstOrNull() ?: return
        val layout = frame.balloonLayout as? BalloonLayoutImpl ?: return
        balloons = AnnouncementBalloons(frame, layout, ::dismiss) { onEdt(::render) }.apply { show(unread) }
    }

    private fun onEdt(action: () -> Unit) {
        ApplicationManager.getApplication().invokeLater { if (!disposed) action() }
    }

    @Synchronized
    private fun submit(action: () -> Unit) {
        if (!disposed) worker.execute(action)
    }

    @Synchronized
    override fun dispose() {
        disposed = true
        watcher?.close()
        http.cancel()
        network.shutdownNow()
        // Let close actions already queued finish writing the read state.
        worker.shutdown()
        SwingUtilities.invokeLater {
            balloons?.detach()
            balloons = null
        }
    }

    companion object {
        private val log = logger<AnnouncementService>()

        fun instance(): AnnouncementService =
            ApplicationManager.getApplication().getService(AnnouncementService::class.java)
    }
}
