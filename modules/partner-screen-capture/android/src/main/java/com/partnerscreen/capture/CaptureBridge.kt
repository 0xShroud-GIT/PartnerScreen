package com.partnerscreen.capture

object CaptureBridge {
  @Volatile var state: String = "idle"
    private set
  @Volatile var listener: ((Map<String, Any>) -> Unit)? = null
  @Volatile var stopRequest: ((String) -> Unit)? = null

  fun emit(type: String, sessionId: String?, reason: String? = null, code: String? = null) {
    state = when (type) {
      "starting" -> "starting"
      "started" -> "capturing"
      "stopped", "revoked", "error" -> "idle"
      else -> state
    }
    val event = mutableMapOf<String, Any>("type" to type)
    if (sessionId != null) event["sessionId"] = sessionId
    if (reason != null) event["reason"] = reason
    if (code != null) event["code"] = code
    listener?.invoke(event)
  }

  fun requestStop(reason: String) {
    val handler = stopRequest
    if (handler != null) handler(reason) else emit("stopped", null, reason)
  }
}
