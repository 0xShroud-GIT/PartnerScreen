package com.partnerscreen.capture

import android.app.Activity
import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33, 35])
class PendingCaptureStartQueueTest {
  private val sessionA = "33333333-3333-4333-8333-333333333333"
  private val sessionB = "88888888-8888-4888-8888-888888888888"

  @Test
  fun latestValidStartWinsAndIntentIsDefensivelyCopied() {
    val queue = PendingCaptureStartQueue()
    val originalA = startIntent(sessionA, "grant-a")
    val originalB = startIntent(sessionB, "grant-b")

    assertTrue(queue.offer(originalA))
    assertTrue(queue.offer(originalB))
    originalB.putExtra(PartnerScreenCaptureService.EXTRA_SESSION_ID, "mutated-after-queue")

    val queued = queue.take()
    assertEquals(PartnerScreenCaptureService.ACTION_START, queued?.action)
    assertEquals(sessionB, queued?.getStringExtra(PartnerScreenCaptureService.EXTRA_SESSION_ID))
    assertEquals(Activity.RESULT_OK, queued?.getIntExtra(PartnerScreenCaptureService.EXTRA_RESULT_CODE, Int.MIN_VALUE))
    assertEquals("grant-b", readGrant(queued)?.action)
    assertFalse(queue.hasPending())
    assertNull(queue.take())
  }

  @Test
  fun invalidStartNeverReplacesAValidQueuedStart() {
    val queue = PendingCaptureStartQueue()
    assertTrue(queue.offer(startIntent(sessionA, "grant-a")))
    assertFalse(queue.offer(Intent(PartnerScreenCaptureService.ACTION_START)))
    assertFalse(queue.offer(startIntent(sessionB, "grant-b").putExtra(PartnerScreenCaptureService.EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)))

    assertEquals(sessionA, queue.take()?.getStringExtra(PartnerScreenCaptureService.EXTRA_SESSION_ID))
  }

  private fun startIntent(sessionId: String, grantAction: String): Intent =
    Intent(PartnerScreenCaptureService.ACTION_START).apply {
      putExtra(PartnerScreenCaptureService.EXTRA_SESSION_ID, sessionId)
      putExtra(PartnerScreenCaptureService.EXTRA_RESULT_CODE, Activity.RESULT_OK)
      putExtra(PartnerScreenCaptureService.EXTRA_RESULT_DATA, Intent(grantAction))
    }

  @Suppress("DEPRECATION")
  private fun readGrant(intent: Intent?): Intent? = intent?.getParcelableExtra(PartnerScreenCaptureService.EXTRA_RESULT_DATA)
}
