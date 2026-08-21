package com.partnerscreen.lifecycle

import android.app.Activity
import android.app.Application
import android.os.Bundle
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PartnerLifecycleModule : Module(), Application.ActivityLifecycleCallbacks {
  private var registered = false

  override fun definition() = ModuleDefinition {
    Name("PartnerLifecycle")
    Events("onLifecycleEvent")

    OnCreate {
      val application = appContext.reactContext?.applicationContext as? Application
      if (application != null && !registered) {
        application.registerActivityLifecycleCallbacks(this@PartnerLifecycleModule)
        registered = true
      }
    }

    OnDestroy {
      val application = appContext.reactContext?.applicationContext as? Application
      if (registered && application != null) {
        try { application.unregisterActivityLifecycleCallbacks(this@PartnerLifecycleModule) } catch (_: Exception) {}
        registered = false
      }
    }
  }

  private fun emit(type: String) {
    try { sendEvent("onLifecycleEvent", mapOf("type" to type)) } catch (_: Exception) {}
  }

  override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
  override fun onActivityStarted(activity: Activity) { emit("activity_started") }
  override fun onActivityResumed(activity: Activity) { emit("activity_resumed") }
  override fun onActivityPaused(activity: Activity) { emit("activity_paused") }
  override fun onActivityStopped(activity: Activity) { emit("activity_stopped") }
  override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
  override fun onActivityDestroyed(activity: Activity) { emit("activity_destroyed") }
}
