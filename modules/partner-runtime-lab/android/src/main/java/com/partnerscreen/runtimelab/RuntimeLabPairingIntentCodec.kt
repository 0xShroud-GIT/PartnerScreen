package com.partnerscreen.runtimelab

import android.content.Intent
import android.util.Base64

internal object RuntimeLabPairingIntentCodec {
  const val EXTRA_PAIRING_QR = "partnerscreen_runtime_lab_pairing_qr"
  const val EXTRA_PAIRING_QR_B64 = "partnerscreen_runtime_lab_pairing_qr_b64"
  private const val PAIRING_QR_PREFIX = "PS1:"
  private const val PAIRING_QR_MAX_CHARS = 8_192
  private const val PAIRING_QR_B64_MAX_CHARS = 12_000

  fun take(intent: Intent?): String? {
    if (intent == null) return null
    val raw = intent.getStringExtra(EXTRA_PAIRING_QR)
    val encoded = intent.getStringExtra(EXTRA_PAIRING_QR_B64)
    intent.removeExtra(EXTRA_PAIRING_QR)
    intent.removeExtra(EXTRA_PAIRING_QR_B64)

    val candidate = when {
      !raw.isNullOrEmpty() -> raw
      !encoded.isNullOrEmpty() && encoded.length <= PAIRING_QR_B64_MAX_CHARS -> decode(encoded)
      else -> null
    } ?: return null

    if (candidate.length > PAIRING_QR_MAX_CHARS) return null
    if (!candidate.startsWith(PAIRING_QR_PREFIX)) return null
    if (candidate.any { it == '\u0000' || it == '\r' || it == '\n' }) return null
    return candidate
  }

  private fun decode(encoded: String): String? = try {
    val bytes = Base64.decode(encoded, Base64.NO_WRAP)
    try { bytes.toString(Charsets.UTF_8) }
    finally { bytes.fill(0) }
  } catch (_: Exception) {
    null
  }
}
