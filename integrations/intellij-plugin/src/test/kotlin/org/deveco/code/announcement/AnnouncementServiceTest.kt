package org.deveco.code.announcement

import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.LightPlatformTestCase
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.net.URI
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class AnnouncementServiceTest : LightPlatformTestCase() {
    fun testSigningAndReviewGateQueriesAndDiscardAnInFlightResponse() {
        val directory = Files.createTempDirectory("announcement-service")
        val marker = directory.resolve("product-agreement.json")
        val store = AnnouncementStore(directory.resolve("cache"))
        val checks = LinkedBlockingQueue<AnnouncementAgreement>()
        val revision = AtomicReference(AnnouncementAgreement.ACCEPTED)
        val requests = LinkedBlockingQueue<Int>()
        val requestCount = AtomicInteger()
        val releaseFirst = CountDownLatch(1)
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/announcement") { exchange ->
            exchange.use {
                val request = requestCount.incrementAndGet()
                requests.add(request)
                if (request == 1) check(releaseFirst.await(15, TimeUnit.SECONDS))
                val body = """{"code":200,"body":{"title":"Announcement $request","content":"Test","publishTime":1}}"""
                val bytes = body.toByteArray()
                runCatching {
                    exchange.sendResponseHeaders(200, bytes.size.toLong())
                    exchange.responseBody.write(bytes)
                }
            }
        }
        server.start()
        val http = AnnouncementHttp({ URI.create("http://127.0.0.1:${server.address.port}/announcement") }, { "test" })
        val service = AnnouncementService(marker, store, http) {
            val status = if (hasAcceptedProductAgreement(
                    marker,
                    "2",
                )
            ) {
                revision.get()
            } else {
                AnnouncementAgreement.NOT_SIGNED
            }
            status.also { checks.add(it) }
        }
        try {
            fun markSigned() {
                val temporary = Files.createTempFile(directory, "acceptance-", ".tmp")
                Files.writeString(temporary, """{"version":"2"}""")
                Files.move(temporary, marker, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            }

            fun awaitCheck(expected: AnnouncementAgreement) {
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                while (true) {
                    val observed = checks.poll((deadline - System.nanoTime()).coerceAtLeast(0), TimeUnit.NANOSECONDS)
                    assertNotNull("The service did not observe $expected", observed)
                    if (observed == expected) return
                }
            }

            service.projectOpened(project)
            awaitCheck(AnnouncementAgreement.NOT_SIGNED)
            assertNull(requests.poll(200, TimeUnit.MILLISECONDS))

            markSigned()
            awaitCheck(AnnouncementAgreement.ACCEPTED)
            assertEquals(1, requests.poll(10, TimeUnit.SECONDS))
            revision.set(AnnouncementAgreement.REVIEW_REQUIRED)
            markSigned()
            awaitCheck(AnnouncementAgreement.REVIEW_REQUIRED)
            releaseFirst.countDown()
            assertNull(requests.poll(200, TimeUnit.MILLISECONDS))
            assertTrue(store.load().items.isEmpty())

            revision.set(AnnouncementAgreement.ACCEPTED)
            markSigned()
            awaitCheck(AnnouncementAgreement.ACCEPTED)
            assertEquals(2, requests.poll(10, TimeUnit.SECONDS))
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
            while (store.load().items.isEmpty() && System.nanoTime() < deadline) Thread.sleep(10)
            assertEquals(listOf("Announcement 2"), store.load().items.map { it.title })
        } finally {
            releaseFirst.countDown()
            Disposer.dispose(service)
            server.stop(0)
        }
    }
}
