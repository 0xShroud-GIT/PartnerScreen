package com.partnerscreen.requestnotification

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PartnerRequestNotificationModule : Module() {
  companion object {
    private const val CHANNEL_ID = "partnerscreen_incoming_request"
    private const val NOTIFICATION_ID = 7306
    const val EXTRA_KIND = "partnerscreen_notification"
    const val EXTRA_SESSION_ID = "partnerscreen_sessionId"
    const val KIND_INCOMING_REQUEST = "incoming_request"
    private const val INCOMING_REQUEST_SCHEME = "partnerscreen"
    private const val INCOMING_REQUEST_HOST = "incoming-request"
    private val SESSION_ID_RE = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)
  }

  override fun definition() = ModuleDefinition {
    Name("PartnerRequestNotification")
    Events("onIncomingRequestOpened")

    AsyncFunction("showRequestNotification") { sessionId: String, partnerName: String ->
      val context = appContext.reactContext ?: return@AsyncFunction false
      if (!hasNotificationPermission(context)) {
        return@AsyncFunction false
      }
      createChannel(context)
      val launchIntent = Intent(Intent.ACTION_VIEW, incomingRequestUri(sessionId)).apply {
        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        setPackage(context.packageName)
        putExtra(EXTRA_KIND, KIND_INCOMING_REQUEST)
        putExtra(EXTRA_SESSION_ID, sessionId)
      }
      val pendingIntent = PendingIntent.getActivity(
        context,
        sessionId.hashCode(),
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

    AsyncFunction("consumeLaunchSessionId") {
      val activity = appContext.currentActivity ?: return@AsyncFunction null
      takeIncomingSessionId(activity.intent)
    }

    OnNewIntent { intent ->
      val sessionId = takeIncomingSessionId(intent) ?: return@OnNewIntent
      sendEvent("onIncomingRequestOpened", mapOf("sessionId" to sessionId))
    }

    OnActivityEntersForeground {
      val activity = appContext.currentActivity ?: return@OnActivityEntersForeground
      val sessionId = takeIncomingSessionId(activity.intent) ?: return@OnActivityEntersForeground
      sendEvent("onIncomingRequestOpened", mapOf("sessionId" to sessionId))
    }
  }

  private fun incomingRequestUri(sessionId: String): Uri =
    Uri.parse("$INCOMING_REQUEST_SCHEME://$INCOMING_REQUEST_HOST/$sessionId")

  private fun parseIncomingRequestSessionId(raw: String?): String? {
    if (raw.isNullOrBlank() || raw.length > 256) return null
    val uri = Uri.parse(raw.trim())
    if (!INCOMING_REQUEST_SCHEME.equals(uri.scheme, ignoreCase = true)) return null
    if (!INCOMING_REQUEST_HOST.equals(uri.host, ignoreCase = true)) return null
    val sessionId = uri.pathSegments.singleOrNull() ?: return null
    if (!SESSION_ID_RE.matches(sessionId)) return null
    return sessionId.lowercase()
  }

  private fun takeIncomingSessionId(intent: Intent?): String? {
    if (intent == null) return null
    val extraKind = intent.getStringExtra(EXTRA_KIND)
    val extraSessionId = intent.getStringExtra(EXTRA_SESSION_ID)
    val fromExtra = if (extraKind == KIND_INCOMING_REQUEST && !extraSessionId.isNullOrBlank() && SESSION_ID_RE.matches(extraSessionId)) {
      extraSessionId.lowercase()
    } else {
      null
    }
    val sessionId = fromExtra ?: parseIncomingRequestSessionId(intent.dataString) ?: return null
    intent.removeExtra(EXTRA_KIND)
    intent.removeExtra(EXTRA_SESSION_ID)
    intent.data = null
    return sessionId
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
