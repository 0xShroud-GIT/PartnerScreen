package com.partnerscreen.capture

import android.content.Context
import android.content.pm.ApplicationInfo

/** Native fail-closed gate for Runtime Laboratory hooks compiled into the module. */
object RuntimeLabGate {
  @JvmStatic
  fun isDebuggable(context: Context): Boolean =
    (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
}
