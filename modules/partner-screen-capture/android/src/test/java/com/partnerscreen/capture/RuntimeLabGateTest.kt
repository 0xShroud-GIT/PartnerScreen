package com.partnerscreen.capture

import android.content.Context
import android.content.pm.ApplicationInfo
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class RuntimeLabGateTest {
  @Test
  fun gateRequiresDebuggableApplicationFlag() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val info = context.applicationInfo
    val original = info.flags
    try {
      info.flags = original and ApplicationInfo.FLAG_DEBUGGABLE.inv()
      assertFalse(RuntimeLabGate.isDebuggable(context))

      info.flags = info.flags or ApplicationInfo.FLAG_DEBUGGABLE
      assertTrue(RuntimeLabGate.isDebuggable(context))
    } finally {
      info.flags = original
    }
  }
}
