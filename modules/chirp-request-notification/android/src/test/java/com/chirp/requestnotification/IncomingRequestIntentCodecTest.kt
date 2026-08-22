package com.chirp.requestnotification

import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33, 35])
class IncomingRequestIntentCodecTest {
  private val sessionA = "33333333-3333-4333-8333-333333333333"
  private val sessionB = "88888888-8888-4888-8888-888888888888"

  @Test
  fun launchIntentCarriesOnlyExactSessionAndConsumesOnce() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val intent = IncomingRequestIntentCodec.buildLaunchIntent(context, sessionA)

    assertEquals(Intent.ACTION_VIEW, intent.action)
    assertEquals(context.packageName, intent.`package`)
    assertEquals("chirp://incoming-request/$sessionA", intent.dataString)
    assertEquals(IncomingRequestIntentCodec.KIND_INCOMING_REQUEST, intent.getStringExtra(IncomingRequestIntentCodec.EXTRA_KIND))
    assertEquals(sessionA, intent.getStringExtra(IncomingRequestIntentCodec.EXTRA_SESSION_ID))
    assertTrue(intent.flags and Intent.FLAG_ACTIVITY_SINGLE_TOP != 0)
    assertTrue(intent.flags and Intent.FLAG_ACTIVITY_CLEAR_TOP != 0)

    assertEquals(sessionA, IncomingRequestIntentCodec.take(intent))
    assertNull(IncomingRequestIntentCodec.take(intent))
    assertNull(intent.data)
  }

  @Test
  fun newerWarmIntentDoesNotReusePreviouslyConsumedSession() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val cold = IncomingRequestIntentCodec.buildLaunchIntent(context, sessionA)
    val warm = IncomingRequestIntentCodec.buildLaunchIntent(context, sessionB)

    assertEquals(sessionA, IncomingRequestIntentCodec.take(cold))
    assertEquals(sessionB, IncomingRequestIntentCodec.take(warm))
    assertNull(IncomingRequestIntentCodec.take(cold))
  }

  @Test
  fun malformedOrSecretBearingRoutesAreRejected() {
    assertNull(IncomingRequestIntentCodec.parse("chirp://incoming-request/not-a-uuid"))
    assertNull(IncomingRequestIntentCodec.parse("https://example.com/incoming-request/$sessionA"))
    assertNull(IncomingRequestIntentCodec.parse("chirp://incoming-request/$sessionA/192.168.1.20"))
    assertNull(IncomingRequestIntentCodec.take(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("chirp://incoming-request/not-a-uuid"))))
  }
}
