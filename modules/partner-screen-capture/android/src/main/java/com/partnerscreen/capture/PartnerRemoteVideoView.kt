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
      WebRtcEngine.getInstance().detachRenderer(renderer)
      boundSessionId = sessionId
      firstFrameSent = false
    }
    if (sessionId.isNotBlank() && isAttachedToWindow) {
      WebRtcEngine.getInstance().attachRenderer(sessionId, renderer)
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    val sessionId = boundSessionId
    if (!released && !sessionId.isNullOrBlank()) {
      WebRtcEngine.getInstance().attachRenderer(sessionId, renderer)
    }
  }

  override fun onDetachedFromWindow() {
    if (!released) WebRtcEngine.getInstance().detachRenderer(renderer)
    super.onDetachedFromWindow()
  }

  override fun onFirstFrameRendered() {
    val sessionId = boundSessionId ?: return
    if (firstFrameSent) return
    firstFrameSent = true
    post { if (!released && boundSessionId == sessionId) onFirstFrame(mapOf("sessionId" to sessionId)) }
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
        renderer.requestLayout()
        invalidate()
      }
    }
  }

  fun release() {
    if (released) return
    released = true
    WebRtcEngine.getInstance().detachRenderer(renderer)
    boundSessionId = null
    firstFrameSent = false
    renderer.release()
  }
}
