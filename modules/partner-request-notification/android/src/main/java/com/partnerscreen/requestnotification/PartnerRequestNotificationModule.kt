package com.partnerscreen.requestnotification

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PartnerRequestNotificationModule : Module() {
  companion object {
    private const val CHANNEL_ID = "partnerscreen_incoming_request"
    private const val NOTIFICATION_ID = 7306
  }

  override fun definition() = ModuleDefinition {
    Name("PartnerRequestNotification")

    AsyncFunction("showRequestNotification") { sessionId: String, partnerName: String ->
      val context = appContext.reactContext ?: return@AsyncFunction false
      if (!hasNotificationPermission(context)) {
        return@AsyncFunction false
      }
      createChannel(context)
      val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        putExtra("partnerscreen_notification", "incoming_request")
        putExtra("partnerscreen_sessionId", sessionId)
      } ?: Intent().apply {
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
      }
      val pendingIntent = PendingIntent.getActivity(
        context,
        0,
        launchIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      val sanitizedName = partnerName.take(40).replace(Regex("[^\\p{Print}]"), "")
      val title = "PartnerScreen — Screen request"
      val text = if (sanitizedName.isNotBlank()) "Trusted partner $sanitizedName is requesting your screen." else "Trusted partner is requesting your screen."
      val notification = NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.ic_menu_view)
        .setContentTitle(title)
        .setContentText(text)
        .setStyle(NotificationCompat.BigTextStyle().bigText(text))
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setAutoCancel(true)
        .setOngoing(false)
        .setContentIntent(pendingIntent)
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .build()
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.notify(NOTIFICATION_ID, notification)
      true
    }

    AsyncFunction("clearRequestNotification") {
      val context = appContext.reactContext ?: return@AsyncFunction false
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.cancel(NOTIFICATION_ID)
      true
    }

    Function("hasNotificationPermission") {
      val context = appContext.reactContext ?: return@Function false
      hasNotificationPermission(context)
    }
  }

  private fun hasNotificationPermission(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
    return ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
  }

  private fun createChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java)
    val existing = manager.getNotificationChannel(CHANNEL_ID)
    if (existing != null) return
    val channel = NotificationChannel(CHANNEL_ID, "Incoming screen requests", NotificationManager.IMPORTANCE_HIGH).apply {
      description = "Shows when your trusted partner requests your screen, even while the app is backgrounded."
      setShowBadge(false)
      enableVibration(true)
    }
    manager.createNotificationChannel(channel)
  }
}
