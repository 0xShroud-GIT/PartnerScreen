package com.partnerscreen.requestnotification

import android.content.Context
import android.content.Intent
import android.net.Uri

/** Production notification intent codec shared directly with Robolectric tests. */
internal object IncomingRequestIntentCodec {
  const val EXTRA_KIND = "partnerscreen_notification"
  const val EXTRA_SESSION_ID = "partnerscreen_sessionId"
  const val KIND_INCOMING_REQUEST = "incoming_request"
  private const val SCHEME = "partnerscreen"
  private const val HOST = "incoming-request"
  private val SESSION_ID_RE = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)

  fun buildLaunchIntent(context: Context, sessionId: String): Intent {
    require(SESSION_ID_RE.matches(sessionId)) { "Incoming request session ID is invalid." }
    val normalized = sessionId.lowercase()
    return Intent(Intent.ACTION_VIEW, uri(normalized)).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      setPackage(context.packageName)
      putExtra(EXTRA_KIND, KIND_INCOMING_REQUEST)
      putExtra(EXTRA_SESSION_ID, normalized)
    }
  }

  fun uri(sessionId: String): Uri = Uri.parse("$SCHEME://$HOST/$sessionId")

  fun parse(raw: String?): String? {
    if (raw.isNullOrBlank() || raw.length > 256) return null
    val parsed = Uri.parse(raw.trim())
    if (!SCHEME.equals(parsed.scheme, ignoreCase = true)) return null
    if (!HOST.equals(parsed.host, ignoreCase = true)) return null
    val sessionId = parsed.pathSegments.singleOrNull() ?: return null
    if (!SESSION_ID_RE.matches(sessionId)) return null
    return sessionId.lowercase()
  }

  /** Consume exactly once so activity foreground callbacks cannot replay a stale request. */
  fun take(intent: Intent?): String? {
    if (intent == null) return null
    val extraKind = intent.getStringExtra(EXTRA_KIND)
    val extraSessionId = intent.getStringExtra(EXTRA_SESSION_ID)
    val fromExtra = if (
      extraKind == KIND_INCOMING_REQUEST &&
      !extraSessionId.isNullOrBlank() &&
      SESSION_ID_RE.matches(extraSessionId)
    ) extraSessionId.lowercase() else null

    val sessionId = fromExtra ?: parse(intent.dataString) ?: return null
    intent.removeExtra(EXTRA_KIND)
    intent.removeExtra(EXTRA_SESSION_ID)
    intent.data = null
    return sessionId
  }
}
