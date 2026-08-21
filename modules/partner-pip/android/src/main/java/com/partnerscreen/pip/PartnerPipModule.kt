package com.partnerscreen.pip

import android.app.PictureInPictureParams
import android.os.Build
import android.util.Rational
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PartnerPipModule : Module() {
  private var wasInPip = false

  override fun definition() = ModuleDefinition {
    Name("PartnerPip")
    Events("onPipModeChanged")

    AsyncFunction("enterPip") { width: Int, height: Int ->
      val activity = appContext.currentActivity ?: return@AsyncFunction false
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@AsyncFunction false
      if (activity.isInPictureInPictureMode) {
        wasInPip = true
        sendEvent("onPipModeChanged", mapOf("isInPictureInPictureMode" to true))
        return@AsyncFunction true
      }
      try {
        val w = width.coerceIn(1, 1920)
        val h = height.coerceIn(1, 1920)
        val rational = Rational(w, h)
        val params = PictureInPictureParams.Builder()
          .setAspectRatio(rational)
          .build()
        val entered = activity.enterPictureInPictureMode(params)
        if (entered) {
          wasInPip = true
          sendEvent("onPipModeChanged", mapOf("isInPictureInPictureMode" to true))
        }
        entered
      } catch (_: Exception) {
        false
      }
    }

    AsyncFunction("isInPip") {
      val activity = appContext.currentActivity ?: return@AsyncFunction false
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return@AsyncFunction false
      activity.isInPictureInPictureMode
    }

    Function("supportsPip") {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
    }

    OnCreate {
      wasInPip = false
    }

    OnActivityEntersForeground {
      val activity = appContext.currentActivity ?: return@OnActivityEntersForeground
      val nowInPip = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) activity.isInPictureInPictureMode else false
      if (wasInPip && !nowInPip) {
        wasInPip = false
        sendEvent("onPipModeChanged", mapOf("isInPictureInPictureMode" to false))
      } else if (!wasInPip && nowInPip) {
        wasInPip = true
        sendEvent("onPipModeChanged", mapOf("isInPictureInPictureMode" to true))
      }
    }

    OnActivityEntersBackground {
      val activity = appContext.currentActivity ?: return@OnActivityEntersBackground
      val nowInPip = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) activity.isInPictureInPictureMode else false
      if (!wasInPip && nowInPip) {
        wasInPip = true
        sendEvent("onPipModeChanged", mapOf("isInPictureInPictureMode" to true))
      } else if (wasInPip && !nowInPip) {
        wasInPip = false
        sendEvent("onPipModeChanged", mapOf("isInPictureInPictureMode" to false))
      }
    }
  }
}
