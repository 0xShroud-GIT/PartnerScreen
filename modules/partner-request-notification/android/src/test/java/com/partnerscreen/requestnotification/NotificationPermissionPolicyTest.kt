package com.partnerscreen.requestnotification

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
class NotificationPermissionPolicyTest {
  @Test
  @Config(sdk = [32])
  fun preAndroid13DoesNotRequireRuntimeNotificationPermission() {
    val app = ApplicationProvider.getApplicationContext<Application>()
    shadowOf(app).denyPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
    assertTrue(NotificationPermissionPolicy.isGranted(app))
  }

  @Test
  @Config(sdk = [33, 35])
  fun android13PlusReflectsGrantAndDenial() {
    val app = ApplicationProvider.getApplicationContext<Application>()
    val shadow = shadowOf(app)
    shadow.denyPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
    assertFalse(NotificationPermissionPolicy.isGranted(app))
    shadow.grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
    assertTrue(NotificationPermissionPolicy.isGranted(app))
    shadow.denyPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
    assertFalse(NotificationPermissionPolicy.isGranted(app))
  }
}
