package org.deveco.code.session

import com.intellij.util.messages.Topic

fun interface SessionRefreshListener {
    fun onSessionsChanged()
}

val SESSION_REFRESH_TOPIC: Topic<SessionRefreshListener> = Topic.create(
    "DevEco Sessions Refresh",
    SessionRefreshListener::class.java,
)
