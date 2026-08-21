package com.partnerscreen.capture;

import android.content.Context;

import org.webrtc.CapturerObserver;
import org.webrtc.JavaI420Buffer;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoCapturer;
import org.webrtc.VideoFrame;

import java.nio.ByteBuffer;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Deterministic generated frames for debuggable Runtime Laboratory APKs only.
 * The production module refuses to select this source when the application is
 * not debuggable, so release MediaProjection consent semantics are unchanged.
 */
final class SyntheticTestCapturer implements VideoCapturer {
  private CapturerObserver observer;
  private final ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor();
  private ScheduledFuture<?> task;
  private final AtomicInteger frameCounter = new AtomicInteger();
  private volatile boolean capturing;
  private int width = 640;
  private int height = 360;

  @Override public void initialize(SurfaceTextureHelper helper, Context context, CapturerObserver observer) {
    this.observer = observer;
  }

  @Override public synchronized void startCapture(int width, int height, int framerate) {
    if (capturing) return;
    this.width = even(width);
    this.height = even(height);
    capturing = true;
    if (observer != null) observer.onCapturerStarted(true);
    long periodMs = Math.max(1L, 1000L / Math.max(1, Math.min(60, framerate)));
    task = executor.scheduleAtFixedRate(this::emitFrame, 0, periodMs, TimeUnit.MILLISECONDS);
  }

  @Override public synchronized void stopCapture() {
    if (!capturing) return;
    capturing = false;
    if (task != null) task.cancel(false);
    task = null;
    if (observer != null) observer.onCapturerStopped();
  }

  @Override public synchronized void changeCaptureFormat(int width, int height, int framerate) {
    boolean restart = capturing;
    if (restart) stopCapture();
    this.width = even(width);
    this.height = even(height);
    if (restart) startCapture(this.width, this.height, framerate);
  }

  @Override public synchronized void dispose() {
    stopCapture();
    observer = null;
    executor.shutdownNow();
  }

  @Override public boolean isScreencast() { return true; }

  private void emitFrame() {
    if (!capturing || observer == null) return;
    int index = frameCounter.incrementAndGet();
    JavaI420Buffer buffer = JavaI420Buffer.allocate(width, height);
    // Moving luma bars encode the low bits of the frame counter. They are visually
    // obvious in emulator screenshots and guarantee that a frozen frame is detectable.
    fillLumaPattern(buffer, index);
    fill(buffer.getDataU(), buffer.getStrideU() * ((height + 1) / 2), (byte) 128);
    fill(buffer.getDataV(), buffer.getStrideV() * ((height + 1) / 2), (byte) 128);
    VideoFrame frame = new VideoFrame(buffer, 0, System.nanoTime());
    try { observer.onFrameCaptured(frame); }
    finally { frame.release(); }
  }

  private void fillLumaPattern(JavaI420Buffer buffer, int frameIndex) {
    ByteBuffer y = buffer.getDataY();
    int stride = buffer.getStrideY();
    y.position(0);
    for (int row = 0; row < height; row++) {
      for (int col = 0; col < stride; col++) {
        int bar = ((col / Math.max(1, width / 8)) + frameIndex) & 7;
        y.put((byte) (32 + bar * 24));
      }
    }
    y.position(0);
  }

  private static void fill(ByteBuffer buffer, int count, byte value) {
    buffer.position(0);
    int bounded = Math.min(count, buffer.capacity());
    for (int i = 0; i < bounded; i++) buffer.put(value);
    buffer.position(0);
  }

  private static int even(int value) {
    int bounded = Math.max(2, value);
    return (bounded & 1) == 0 ? bounded : bounded - 1;
  }
}
