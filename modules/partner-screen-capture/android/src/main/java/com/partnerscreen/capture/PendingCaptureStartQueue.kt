package com.partnerscreen.capture

import android.app.Activity
import android.content.Intent
import android.os.Build

/**
 * Production-owned Stop -> Start queue. The service consumes this exact helper;
 * JVM/Robolectric tests therefore exercise the same intent copying and latest-wins
 * semantics used on device instead of a parallel TypeScript model.
 */
internal class PendingCaptureStartQueue {
  private var pending: Intent? = null

  fun offer(raw: Intent): Boolean {
    val copy = copyValidStartIntent(raw) ?: return false
    pending = copy
    return true
  }

  fun take(): Intent? = pending.also { pending = null }

  fun clear() {
    pending = null
  }

  fun hasPending(): Boolean = pending != null

  private fun copyValidStartIntent(intent: Intent): Intent? {
    val sessionId = intent.getStringExtra(PartnerScreenCaptureService.EXTRA_SESSION_ID) ?: return null
    if (sessionId.isBlank()) return null
    val resultCode = intent.getIntExtra(PartnerScreenCaptureService.EXTRA_RESULT_CODE, Int.MIN_VALUE)
    val resultData = readResultData(intent) ?: return null
    if (resultCode != Activity.RESULT_OK) return null
    return Intent(PartnerScreenCaptureService.ACTION_START).apply {
      putExtra(PartnerScreenCaptureService.EXTRA_SESSION_ID, sessionId)
      putExtra(PartnerScreenCaptureService.EXTRA_RESULT_CODE, resultCode)
      putExtra(PartnerScreenCaptureService.EXTRA_RESULT_DATA, Intent(resultData))
    }
  }

  @Suppress("DEPRECATION")
  private fun readResultData(intent: Intent): Intent? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableExtra(PartnerScreenCaptureService.EXTRA_RESULT_DATA, Intent::class.java)
    } else {
      intent.getParcelableExtra(PartnerScreenCaptureService.EXTRA_RESULT_DATA)
    }
}
