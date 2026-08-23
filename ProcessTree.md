# Hub — Startup Process Tree

Traces exactly what happens from process launch (`node server.js`) through
the Hub reaching steady state. Built by reading the actual source (not
inferred) — see file:line references throughout. Reflects the code as it
exists today, including subsystems that are present but intentionally
disabled (commented out) since this repo was cloned from the Client repo.

## Visualization

```mermaid
flowchart TD
    A["node server.js"] --> B["new NDPi() → initiate()<br/>server.js:49,53"]
    B --> C["exec('./sh/startup')<br/>server.js:55<br/>banner + xdotool mousemove ×2 (nudges X11 awake)"]
    C -->|"on 'exit'"| D["startFsData()<br/>server.js:64,73"]

    D --> E["new HubFsData(version, versionDate)<br/>hub_fs.js:43<br/>service/hub_fs.js"]
    E --> F["init() (process.nextTick)<br/>hub_fs.js:105,108"]
    F --> F1["mkdir DATA_NDPI_PATH if missing<br/>hub_fs.js:112"]
    F1 --> F2["Resolve device_id<br/>hub_fs.js:118<br/>Linux: /sys/.../serial-number → /etc/machine-id<br/>macOS fallback: ioreg IOPlatformSerialNumber"]
    F2 --> F3["Build fileMap: ~20 per-key settings<br/>hub_fs.js:148-346<br/>read existing flat file under DATA_NDPI_PATH,<br/>else write the default"]
    F3 --> F4["Load 7 JSON collections<br/>hub_fs.js:357-363<br/>accounts / clients / groups / rokuTvs /<br/>favoritedSources / discoveredSources / customLogo"]
    F4 --> F4a{"accounts.json empty?"}
    F4a -->|yes| F4b["createDefaultAdminAccount()<br/>hub_fs.js:766<br/>username 'admin', PIN '0000'"]
    F4a -->|no| F5
    F4b --> F5["start()<br/>hub_fs.js:368"]
    F5 --> G1["startWatcher() — fs.watch(dataDir)<br/>hub_fs.js:369,386"]
    F5 --> G2["startDrmMonitor() — udevadm monitor<br/>hub_fs.js:370"]
    F5 --> G3["updateOutputDisplayFiles() (once, sync head start)<br/>hub_fs.js:379"]
    F5 --> G4["pollUpdate() — 10 min interval<br/>hub_fs.js:380"]
    F5 --> G5["emit('ready')<br/>hub_fs.js:381"]
    F5 -.await.-> G6["waitForNetwork() → pollIp() — 1s interval<br/>hub_fs.js:382-383"]

    G5 -->|"NDPi.settings.on('ready')"| H["server.js:77-84"]
    H --> H1["targetSource = get('ndpi_status_ndi_source_target')"]
    H --> H2["func.setDisplayResolution()"]
    H --> H3["startApi()<br/>server.js:203"]
    H -.disabled.-> HX["startAirPlay() / startLcdDisplay() /<br/>startMdns() / startPythonBackend()<br/>server.js:80-83, all commented out<br/>(Client-only subsystems, never started on Hub)"]

    H3 --> I["new HubApiServer(settings)<br/>hub_api_server.js:114"]
    I --> J["start()<br/>hub_api_server.js:262"]
    J --> J1["express() + static mounts<br/>hub_api_server.js:263-299<br/>/ (public), /assets, /scripts, /media"]
    J --> J2["Register 8 WebSocket server groups (noServer)"]
    J2 --> J2a["__ws_NDIStreams() → /ws/ndi-stream/:id"]
    J2 --> J2b["__ws_Sources() → /ws/sources"]
    J2 --> J2c["__ws_Gui() → /ws"]
    J2 --> J2d["__ws_HubSystem() → /ws/system"]
    J2 --> J2e["__ws_HubStats() → /ws/hub-stats"]
    J2 --> J2f["__ws_Console() → /ws/console"]
    J2 --> J2g["__ws_DevicesSystemRelay() → /ws/devices/system"]
    J2 --> J2h["__ws_DevicesStatsRelay() → /ws/devices/stats"]
    J --> J3["__Routers()<br/>hub_api_server.js:1535<br/>registers /api/* routes BEFORE generic page routes<br/>(routing-order rule — see CLAUDE.md)"]
    J3 --> J3a["__RoutesAccounts / __RoutesDevices /<br/>__RoutesGroups / __RoutesRoku / __RoutesSystem"]
    J --> J4["startMdnsDiscovery()<br/>hub_api_server.js:1252<br/>bonjour.find({type:'ndpi-monitor-client'})<br/>browses LAN for Client devices"]
    J --> J5["startBroadcastIntervals()<br/>hub_api_server.js:1358<br/>10s heartbeat → broadcastToGUI() over /ws"]
    J --> J6["startDeviceTimeoutMonitor()<br/>hub_api_server.js:1367<br/>sweeps clients.json every 20s,<br/>marks stale devices offline"]
    J --> J7["reconnectAllDeviceRelays()<br/>hub_api_server.js:1127<br/>for every already-known adopted device,<br/>open outbound /ws/system + /ws/stats<br/>relay sockets to that device"]
    J --> K["startServer()<br/>hub_api_server.js:2689"]
    K --> K1["http.createServer(App).listen(PORT_API, '0.0.0.0')<br/>hub_api_server.js:2692<br/>default 3080"]
    K1 -->|"listen callback"| K2["emit('online') (process.nextTick)<br/>hub_api_server.js:2695"]
    K1 --> K3["Server.on('upgrade', ...)<br/>hub_api_server.js:2698<br/>routes ws upgrade requests to the<br/>8 registered WS servers by pathname"]

    K2 -->|"server_api.on('online')"| L["server.js:206-218"]
    L --> L1["isInitialized = true"]
    L -.disabled.-> LX["openCecController() / connectToNDPiServer() /<br/>startChromium()<br/>server.js:210-212, all commented out<br/>(controller_cec stays null; internal CEC route always 400s)"]

    M["Steady state"]
    K1 --> M
    M -.on demand.-> M1["/ws/sources connection → startDiscovery()<br/>hub_api_server.js:368,384<br/>spawns ndi_receiver_v3__NDI6/ndpi_discover<br/>(ARM64 Linux binary — ENOEXEC on non-Pi hosts,<br/>caught, source discovery just disables)"]
    M -.on demand.-> M2["/ws/ndi-stream/:id → new NDIStreamManager()<br/>hub_api_server.js:1590<br/>proxies MJPEG from ndi-backend/ Python FastAPI<br/>process (not started here — spawned lazily per stream)"]
    M -.per adopted device.-> M3["connectDeviceSystemRelay() /<br/>connectDeviceStatsRelay()<br/>outbound ws to <device-ip>:<device-port>/ws/system,/ws/stats<br/>5s reconnect loop, feeds device caches"]
    J4 -.on mDNS 'up'.-> M4["ensureDeviceRelayConnections()<br/>for already-adopted devices whose relay isn't up yet"]

    N["Signals"]
    N --> N1["SIGTERM / SIGINT → quitNDPi(signal)<br/>server.js:430-438<br/>_closePythonBackend (no-op, never started) →<br/>_closeApi (closes HTTP+WS server, timers) →<br/>_closeFsData (stops watcher/DRM monitor)"]
    N --> N2["uncaughtException → logged only, process stays up<br/>server.js:394"]
    N --> N3["unhandledRejection → logged, exit(1)<br/>server.js:405,419"]
```

