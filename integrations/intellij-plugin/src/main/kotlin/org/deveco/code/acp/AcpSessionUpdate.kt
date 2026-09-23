package org.deveco.code.acp

import com.agentclientprotocol.model.SessionId
import com.agentclientprotocol.model.SessionUpdate

internal data class AcpSessionUpdate(val sessionId: SessionId, val update: SessionUpdate)
