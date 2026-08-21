package com.partnerscreen.keepawake

import android.view.WindowManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PartnerKeepAwakeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PartnerKeepAwake")

    AsyncFunction("enable") {
      val activity = appContext.currentActivity ?: return@AsyncFunction false
      activity.runOnUiThread {
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      }
      true
    }

    AsyncFunction("disable") {
      val activity = appContext.currentActivity ?: return@AsyncFunction false
      activity.runOnUiThread {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      }
      true
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
