package com.partnerscreen.control

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Android-sanctioned lifecycle for trusted local availability/control while the process is alive.
 *
 * This foreground service currently keeps the process eligible for trusted local networking;
 * the actual control ServerSocket remains in PartnerControlModule's process-scoped native runtime.
 * A full process death therefore cannot reconstruct authenticated reachability yet and must fail closed.
 */
class PartnerTrustedPresenceService : Service() {
  companion object {
    const val ACTION_START = "com.partnerscreen.control.PRESENCE_START"
    private const val CHANNEL_ID = "partnerscreen_trusted_presence"
    private const val NOTIFICATION_ID = 7307

    @Volatile var running = false
      private set

    fun start(context: Context) {
      val intent = Intent(context, PartnerTrustedPresenceService::class.java).setAction(ACTION_START)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
      else context.startService(intent)
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, PartnerTrustedPresenceService::class.java))
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // START_STICKY may recreate the service with null Intent after full process death. Until a secure
    // native trust-store/listener reconstruction bridge exists, advertising "Available" would be false.
    if (intent?.action != ACTION_START) {
      running = false
      try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (_: Exception) {}
      stopSelf(startId)
      return START_NOT_STICKY
    }

    running = true
    createChannel()
    startForegroundCompat(buildNotification())
    return START_STICKY
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Trusted partner availability", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Keeps PartnerScreen reachable by your trusted partner on this Wi-Fi."
        setShowBadge(false)
      },
    )
  }

  private fun buildNotification(): Notification {
    val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val pending = if (launch != null) {
      PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    } else null
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID)
    else {
      @Suppress("DEPRECATION") Notification.Builder(this)
    }
    return builder
      .setSmallIcon(android.R.drawable.ic_menu_mylocation)
      .setContentTitle("PartnerScreen")
      .setContentText("Available to your trusted partner on this Wi-Fi")
      .setCategory(Notification.CATEGORY_SERVICE)
      .setOngoing(true)
      .setContentIntent(pending)
      .build()
  }

  private fun startForegroundCompat(notification: Notification) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }
}
