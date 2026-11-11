package org.deveco.code.migration

import com.intellij.notification.NotificationDisplayType
import com.intellij.notification.NotificationGroup
import com.intellij.notification.NotificationGroupManager
import com.intellij.openapi.application.ApplicationManager
import com.intellij.serviceContainer.ComponentManagerImpl
import com.intellij.testFramework.LightPlatformTestCase
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.deveco.code.acp.AcpClientService
import org.deveco.code.acp.CliBinaryExtractor
import org.deveco.code.acp.SharedAcpBackend
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Platform-fixture unit tests for the migration task orchestration
 * ([MigrationTask]): the D12 onFinished contract on an aborted run (backend
 * unavailable — no spawnable bundled CLI), the Compose/Swing bridge event
 * ([MigrationEvents.dismissed]) and the deterministic project marker key.
 * The full detect -> confirm -> execute -> report loop against a live backend
 * subprocess is covered by integration testing.
 */
class MigrationTaskTest : LightPlatformTestCase() {

    private lateinit var serviceInstance: AcpClientService

    override fun setUp() {
        super.setUp()
        // plugin.xml-declared services (post-0.3.1, AcpClientService and
        // SharedAcpBackend are no longer light services) are not resolvable in
        // the bare test platform: register the app backend, then wire the
        // project facade through the project container so getService lookups
        // behave like production.
        (ApplicationManager.getApplication() as ComponentManagerImpl).replaceServiceInstance(
            SharedAcpBackend::class.java,
            SharedAcpBackend(),
            testRootDisposable,
        )
        serviceInstance = AcpClientService(getProject())
        (getProject() as ComponentManagerImpl).replaceServiceInstance(
            AcpClientService::class.java,
            serviceInstance,
            testRootDisposable,
        )
        // The migration notifier looks up the "DevEco Code Migration" group,
        // which lives in plugin.xml and is therefore absent in the bare test
        // platform — without it the abort path dies in notifyError before
        // onFinished can release the migrating state (D12). Substitute a
        // delegating manager that serves the group and forwards the rest.
        val app = ApplicationManager.getApplication()
        val realManager = app.getService(NotificationGroupManager::class.java)
        val migrationGroup = NotificationGroup("DevEco Code Migration", NotificationDisplayType.BALLOON, false)
        (app as ComponentManagerImpl).replaceServiceInstance(
            NotificationGroupManager::class.java,
            object : NotificationGroupManager {
                override fun getNotificationGroup(groupId: String): NotificationGroup? = if (groupId ==
                    "DevEco Code Migration"
                ) {
                    migrationGroup
                } else {
                    realManager?.getNotificationGroup(groupId)
                }

                override fun isGroupRegistered(groupId: String): Boolean =
                    groupId == "DevEco Code Migration" || realManager?.isGroupRegistered(groupId) == true

                override fun getRegisteredNotificationGroups(): Collection<NotificationGroup> =
                    realManager?.getRegisteredNotificationGroups().orEmpty() + migrationGroup

                override fun isRegisteredNotificationId(notificationId: String): Boolean =
                    realManager?.isRegisteredNotificationId(notificationId) == true
            },
            testRootDisposable,
        )
    }

    private fun service(): AcpClientService = getProject().getService(AcpClientService::class.java)

    fun testRunAbortsAndReportsNullWhenBackendUnavailable() {
        val service = service()
        // Make the extracted dummy binary unspawnable on every platform so
        // connect() fails fast and deterministically.
        File(CliBinaryExtractor.extract()).setExecutable(false)
        val stateStore = MigrationStateStore(Files.createTempFile("codegenie-migration-test", ".json"))
        val finished = AtomicReference<MigrationReport?>()
        val latch = CountDownLatch(1)
        try {
            val task = MigrationTask(getProject(), service, stateStore) { report ->
                finished.set(report)
                latch.countDown()
            }

            task.runInBackground()

            assertTrue("onFinished was not called within 30s", latch.await(30, TimeUnit.SECONDS))
            // D12: the aborted run (backend down, no report produced) must
            // still release the prompt bar's migrating state.
            assertNull(finished.get())
        } finally {
            service.disconnect()
        }
    }

    fun testDismissedEventIsDeliveredToSubscribers() {
        runBlocking {
            val received = mutableListOf<String>()
            val job = launch {
                MigrationEvents.dismissed.collect { received.add(it) }
            }
            try {
                withTimeout(5_000) {
                    while (received.isEmpty()) {
                        MigrationEvents.dismissed.tryEmit("proj-1")
                        delay(20)
                    }
                }
            } finally {
                job.cancel()
            }
            assertTrue(received.contains("proj-1"))
        }
    }

    fun testDismissedEventIsNotReplayedToLateSubscribers() {
        runBlocking {
            // replay = 0: an emission with no collector is not stored.
            MigrationEvents.dismissed.tryEmit("early")

            val received = mutableListOf<String>()
            val job = launch {
                MigrationEvents.dismissed.collect { received.add(it) }
            }
            delay(200)
            job.cancel()

            assertTrue(received.isEmpty())
        }
    }

    fun testResolveProjectKeyIsSanitized() {
        val key = MigrationDetectorFactory.resolveProjectKey(getProject())

        assertFalse(key.isEmpty())
        assertTrue("unsanitized key: $key", key.matches(Regex("[a-zA-Z0-9._-]+")))
    }
}
