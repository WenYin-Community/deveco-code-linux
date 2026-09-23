package org.deveco.code.session.ui.messages

import org.deveco.code.MyMessageBundle
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.time.temporal.TemporalAdjusters
import java.util.Locale

/**
 * Formats message timestamps with smart relative formatting rules.
 *
 * Rules (based on UI design spec):
 * - Same day: "15:30"
 * - Within this week (Mon-Sun): "星期六 15:30"
 * - Within this year: "1月1日"
 * - Other year: "2025年12月31日"
 */
internal object MessageTimeFormatter {

    fun format(timestamp: Long, now: Long = System.currentTimeMillis()): String {
        val zone = ZoneId.systemDefault()
        val localDate = Instant.ofEpochMilli(timestamp).atZone(zone).toLocalDate()
        val nowDate = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()

        return when {
            localDate == nowDate -> {
                // 本自然日内: 15:30
                formatTime(timestamp, "HH:mm")
            }

            isWithinThisWeek(localDate, nowDate) -> {
                // 超出本自然日且本自然周内: 星期六 15:30
                val dayOfWeek = localDate.dayOfWeek.getDisplayName(TextStyle.FULL, Locale.CHINESE)
                "$dayOfWeek ${formatTime(timestamp, "HH:mm")}"
            }

            localDate.year == nowDate.year -> {
                // 一周以外且本自然年内: 1月1日
                "${localDate.monthValue}月${localDate.dayOfMonth}日"
            }

            else -> {
                // 本自然年外: 2025年12月31日
                "${localDate.year}年${localDate.monthValue}月${localDate.dayOfMonth}日"
            }
        }
    }

    private fun formatTime(timestamp: Long, pattern: String): String {
        val formatter = DateTimeFormatter.ofPattern(pattern)
        return Instant.ofEpochMilli(timestamp)
            .atZone(ZoneId.systemDefault())
            .format(formatter)
    }

    /**
     * Checks if [date] is within the current week (Monday to Sunday).
     * The current week starts on Monday of [nowDate]'s week.
     */
    private fun isWithinThisWeek(date: LocalDate, nowDate: LocalDate): Boolean {
        val weekStart = nowDate.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
        val weekEnd = nowDate.with(TemporalAdjusters.nextOrSame(DayOfWeek.SUNDAY))
        return date >= weekStart && date <= weekEnd && date != nowDate
    }
}

/**
 * Formats a duration in milliseconds to a human-readable localized string.
 *
 * Examples:
 * - 30000ms -> "30s" (English) / "30 秒" (Chinese)
 * - 923000ms -> "15m23s" (English) / "15 分 23 秒" (Chinese)
 * - 7200000ms -> "2h0m" (English) / "2 小时 0 分" (Chinese)
 */
internal fun formatDuration(ms: Long): String {
    val totalSeconds = (ms / 1000).toInt().coerceAtLeast(0)
    return when {
        totalSeconds < 60 -> MyMessageBundle.message("duration.seconds", totalSeconds)

        totalSeconds < 3600 -> {
            val minutes = totalSeconds / 60
            val seconds = totalSeconds % 60
            MyMessageBundle.message("duration.minutes", minutes, seconds)
        }

        else -> {
            val hours = totalSeconds / 3600
            val minutes = (totalSeconds % 3600) / 60
            MyMessageBundle.message("duration.hours", hours, minutes)
        }
    }
}
