package com.chirp.control

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

private const val MAX_FRAME_BYTES = 48 * 1024
private const val CONNECT_TIMEOUT_MS = 5_000
private const val SEND_TIMEOUT_MS = 4_000
private const val INBOUND_CLASSIFY_TIMEOUT_MS = 1_500
private const val ACCEPT_WORKERS = 1
private const val IO_WORKERS = 4

private data class WifiEndpoint(val network: Network, val address: Inet4Address)
private data class ListenerHandle(val socket: ServerSocket, val host: String)
private data class ConnectionHandle(val socket: Socket, val writeLock: Any = Any())

class ChirpControlModule : Module() {
  companion object {
    private val listeners = ConcurrentHashMap<String, ListenerHandle>()
    private val connections = ConcurrentHashMap<String, ConnectionHandle>()
    private val connectionLock = Any()
    private val pendingEvents = ArrayDeque<Map<String, Any>>()
    @Volatile var presenceRequired = false
    @Volatile private var eventSink: ((Map<String, Any>) -> Unit)? = null
    // Accepts must not share a pool with blocked reads/writes: a stuck TCP read must never
    // starve listener accepts or control sends. Probe connect-and-close also classifies on IO.
    private val acceptExecutor: ExecutorService = Executors.newFixedThreadPool(ACCEPT_WORKERS)
    private val ioExecutor: ExecutorService = Executors.newFixedThreadPool(IO_WORKERS)

    fun currentListener(): Map<String, Any>? {
      val entry = listeners.entries.firstOrNull() ?: return null
      return mapOf("listenerId" to entry.key, "host" to entry.value.host, "port" to entry.value.socket.localPort)
    }

    fun attachSink(sink: ((Map<String, Any>) -> Unit)?) {
      eventSink = sink
      if (sink == null) return
      val replay: List<Map<String, Any>>
      synchronized(pendingEvents) {
        replay = pendingEvents.toList()
        pendingEvents.clear()
      }
      for (event in replay) sink(event)
    }

    fun emitEvent(event: Map<String, Any>) {
      val sink = eventSink
      if (sink != null) {
        sink(event)
        return
      }
      synchronized(pendingEvents) {
        if (pendingEvents.size >= 16) pendingEvents.removeFirst()
        pendingEvents.addLast(event)
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("ChirpControl")
    Events("onChirpControlEvent")

    OnCreate {
      attachSink { event -> sendEvent("onChirpControlEvent", event) }
    }

    AsyncFunction("startTrustedPresence") {
      presenceRequired = true
      val context = appContext.reactContext?.applicationContext ?: throw IllegalStateException("Android context is unavailable.")
      ChirpTrustedPresenceService.start(context)
      true
    }

    AsyncFunction("stopTrustedPresence") {
      presenceRequired = false
      val context = appContext.reactContext?.applicationContext
      if (context != null) ChirpTrustedPresenceService.stop(context)
      true
    }

    Function("getActiveListener") { currentListener() }

    AsyncFunction("startListener") {
      currentListener()?.let { return@AsyncFunction it }
      require(listeners.isEmpty()) { "A control listener is already active." }
      val wifi = activeWifiEndpoint() ?: throw IllegalStateException("Control requires an active private IPv4 Wi-Fi address.")
      val server = ServerSocket()
      server.reuseAddress = true
      server.bind(InetSocketAddress(wifi.address, 0), 2)
      val id = UUID.randomUUID().toString()
      val host = wifi.address.hostAddress ?: throw IllegalStateException("Wi-Fi address is unavailable.")
      listeners[id] = ListenerHandle(server, host)
      acceptExecutor.execute { acceptLoop(id, server) }
      mapOf("listenerId" to id, "host" to host, "port" to server.localPort)
    }

    AsyncFunction("stopListener") { listenerId: String ->
      try { listeners.remove(listenerId)?.socket?.close() } catch (_: Exception) { /* best effort */ }
    }

    AsyncFunction("connect") { host: String, port: Int ->
      val address = parsePrivateIpv4(host) ?: throw IllegalArgumentException("Control endpoint must be a private IPv4 address.")
      require(port in 1..65535) { "Control endpoint port is invalid." }
      synchronized(connectionLock) { require(connections.isEmpty()) { "A control connection is already active." } }
      val wifi = activeWifiEndpoint(address) ?: throw IllegalStateException("No active Wi-Fi route can reach the control endpoint.")
      val socket = Socket()
      try {
        socket.tcpNoDelay = true
        socket.keepAlive = true
        wifi.network.bindSocket(socket)
        socket.bind(InetSocketAddress(wifi.address, 0))
        socket.connect(InetSocketAddress(address, port), CONNECT_TIMEOUT_MS)
        registerConnection(socket, "outbound", null)
      } catch (error: Exception) {
        try { socket.close() } catch (_: Exception) { /* best effort */ }
        throw error
      }
    }

    AsyncFunction("send") { connectionId: String, frame: String ->
      val bytes = frame.toByteArray(StandardCharsets.UTF_8)
      require(bytes.isNotEmpty() && bytes.size <= MAX_FRAME_BYTES) { "Control frame size is invalid." }
      val handle = connections[connectionId] ?: throw IllegalStateException("Control connection is not active.")
      val write = ioExecutor.submit {
        synchronized(handle.writeLock) {
          val output = DataOutputStream(handle.socket.getOutputStream())
          output.writeInt(bytes.size)
          output.write(bytes)
          output.flush()
        }
      }
      try {
        write.get(SEND_TIMEOUT_MS.toLong(), TimeUnit.MILLISECONDS)
      } catch (error: TimeoutException) {
        write.cancel(true)
        closeConnection(connectionId, emit = true)
        throw IllegalStateException("Control send timed out.", error)
      } catch (error: ExecutionException) {
        closeConnection(connectionId, emit = true)
        throw IllegalStateException("Control send failed.", error.cause ?: error)
      } catch (error: InterruptedException) {
        Thread.currentThread().interrupt()
        write.cancel(true)
        closeConnection(connectionId, emit = true)
        throw IllegalStateException("Control send was interrupted.", error)
      } finally {
        bytes.fill(0)
      }
    }

    AsyncFunction("close") { connectionId: String -> closeConnection(connectionId, emit = true) }

    OnDestroy {
      attachSink(null)
      if (!presenceRequired) shutdownAll()
    }
  }

  private fun acceptLoop(listenerId: String, server: ServerSocket) {
    while (!server.isClosed && listeners.containsKey(listenerId)) {
      try {
        val socket = server.accept()
        socket.tcpNoDelay = true
        socket.keepAlive = true
        ioExecutor.execute { classifyInbound(listenerId, socket) }
      } catch (_: Exception) {
        if (!server.isClosed && listeners.containsKey(listenerId)) emitListenerError("listener_failed", listenerId)
        break
      }
    }
    listeners.remove(listenerId)
    try { server.close() } catch (_: Exception) { /* best effort */ }
  }

  private fun classifyInbound(listenerId: String, socket: Socket) {
    val firstFrame: ByteArray? = try {
      socket.soTimeout = INBOUND_CLASSIFY_TIMEOUT_MS
      val input = DataInputStream(socket.getInputStream())
      val length = input.readInt()
      if (length <= 0 || length > MAX_FRAME_BYTES) null
      else {
        val bytes = ByteArray(length)
        input.readFully(bytes)
        bytes
      }
    } catch (_: Exception) {
      null
    }
    try { socket.soTimeout = 0 } catch (_: Exception) { /* best effort */ }
    if (firstFrame == null) {
      try { socket.close() } catch (_: Exception) { /* probe or junk */ }
      return
    }
    if (!listeners.containsKey(listenerId)) {
      firstFrame.fill(0)
      try { socket.close() } catch (_: Exception) { /* stale listener */ }
      return
    }
    val connectionId = synchronized(connectionLock) {
      if (connections.isNotEmpty()) null
      else registerConnectionLocked(socket, "inbound", listenerId)
    }
    if (connectionId == null) {
      firstFrame.fill(0)
      try { socket.close() } catch (_: Exception) { /* best effort */ }
      emitError("busy", null)
      return
    }
    emitEvent(mapOf(
      "type" to "message",
      "connectionId" to connectionId,
      "frame" to String(firstFrame, StandardCharsets.UTF_8),
    ))
    firstFrame.fill(0)
    ioExecutor.execute { readLoop(connectionId, socket) }
  }

  private fun registerConnection(socket: Socket, direction: String, listenerId: String?): String = synchronized(connectionLock) {
    require(connections.isEmpty()) { "A control connection is already active." }
    registerConnectionLocked(socket, direction, listenerId)
  }

  private fun registerConnectionLocked(socket: Socket, direction: String, listenerId: String?): String {
    val connectionId = UUID.randomUUID().toString()
    connections[connectionId] = ConnectionHandle(socket)
    val event = mutableMapOf<String, Any>("type" to "connected", "connectionId" to connectionId, "direction" to direction)
    if (listenerId != null) event["listenerId"] = listenerId
    emitEvent(event)
    if (direction == "outbound") ioExecutor.execute { readLoop(connectionId, socket) }
    return connectionId
  }

  private fun readLoop(connectionId: String, socket: Socket) {
    try {
      val input = DataInputStream(socket.getInputStream())
      while (!socket.isClosed) {
        val length = try { input.readInt() } catch (_: EOFException) { break }
        if (length <= 0 || length > MAX_FRAME_BYTES) { emitError("invalid_frame_size", connectionId); break }
        val bytes = ByteArray(length)
        input.readFully(bytes)
        emitEvent(mapOf(
          "type" to "message",
          "connectionId" to connectionId,
          "frame" to String(bytes, StandardCharsets.UTF_8),
        ))
        bytes.fill(0)
      }
    } catch (_: Exception) {
      if (!socket.isClosed && connections.containsKey(connectionId)) emitError("connection_failed", connectionId)
    } finally {
      closeConnection(connectionId, emit = true)
    }
  }

  private fun closeConnection(connectionId: String, emit: Boolean) {
    val removed = synchronized(connectionLock) { connections.remove(connectionId) } ?: return
    try { removed.socket.close() } catch (_: Exception) { /* best effort */ }
    if (emit) emitEvent(mapOf("type" to "closed", "connectionId" to connectionId))
  }

  private fun emitError(code: String, connectionId: String?) {
    val event = mutableMapOf<String, Any>("type" to "error", "code" to code)
    if (connectionId != null) event["connectionId"] = connectionId
    emitEvent(event)
  }

  private fun emitListenerError(code: String, listenerId: String) {
    emitEvent(mapOf("type" to "error", "code" to code, "listenerId" to listenerId))
  }

  private fun shutdownAll() {
    listeners.keys.toList().forEach { id -> try { listeners.remove(id)?.socket?.close() } catch (_: Exception) { } }
    connections.keys.toList().forEach { id -> closeConnection(id, emit = false) }
  }

  private fun activeWifiEndpoint(destination: Inet4Address? = null): WifiEndpoint? {
    val context = appContext.reactContext ?: return null
    val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return null

    fun endpointFor(network: Network): WifiEndpoint? {
      val capabilities = connectivity.getNetworkCapabilities(network) ?: return null
      if (!capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return null
      if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return null
      if (!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)) return null
      val links = connectivity.getLinkProperties(network) ?: return null
      if (destination != null && !hasRouteTo(links, destination)) return null
      val address = links.linkAddresses.asSequence().map { it.address }.filterIsInstance<Inet4Address>()
        .firstOrNull { !it.isLoopbackAddress && isPrivateIpv4(it) } ?: return null
      return WifiEndpoint(network, address)
    }

    val active = connectivity.activeNetwork
    if (active != null) endpointFor(active)?.let { return it }

    @Suppress("DEPRECATION")
    return connectivity.allNetworks
      .asSequence()
      .filter { it != active }
      .mapNotNull { endpointFor(it) }
      .firstOrNull()
  }

  private fun hasRouteTo(links: LinkProperties, destination: Inet4Address): Boolean = links.routes.any { it.matches(destination) }

  private fun parsePrivateIpv4(host: String): Inet4Address? {
    if (!host.matches(Regex("^\\d{1,3}(\\.\\d{1,3}){3}$"))) return null
    val address = try { InetAddress.getByName(host) } catch (_: Exception) { return null }
    return (address as? Inet4Address)?.takeIf { isPrivateIpv4(it) }
  }

  private fun isPrivateIpv4(address: Inet4Address): Boolean {
    val octets = address.address.map { it.toInt() and 0xff }
    return octets[0] == 10 || (octets[0] == 172 && octets[1] in 16..31) || (octets[0] == 192 && octets[1] == 168)
  }
}
