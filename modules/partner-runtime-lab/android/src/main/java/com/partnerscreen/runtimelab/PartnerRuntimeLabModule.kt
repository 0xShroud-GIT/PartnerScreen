package com.partnerscreen.runtimelab

import android.content.Context
import android.content.pm.ApplicationInfo
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PartnerRuntimeLabModule : Module() {
  private val lock = Any()
  private var pendingPairingQr: String? = null

  override fun definition() = ModuleDefinition {
    Name("PartnerRuntimeLab")

    AsyncFunction("consumePairingQr") {
      val context = appContext.reactContext ?: return@AsyncFunction null
      if (!isDebuggable(context)) return@AsyncFunction null

      synchronized(lock) {
        val pending = pendingPairingQr
        if (pending != null) {
          pendingPairingQr = null
          return@AsyncFunction pending
        }
      }

      val activity = appContext.currentActivity ?: return@AsyncFunction null
      RuntimeLabPairingIntentCodec.take(activity.intent)
    }

    OnNewIntent { intent ->
      val context = appContext.reactContext ?: return@OnNewIntent
      if (!isDebuggable(context)) return@OnNewIntent
      val payload = RuntimeLabPairingIntentCodec.take(intent) ?: return@OnNewIntent
      synchronized(lock) { pendingPairingQr = payload }
    }

    OnActivityEntersForeground {
      val context = appContext.reactContext ?: return@OnActivityEntersForeground
      if (!isDebuggable(context)) return@OnActivityEntersForeground
      val activity = appContext.currentActivity ?: return@OnActivityEntersForeground
      val payload = RuntimeLabPairingIntentCodec.take(activity.intent) ?: return@OnActivityEntersForeground
      synchronized(lock) { if (pendingPairingQr == null) pendingPairingQr = payload }
    }

    OnDestroy {
      synchronized(lock) { pendingPairingQr = null }
    }
  }

  private fun isDebuggable(context: Context): Boolean =
    (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
}
