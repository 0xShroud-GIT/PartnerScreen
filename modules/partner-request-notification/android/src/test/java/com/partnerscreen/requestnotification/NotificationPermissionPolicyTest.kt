package com.partnerscreen.requestnotification

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
class NotificationPermissionPolicyTest {
  private val channelId = "partnerscreen_incoming_request"

  @Test
  @Config(sdk = [31, 32])
  fun android12And12LDoNotRequireRuntimeNotificationPermission() {
    val app = ApplicationProvider.getApplicationContext<Application>()
    shadowOf(app).denyPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
    assertEquals(NotificationPermissionPolicy.Capability.GRANTED, NotificationPermissionPolicy.capability(app, channelId))
  }

  @Test
  @Config(sdk = [33, 34, 35, 36])
  fun android13Through16ExposeRuntimePermissionRequirement() {
    val app = ApplicationProvider.getApplicationContext<Application>()
    val shadow = shadowOf(app)
    shadow.denyPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
    assertEquals(NotificationPermissionPolicy.Capability.RUNTIME_PERMISSION_REQUIRED, NotificationPermissionPolicy.capability(app, channelId))
    shadow.grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
    assertEquals(NotificationPermissionPolicy.Capability.GRANTED, NotificationPermissionPolicy.capability(app, channelId))
  }
}
