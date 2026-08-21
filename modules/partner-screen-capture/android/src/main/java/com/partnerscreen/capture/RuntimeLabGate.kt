package com.partnerscreen.capture

import android.content.Context
import android.content.pm.ApplicationInfo

/** Native fail-closed gate for Runtime Laboratory hooks compiled into the module. */
internal object RuntimeLabGate {
  fun isDebuggable(context: Context): Boolean =
    (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
}