## Notes on what's *not* pictured

- **Disabled-but-present Client subsystems**: `startAirPlay()`,
  `startLcdDisplay()`, `startMdns()` (mDNS *broadcast* — distinct from the
  Hub's own mDNS *discovery* in `startMdnsDiscovery()`), `startPythonBackend()`,
  `openCecController()`, `connectToNDPiServer()`, `startChromium()` all
  still exist as methods on the `NDPi` class in `server.js` but their call
  sites are commented out. `this.controller_cec` is therefore always
  `null` — any route that touches it (the internal CEC proxy) always
  400s. These were deliberately left in place by a prior session rather
  than deleted, matching the Client's own `index.js` shape for easier
  diffing.
- **`ndi-backend/` Python FastAPI process**: not started by `server.js`
  at all — `NDIStreamManager` (`service/NDIStreamManager.js`) is
  instantiated lazily, once per `/ws/ndi-stream/:id` browser connection,
  and presumably talks to a Python backend that must already be running
  separately (out of scope for this file — nothing in the traced startup
  path spawns it).
- **`./ndi-discover`, `ndpi_discover`**: ARM64 Linux binaries. On this
  repo's macOS dev environment `spawn()` fails with `ENOEXEC`; the
  failure is caught (`hub_api_server.js:397-405`) so the Hub keeps
  running with source discovery simply disabled. On real Pi hardware this
  spawns and streams live NDI source listings.
