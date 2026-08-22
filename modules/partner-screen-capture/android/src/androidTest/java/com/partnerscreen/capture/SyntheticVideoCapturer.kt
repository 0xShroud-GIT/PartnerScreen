package com.partnerscreen.capture

import android.content.Context
import org.webrtc.CapturerObserver
import org.webrtc.JavaI420Buffer
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer
import org.webrtc.VideoFrame
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Instrumentation-only frame generator. Production APK source never selects this
 * capturer; it exists so WebRTC transport/decoder/renderer qualification can be
 * isolated from Android MediaProjection consent and real screen capture.
 */
internal class SyntheticVideoCapturer : VideoCapturer {
  private var observer: CapturerObserver? = null
  private val executor = Executors.newSingleThreadScheduledExecutor()
  private var task: ScheduledFuture<*>? = null
  private val frameCounter = AtomicInteger(0)
  @Volatile private var capturing = false
  private var width = 320
  private var height = 180

  override fun initialize(surfaceTextureHelper: SurfaceTextureHelper?, applicationContext: Context?, capturerObserver: CapturerObserver?) {
    observer = capturerObserver
  }

  override fun startCapture(width: Int, height: Int, framerate: Int) {
    if (capturing) return
    this.width = width.coerceAtLeast(2).let { if (it % 2 == 0) it else it - 1 }
    this.height = height.coerceAtLeast(2).let { if (it % 2 == 0) it else it - 1 }
    capturing = true
    observer?.onCapturerStarted(true)
    val periodMs = (1000L / framerate.coerceIn(1, 60)).coerceAtLeast(1L)
    task = executor.scheduleAtFixedRate({ emitFrame() }, 0, periodMs, TimeUnit.MILLISECONDS)
  }

  override fun stopCapture() {
    if (!capturing) return
    capturing = false
    task?.cancel(false)
    task = null
    observer?.onCapturerStopped()
  }

  override fun changeCaptureFormat(width: Int, height: Int, framerate: Int) {
    val wasCapturing = capturing
    if (wasCapturing) stopCapture()
    if (wasCapturing) startCapture(width, height, framerate)
  }

  override fun dispose() {
    try { stopCapture() } catch (_: Exception) {}
    executor.shutdownNow()
    observer = null
  }

  override fun isScreencast(): Boolean = true

  private fun emitFrame() {
    if (!capturing) return
    val index = frameCounter.incrementAndGet()
    val buffer = JavaI420Buffer.allocate(width, height)
    val yValue = (16 + (index % 200)).toByte()
    fill(buffer.dataY, buffer.strideY * height, yValue)
    fill(buffer.dataU, buffer.strideU * ((height + 1) / 2), 128.toByte())
    fill(buffer.dataV, buffer.strideV * ((height + 1) / 2), 128.toByte())
    val frame = VideoFrame(buffer, 0, System.nanoTime())
    try {
      observer?.onFrameCaptured(frame)
    } finally {
      frame.release()
    }
  }

  private fun fill(buffer: java.nio.ByteBuffer, count: Int, value: Byte) {
    buffer.position(0)
    repeat(count.coerceAtMost(buffer.capacity())) { buffer.put(value) }
    buffer.position(0)
  }
}
