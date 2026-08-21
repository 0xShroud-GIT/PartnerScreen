package com.partnerscreen.keepawake

import android.view.WindowManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PartnerKeepAwakeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PartnerKeepAwake")

    AsyncFunction("enable") { promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      activity.runOnUiThread {
        try {
          activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
          val enabled = (activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) != 0
          promise.resolve(enabled)
        } catch (_: Exception) {
          promise.resolve(false)
        }
      }
    }

    AsyncFunction("disable") { promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      activity.runOnUiThread {
        try {
          activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
          val enabled = (activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) != 0
          promise.resolve(!enabled)
        } catch (_: Exception) {
          promise.resolve(false)
        }
      }
    }

    Function("isEnabled") {
      val activity = appContext.currentActivity ?: return@Function false
      (activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) != 0
    }

    OnActivityDestroys {
      // Activity recreation will create a new window; the flag will be re-applied by the viewer's useEffect if still active.
    }
  }
}
