package com.partnerscreen.runtimelab

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PartnerRuntimeLabModule : Module() {
  companion object {
    const val EXTRA_PAIRING_QR = "partnerscreen_runtime_lab_pairing_qr"
    const val EXTRA_PAIRING_QR_B64 = "partnerscreen_runtime_lab_pairing_qr_b64"
    private const val PAIRING_QR_PREFIX = "PS1:"
    private const val PAIRING_QR_MAX_CHARS = 8_192
    private const val PAIRING_QR_B64_MAX_CHARS = 12_000
  }

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
      takePairingQr(activity.intent)
    }

    OnNewIntent { intent ->
      val context = appContext.reactContext ?: return@OnNewIntent
      if (!isDebuggable(context)) return@OnNewIntent
      val payload = takePairingQr(intent) ?: return@OnNewIntent
      synchronized(lock) { pendingPairingQr = payload }
    }

    OnActivityEntersForeground {
      val context = appContext.reactContext ?: return@OnActivityEntersForeground
      if (!isDebuggable(context)) return@OnActivityEntersForeground
      val activity = appContext.currentActivity ?: return@OnActivityEntersForeground
      val payload = takePairingQr(activity.intent) ?: return@OnActivityEntersForeground
      synchronized(lock) { if (pendingPairingQr == null) pendingPairingQr = payload }
    }

    OnDestroy {
      synchronized(lock) { pendingPairingQr = null }
    }
  }

  private fun takePairingQr(intent: Intent?): String? {
    if (intent == null) return null
    val raw = intent.getStringExtra(EXTRA_PAIRING_QR)
    val encoded = intent.getStringExtra(EXTRA_PAIRING_QR_B64)
    intent.removeExtra(EXTRA_PAIRING_QR)
    intent.removeExtra(EXTRA_PAIRING_QR_B64)

    val candidate = when {
      !raw.isNullOrEmpty() -> raw
      !encoded.isNullOrEmpty() && encoded.length <= PAIRING_QR_B64_MAX_CHARS -> decodePairingQr(encoded)
      else -> null
    } ?: return null

    if (candidate.length > PAIRING_QR_MAX_CHARS) return null
    if (!candidate.startsWith(PAIRING_QR_PREFIX)) return null
    if (candidate.any { it == '\u0000' || it == '\r' || it == '\n' }) return null
    return candidate
  }

  private fun decodePairingQr(encoded: String): String? = try {
    val bytes = Base64.decode(encoded, Base64.NO_WRAP)
    try { bytes.toString(Charsets.UTF_8) }
    finally { bytes.fill(0) }
  } catch (_: Exception) {
    null
  }

  private fun isDebuggable(context: Context): Boolean =
    (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
}
