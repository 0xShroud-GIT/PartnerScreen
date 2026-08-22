package com.partnerscreen.capture

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val CAPTURE_REQUEST_CODE = 7305
private data class CaptureGrant(val resultCode: Int, val data: Intent)

class PartnerScreenCaptureModule : Module() {
  private val lock = Any()
  private var consentPromise: Promise? = null
  private var pendingGrant: CaptureGrant? = null
  private val bridgeListener: (Map<String, Any>) -> Unit = { event -> sendEvent("onPartnerScreenCaptureEvent", event) }
  private val mediaListener = WebRtcEngine.EventListener { event -> sendEvent("onPartnerScreenMediaEvent", event) }
  private val rendererListener: (Map<String, Any>) -> Unit = { event -> sendEvent("onPartnerScreenMediaEvent", event) }

  override fun definition() = ModuleDefinition {
    Name("PartnerScreenCapture")
    Events("onPartnerScreenCaptureEvent", "onPartnerScreenMediaEvent")

    View(PartnerRemoteVideoView::class) {
      Events("onFirstFrame", "onFrameResolution")
      Prop("sessionId") { view: PartnerRemoteVideoView, value: String -> view.bindSession(value) }
      OnViewDestroys { view: PartnerRemoteVideoView -> view.release() }
    }

    OnCreate {
      CaptureBridge.listener = bridgeListener
      WebRtcEngine.getInstance().setEventListener(mediaListener)
      RendererTelemetryBridge.listener = rendererListener
    }

    AsyncFunction("requestConsent") { promise: Promise ->
      val activity = appContext.currentActivity
      val manager = activity?.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as? MediaProjectionManager
      if (activity == null || manager == null) {
        CaptureBridge.emit("error", null, code = "capture_unavailable")
        promise.resolve(false)
        return@AsyncFunction
      }
      synchronized(lock) {
        if (consentPromise != null || pendingGrant != null || CaptureBridge.state != "idle") {
          promise.resolve(false)
          return@AsyncFunction
        }
        consentPromise = promise
      }
      activity.runOnUiThread {
        try { activity.startActivityForResult(manager.createScreenCaptureIntent(), CAPTURE_REQUEST_CODE) }
        catch (_: Exception) {
          val pending = synchronized(lock) { pendingGrant = null; consentPromise.also { consentPromise = null } }
          CaptureBridge.emit("error", null, code = "capture_unavailable")
          pending?.resolve(false)
        }
      }
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != CAPTURE_REQUEST_CODE) return@OnActivityResult
      val resultData = payload.data
      val result = synchronized(lock) {
        val pending = consentPromise
        consentPromise = null
        if (pending == null) { pendingGrant = null; null }
        else {
          val granted = payload.resultCode == android.app.Activity.RESULT_OK && resultData != null
          pendingGrant = if (granted) CaptureGrant(payload.resultCode, Intent(resultData)) else null
          pending to granted
        }
      }
      result?.first?.resolve(result.second)
    }

    AsyncFunction("startCapture") { sessionId: String ->
      require(sessionId.isNotBlank()) { "Capture session is invalid." }
      val context = appContext.reactContext ?: throw IllegalStateException("Screen capture runtime is unavailable.")
      val grant = synchronized(lock) { val value = pendingGrant ?: throw IllegalStateException("A fresh screen capture grant is required."); pendingGrant = null; value }
      val intent = Intent(context, PartnerScreenCaptureService::class.java)
        .setAction(PartnerScreenCaptureService.ACTION_START)
        .putExtra(PartnerScreenCaptureService.EXTRA_RESULT_CODE, grant.resultCode)
        .putExtra(PartnerScreenCaptureService.EXTRA_RESULT_DATA, grant.data)
        .putExtra(PartnerScreenCaptureService.EXTRA_SESSION_ID, sessionId)
      CaptureBridge.emit("starting", sessionId)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
      true
    }

    AsyncFunction("stopCapture") { promise: Promise ->
      clearPendingConsent()
      if (CaptureBridge.state == "idle") {
        promise.resolve(true)
        return@AsyncFunction
      }
      val mainHandler = Handler(Looper.getMainLooper())
      var settled = false
      val settle = { ok: Boolean ->
        if (!settled) {
          settled = true
          promise.resolve(ok)
        }
      }
      CaptureBridge.waitForIdle { ok -> mainHandler.post { settle(ok) } }
      CaptureBridge.requestStop("user")
      mainHandler.postDelayed({ settle(false) }, 5_000)
    }
    Function("getState") { CaptureBridge.state }

    AsyncFunction("prepareRequesterMedia") { sessionId: String ->
      val context = appContext.reactContext ?: return@AsyncFunction false
      WebRtcEngine.getInstance().prepareRequester(context, sessionId)
    }
    AsyncFunction("createPublisherOffer") { sessionId: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) { promise.resolve(""); return@AsyncFunction }
      WebRtcEngine.getInstance().createPublisherOffer(context, sessionId, object : WebRtcEngine.SdpResult {
        override fun onSuccess(sdp: String) { promise.resolve(sdp) }
        override fun onFailure() { promise.resolve("") }
      })
    }
    AsyncFunction("acceptOffer") { sessionId: String, sdp: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) { promise.resolve(""); return@AsyncFunction }
      WebRtcEngine.getInstance().acceptOffer(context, sessionId, sdp, object : WebRtcEngine.SdpResult {
        override fun onSuccess(answer: String) { promise.resolve(answer) }
        override fun onFailure() { promise.resolve("") }
      })
    }
    AsyncFunction("acceptAnswer") { sessionId: String, sdp: String, promise: Promise ->
      WebRtcEngine.getInstance().acceptAnswer(sessionId, sdp, WebRtcEngine.Result { success -> promise.resolve(success) })
    }
    AsyncFunction("addIceCandidate") { sessionId: String, sdpMid: String, sdpMLineIndex: Int, candidate: String ->
      WebRtcEngine.getInstance().addRemoteIceCandidate(sessionId, sdpMid, sdpMLineIndex, candidate)
    }
    AsyncFunction("closeMedia") { sessionId: String -> WebRtcEngine.getInstance().closeMedia(sessionId); true }
    AsyncFunction("restartIce") { sessionId: String -> WebRtcEngine.getInstance().restartIce(sessionId) }
    AsyncFunction("getMediaStats") { sessionId: String, promise: Promise ->
      WebRtcEngine.getInstance().getStats(sessionId) { stats ->
        if (stats == null) promise.resolve(null) else promise.resolve(stats)
      }
    }

    OnActivityDestroys { clearPendingConsent() }
    OnDestroy {
      clearPendingConsent()
      if (CaptureBridge.listener === bridgeListener) CaptureBridge.listener = null
      if (RendererTelemetryBridge.listener === rendererListener) RendererTelemetryBridge.listener = null
      WebRtcEngine.getInstance().setEventListener(null)
    }
  }

  private fun clearPendingConsent() {
    val pending = synchronized(lock) { pendingGrant = null; consentPromise.also { consentPromise = null } }
    pending?.resolve(false)
  }
}