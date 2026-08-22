package com.partnerscreen.pip

import android.app.PictureInPictureParams
import android.util.Rational

/** Production PiP geometry conversion shared with native tests. */
internal object PipParamsFactory {
  fun create(width: Int, height: Int): PictureInPictureParams {
    val w = width.coerceIn(1, 1920)
    val h = height.coerceIn(1, 1920)
    return PictureInPictureParams.Builder()
      .setAspectRatio(Rational(w, h))
      .build()
  }
}
