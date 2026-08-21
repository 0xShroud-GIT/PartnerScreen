package com.partnerscreen.runtimelab

import android.content.Intent
import android.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class RuntimeLabPairingIntentCodecTest {
  private val payload = "PS1:{\"protocolVersion\":1,\"fixture\":\"runtime-lab-only\"}"

  @Test
  fun base64PayloadIsConsumedExactlyOnce() {
    val encoded = Base64.encodeToString(payload.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
    val intent = Intent().putExtra(RuntimeLabPairingIntentCodec.EXTRA_PAIRING_QR_B64, encoded)

    assertEquals(payload, RuntimeLabPairingIntentCodec.take(intent))
    assertNull(RuntimeLabPairingIntentCodec.take(intent))
  }

  @Test
  fun rawPayloadIsConsumedExactlyOnce() {
    val intent = Intent().putExtra(RuntimeLabPairingIntentCodec.EXTRA_PAIRING_QR, payload)

    assertEquals(payload, RuntimeLabPairingIntentCodec.take(intent))
    assertNull(RuntimeLabPairingIntentCodec.take(intent))
  }

  @Test
  fun malformedOrMultilineInputIsRejectedAndRemoved() {
    val intent = Intent().putExtra(RuntimeLabPairingIntentCodec.EXTRA_PAIRING_QR, "PS1:bad\nvalue")

    assertNull(RuntimeLabPairingIntentCodec.take(intent))
    assertNull(RuntimeLabPairingIntentCodec.take(intent))
  }

  @Test
  fun nonPartnerScreenPayloadIsRejected() {
    val intent = Intent().putExtra(RuntimeLabPairingIntentCodec.EXTRA_PAIRING_QR, "https://example.invalid/not-a-pair")
    assertNull(RuntimeLabPairingIntentCodec.take(intent))
  }
}
