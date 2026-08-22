package com.partnerscreen.capture

import android.content.Context
import android.view.ViewGroup
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer

class PartnerRemoteVideoView(context: Context, appContext: AppContext) : ExpoView(context, appContext), RendererCommon.RendererEvents {
  private val onFirstFrame by EventDispatcher()
  private val onFrameResolution by EventDispatcher()
  private val renderer = SurfaceViewRenderer(context)
  private val bindingExecutor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "PartnerScreenRendererBinding").apply { isDaemon = true }
  }
  @Volatile private var boundSessionId: String? = null
  @Volatile private var boundTrackEpoch = 0
  @Volatile private var firstFrameSent = false
  @Volatile private var released = false
  @Volatile private var bindingGeneration = 0L

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
      bindingGeneration += 1
      boundSessionId = sessionId
      firstFrameSent = false
      if (!previousSessionId.isNullOrBlank()) queueDetach(previousSessionId)
    }
    if (sessionId.isNotBlank() && isAttachedToWindow) queueAttach(sessionId)
  }

  fun bindTrackEpoch(trackEpoch: Int) {
    if (released) return
    if (boundTrackEpoch != trackEpoch) {
      boundTrackEpoch = trackEpoch
      firstFrameSent = false
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    val sessionId = boundSessionId
    if (!released && !sessionId.isNullOrBlank()) queueAttach(sessionId)
  }

  override fun onDetachedFromWindow() {
    if (!released) {
      val sessionId = boundSessionId
      if (!sessionId.isNullOrBlank()) queueDetach(sessionId)
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
    bindingGeneration += 1
    val sessionId = boundSessionId
    boundSessionId = null
    firstFrameSent = false
    try {
      bindingExecutor.execute {
        WebRtcEngine.getInstance().detachRenderer(renderer)
        if (!sessionId.isNullOrBlank()) RendererTelemetryBridge.emitDetached(sessionId)
        try { renderer.release() } catch (_: Exception) { }
        bindingExecutor.shutdown()
      }
    } catch (_: RejectedExecutionException) {
      // A repeated teardown must never block the Android UI thread.
    }
  }

  private fun queueAttach(sessionId: String) {
    val generation = bindingGeneration
    try {
      bindingExecutor.execute {
        if (released || generation != bindingGeneration || boundSessionId != sessionId) return@execute
        val attached = WebRtcEngine.getInstance().attachRenderer(sessionId, renderer)
        if (attached && !released && generation == bindingGeneration && boundSessionId == sessionId) {
          RendererTelemetryBridge.emitAttached(sessionId)
        } else if (attached) {
          WebRtcEngine.getInstance().detachRenderer(renderer)
        }
      }
    } catch (_: RejectedExecutionException) {
      // View teardown already owns renderer cleanup.
    }
  }

  private fun queueDetach(sessionId: String) {
    try {
      bindingExecutor.execute {
        WebRtcEngine.getInstance().detachRenderer(renderer)
        RendererTelemetryBridge.emitDetached(sessionId)
      }
    } catch (_: RejectedExecutionException) {
      // View teardown already owns renderer cleanup.
    }
  }
}
