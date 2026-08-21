package com.partnerscreen.capture

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.roundToInt

class PartnerScreenCaptureService : Service() {
  companion object {
    const val ACTION_START = "com.partnerscreen.capture.START"
    const val ACTION_STOP = "com.partnerscreen.capture.STOP"
    const val EXTRA_RESULT_CODE = "resultCode"
    const val EXTRA_RESULT_DATA = "resultData"
    const val EXTRA_SESSION_ID = "sessionId"
    private const val CHANNEL_ID = "partnerscreen_screen_sharing"
    private const val NOTIFICATION_ID = 7305
    private const val ACTIVITY_RESULT_MISSING = Int.MIN_VALUE
    private const val CAPTURE_LONG_EDGE_PX = 1600.0
    private const val CAPTURE_FPS = 30
  }

  private val mainHandler = Handler(Looper.getMainLooper())
  private val engineExecutor = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "PartnerScreenCaptureEngine") }
  private var stopping = false
  private var captureStarting = false
  private var captureStarted = false
  private var captureSessionId: String? = null

  override fun onCreate() {
    super.onCreate()
    CaptureBridge.stopRequest = { reason -> mainHandler.post { stopInternal(reason, emitRevoked = false) } }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> stopInternal("notification", emitRevoked = false)
      ACTION_START -> startProjection(intent)
    }
    return START_NOT_STICKY
  }

  private fun startProjection(intent: Intent) {
    if (captureStarting || captureStarted || stopping) return
    val sessionId = intent.getStringExtra(EXTRA_SESSION_ID)
    if (sessionId == null) {
      stopSelf()
      return
    }
    captureStarting = true
    captureSessionId = sessionId
    try {
      createNotificationChannel()
      startForegroundCompat(buildNotification("Preparing screen sharing…"))

      val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, ACTIVITY_RESULT_MISSING)
      val resultData = readResultData(intent) ?: throw IllegalStateException("Missing capture grant.")
      if (resultCode != android.app.Activity.RESULT_OK) throw IllegalStateException("Screen capture grant was not approved.")
      val (width, height) = captureSize()

      engineExecutor.execute {
        try {
          WebRtcEngine.getInstance().startScreenCapture(
            applicationContext,
            resultData,
            width,
            height,
            CAPTURE_FPS,
            object : WebRtcEngine.CaptureListener {
              // The callback closes over the immutable sessionId of THIS start. It may only mutate
              // capture state or emit events while captureSessionId still equals that session (i.e.
              // this exact capture attempt is still the active one).
              override fun onStarted(success: Boolean) {
                mainHandler.post {
                  if (stopping) return@post
                  if (captureSessionId != sessionId) return@post
                  captureStarting = false
                  if (!success) {
                    CaptureBridge.emit("error", sessionId, code = "capture_start_failed")
                    stopInternal("service_destroyed", emitRevoked = false, emitStopped = false)
                    return@post
                  }
                  captureStarted = true
                  updateNotification(buildNotification("Screen sharing active"))
                  CaptureBridge.emit("started", sessionId)
                }
              }

              override fun onProjectionStopped() {
                mainHandler.post {
                  if (stopping) return@post
                  if (captureSessionId != sessionId) return@post
                  stopInternal("revoked", emitRevoked = true)
                }
              }
            },
          )
        } catch (_: Exception) {
          mainHandler.post {
            if (stopping) return@post
            if (captureSessionId != sessionId) return@post
            CaptureBridge.emit("error", sessionId, code = "capture_start_failed")
            stopInternal("service_destroyed", emitRevoked = false, emitStopped = false)
          }
        }
      }
    } catch (_: Exception) {
      if (captureSessionId == sessionId) {
        CaptureBridge.emit("error", sessionId, code = "capture_start_failed")
        stopInternal("service_destroyed", emitRevoked = false, emitStopped = false)
      }
    }
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    if (!captureStarted || stopping) return
    val (width, height) = captureSize()
    engineExecutor.execute { WebRtcEngine.getInstance().changeScreenCaptureFormat(width, height, CAPTURE_FPS) }
  }

  private fun stopInternal(reason: String, emitRevoked: Boolean, emitStopped: Boolean = true) {
    if (stopping) return
    stopping = true
    captureStarting = false
    captureStarted = false
    val sessionId = captureSessionId
    captureSessionId = null
    CaptureBridge.stopRequest = null
    engineExecutor.execute {
      WebRtcEngine.getInstance().stopScreenCapture()
      mainHandler.post {
        if (emitRevoked && sessionId != null) CaptureBridge.emit("revoked", sessionId)
        else if (emitStopped && sessionId != null) CaptureBridge.emit("stopped", sessionId, reason = normalizeStopReason(reason))
        try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (_: Exception) {}
        stopSelf()
      }
    }
  }

  override fun onDestroy() {
    if (!stopping && (captureStarting || captureStarted)) stopInternal("service_destroyed", emitRevoked = false)
    CaptureBridge.stopRequest = null
    engineExecutor.shutdown()
    super.onDestroy()
  }

  private fun captureSize(): Pair<Int, Int> {
    val metrics = resources.displayMetrics
    val rawWidth = max(1, metrics.widthPixels)
    val rawHeight = max(1, metrics.heightPixels)
    val scale = minOf(1.0, CAPTURE_LONG_EDGE_PX / max(rawWidth, rawHeight).toDouble())
    return evenAtLeastTwo(rawWidth * scale) to evenAtLeastTwo(rawHeight * scale)
  }

  private fun evenAtLeastTwo(value: Double): Int {
    val rounded = max(2, value.roundToInt())
    return if (rounded % 2 == 0) rounded else rounded - 1
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Screen sharing", NotificationManager.IMPORTANCE_LOW).apply {
        description = "PartnerScreen screen sharing controls"
        setShowBadge(false)
      },
    )
  }

  private fun buildNotification(text: String): Notification {
    val stopIntent = PendingIntent.getService(
      this,
      0,
      Intent(this, PartnerScreenCaptureService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID) else {
      @Suppress("DEPRECATION") Notification.Builder(this)
    }
    return builder
      .setSmallIcon(android.R.drawable.ic_menu_view)
      .setContentTitle("PartnerScreen")
      .setContentText(text)
      .setCategory(Notification.CATEGORY_SERVICE)
      .setOngoing(true)
      .addAction(Notification.Action.Builder(android.R.drawable.ic_media_pause, "Stop sharing", stopIntent).build())
      .build()
  }

  private fun startForegroundCompat(notification: Notification) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
    else startForeground(NOTIFICATION_ID, notification)
  }

  private fun updateNotification(notification: Notification) {
    (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION_ID, notification)
  }

  @Suppress("DEPRECATION")
  private fun readResultData(intent: Intent): Intent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java) else intent.getParcelableExtra(EXTRA_RESULT_DATA)

  private fun normalizeStopReason(reason: String): String = when (reason) {
    "user" -> "user"
    "notification" -> "notification"
    else -> "service_destroyed"
  }
}
