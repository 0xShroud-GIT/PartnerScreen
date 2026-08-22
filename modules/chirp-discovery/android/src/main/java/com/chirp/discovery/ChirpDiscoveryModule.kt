package com.chirp.discovery

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private const val SERVICE_TYPE = "_chirp._tcp."
private const val PROTOCOL_VERSION = "1"
private const val START_TIMEOUT_SECONDS = 8L
private const val PROBE_TIMEOUT_MS = 3_000

private val HINT_RE = Regex("^[0-9a-f]{32}$")
private val NONCE_RE = Regex("^[0-9a-f]{32}$")
private val PROOF_RE = Regex("^[0-9a-f]{64}$")

private data class WifiEndpoint(
  val network: Network,
  val address: Inet4Address,
)

private data class PreparedAdvertisement(
  val generation: Long,
  val id: String,
  val socket: ServerSocket,
  val wifi: WifiEndpoint,
  val nonce: String,
)

private data class PendingStart(
  val generation: Long,
  val promise: Promise,
  val settled: AtomicBoolean = AtomicBoolean(false),
)

class ChirpDiscoveryModule : Module() {
  private val callbackExecutor: ScheduledExecutorService = Executors.newScheduledThreadPool(2)
  private val acceptExecutor = Executors.newSingleThreadExecutor()
  private val stateLock = Any()
  private var generation: Long = 0
  private var prepared: PreparedAdvertisement? = null
  private var registrationListener: NsdManager.RegistrationListener? = null
  private var discoveryListener: NsdManager.DiscoveryListener? = null
  @Volatile private var registeredServiceName: String? = null
  private var multicastLock: WifiManager.MulticastLock? = null
  private var pendingStart: PendingStart? = null
  private val serviceInfoCallbacks = HashMap<String, NsdManager.ServiceInfoCallback>()

  override fun definition() = ModuleDefinition {
    Name("ChirpDiscovery")
    Events("onChirpDiscoveryEvent")

    AsyncFunction("prepareAdvertisement") {
      synchronized(stateLock) {
        if (prepared != null || registrationListener != null || discoveryListener != null || pendingStart != null) {
          throw IllegalStateException("Trusted discovery is already active.")
        }
      }

      val wifi = activeWifiEndpoint()
        ?: throw IllegalStateException("Trusted availability requires an active private IPv4 Wi-Fi address.")
      val server = ServerSocket()
      try {
        server.reuseAddress = true
        server.bind(InetSocketAddress(wifi.address, 0), 4)
      } catch (error: Exception) {
        try { server.close() } catch (_: Exception) { /* best effort */ }
        throw IllegalStateException("Trusted availability probe listener could not bind to Wi-Fi.", error)
      }

      val item = synchronized(stateLock) {
        val nextGeneration = ++generation
        PreparedAdvertisement(
          generation = nextGeneration,
          id = UUID.randomUUID().toString(),
          socket = server,
          wifi = wifi,
          nonce = UUID.randomUUID().toString().replace("-", "").lowercase(),
        ).also { prepared = it }
      }
      acceptExecutor.execute { acceptProbeLoop(item) }

      mapOf(
        "advertisementId" to item.id,
        "host" to (wifi.address.hostAddress ?: throw IllegalStateException("Wi-Fi address is unavailable.")),
        "port" to server.localPort,
        "nonce" to item.nonce,
      )
    }

    AsyncFunction("start") { advertisementId: String, peerHint: String, proof: String, promise: Promise ->
      val normalizedHint = peerHint.lowercase()
      val normalizedProof = proof.lowercase()
      if (!HINT_RE.matches(normalizedHint) || !PROOF_RE.matches(normalizedProof)) {
        promise.reject("ERR_DISCOVERY_ARGUMENT", "Trusted discovery authentication fields are invalid.", IllegalArgumentException())
        return@AsyncFunction
      }

      val item = synchronized(stateLock) {
        val current = prepared
        if (current == null || current.id != advertisementId || pendingStart != null || registrationListener != null || discoveryListener != null) {
          null
        } else {
          pendingStart = PendingStart(current.generation, promise)
          current
        }
      }
      if (item == null) {
        promise.reject("ERR_DISCOVERY_STATE", "Prepared trusted availability is unavailable.", IllegalStateException())
        return@AsyncFunction
      }

      val manager = try {
        acquireMulticastLock()
        nsdManager()
      } catch (error: Exception) {
        rejectPending(item.generation, "ERR_DISCOVERY_START", "Android trusted discovery is unavailable.", error)
        stopAll(rejectPending = false)
        return@AsyncFunction
      }

      val listener = object : NsdManager.RegistrationListener {
        override fun onServiceRegistered(serviceInfo: NsdServiceInfo) {
          val acceptedRegistration = synchronized(stateLock) {
            if (!isCurrentLocked(item.generation)) false
            else {
              registeredServiceName = serviceInfo.serviceName
              true
            }
          }
          if (!acceptedRegistration) {
            try { manager.unregisterService(this) } catch (_: Exception) { /* stale cleanup */ }
            return
          }
          beginDiscovery(manager, item)
        }

        override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
          if (!isCurrent(item.generation)) return
          rejectPending(
            item.generation,
            "ERR_DISCOVERY_REGISTRATION",
            "Android NSD registration failed ($errorCode).",
            IllegalStateException("registration_failed_$errorCode"),
          )
          stopAll(rejectPending = false)
        }

        override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) = Unit
        override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = Unit
      }

