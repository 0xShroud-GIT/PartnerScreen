package com.chirp.requestnotification

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ChirpRequestNotificationModule : Module() {
  companion object {
    private const val CHANNEL_ID = "chirp_incoming_request"
    private const val NOTIFICATION_ID = 7306
    const val EXTRA_KIND = IncomingRequestIntentCodec.EXTRA_KIND
    const val EXTRA_SESSION_ID = IncomingRequestIntentCodec.EXTRA_SESSION_ID
    const val KIND_INCOMING_REQUEST = IncomingRequestIntentCodec.KIND_INCOMING_REQUEST
  }

  override fun definition() = ModuleDefinition {
    Name("ChirpRequestNotification")
    Events("onIncomingRequestOpened")

    AsyncFunction("showRequestNotification") { sessionId: String, partnerName: String ->
      val context = appContext.reactContext ?: return@AsyncFunction false
      if (!NotificationPermissionPolicy.isAvailable(context, CHANNEL_ID)) {
        return@AsyncFunction false
      }
      createChannel(context)
      val launchIntent = try {
        IncomingRequestIntentCodec.buildLaunchIntent(context, sessionId)
      } catch (_: IllegalArgumentException) {
        return@AsyncFunction false
      }
      val pendingIntent = PendingIntent.getActivity(
        context,
        sessionId.hashCode(),
        launchIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      val sanitizedName = partnerName.take(40).replace(Regex("[^\\p{Print}]"), "")
      val title = "Chirp — Screen request"
      val text = if (sanitizedName.isNotBlank()) {
        "Trusted partner $sanitizedName is requesting your screen."
      } else {
        "Trusted partner is requesting your screen."
      }
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
      NotificationPermissionPolicy.isAvailable(context, CHANNEL_ID)
    }

    Function("notificationCapability") {
      val context = appContext.reactContext ?: return@Function "app_disabled"
      NotificationPermissionPolicy.capability(context, CHANNEL_ID).wireValue
    }

    AsyncFunction("consumeLaunchSessionId") {
      val activity = appContext.currentActivity ?: return@AsyncFunction null
      IncomingRequestIntentCodec.take(activity.intent)
    }

    OnNewIntent { intent ->
      val sessionId = IncomingRequestIntentCodec.take(intent) ?: return@OnNewIntent
      sendEvent("onIncomingRequestOpened", mapOf("sessionId" to sessionId))
    }

    OnActivityEntersForeground {
      val activity = appContext.currentActivity ?: return@OnActivityEntersForeground
      val sessionId = IncomingRequestIntentCodec.take(activity.intent) ?: return@OnActivityEntersForeground
      sendEvent("onIncomingRequestOpened", mapOf("sessionId" to sessionId))
    }
  }

  private fun createChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    val existing = manager.getNotificationChannel(CHANNEL_ID)
    if (existing != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Incoming screen requests",
      NotificationManager.IMPORTANCE_HIGH,
    ).apply {
      description = "Shows when your trusted partner requests your screen, even while the app is backgrounded."
      setShowBadge(false)
      enableVibration(true)
    }
    manager.createNotificationChannel(channel)
  }
}
