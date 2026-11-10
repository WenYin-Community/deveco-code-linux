package org.deveco.code.session.ui.messages

import com.intellij.DynamicBundle
import org.deveco.code.MyMessageBundle
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

/**
 * Formats message timestamps with smart relative formatting rules.
 *
 * Display rules (based on UI design spec):
 * - < 1 minute: "刚刚" / "Just now"
 * - < 60 minutes: "20 分钟前" / "20 minutes ago"
 * - Today: "09:41"
 * - Yesterday: "昨天 18:05" / "Yesterday 18:05"
 * - This year: "10月1日 14:12" / "Oct 1 14:12"
 * - Earlier: "2025-12-30 14:12" / "Dec 30, 2025 14:12"
 *
 * Hover tooltip always shows full timestamp: "2026-10-01 14:12:00"
 */
internal object MessageTimeFormatter {

    private val HOVER_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
    private val EARLIER_DISPLAY_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")

    fun format(timestamp: Long, now: Long = System.currentTimeMillis()): String {
        val zone = ZoneId.systemDefault()
        val instant = Instant.ofEpochMilli(timestamp)
        val nowInstant = Instant.ofEpochMilli(now)
        val localDateTime = instant.atZone(zone).toLocalDateTime()
        val nowDateTime = nowInstant.atZone(zone).toLocalDateTime()
        val localDate = localDateTime.toLocalDate()
        val nowDate = nowDateTime.toLocalDate()
        val locale = DynamicBundle.getLocale()

        val minutesAgo = ChronoUnit.MINUTES.between(instant, nowInstant)

        return when {
            minutesAgo < 1 -> {
                MyMessageBundle.message("time.justNow")
            }

            minutesAgo < 60 -> {
                MyMessageBundle.message("time.minutesAgo", minutesAgo)
            }

            localDate == nowDate -> {
                localDateTime.format(DateTimeFormatter.ofPattern("HH:mm", locale))
            }

            localDate == nowDate.minusDays(1) -> {
                val timeStr = localDateTime.format(DateTimeFormatter.ofPattern("HH:mm", locale))
                MyMessageBundle.message("time.yesterdayWithTime", timeStr)
            }

            localDate.year == nowDate.year -> {
                val pattern = MyMessageBundle.message("time.pattern.thisYear")
                localDateTime.format(DateTimeFormatter.ofPattern(pattern, locale))
            }

            else -> {
                localDateTime.format(EARLIER_DISPLAY_FORMAT)
            }
        }
    }

    /** Returns the full timestamp string for hover tooltip: "2026-10-01 14:12:00" */
    fun formatHover(timestamp: Long): String {
        val zone = ZoneId.systemDefault()
        return Instant.ofEpochMilli(timestamp).atZone(zone).toLocalDateTime().format(HOVER_FORMAT)
    }

    /**
     * Formats the relative timestamp with a turn-status prefix, e.g.
     * "「已停止 · 刚刚」" / "Stopped · just now". [statusCode] is "stopped" or
     * "failed"; resolved against the message bundle so the label and layout
     * (brackets, separator) stay locale-specific.
     */
    fun formatWithStatus(timestamp: Long, statusCode: String, now: Long = System.currentTimeMillis()): String =
        MyMessageBundle.message(
            "message.timestamp.statusFormat",
            MyMessageBundle.message("message.status.$statusCode"),
            format(timestamp, now),
        )

    /** Same as [formatWithStatus] but for the hover tooltip's full timestamp. */
    fun formatHoverWithStatus(timestamp: Long, statusCode: String): String = MyMessageBundle.message(
        "message.timestamp.statusFormat",
        MyMessageBundle.message("message.status.$statusCode"),
        formatHover(timestamp),
    )
}