      synchronized(stateLock) {
        if (!isCurrentLocked(item.generation)) {
          rejectPending(item.generation, "ERR_DISCOVERY_STOPPED", "Trusted discovery was stopped.", IllegalStateException())
          return@AsyncFunction
        }
        registrationListener = listener
      }

      val serviceInfo = NsdServiceInfo().apply {
        serviceName = "Chirp-${item.nonce.take(10)}"
        serviceType = SERVICE_TYPE
        port = item.socket.localPort
        setAttribute("v", PROTOCOL_VERSION)
        setAttribute("h", normalizedHint)
        setAttribute("n", item.nonce)
        setAttribute("p", normalizedProof)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          network = item.wifi.network
        }
      }

      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          manager.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, callbackExecutor, listener)
        } else {
          @Suppress("DEPRECATION")
          manager.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, listener)
        }
      } catch (error: Exception) {
        rejectPending(item.generation, "ERR_DISCOVERY_REGISTRATION", "Android NSD registration could not start.", error)
        stopAll(rejectPending = false)
        return@AsyncFunction
      }

      callbackExecutor.schedule({
        if (hasPendingStart(item.generation)) {
          rejectPending(item.generation, "ERR_DISCOVERY_TIMEOUT", "Trusted discovery did not become ready in time.", IllegalStateException("start_timeout"))
          stopAll(rejectPending = false)
        }
      }, START_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    }

    AsyncFunction("probe") { host: String, port: Int ->
      val address = parsePrivateIpv4(host)
        ?: throw IllegalArgumentException("Trusted endpoint must be a private IPv4 address.")
      require(port in 1..65535) { "Trusted endpoint port is invalid." }
      val wifi = activeWifiEndpoint(address)
        ?: throw IllegalStateException("No active Wi-Fi route can reach the trusted endpoint.")
      val socket = Socket()
      try {
        socket.tcpNoDelay = true
        wifi.network.bindSocket(socket)
        socket.bind(InetSocketAddress(wifi.address, 0))
        socket.connect(InetSocketAddress(address, port), PROBE_TIMEOUT_MS)
      } finally {
        try { socket.close() } catch (_: Exception) { /* best effort */ }
      }
    }

    AsyncFunction("stop") {
      stopAll(rejectPending = true)
    }

    OnDestroy {
      stopAll(rejectPending = true)
      acceptExecutor.shutdownNow()
      callbackExecutor.shutdownNow()
    }
  }

  private fun beginDiscovery(manager: NsdManager, item: PreparedAdvertisement) {
    if (!isCurrent(item.generation)) return
    val browse = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(serviceType: String) {
        if (!isCurrent(item.generation)) {
          try { manager.stopServiceDiscovery(this) } catch (_: Exception) { /* stale cleanup */ }
          return
        }
        val serviceName = registeredServiceName
        if (serviceName == null) {
          rejectPending(item.generation, "ERR_DISCOVERY_STATE", "Registered service identity is unavailable.", IllegalStateException())
          stopAll(rejectPending = false)
          return
        }
        resolvePending(item.generation, mapOf("serviceName" to serviceName))
      }

      override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
        if (!isCurrent(item.generation)) return
        rejectPending(
          item.generation,
          "ERR_DISCOVERY_BROWSE",
          "Android NSD discovery failed ($errorCode).",
          IllegalStateException("discovery_start_failed_$errorCode"),
        )
        stopAll(rejectPending = false)
      }

      override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
      override fun onDiscoveryStopped(serviceType: String) = Unit

      override fun onServiceFound(serviceInfo: NsdServiceInfo) {
        if (!isCurrent(item.generation)) return
        if (normalizeType(serviceInfo.serviceType) != normalizeType(SERVICE_TYPE)) return
        if (serviceInfo.serviceName == registeredServiceName) return
        resolveService(manager, item, serviceInfo)
      }

      override fun onServiceLost(serviceInfo: NsdServiceInfo) {
        if (!isCurrent(item.generation)) return
        if (serviceInfo.serviceName == registeredServiceName) return
        sendEvent(
          "onChirpDiscoveryEvent",
          mapOf("type" to "service_lost", "serviceName" to serviceInfo.serviceName),
        )
      }
    }

    synchronized(stateLock) {
      if (!isCurrentLocked(item.generation)) return
      discoveryListener = browse
    }

    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, item.wifi.network, callbackExecutor, browse)
      } else {
        @Suppress("DEPRECATION")
        manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, browse)
      }
    } catch (error: Exception) {
      rejectPending(item.generation, "ERR_DISCOVERY_BROWSE", "Android NSD discovery could not start.", error)
      stopAll(rejectPending = false)
    }
  }

  private fun resolveService(manager: NsdManager, item: PreparedAdvertisement, serviceInfo: NsdServiceInfo) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      watchServiceInfo(manager, item, serviceInfo)
      return
    }
    resolveServiceLegacy(manager, item, serviceInfo)
  }

  private fun watchServiceInfo(manager: NsdManager, item: PreparedAdvertisement, serviceInfo: NsdServiceInfo) {
    val key = serviceInfo.serviceName ?: return
    synchronized(stateLock) {
      if (!isCurrentLocked(item.generation)) return
      if (serviceInfoCallbacks.containsKey(key)) return
    }
    val callback = object : NsdManager.ServiceInfoCallback {
      override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) {
        synchronized(stateLock) { serviceInfoCallbacks.remove(key) }
      }

      override fun onServiceUpdated(updated: NsdServiceInfo) {
        emitResolvedIfTrusted(item, updated)
      }

      override fun onServiceLost() {
        synchronized(stateLock) { serviceInfoCallbacks.remove(key) }
        if (!isCurrent(item.generation)) return
        if (key == registeredServiceName) return
        sendEvent(
          "onChirpDiscoveryEvent",
          mapOf("type" to "service_lost", "serviceName" to key),
        )
      }

      override fun onServiceInfoCallbackUnregistered() {
        synchronized(stateLock) { serviceInfoCallbacks.remove(key) }
      }
    }
    val registered = synchronized(stateLock) {
      if (!isCurrentLocked(item.generation) || serviceInfoCallbacks.containsKey(key)) false
      else {
        serviceInfoCallbacks[key] = callback
        true
      }
    }
    if (!registered) return
    try {
      manager.registerServiceInfoCallback(serviceInfo, callbackExecutor, callback)
    } catch (_: Exception) {
      synchronized(stateLock) { serviceInfoCallbacks.remove(key) }
    }
  }

  private fun resolveServiceLegacy(manager: NsdManager, item: PreparedAdvertisement, serviceInfo: NsdServiceInfo) {
    val listener = object : NsdManager.ResolveListener {
      override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = Unit

      override fun onServiceResolved(resolved: NsdServiceInfo) {
        emitResolvedIfTrusted(item, resolved)
      }
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        @Suppress("DEPRECATION")
        manager.resolveService(serviceInfo, callbackExecutor, listener)
      } else {
        @Suppress("DEPRECATION")
        manager.resolveService(serviceInfo, listener)
      }
    } catch (_: Exception) {
      // An unrelated or disappearing LAN service must not affect trusted availability.
    }
  }

  private fun emitResolvedIfTrusted(item: PreparedAdvertisement, resolved: NsdServiceInfo) {
    if (!isCurrent(item.generation)) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      val network = resolved.network
      if (network != null && network != item.wifi.network) return
    }
    val host = resolvedPrivateIpv4(resolved) ?: return
    val attrs = resolved.attributes
    val version = decodeAttribute(attrs["v"]) ?: return
    val hint = decodeAttribute(attrs["h"])?.lowercase() ?: return
    val nonce = decodeAttribute(attrs["n"])?.lowercase() ?: return
    val proof = decodeAttribute(attrs["p"])?.lowercase() ?: return
    if (version != PROTOCOL_VERSION || !HINT_RE.matches(hint) || !NONCE_RE.matches(nonce) || !PROOF_RE.matches(proof)) return
    if (resolved.port !in 1..65535) return

    sendEvent(
      "onChirpDiscoveryEvent",
      mapOf(
        "type" to "service_resolved",
        "service" to mapOf(
          "serviceName" to resolved.serviceName,
          "host" to host,
          "port" to resolved.port,
          "peerHint" to hint,
          "nonce" to nonce,
          "proof" to proof,
        ),
      ),
    )
  }

  private fun resolvedPrivateIpv4(serviceInfo: NsdServiceInfo): String? {
    val addresses: List<InetAddress> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      serviceInfo.hostAddresses
    } else {
      @Suppress("DEPRECATION")
      listOfNotNull(serviceInfo.host)
    }
    return addresses
      .filterIsInstance<Inet4Address>()
      .firstOrNull { isPrivateIpv4(it) }
      ?.hostAddress
  }

  private fun decodeAttribute(value: ByteArray?): String? {
    if (value == null || value.isEmpty() || value.size > 128) return null
    return try { String(value, StandardCharsets.UTF_8) } catch (_: Exception) { null }
  }

  private fun acceptProbeLoop(item: PreparedAdvertisement) {
    while (isCurrent(item.generation) && !item.socket.isClosed) {
      try {
        val socket = item.socket.accept()
        try { socket.close() } catch (_: Exception) { /* best effort */ }
      } catch (_: Exception) {
        break
      }
    }
  }

  private fun resolvePending(generation: Long, value: Any) {
    val pending = synchronized(stateLock) {
      pendingStart?.takeIf { it.generation == generation }?.also { pendingStart = null }
    } ?: return
    if (pending.settled.compareAndSet(false, true)) pending.promise.resolve(value)
  }

  private fun rejectPending(generation: Long, code: String, message: String, cause: Throwable) {
    val pending = synchronized(stateLock) {
      pendingStart?.takeIf { it.generation == generation }?.also { pendingStart = null }
    } ?: return
    if (pending.settled.compareAndSet(false, true)) pending.promise.reject(code, message, cause)
  }

  private fun hasPendingStart(generation: Long): Boolean = synchronized(stateLock) {
    pendingStart?.generation == generation && isCurrentLocked(generation)
  }

  private fun isCurrent(generation: Long): Boolean = synchronized(stateLock) { isCurrentLocked(generation) }

  private fun isCurrentLocked(candidate: Long): Boolean =
    prepared?.generation == candidate && generation == candidate

  private fun stopAll(rejectPending: Boolean) {
    val pendingToReject: PendingStart?
    val manager = try { nsdManager() } catch (_: Exception) { null }
    val browse: NsdManager.DiscoveryListener?
    val registration: NsdManager.RegistrationListener?
    val watchers: List<NsdManager.ServiceInfoCallback>
    val socket: ServerSocket?
    val lock: WifiManager.MulticastLock?

    synchronized(stateLock) {
      generation += 1
      pendingToReject = if (rejectPending) pendingStart.also { pendingStart = null } else null
      browse = discoveryListener.also { discoveryListener = null }
      registration = registrationListener.also { registrationListener = null }
      watchers = serviceInfoCallbacks.values.toList()
      serviceInfoCallbacks.clear()
      socket = prepared?.socket
      prepared = null
      registeredServiceName = null
      lock = multicastLock
      multicastLock = null
    }

    if (pendingToReject != null && pendingToReject.settled.compareAndSet(false, true)) {
      pendingToReject.promise.reject("ERR_DISCOVERY_STOPPED", "Trusted discovery was stopped.", IllegalStateException())
    }
    if (manager != null && browse != null) {
      try { manager.stopServiceDiscovery(browse) } catch (_: Exception) { /* best effort */ }
    }
    if (manager != null && registration != null) {
      try { manager.unregisterService(registration) } catch (_: Exception) { /* best effort */ }
    }
    if (manager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      for (callback in watchers) {
        try { manager.unregisterServiceInfoCallback(callback) } catch (_: Exception) { /* best effort */ }
      }
    }
    try { socket?.close() } catch (_: Exception) { /* best effort */ }
    try { if (lock?.isHeld == true) lock.release() } catch (_: Exception) { /* best effort */ }
  }

  private fun acquireMulticastLock() {
    if (multicastLock?.isHeld == true) return
    val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable.")
    val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
      ?: throw IllegalStateException("Wi-Fi service is unavailable.")
    synchronized(stateLock) {
      if (multicastLock?.isHeld != true) {
        multicastLock = wifi.createMulticastLock("ChirpDiscovery").apply {
          setReferenceCounted(false)
          acquire()
        }
      }
    }
  }

  private fun nsdManager(): NsdManager {
    val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable.")
    return context.getSystemService(Context.NSD_SERVICE) as? NsdManager
      ?: throw IllegalStateException("Android NSD service is unavailable.")
  }

  private fun normalizeType(value: String): String = value.trim().removeSuffix(".").lowercase()

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
      val address = links.linkAddresses.asSequence()
        .map { it.address }
        .filterIsInstance<Inet4Address>()
        .firstOrNull { !it.isLoopbackAddress && isPrivateIpv4(it) }
        ?: return null
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

  private fun hasRouteTo(links: LinkProperties, destination: Inet4Address): Boolean =
    links.routes.any { route -> route.matches(destination) }

  private fun parsePrivateIpv4(host: String): Inet4Address? {
    if (!host.matches(Regex("^\\d{1,3}(\\.\\d{1,3}){3}$"))) return null
    val address = try { InetAddress.getByName(host) } catch (_: Exception) { return null }
    return (address as? Inet4Address)?.takeIf { isPrivateIpv4(it) }
  }

  private fun isPrivateIpv4(address: Inet4Address): Boolean {
    val octets = address.address.map { it.toInt() and 0xff }
    return when {
      octets[0] == 10 -> true
      octets[0] == 172 && octets[1] in 16..31 -> true
      octets[0] == 192 && octets[1] == 168 -> true
      else -> false
    }
  }
}
