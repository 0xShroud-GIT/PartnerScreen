package com.partnerscreen.capture

/**
 * Sanitized renderer observability bridge.
 *
 * Renderer lifecycle belongs to PartnerRemoteVideoView rather than WebRtcEngine: the view knows
 * when it is mounted/detached and when decoded frame geometry is actually delivered. Only bounded
 * dimensions/rotation and the current session id are forwarded through the existing media event
 * channel; no SDP, candidate, address, credential, or frame content is exposed.
 */
object RendererTelemetryBridge {
  @Volatile var listener: ((Map<String, Any>) -> Unit)? = null

  fun emitAttached(sessionId: String) {
    if (sessionId.isBlank()) return
    listener?.invoke(mapOf(
      "type" to "renderer",
      "sessionId" to sessionId,
      "attached" to true,
    ))
  }

  fun emitGeometry(sessionId: String, width: Int, height: Int, rotation: Int) {
    if (sessionId.isBlank()) return
    if (width !in 1..16384 || height !in 1..16384) return
    val normalizedRotation = ((rotation % 360) + 360) % 360
    if (normalizedRotation != 0 && normalizedRotation != 90 && normalizedRotation != 180 && normalizedRotation != 270) return
    listener?.invoke(mapOf(
      "type" to "renderer",
      "sessionId" to sessionId,
      "attached" to true,
      "width" to width,
      "height" to height,
      "rotation" to normalizedRotation,
    ))
  }

  fun emitDetached(sessionId: String) {
    if (sessionId.isBlank()) return
    listener?.invoke(mapOf(
      "type" to "renderer",
      "sessionId" to sessionId,
      "attached" to false,
    ))
  }
}
