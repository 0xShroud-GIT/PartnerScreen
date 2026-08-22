package com.partnerscreen.capture

import android.content.Context
import android.view.ViewGroup
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer

class PartnerRemoteVideoView(context: Context, appContext: AppContext) : ExpoView(context, appContext), RendererCommon.RendererEvents {
  private val onFirstFrame by EventDispatcher()
  private val onFrameResolution by EventDispatcher()
  private val renderer = SurfaceViewRenderer(context)
  private var boundSessionId: String? = null
  private var firstFrameSent = false
  private var released = false

  init {
    val engine = WebRtcEngine.getInstance()
    renderer.init(engine.getEglContext(context), this)
    renderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
    renderer.setEnableHardwareScaler(true)
    renderer.setMirror(false)
    addView(renderer, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
  }

  fun bindSession(sessionId: String) {
    if (released) return
    if (boundSessionId != sessionId) {
      val previousSessionId = boundSessionId
      WebRtcEngine.getInstance().detachRenderer(renderer)
      if (!previousSessionId.isNullOrBlank()) RendererTelemetryBridge.emitDetached(previousSessionId)
      boundSessionId = sessionId
      firstFrameSent = false
    }
    if (sessionId.isNotBlank() && isAttachedToWindow) attachCurrentRenderer(sessionId)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    val sessionId = boundSessionId
    if (!released && !sessionId.isNullOrBlank()) attachCurrentRenderer(sessionId)
  }

  override fun onDetachedFromWindow() {
    if (!released) {
      val sessionId = boundSessionId
      WebRtcEngine.getInstance().detachRenderer(renderer)
      if (!sessionId.isNullOrBlank()) RendererTelemetryBridge.emitDetached(sessionId)
    }
    super.onDetachedFromWindow()
  }

  override fun onFirstFrameRendered() {
    val sessionId = boundSessionId ?: return
    if (firstFrameSent) return
    firstFrameSent = true
    post {
      if (!released && boundSessionId == sessionId) {
        RendererTelemetryBridge.emitAttached(sessionId)
        onFirstFrame(mapOf("sessionId" to sessionId))
      }
    }
  }

  override fun onFrameResolutionChanged(videoWidth: Int, videoHeight: Int, rotation: Int) {
    val sessionId = boundSessionId
    post {
      if (!released && sessionId != null && boundSessionId == sessionId) {
        onFrameResolution(mapOf(
          "sessionId" to sessionId,
          "width" to videoWidth,
          "height" to videoHeight,
          "rotation" to rotation,
        ))
        RendererTelemetryBridge.emitGeometry(sessionId, videoWidth, videoHeight, rotation)
        renderer.requestLayout()
        invalidate()
      }
    }
  }

  fun release() {
    if (released) return
    released = true
    val sessionId = boundSessionId
    WebRtcEngine.getInstance().detachRenderer(renderer)
    if (!sessionId.isNullOrBlank()) RendererTelemetryBridge.emitDetached(sessionId)
    boundSessionId = null
    firstFrameSent = false
    renderer.release()
  }

  private fun attachCurrentRenderer(sessionId: String) {
    if (WebRtcEngine.getInstance().attachRenderer(sessionId, renderer)) {
      RendererTelemetryBridge.emitAttached(sessionId)
    }
  }
}
