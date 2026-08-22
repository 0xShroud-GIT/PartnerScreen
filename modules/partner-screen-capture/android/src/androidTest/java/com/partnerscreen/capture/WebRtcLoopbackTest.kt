package com.partnerscreen.capture

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RTCStatsReport
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSink
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class WebRtcLoopbackTest {
  @Test
  fun syntheticFramesCrossRealPeerConnectionsAndSurviveIceRestart() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions())
    val egl = EglBase.create()
    val factory = PeerConnectionFactory.builder()
      .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
      .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
      .createPeerConnectionFactory()

    val observerA = LoopObserver()
    val observerB = LoopObserver()
    val config = PeerConnection.RTCConfiguration(emptyList()).apply {
      sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
      iceTransportsType = PeerConnection.IceTransportsType.ALL
    }
    val peerA = requireNotNull(factory.createPeerConnection(config, observerA))
    val peerB = requireNotNull(factory.createPeerConnection(config, observerB))
    observerA.connectRemote(peerB)
    observerB.connectRemote(peerA)

    val source: VideoSource = factory.createVideoSource(true)
    val helper = SurfaceTextureHelper.create("PartnerScreenSyntheticLoopback", egl.eglBaseContext)
    assertNotNull(helper)
    val capturer = SyntheticVideoCapturer()
    capturer.initialize(helper, context, source.capturerObserver)
    val track: VideoTrack = factory.createVideoTrack("runtime-lab-synthetic", source)
    track.setEnabled(true)
    requireNotNull(peerA.addTrack(track, listOf("runtime-lab")))

    try {
      negotiate(peerA, peerB, observerA, observerB, iceRestart = false)
      capturer.startCapture(320, 180, 20)

      assertTrue("peer A did not connect", observerA.connected.await(15, TimeUnit.SECONDS))
      assertTrue("peer B did not connect", observerB.connected.await(15, TimeUnit.SECONDS))
      assertTrue("remote track was not delivered", observerB.remoteTrack.await(10, TimeUnit.SECONDS))
      assertTrue("decoded frames did not reach the sink", waitUntil(15_000) { observerB.renderedFrames.get() >= 10 })

      val senderStats = stats(peerA)
      val receiverStats = stats(peerB)
      assertTrue("sender bytesSent did not advance", sumVideoMetric(senderStats, "outbound-rtp", "bytesSent") > 0)
      assertTrue("sender framesEncoded did not advance", sumVideoMetric(senderStats, "outbound-rtp", "framesEncoded") > 0)
      assertTrue("receiver bytesReceived did not advance", sumVideoMetric(receiverStats, "inbound-rtp", "bytesReceived") > 0)
      assertTrue("receiver framesDecoded did not advance", sumVideoMetric(receiverStats, "inbound-rtp", "framesDecoded") > 0)
      assertTrue("no succeeded selected candidate pair", hasSucceededCandidatePair(senderStats) || hasSucceededCandidatePair(receiverStats))

      val beforeRestart = observerB.renderedFrames.get()
      peerA.restartIce()
      negotiate(peerA, peerB, observerA, observerB, iceRestart = true)
      assertTrue("frames stopped after ICE restart", waitUntil(15_000) { observerB.renderedFrames.get() >= beforeRestart + 10 })
    } finally {
      try { capturer.stopCapture() } catch (_: Exception) {}
      capturer.dispose()
      try { track.dispose() } catch (_: Exception) {}
      try { source.dispose() } catch (_: Exception) {}
      try { helper?.dispose() } catch (_: Exception) {}
      try { peerA.close() } catch (_: Exception) {}
      try { peerB.close() } catch (_: Exception) {}
      try { peerA.dispose() } catch (_: Exception) {}
      try { peerB.dispose() } catch (_: Exception) {}
      factory.dispose()
      egl.release()
    }
  }

  private fun negotiate(
    offerer: PeerConnection,
    answerer: PeerConnection,
    offererObserver: LoopObserver,
    answererObserver: LoopObserver,
    iceRestart: Boolean,
  ) {
    offererObserver.disableRemoteCandidates()
    answererObserver.disableRemoteCandidates()

    val constraints = MediaConstraints()
    if (iceRestart) constraints.mandatory.add(MediaConstraints.KeyValuePair("IceRestart", "true"))
    val offer = createDescription(offerer, true, constraints)
    setDescription(offerer, true, offer)
    setDescription(answerer, false, offer)
    offererObserver.enableRemoteCandidates()

    val answer = createDescription(answerer, false, MediaConstraints())
    setDescription(answerer, true, answer)
    setDescription(offerer, false, answer)
    answererObserver.enableRemoteCandidates()
  }

  private fun createDescription(peer: PeerConnection, offer: Boolean, constraints: MediaConstraints): SessionDescription {
    val latch = CountDownLatch(1)
    val result = AtomicReference<SessionDescription?>()
    val error = AtomicReference<String?>()
    val observer = object : SdpObserver {
      override fun onCreateSuccess(description: SessionDescription) { result.set(description); latch.countDown() }
      override fun onCreateFailure(message: String) { error.set(message); latch.countDown() }
      override fun onSetSuccess() = Unit
      override fun onSetFailure(message: String) = Unit
    }
    if (offer) peer.createOffer(observer, constraints) else peer.createAnswer(observer, constraints)
    assertTrue("SDP create timed out", latch.await(10, TimeUnit.SECONDS))
    if (error.get() != null) throw AssertionError("SDP create failed: ${error.get()}")
    return requireNotNull(result.get())
  }

  private fun setDescription(peer: PeerConnection, local: Boolean, description: SessionDescription) {
    val latch = CountDownLatch(1)
    val error = AtomicReference<String?>()
    val observer = object : SdpObserver {
      override fun onSetSuccess() { latch.countDown() }
      override fun onSetFailure(message: String) { error.set(message); latch.countDown() }
      override fun onCreateSuccess(description: SessionDescription) = Unit
      override fun onCreateFailure(message: String) = Unit
    }
    if (local) peer.setLocalDescription(observer, description) else peer.setRemoteDescription(observer, description)
    assertTrue("SDP set timed out", latch.await(10, TimeUnit.SECONDS))
    if (error.get() != null) throw AssertionError("SDP set failed: ${error.get()}")
  }

  private fun stats(peer: PeerConnection): RTCStatsReport {
    val latch = CountDownLatch(1)
    val result = AtomicReference<RTCStatsReport?>()
    peer.getStats { report -> result.set(report); latch.countDown() }
    assertTrue("getStats timed out", latch.await(10, TimeUnit.SECONDS))
    return requireNotNull(result.get())
  }

  private fun sumVideoMetric(report: RTCStatsReport, type: String, key: String): Long =
    report.statsMap.values
      .filter { it.type == type && it.members["kind"] == "video" }
      .mapNotNull { it.members[key] as? Number }
      .sumOf { it.toLong() }

  private fun hasSucceededCandidatePair(report: RTCStatsReport): Boolean =
    report.statsMap.values.any {
      it.type == "candidate-pair" && it.members["state"] == "succeeded" && it.members["nominated"] == true
    }

  private fun waitUntil(timeoutMs: Long, predicate: () -> Boolean): Boolean {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
      if (predicate()) return true
      Thread.sleep(25)
    }
    return predicate()
  }

  private class LoopObserver : PeerConnection.Observer {
    val connected = CountDownLatch(1)
    val remoteTrack = CountDownLatch(1)
    val renderedFrames = AtomicInteger(0)
    private val remoteReady = AtomicBoolean(false)
    private val pendingCandidates = CopyOnWriteArrayList<IceCandidate>()
    private var remote: PeerConnection? = null

    fun connectRemote(peer: PeerConnection) { remote = peer }

    fun disableRemoteCandidates() {
      remoteReady.set(false)
    }

    fun enableRemoteCandidates() {
      remoteReady.set(true)
      val target = remote ?: return
      for (candidate in pendingCandidates) target.addIceCandidate(candidate)
      pendingCandidates.clear()
    }

    override fun onSignalingChange(newState: PeerConnection.SignalingState) = Unit
    override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState) = Unit
    override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
    override fun onIceGatheringChange(newState: PeerConnection.IceGatheringState) = Unit
    override fun onIceCandidate(candidate: IceCandidate) {
      val target = remote
      if (target == null || !remoteReady.get()) pendingCandidates.add(candidate)
      else target.addIceCandidate(candidate)
    }
    override fun onIceCandidatesRemoved(candidates: Array<IceCandidate>) = Unit
    override fun onAddStream(stream: MediaStream) = Unit
    override fun onRemoveStream(stream: MediaStream) = Unit
    override fun onDataChannel(dataChannel: DataChannel) { dataChannel.close() }
    override fun onRenegotiationNeeded() = Unit
    override fun onAddTrack(receiver: RtpReceiver, mediaStreams: Array<MediaStream>) = Unit
    override fun onTrack(transceiver: RtpTransceiver) {
      val video = transceiver.receiver.track() as? VideoTrack ?: return
      video.addSink(VideoSink { renderedFrames.incrementAndGet() })
      remoteTrack.countDown()
    }
    override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
      if (newState == PeerConnection.PeerConnectionState.CONNECTED) connected.countDown()
    }
  }
}
