package com.partnerscreen.requestnotification

import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/** Read-only Android notification capability query. Prompt ownership remains in foreground UI. */
internal object NotificationPermissionPolicy {
  enum class Capability(val wireValue: String) {
    GRANTED("granted"),
    RUNTIME_PERMISSION_REQUIRED("runtime_permission_required"),
    APP_DISABLED("app_disabled"),
    CHANNEL_DISABLED("channel_disabled"),
  }

  fun capability(context: Context, channelId: String): Capability {
    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      return Capability.RUNTIME_PERMISSION_REQUIRED
    }

    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) {
      return Capability.APP_DISABLED
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val manager = context.getSystemService(NotificationManager::class.java)
      val channel = manager?.getNotificationChannel(channelId)
      if (channel != null && channel.importance == NotificationManager.IMPORTANCE_NONE) {
        return Capability.CHANNEL_DISABLED
      }
    }

    return Capability.GRANTED
  }

  fun isAvailable(context: Context, channelId: String): Boolean =
    capability(context, channelId) == Capability.GRANTED
}
