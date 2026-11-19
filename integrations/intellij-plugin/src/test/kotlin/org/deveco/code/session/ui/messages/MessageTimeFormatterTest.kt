package org.deveco.code.session.ui.messages

import com.intellij.DynamicBundle
import org.deveco.code.MyMessageBundle
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.TimeZone

/**
 * Unit tests for [MessageTimeFormatter]. Both the timestamp and "now" are
 * pinned to a fixed zone so the date arithmetic (just-now / minutes-ago /
 * today / yesterday / this-year / earlier) is deterministic on any machine.
 * Localized strings are resolved through the same message bundle the
 * formatter uses, so the assertions verify BRANCH SELECTION and clock
 * formatting rather than one hard-wired locale.
 */
class MessageTimeFormatterTest {

    private val zone: ZoneId = ZoneId.of("Asia/Shanghai")
    private val savedTimeZone: TimeZone = TimeZone.getDefault()
    private val now: LocalDateTime = LocalDateTime.of(2026, 11, 12, 15, 0)

    @Before
    fun pinSystemTimeZone() {
        TimeZone.setDefault(TimeZone.getTimeZone(zone))
    }

    @After
    fun restoreSystemTimeZone() {
        TimeZone.setDefault(savedTimeZone)
    }

    private fun epochMs(dateTime: LocalDateTime): Long = dateTime.atZone(zone).toInstant().toEpochMilli()

    @Test
    fun lessThanAMinuteAgoShowsJustNow() {
        assertEquals(
            MyMessageBundle.message("time.justNow"),
            MessageTimeFormatter.format(epochMs(now.minusSeconds(30)), epochMs(now)),
        )
    }

    @Test
    fun futureTimestampsClampToJustNow() {
        assertEquals(
            MyMessageBundle.message("time.justNow"),
            MessageTimeFormatter.format(epochMs(now.plusMinutes(5)), epochMs(now)),
        )
    }

    @Test
    fun exactlyOneMinuteAgoEntersMinutesAgoBranch() {
        assertEquals(
            MyMessageBundle.message("time.minutesAgo", 1L),
            MessageTimeFormatter.format(epochMs(now.minusMinutes(1)), epochMs(now)),
        )
    }

    @Test
    fun fiftyNineMinutesAgoIsStillMinutesAgo() {
        assertEquals(
            MyMessageBundle.message("time.minutesAgo", 59L),
            MessageTimeFormatter.format(epochMs(now.minusMinutes(59)), epochMs(now)),
        )
    }

    @Test
    fun ninetyMinutesSameDayShowsClockTime() {
        assertEquals("13:30", MessageTimeFormatter.format(epochMs(now.minusMinutes(90)), epochMs(now)))
    }

    @Test
    fun yesterdayShowsYesterdayLabelWithTime() {
        val ts = LocalDateTime.of(2026, 11, 11, 18, 5)

        assertEquals(
            MyMessageBundle.message("time.yesterdayWithTime", "18:05"),
            MessageTimeFormatter.format(epochMs(ts), epochMs(now)),
        )
    }

    @Test
    fun crossingMidnightWithinTwoHoursStillCountsAsYesterday() {
        val lateNightNow = LocalDateTime.of(2026, 11, 12, 1, 30)
        val ts = LocalDateTime.of(2026, 11, 11, 23, 0)

        assertEquals(
            MyMessageBundle.message("time.yesterdayWithTime", "23:00"),
            MessageTimeFormatter.format(epochMs(ts), epochMs(lateNightNow)),
        )
    }

    @Test
    fun sameYearEarlierDateUsesThisYearPattern() {
        val ts = LocalDateTime.of(2026, 6, 1, 9, 41)

        val expected = ts.format(
            DateTimeFormatter.ofPattern(MyMessageBundle.message("time.pattern.thisYear"), DynamicBundle.getLocale()),
        )
        assertEquals(expected, MessageTimeFormatter.format(epochMs(ts), epochMs(now)))
    }

    @Test
    fun crossYearTimestampShowsFullDate() {
        val ts = LocalDateTime.of(2025, 12, 30, 14, 12)

        assertEquals("2025-12-30 14:12", MessageTimeFormatter.format(epochMs(ts), epochMs(now)))
    }

    @Test
    fun crossYearYesterdayStillShowsYesterdayLabel() {
        val newYearNow = LocalDateTime.of(2027, 1, 1, 10, 0)
        val ts = LocalDateTime.of(2026, 12, 31, 23, 0)

        assertEquals(
            MyMessageBundle.message("time.yesterdayWithTime", "23:00"),
            MessageTimeFormatter.format(epochMs(ts), epochMs(newYearNow)),
        )
    }

    @Test
    fun newYearBoundaryBeyondYesterdayLandsInEarlierBranch() {
        val newYearNow = LocalDateTime.of(2027, 1, 2, 10, 0)
        val ts = LocalDateTime.of(2026, 12, 31, 23, 0)

        assertEquals("2026-12-31 23:00", MessageTimeFormatter.format(epochMs(ts), epochMs(newYearNow)))
    }

    @Test
    fun hoverShowsFullTimestampWithSeconds() {
        val ts = LocalDateTime.of(2026, 10, 1, 14, 12, 0)

        assertEquals("2026-10-01 14:12:00", MessageTimeFormatter.formatHover(epochMs(ts)))
    }

    @Test
    fun formatWithStatusCombinesStatusLabelAndRelativeTime() {
        val expected = MyMessageBundle.message(
            "message.timestamp.statusFormat",
            MyMessageBundle.message("message.status.stopped"),
            MyMessageBundle.message("time.minutesAgo", 20L),
        )

        assertEquals(
            expected,
            MessageTimeFormatter.formatWithStatus(epochMs(now.minusMinutes(20)), "stopped", epochMs(now)),
        )
    }

    @Test
    fun formatHoverWithStatusCombinesStatusLabelAndFullTimestamp() {
        val ts = LocalDateTime.of(2025, 12, 30, 14, 12)
        val expected = MyMessageBundle.message(
            "message.timestamp.statusFormat",
            MyMessageBundle.message("message.status.failed"),
            "2025-12-30 14:12:00",
        )

        assertEquals(expected, MessageTimeFormatter.formatHoverWithStatus(epochMs(ts), "failed"))
    }
}
