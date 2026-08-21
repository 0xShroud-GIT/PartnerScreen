package com.partnerscreen.capture

object CaptureBridge {
  @Volatile var state: String = "idle"
    private set
  @Volatile var listener: ((Map<String, Any>) -> Unit)? = null
  @Volatile var stopRequest: ((String) -> Unit)? = null
  private val idleLock = Any()
  private val idleWaiters = mutableListOf<(Boolean) -> Unit>()

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
    if (state == "idle") flushIdleWaiters(true)
  }

  fun waitForIdle(callback: (Boolean) -> Unit) {
    if (state == "idle") {
      callback(true)
      return
    }
    synchronized(idleLock) {
      if (state == "idle") {
        callback(true)
        return
      }
      idleWaiters.add(callback)
    }
  }

  fun requestStop(reason: String) {
    val handler = stopRequest
    if (handler != null) handler(reason) else emit("stopped", null, reason)
  }

  private fun flushIdleWaiters(success: Boolean) {
    val waiters = synchronized(idleLock) {
      val copy = idleWaiters.toList()
      idleWaiters.clear()
      copy
    }
    waiters.forEach { it(success) }
  }
}
