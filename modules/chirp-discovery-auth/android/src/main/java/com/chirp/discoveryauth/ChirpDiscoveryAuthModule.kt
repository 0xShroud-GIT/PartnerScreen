package com.partnerscreen.discoveryauth

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.nio.charset.StandardCharsets
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

private const val HMAC_ALGORITHM = "HmacSHA256"
private const val HMAC_KEY_HEX_LENGTH = 64
private const val HMAC_OUTPUT_HEX_LENGTH = 64
private const val MAX_MESSAGE_BYTES = 512
private val KEY_RE = Regex("^[0-9a-f]{64}$")
private val HEX = "0123456789abcdef".toCharArray()

class PartnerDiscoveryAuthModule : Module() {
  @Volatile private var selfTestPassed = false
  private val selfTestLock = Any()

  override fun definition() = ModuleDefinition {
    Name("PartnerDiscoveryAuth")

    AsyncFunction("hmacSha256") { keyHex: String, message: String ->
      ensureSelfTest()
      val normalizedKey = keyHex.lowercase()
      require(normalizedKey.length == HMAC_KEY_HEX_LENGTH && KEY_RE.matches(normalizedKey)) {
        "Authentication key is invalid."
      }
      require(message.isNotEmpty() && message.all { it.code <= 0x7f }) {
        "Authentication message must be bounded ASCII."
      }
      val messageBytes = message.toByteArray(StandardCharsets.US_ASCII)
      require(messageBytes.size <= MAX_MESSAGE_BYTES) {
        "Authentication message is too large."
      }

      val keyBytes = hexToBytes(normalizedKey)
      try {
        computeHmacHex(keyBytes, messageBytes)
      } finally {
        keyBytes.fill(0)
        messageBytes.fill(0)
      }
    }
  }

  private fun ensureSelfTest() {
    if (selfTestPassed) return
    synchronized(selfTestLock) {
      if (selfTestPassed) return
      val key = ByteArray(20) { 0x0b.toByte() }
      val message = "Hi There".toByteArray(StandardCharsets.US_ASCII)
      val expected = "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
      try {
        check(computeHmacHex(key, message) == expected) { "Android HMAC-SHA256 self-test failed." }
        selfTestPassed = true
      } finally {
        key.fill(0)
        message.fill(0)
      }
    }
  }

  private fun computeHmacHex(key: ByteArray, message: ByteArray): String {
    val mac = Mac.getInstance(HMAC_ALGORITHM)
    mac.init(SecretKeySpec(key, HMAC_ALGORITHM))
    val output = mac.doFinal(message)
    try {
      check(output.size * 2 == HMAC_OUTPUT_HEX_LENGTH) { "Unexpected HMAC-SHA256 output length." }
      return bytesToHex(output)
    } finally {
      output.fill(0)
      mac.reset()
    }
  }

  private fun hexToBytes(hex: String): ByteArray {
    val output = ByteArray(hex.length / 2)
    for (index in output.indices) {
      val high = Character.digit(hex[index * 2], 16)
      val low = Character.digit(hex[index * 2 + 1], 16)
      require(high >= 0 && low >= 0) { "Authentication key is invalid." }
      output[index] = ((high shl 4) or low).toByte()
    }
    return output
  }

  private fun bytesToHex(bytes: ByteArray): String {
    val output = CharArray(bytes.size * 2)
    for (index in bytes.indices) {
      val value = bytes[index].toInt() and 0xff
      output[index * 2] = HEX[value ushr 4]
      output[index * 2 + 1] = HEX[value and 0x0f]
    }
    return String(output)
  }
}
