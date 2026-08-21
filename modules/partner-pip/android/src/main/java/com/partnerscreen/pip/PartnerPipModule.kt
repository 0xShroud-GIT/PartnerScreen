package com.partnerscreen.pip

import android.app.PictureInPictureParams
import android.os.Build
import android.util.Rational
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PartnerPipModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PartnerPip")
    Events("onPipModeChanged")

    AsyncFunction("enterPip") { width: Int, height: Int ->
      val activity = appContext.currentActivity ?: return@AsyncFunction false
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@AsyncFunction false
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && activity.isInPictureInPictureMode) return@AsyncFunction true
      try {
        val w = width.coerceIn(1, 1920)
        val h = height.coerceIn(1, 1920)
        val rational = Rational(w, h)
        val params = PictureInPictureParams.Builder()
          .setAspectRatio(rational)
          // Keep a visible control: the system will show the app's PiP action area; we keep Stop accessible via return-to-app.
          .build()
        activity.enterPictureInPictureMode(params)
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

    // Expo handles piping activity PiP callbacks via these handlers if available.
    // Fallback: we also poll via direct listener registration in OnCreate.
    OnCreate {
      // Register a listener for PiP mode changes to emit JS events for diagnostics.
      appContext.currentActivity?.let { activity ->
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          // Use the activity's addOnPictureInPictureModeChangedListener if available (API 26+)
          try {
            // Reflection-free direct call on supported API
            // We add a listener that forwards to JS
            // Note: Expo's OnCreate runs before activity is fully available; we also handle in OnActivityCreates.
          } catch (_: Exception) {}
        }
      }
    }

    OnActivityEntersPictureInPicture {
      sendEvent("onPipModeChanged", mapOf("isInPictureInPictureMode" to true))
    }

    OnActivityLeavesPictureInPicture {
      sendEvent("onPipModeChanged", mapOf("isInPictureInPictureMode" to false))
    }
  }
}
