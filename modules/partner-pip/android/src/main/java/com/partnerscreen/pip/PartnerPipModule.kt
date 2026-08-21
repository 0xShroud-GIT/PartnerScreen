package com.partnerscreen.pip

import android.app.PictureInPictureParams
import android.content.Intent
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
      val params = try { pictureParams(width, height) } catch (_: Exception) { return@AsyncFunction false }
      if (activity.isInPictureInPictureMode) {
        try { activity.setPictureInPictureParams(params) } catch (_: Exception) {}
        wasInPip = true
        sendEvent("onPipModeChanged", mapOf("isInPictureInPictureMode" to true))
        return@AsyncFunction true
      }
      try {
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

    AsyncFunction("updatePipAspect") { width: Int, height: Int ->
      val activity = appContext.currentActivity ?: return@AsyncFunction false
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@AsyncFunction false
      if (!activity.isInPictureInPictureMode) return@AsyncFunction false
      try {
        activity.setPictureInPictureParams(pictureParams(width, height))
        true
      } catch (_: Exception) {
        false
      }
    }

    AsyncFunction("exitPip") {
      val activity = appContext.currentActivity ?: return@AsyncFunction false
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return@AsyncFunction true
      if (!activity.isInPictureInPictureMode) {
        if (wasInPip) {
          wasInPip = false
          sendEvent("onPipModeChanged", mapOf("isInPictureInPictureMode" to false))
        }
        return@AsyncFunction true
      }
      try {
        val intent = Intent(activity, activity.javaClass).apply {
          flags = Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        activity.startActivity(intent)
        wasInPip = false
        sendEvent("onPipModeChanged", mapOf("isInPictureInPictureMode" to false))
        true
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

  private fun pictureParams(width: Int, height: Int): PictureInPictureParams {
    val w = width.coerceIn(1, 1920)
    val h = height.coerceIn(1, 1920)
    return PictureInPictureParams.Builder()
      .setAspectRatio(Rational(w, h))
      .build()
  }
}
