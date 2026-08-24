# NDPi Monitor — Hub (this repo)

Working notes for completing this repo. Do not trust any `*.md` file in either
repo for architecture facts (they're stale) — this file is the exception,
since it's derived directly from reading the actual source and from live
repros, and is meant to be kept current as work proceeds.

## The two repos

- **This repo** (`Server__v3_1_0`, package name `ndpi-monitor-server`) — the
  **Hub**. User has renamed "Server" → "Hub" conceptually; code/config/comments
  still say "server" / "SERVER" / even "CLIENT" in leftover copy-pasted spots.
  Don't be surprised by mismatched naming — it's cosmetic debt, not a signal
  of a different architecture.
- **`../Client__v3_1_0`** (package name `ndpi-monitor-client`) — the
  **Client**: runs on each Raspberry Pi device, receives/displays one NDI
  source on its HDMI output, and exposes a local web UI + REST/WS API. This
  is "application version 3" — the **authoritative reference**. The Hub's job
  is to match what the Client actually does, not the other way around.
  **Do not edit files under `Client__v3_1_0` unless explicitly asked** — it's
  the fixed target, not part of this task.
- Files/folders prefixed `DEP_`, `XYZ_`, or named `*copy*` in either repo are
  deprecated/backup — ignore them as implementation references, but don't
  delete without asking.

## What the Hub is

A central dashboard + backend that discovers, tracks, and remote-controls
many Client devices on the LAN. It is **not** itself an NDI receiver/display
for arbitrary sources — it manages devices that are. It does, however, appear
to run its own kiosk-mode browser on an attached screen (`config/kiosk.service`,
`config/openbox`, `config/lightdm-autologin.conf`) showing its **own**
dashboard UI (`public/dashboard/dashboard.html`), which is why Hub-local
display-resolution/CEC settings could legitimately still matter — unlike
Client-only concerns (NDI receiver tuning, overlay image, audio volume),
which do not apply to the Hub at all.

## Hub architecture (as built)

- `server.js` — process entrypoint. Boots `hub_fs.js`, then `hub_api_server.js`.
  Cloned from Client's `index.js` and already correctly has Client-only
  subsystems (CEC controller, chromium kiosk launcher, AirPlay, LCD display,
  mDNS *broadcast*, Python NDI backend) commented out / never started. This
  part of the adaptation was already done correctly by a prior session.
- `service/hub_fs.js` — settings + data persistence layer, modeled on
  Client's `client_fs.js`. Two kinds of storage:
  - Per-key flat files under `process.env.DATA_NDPI_PATH` (`this.fileMap`),
    mirroring Client's pattern — **but most of these keys are still
    Client-device settings copy-pasted wholesale** (CEC, NDI receiver
    bandwidth/color/scale, `device_volume` w/ 256 dropdown options,
    `media_overlay_image`, `ndi_source_discovery_exec`) that don't apply to
    a Hub. Needs pruning to just what a Hub genuinely needs (device
    identity, API port, display resolution *if* Hub kiosk-mode is real,
    update-check bookkeeping).
  - JSON collection files (`accounts.json`, `clients.json`, `groups.json`,
    `roku-tvs.json`, `favorited-sources.json`) — this part is Hub-appropriate
    and already well-built (accounts w/ PIN auth, managed Client devices,
    groups, Roku TVs, favorited NDI sources).
- `service/hub_api_server.js` (2076 lines) — Express + WS server. Two
  generations of API coexist here:
  - **Hub-appropriate (new, keep)**: `/api/devices`, `/api/discovered-devices`,
    `/api/groups`, `/api/group/...`, `/api/roku-*`, `/api/account*`,
    `/api/admin/accounts`, `/api/favorite-ndi-sources`, `/api/active-viewers`,
    `/ws` (GUI live-update socket), `/ws/client` (persistent Client-device
    connection — **this one matches the real Client protocol correctly**,
    see below), mDNS discovery of Clients (`bonjour.find({type:'ndpi-monitor-client'})`).
  - **Vestigial single-Pi-client code (copy-pasted from Client, mostly dead
    weight on a Hub)**: `/ws/display`, `/ws/system`, `/ws/stats`, `/ws/sources`,
    `/api/v1/rpc`, `/api/v1/__internal/*` (cec/ndi/shutdown/reboot against
    `localhost`), the root `./ndi-discover` + `func.processCommand()` local
    NDI-source-selection flow. `this.controller_cec` is always `null` (never
    instantiated on the Hub), so the CEC internal route always 400s.
- `service/functions.js` (1090 lines) — near-verbatim copy of Client's
  `functions.js`. Almost entirely single-Pi concerns (xrandr, cec-compliance,
  xdotool window management, fadeVolume, NDI receiver window handling) that
  don't apply to a Hub. `processCommand()` here is dead code path from the
  Hub's own `/api/v1/rpc` — real device control goes through
  `hub_api_server.js`'s `sendCommandToClient()` over `/ws/client` instead.
- `service/NDIStreamManager.js` — legitimate, Hub-specific feature: proxies
  MJPEG frames from a local Python backend (`ndi-backend/`, FastAPI) over
  WebSocket for **live-preview thumbnails of NDI sources in the browser**,
  independent of any Client device. Compiled binaries
  (`ndi_receiver_v3__NDI6/ndpi_discover`, root `./ndi-discover`) are ARM64 —
  can't be exercised locally on macOS, only on the real Pi.
- `public/` — the Hub's own multi-page dashboard, one folder per page
  (`dashboard/`, `devices/`, `device/`, `groups/`, `group/`,
  `device-discovery/`, `users/`, `settings/`, `account-settings/`,
  `advanced-account-settings/`, `create-account/`, `set-pin/`, `sign-in/`,
  `console/`, `not-found/`), plus shared `public/01-scripts/*.js` and
  `public/styles.css`. Auth is PIN-based; the PIN's SHA-256 hash doubles as
  the bearer token (stored in `localStorage['ndpi_token']`), sent back to
  `POST /api/account` to resolve the session — no rotation/expiry.

## Running locally (dev/testing)

Nothing in this repo sets `DATA_NDPI_PATH` / `PORT_API` — they're presumably
provisioned externally on real Pi hardware (not tracked here). For local
testing:

```bash
DATA_NDPI_PATH=/tmp/hubdata PORT_API=3080 node server.js
```

Boots cleanly on macOS; only Linux-only tooling fails gracefully
(`udevadm`, `ip`, `xrandr`, etc. — all wrapped in try/catch or exec-error
handlers already). Default admin account created on first run:
**username `admin`, PIN `0000`**.

## Client protocol reference (ground truth — Hub must match this exactly)

Full detail was captured via a dedicated research pass; condensed here.

- **Client HTTP port**: `local_port_number_api` setting → `process.env.PORT_API`
  → default `3080`. **Hub uses the same default/convention for its own port.**
- **Client → Hub connection**: Client opens `ws://<ndpi_hub_hostname>:<ndpi_hub_port>/ws/client`
  and only connects once both are configured (and hostname isn't `localhost`).
  No auth/handshake beyond the first message.
- **Client → Hub message** (`type: 'client-status'`, sent on connect + every
  5000ms + on any local setting change):
  ```json
  {
    "type": "client-status",
    "deviceId": "...", "deviceName": "...", "ip": "...",
    "currentSource": "...", "displayMode": "overlay|blank",
    "streamStatus": "idle|streaming|stalled",
    "ndiInfo": { "resolution": "...", "framerate": 0, "displayName": "...",
                 "displayResolution": "...", "uptime": 0 },
    "systemStats": { "cpu": 0, "memory": {"percent":0,"used":0,"total":0},
                      "temperature": 0, "uptime": 0 },
    "settings": [ ["key", {"key":"...","value":"...","group":"...",
                   "allowEditInternal":bool,"allowEditExternal":bool,
                   "options":[...]?}], ... ]
  }
  ```
  Hub's `__ws_Devices()` handler in `hub_api_server.js` already consumes this
  shape correctly.
- **Hub → Client commands**: sent as raw JSON over the same open socket,
  **fire-and-forget — the Client never sends a response back over this
  channel**, regardless of command type. `sendCommandToClient()` in
  `hub_api_server.js` correctly resolves immediately after `ws.send()`; don't
  try to add a request/response pattern here without changing the Client too.
  Valid `type` values (exact strings, matching Client's `processCommand`
  switch in `functions.js`): `ping`, `show-blank`, `show-overlay`,
  `set-overlay`, `set-source`, `get-sources`, `send-cec`, `shutdown-device`,
  `reboot-device`, `rename-device`, `set-setting`, `check-for-update`,
  `install-update`.
  - ⚠️ **`show-blank` / `show-overlay` are a trap**: Client's handler for
    both calls `setNdi(command, response)`, which re-applies `command.data`
    as the NDI source target. If `data` is omitted (as Hub currently sends
    it), the source gets reset to `'none'`. Client's own local UI
    (`system.js`) never actually calls these two types — it toggles overlay
    vs. blank via `{type:'set-setting', data:{name:'ndpi_status_no_source_display_mode', value:'overlay'|'blank'}}`
    instead. **Hub should do the same**, not send `show-overlay`/`show-blank`.
  - `set-overlay` data shape: `{name,type,size,dateLastModified,dateUploaded,src}` — Hub's `/api/device/:id/overlay-image` route already builds this correctly.
  - `set-setting` data shape: `{name, value}` — Hub's `/api/device/:id/setting` route already builds this correctly. Client's `updateSetting()` only checks that a file with that key name already exists — it does **not** enforce `allowEditExternal` server-side (that flag is UI-only, used to grey out inputs).
  - `send-cec` data: a single already-encoded string, e.g. `encodeURI('standby 0')`. Confirm Hub's device page encodes the same way before sending.
  - Known **Client-side bug** (not ours to fix, but worth knowing): `rename-device`'s handler calls `fs.writeFileSync(path)` with no data argument — this throws inside Client's `processCommand`. Renaming a device remotely is currently broken on the Client side regardless of what Hub sends.
- **mDNS**: Client advertises service type **`ndpi-monitor-client`**, name
  `` `${type}-${deviceId}` ``, TXT fields `deviceId, deviceName, ip,
  commandPort, type, status, version`. Hub's `startMdnsDiscovery()` already
  matches this correctly.
- **Client settings** (`client_fs.js` fileMap) include many keys that are
  genuinely Client-only (CEC, NDI receiver tuning, `device_volume`, overlay
  image, chromium/NDI PIDs) — do not add Hub equivalents of these. The ones
  relevant to a Hub-side settings model: `device_name`, `device_id`,
  `device_ip`, `local_port_number_api`, `ndpi_version*`,
  `output_display_*` (if Hub kiosk mode is real).

## Status: fixes applied so far

Items 1-4 below (routing, shutdown crash, show-overlay/blank, port mismatch)
are **fixed** as of this pass, plus one additional bug found while verifying
fix #1 live: the generic `/:page/:ext/` catch-all was registered *before*
the real `/api/*` routes in `__Routers()`, so Express matched it first for
*any* two-segment path — including `/api/devices`, `/api/groups`,
`/api/discovered-devices`, `/api/admin/accounts`, `/api/roku-tvs`,
`/api/favorite-ndi-sources`, `/api/active-viewers`, `/api/resolution`,
`/api/system-logs`, `/api/account` (all exactly two segments). Every one of
these silently returned an Express file-not-found error page instead of
JSON — meaning no page's data ever actually loaded, independent of the
navigation bug. **Fixed by reordering `__Routers()`**: all `/api/*`
route-registration methods (`__RoutesAccounts`, `__RoutesDevices`,
`__RoutesGroups`, `__RoutesRoku`, `__RoutesSystem`, plus the `/api/v1/ndi-*`
block) now run *before* the generic page-serving routes (`/`,
`/:page/:ext/`, `/:page.html`, `/test-page`), which in turn run before the
final 404 catch-all. **Lesson: any future route added to this file must go
through one of the `__Routes*` methods (or otherwise be registered before
the generic page block), never after it.**

Also removed as part of this pass (zero consumers anywhere in the repo,
confirmed via repo-wide grep before deleting): `/ws/display`, `/ws/system`,
`/ws/stats`, `/ws/sources` WebSocket endpoints, `/api/v1/rpc`,
`/api/v1/__internal/:path`, and the corresponding dead code in
`functions.js` (`processCommand`, `setNdi`, `checkCecCompliance`, `exe`,
`wait`, `fadeVolume`, `launchPicom`, `killPicom`, `updateSetting`,
`updateInstall`, all `*Window_*` helpers, `activateWindow_AirPlay`,
`activateDisplay`, `discoverNDISources`, `formatNDISource`,
`getNDISourcesForAPI`, `getLocalIp`). `functions.js` now only exports
`stdoutToArray`, `waitForNetwork`, `setDisplayResolution`, `checkForUpdate`
— all four confirmed still in active use by `server.js`/`hub_fs.js`. The
public OBS-overlay pages (`public/02-custom-overlays/*.html`) were checked
first and confirmed to be pure static CSS with zero JS/API wiring, so they
were not affected by any of this.

`hub_fs.js`'s fileMap has also been pruned: removed `device_volume` (256-entry
dropdown), `ndpi_airplay_server_pin`, `ndpi_command_log`,
`ndi_source_discovery_exec`, `media_overlay_image` (all Client-only, zero
Hub consumers, confirmed via grep before removing), and the dead
`output_display_cec_*` writes inside `updateOutputDisplayFiles()` (wrote to
keys that were never in the fileMap to begin with — silent no-ops).
`device_type` default changed from `"NDPi Monitor Server"` to
`"NDPi Monitor Hub"`. Kept: device identity, ports, version/update
bookkeeping, and all `output_display_*` keys (Hub's own kiosk-screen
resolution — confirmed live via `server.js`'s active
`output_display_port`/`output_display_resolution_preference` listeners
calling `func.setDisplayResolution()`).

Frontend fixes also applied: `groups.html` now loads `/scripts/functions.js`
(was `/functions.js`, 404ing and breaking nav-bar wiring on that page only);
`01-scripts/functions.js`'s bootstrap no longer throws when `initPage` isn't
defined (guarded with `typeof initPage === 'function'`); `ws-client.js`'s
`sendViewerLeave()` now reads `localStorage['ndpi_account']` like
`sendViewerJoin()` does instead of relying on an accidental global; and
`users.html`'s grant/revoke-admin feature is restored (re-enabled
`toggleAdminPrivileges()`, wired off the already-loaded `account` global
instead of the never-populated `currentUser`, removed the dead local
`showToast()`). All verified live: full page sweep (200 on every page),
full `/api/*` sweep (200), PIN sign-in flow (`admin`/`0000`) all pass.

**Correction**: `/ws/sources` + `startDiscovery()` (spawns the long-running
`ndpi_discover` binary from `ndi_receiver_v3__NDI6/`, same one
`Client__v3_1_0/service/client_api_server.js` uses, pushing live NDI-source
updates to connected browsers) was reinstated at the user's explicit
request — it was live, user-facing functionality, not dead weight, despite
having no current frontend consumer wired up yet. Lesson: a websocket/route
having zero *current frontend* callers doesn't necessarily mean it's safe to
delete — check with the user before removing infrastructure that mirrors a
real Client-side capability, even if nothing in `public/` currently opens
it. `_tryCloseDiscovery()` keeps the null-check fix from earlier. Verified
on macOS: `spawn('./ndpi_discover', ...)` fails with `ENOEXEC` (ARM64 Linux
binary, wrong host arch) but the process stays up and shuts down cleanly —
expected on this dev machine, will run correctly on real Pi hardware. No
`.on('error', ...)` handler on the child process, intentionally, to match
the Client's own implementation exactly.

**Discovered NDI sources are now file-backed** (per user request): added
`discovered-ndi-sources.json` to `hub_fs.js` (`loadDiscoveredSources()` /
`getDiscoveredSources()` / `setDiscoveredSources()`, same pattern as
`favoritedSources`/`rokuTvs`). `startDiscovery()`'s `ndpi_discover` stdout
handler now writes through `this.settings.setDiscoveredSources(sources)`
instead of keeping a separate in-memory `this.availableSources` field
(removed). Every reader — `/ws/sources`'s on-connect send, `getNDISources()`
(and therefore `/api/ndi-sources` and the 10s GUI broadcast) — now reads
`this.settings.getDiscoveredSources()`, so there's one source of truth that
also survives a Hub restart instead of resetting to empty until the
discovery process reports back in. `getNDISources()` no longer shells out to
the broken `./ndi-discover` binary at all; it only merges the file's
contents with favorited sources.

**Found + fixed while verifying that change**: `startDiscovery()`'s
`spawn('./ndpi_discover', ...)` throws *synchronously* when the binary is
missing/wrong-architecture/non-executable (confirmed live: `ENOEXEC` on this
macOS dev machine, since the binary is compiled ARM64 Linux). Since
`getNDISources()` is `async` and Express 4 does not catch rejected promises
from async route handlers, this took the whole Hub process down
(`unhandledRejection` → `exit(1)`) on the very first `GET /api/ndi-sources`
call — a real crash risk on any Hub install where the binary is
missing/broken, not just on this dev machine. Wrapped the `spawn()` call in
try/catch (plus kept a `.on('error', ...)` handler for the async-failure
case) so a broken discovery binary just disables source discovery
(`/api/ndi-sources` returns `[]`) instead of crashing the Hub. Verified live:
repeated calls both return `200 []` and the process stays up.

**Fixed from real deployment logs**: `account-settings.html` loaded its own
page script via `/scripts/account-settings.js` — but `/scripts/` is mounted
to `public/01-scripts/` (shared utilities), not to each page's own folder;
the real file is `public/account-settings/account-settings.js`, reachable
at `/account-settings/account-settings.js` via the root `public/` static
mount. This was the only page with a real (non-empty) page-specific JS file
that actually got this wrong — checked all other `/scripts/*.js` references
across every page and they all correctly resolve into `01-scripts/`.

Also improved: `startMdnsDiscovery()`'s "Discovered NDPi Client without a
device ID" log now includes `service.name`/`host`/`fqdn`/`txt` instead of a
bare message. Client's `client_bonjour.js` gates on `deviceId` being set
before it ever calls `bonjour.publish()`, so this shouldn't be reachable in
steady state — most likely explanation is the mDNS browser firing `up` from
a PTR/SRV response that arrived before the TXT record resolved (a known
`bonjour`-package race, plausibly more likely right after Client's 60s
republish cycle stops+restarts its own advertisement). Not treated as a bug
fix since there's no evidence devices are lost permanently (a later `up`
event should carry the full TXT data) — just made diagnosable if it
recurs or turns out to be persistent for a specific device.

**Root-caused "Discovered NDPi Client without a device ID" from real logs**:
it's a decoding bug in the old `bonjour`/`dns-txt` dependency chain, not a
Client or Hub application bug. A DNS TXT record is supposed to be multiple
length-prefixed `<character-string>` entries; the library was instead
handing back one field whose value was every entry concatenated together,
with each entry's own length byte leaking through as a literal control
character (0x00-0x1F) — confirmed exactly from the user's real log line:
key `"\x19deviceid"` → value `"F564BD8290C80176\x1bdeviceName=HV Camp
Entryway\rip=10.0.1.182\x10commandPort=3080\x18type=..."`, where `0x19` =
25 decimal = the exact length of `"deviceId=F564BD8290C80176"`. Since the
field names and `=` delimiters always survive intact regardless of exactly
how the corruption lands, added `_extractMdnsTxtField(service, key)` in
`hub_api_server.js` — reconstructs the raw blob from `service.txt`'s
entries and regex-matches `key=<run of non-control characters>` as a
fallback whenever the clean `service.txt.<key>` lookup comes up empty.
Verified against the exact corrupted payload from the log: correctly
recovers `deviceId`, `deviceName`, `ip`, and `commandPort`. Applied to both
the `'up'` and `'down'` mDNS handlers.

**Verified the Hub's `device/device.html` against the Client's real local UI**
(fetched live from a production device at `ndpi-client.local:3080` — its
`system.html`/`system.js`/`socket.js` were byte-for-byte identical to
`Client__v3_1_0/public/`, so no drift to account for). Client's own UI opens
three sockets from the browser directly to that one device
(`ws/system` bidirectional settings editor, `ws/sources` read-only,
`ws/stats` read-only) and renders one form control per key in its settings
`fileMap`, grouped by `object.group`. **Those three sockets only accept
connections from the same local network segment as that specific device —
the Hub's browser can't (and shouldn't) connect to them directly**, since
that would bypass the Hub's own centralization and break for remote/VPN
access to the Hub. The Hub already has the right architecture in place
instead: every Client pushes its full settings `fileMap` to the Hub every
5s (+on change) over the persistent `/ws/client` connection
(`clientServer_websocket.js`), the Hub stores it per-device
(`client.settings`), and relays the whole device list to every connected
admin browser over its own `/ws` GUI socket — `device.html` was already
built to consume exactly this (`ws.onDevicesUpdate`), and already rendered
every `allowEditExternal` setting generically. Found and fixed three real
gaps rather than needing to rebuild this from scratch:
1. **Live updates were silently broken**: `ws.onDevicesUpdate`'s diffing
   logic aliased `device`/`updatedDevice` (not copies) and mutated
   `.systemStats = null` on *both* before comparing, intending to ignore
   noisy per-tick stat changes — but since they were the same references,
   this corrupted the incoming data itself, so `device.systemStats` got
   permanently nulled the first time any other field changed after page
   load, and the CPU/temp/mem header would silently vanish and never
   recover. Rewritten to diff via destructured copies (never mutates either
   object) and always assign the real `updatedDevice` through, with a new
   `updateStatsHeader()` (extracted out of `updateDevice()`) called on
   stats-only ticks so the header stays live without forcing a full
   re-render every 5 seconds.
2. `renderSettings()` only showed `allowEditExternal` fields, silently
   dropping every read-only diagnostic (CEC power status, process IDs,
   output display manufacturer/model, mDNS status, etc.) — Client's own UI
   shows these too, just `disabled`. Changed to render every reported
   setting, read-only ones disabled but visible, matching Client exactly.
3. Added grouping by `obj.group` (mirrors Client's per-card grouping:
   Device/Backend/Receiver/Display_Resolution/etc.) instead of one flat
   list, and excluded `ndpi_status_no_source_display_mode` from the generic
   grid (already has dedicated "Display Overlay"/"Blank Display" buttons —
   would otherwise show as a redundant second control for the same field).

**Fixed 4 more bugs from real usage**, two of which share a root cause:
1. **`settings.html` crashed on load** (`Cannot read properties of null
   (reading 'isAdmin')`) — `renderSections()` was called at top-level script
   scope, which runs *before* `01-scripts/functions.js`'s async
   `loadUserAccount()` call resolves, so the global `account` was still
   `null`. Fixed by moving the call into `initPage()`, the hook
   `functions.js`'s bootstrap already calls once `account` is actually
   loaded (same pattern `console.html` already used correctly).
2. **`set-pin.html` silently did nothing on submit** — same root cause, more
   severe: line 1 of the script synchronously read `account.firstName`
   before `account` loaded, threw immediately, and since it's a top-level
   statement that killed the rest of the script before it ever reached
   `form.addEventListener('submit', ...)` — the button had no handler at
   all. Fixed the same way (wrapped in `initPage()`). Also un-commented the
   PIN-match live-validation listeners while in there (previously dead
   stubs — one of the "lower priority" items below, now done).
3. **Root page redirected to `/signin.html` instead of `/sign-in.html`**
   (missing hyphen — the real page is `public/sign-in/sign-in.html`). Before
   my routing fix earlier this session this typo'd path would 404 with a
   bare Express error page; now it 404s to the styled not-found page
   instead — neither is the sign-in page. Fixed in `01-scripts/auth.js`
   (`redirectSignIn()` + the token-clear check) and a dead/commented
   reference in `advanced-account-settings.html`.
4. **Sign Out button "didn't work"** — same `/signin.html` typo:
   `signOut()` in `auth.js` correctly clears `localStorage` and calls
   `redirectSignIn()`, it just landed on the 404/not-found page instead of
   sign-in, which reads as "nothing happened." Fixed by the auth.js change
   above (bugs 3 and 4 are the same fix).

Checked every other page for the same "reads `account.x` before it's
loaded" crash pattern: `advanced-account-settings.html`/`create-account.html`
guard their admin check in a `setTimeout(…, 1000)` (works in practice,
lower-severity timing hazard, not a hard crash — left as-is, already listed
as a known issue above); `groups.html`'s is inside a commented-out dead
block; `group.html`'s and `device.html`'s only run from inside
data-dependent render functions invoked after their own async fetches
resolve, not at top-level scope — not the same bug.

**Fixed a regression I introduced, plus its actual root cause**:
1. Wrapping `settings.html`'s `renderSections()` in `initPage()` (previous
   fix) broke `initializeScale()`/`initializeScreenSaverSettings()`, which
   were still called at top-level script scope — before `renderSections()`
   (now deferred) had built the DOM elements they set `.value` on.
   `initializeScreenSaverSettings()` has no defensive null-check, so it
   threw immediately on `#screenSaverWait` being null — and since that's a
   top-level statement, the throw aborted the rest of the script before it
   ever reached `let rokuTvs = [];`, leaving that binding in the temporal
   dead zone (hence the *second*, seemingly unrelated `ReferenceError:
   Cannot access 'rokuTvs' before initialization` — same root cause, one
   fix). Moved both calls into `initPage()`, after `renderSections()`.
2. **The actual reason `set-pin.html` "still doesn't work" despite the
   earlier `initPage()` fix**: `01-scripts/functions.js`'s bootstrap
   unconditionally did `document.querySelector('.topbar').clientHeight` —
   but `set-pin.html` and `create-account.html` are standalone auth-flow
   pages with no topbar/bottombar app shell at all. That threw immediately,
   before `loadUserAccount()` or `initPage()` ever ran — so `initPage()`
   was correctly written but never actually got called. Made the bootstrap
   skip topbar-sizing and nav-button-wiring when those elements don't
   exist, instead of assuming every page that loads `functions.js` has the
   full app shell. This is what actually unblocks `set-pin.html`'s submit
   handler (and fixes `create-account.html`'s `account.isAdmin` check,
   which needs `loadUserAccount()` to have actually run too).

**Root-caused "can't see the ability to update client device variables"**:
confirmed via the user that a real device *was* connected, so I fetched its
actual live settings directly (`ws://ndpi-client.local:3080/ws/system`) and
found `ndpi_hub_port` was blank. Per `Client__v3_1_0/service/
clientServer_websocket.js`, the persistent `/ws/client` connection — the
*only* channel that ever delivers a device's `settings` snapshot to a Hub —
only opens once **both** `ndpi_hub_hostname` and `ndpi_hub_port` are set.
A device can be fully visible in the Hub's UI via mDNS (name/ip/port only)
while never having actually connected or reported anything. Not a Hub bug;
`renderSettings()` was already correct (verified against the device's real
47-entry settings payload).

**Built an actual fix for the underlying gap, not just a diagnosis**
(user's follow-up ask): when the Hub adopts a device discovered via mDNS
(`POST /api/device/:id?`), it now automatically tells that device where to
find this Hub, closing the loop instead of requiring the admin to
manually configure `ndpi_hub_hostname`/`ndpi_hub_port` on each device by
hand:
- **New endpoint on the Client** (`Client__v3_1_0/service/
  client_api_server.js`, explicitly authorized by the user to edit):
  `POST /api/v1/adopt` with `{ hubHostname, hubPort }` — writes both
  settings directly via `this.settings.put(...)`, same pattern as the
  existing `__internal` `'ndi'` case. No new Client-side auth; matches the
  rest of that API's existing (unauthenticated) surface.
- **Hub side**: added `hub_fs.js#getDiscoveredClient(deviceId)` (a
  singular, *unfiltered* lookup — `getDiscoveredClients()` deliberately
  excludes already-adopted devices, but adopt time is exactly when the raw
  mDNS-reported `ip`/`commandPort` is needed) and
  `hub_api_server.js#configureDeviceHubConnection(ip, commandPort)`, which
  POSTs to the device's new `/api/v1/adopt` with this Hub's own IP
  (`getServerIP()` — existed already, was unused until now) and port.
  Wired into the adopt route as best-effort (a device being briefly
  unreachable at adopt time doesn't fail the adopt itself; response
  includes `hubConfigured: true/false` either way).
- Verified end-to-end against a test double implementing the exact new
  Client endpoint: successful adopt correctly updates the fake device's
  settings, missing-field validation correctly 400s, and an unreachable
  device fails gracefully (`ECONNREFUSED`, no hang/crash) — plus confirmed
  live that the real adopt route still safely no-ops (`hubConfigured:
  false`) when no discovered-client record exists yet. **Not tested
  against the real "HV Camp Entryway" device** — doing so would actually
  repoint its live Hub connection, and the new Client endpoint isn't
  deployed there yet anyway (only exists in this local repo checkout).

**Added direct-to-device live sockets on `device/device.html`** (user
request): the browser now also opens `ws://<device-ip>:<device-port>/ws/system`
and `.../ws/stats` straight to the device itself
(`Client__v3_1_0/service/client_api_server.js`), the same two sockets its
own local `system.js` UI uses — in addition to (not replacing) the
existing Hub-relayed `ws.onDevicesUpdate` path, which stays as the
fallback/baseline and is still what keeps Hub-only fields (group,
online/offline status) current.
- `/ws/system` pushes the full settings snapshot (`Array.from(fileMap)`,
  same tuple shape as `device.settings`) on connect and again the instant
  *any* setting changes on the device — not just on the Hub's ~5s
  status-report cadence. `applyDeviceSettingsTuples()` applies it and
  derives `currentSource`/`displayMode`/`streamStatus`/`ndiInfo` from the
  tuples the same way the Client's own Hub-status report does, then calls
  `renderSources()`/`updateDevice()`.
- `/ws/stats` pushes raw `os.*`-derived fields (loadavg, cpus, freemem,
  totalmem, osUptime, thermal.thermal_zone0) every ~1s — a *different*
  shape than `device.systemStats`. `applyDeviceRawStats()` converts it to
  the `{cpu,memory,temperature,uptime}` shape the stats header expects.
  **Correction (this file previously said the wrong thing here)**:
  `client_api_server.js`'s `getSystemStats()` does `Number(os.uptime)` /
  `String(os.arch)` etc — no `()` — which looks like a bug (stringifying
  the function reference instead of calling it) but isn't one: Node's
  `os` module functions carry a `Symbol.toPrimitive` that makes `String()`/
  `Number()` coercion invoke them correctly (verified empirically:
  `String(os.arch)` → `'arm64'`, not the function source). So `osUptime` is
  a real, correct value — `uptime` is now read from it directly.
- Both sockets get their own simple 5s reconnect loop (mirrors the
  reconnect pattern used elsewhere in this app), matched to `ws:`/`wss:`
  based on the Hub page's own protocol, and are closed on
  `beforeunload`. Requires the admin's browser to be able to reach the
  device's IP directly (not just the Hub) — an explicit tradeoff the user
  chose for lower-latency updates over strict Hub-only centralization.
- Verified via `node --check` on the extracted inline script only — **the
  user asked to skip further verification and will test this against real
  devices themselves.**

**Fixed "None" source card not showing selected**: the Client stores "no
source" as the literal lowercase string `'none'` once a source has ever
actively been cleared (`Client__v3_1_0/service/functions.js`'s
`set-source`/`'ndi'` handler does `String(data || 'none')`), not just as
an empty/falsy value — but every "is this the current source" check in
the Hub frontend compared against the capitalized `'None'` placeholder
only, which is just the fallback substituted when the value is
empty/undefined. It never matched the real lowercase value, and picking
"None" made it *worse*: it sends `currentSource: ''`, which the Client
turns into literal `'none'` on its own settings, so the very next status
report flips the display back to "not selected." Added a shared
`isNoSource(value)` helper (case-insensitive, treats `''`/`'none'` both
as "no source") and used it everywhere the source-selection state is
checked or displayed:
- `device/device.html` (the reported page) — "None" card
  selected/current-badge state, and the "Current Source" info display.
- `group/group.html` (same pattern found on request) — its own "None"
  source card, header "current source" display/color, and per-device
  source text in the group's device list.
- `devices/devices.html` and `groups/groups.html` — simpler,
  single-use display-only fallbacks (no selection-state logic tied to
  them), fixed inline rather than with the shared helper since each is
  used exactly once.

**Added a device/browser clock-sync indicator** (user request) — a new
"Sync" pill next to Uptime in `device.html`'s stats header. Every
`/ws/stats` message from the device includes its own `systemTime`
(`client_api_server.js`'s `getSystemStats()`: `systemTime: String(new
Date())`); `applyDeviceRawStats()` now diffs that against this browser's
clock and stores `device.clockSync = {diffSeconds, inSync}` (`inSync` =
within 3s), and the pill shows "In Sync" (green), "Xs Ahead/Behind"
(yellow ≤10s, red beyond that), or a neutral "—" before the first direct
`/ws/stats` message arrives (the Hub-relayed path doesn't carry
`systemTime` at all, so there's nothing to compare until the direct
socket connects). Had to also fix a side effect: `ws.onDevicesUpdate`
fully replaces the `device` object with the Hub-relayed one on every
change, which has no `clockSync` field — without carrying it forward
explicitly, the pill would've flickered back to "—" on every Hub-relay
tick even while the direct socket stayed healthy and its own comparison
would have spuriously forced a full re-render every tick too (a field
present-vs-absent mismatch always fails the JSON.stringify diff check).

**Aligned `device.html`/`group.html` header + stats-pill styling** (user
request, scoped to visual/layout consistency rather than forcing
single-device-only sections — overlay image, per-device settings editor,
software update — onto a multi-device group page, since those don't have
a group-level equivalent): matched the title to the same 32px size and
removed group's manual 28px-spacer centering hack in favor of the same
simple layout device.html already used; replaced group's static,
asymmetric-flex 2-item stats header (hand-written HTML, `flex:1`/`flex:9`)
with a dynamically-rebuilt 3-pill row using the exact same per-pill markup
device.html's `updateStatsHeader()` uses (equal-width flex-column pills,
uppercase 11px label, bold colored 16px value) — Devices / Online (X/Y,
color-coded) / Source. The `#deviceCount`/`#currentSourceDisplay` element
IDs that used to be patched in place no longer exist (replaced by a full
`innerHTML` rebuild each call, matching device's pattern) — updated the
two other call sites that touched them directly
(`removeDeviceFromGroup()`, and added a call from `ws.onDevicesUpdate`
which previously never refreshed the header at all, so the new "Online"
count would've gone stale between group-level broadcasts).

**Built four new WebSocket endpoints** (user request):
1. **`/ws/system`** — the Hub's own settings feed, mirroring
   `Client__v3_1_0/service/client_api_server.js`'s local `__ws_System()`
   exactly: sends `Array.from(this.settings.fileMap)` on connect, then the
   same raw string again in full any time a Hub setting changes
   (`fsData.on('update', ...)`, restored in the constructor — this hookup
   existed before the earlier "vestigial code" cleanup pass and needed to
   come back for the Hub's own settings specifically, not the removed
   Client-only single-device concerns).
2. **`/ws/stats`** — the Hub's own machine stats, in the same *raw*
   `os.*`-derived shape `client_api_server.js`'s `getSystemStats()`
   produces (systemTime, osArchitecture, osUptime, freemem, totalmem,
   hostname, loadavg, thermal.{thermal_zone0,fan1_input}, osMachine,
   osPlatform, osRelease, osVersion, networkInterfaces, cpus) — deliberately
   a *different* method (`getHubRawSystemStats()`) from the pre-existing
   `hubSystemStats()` (which stays as-is, still feeding the `/ws` GUI
   broadcast's summarized `system-stats` messages) so as not to disturb
   that existing consumer. Pushes on connect, then every ~1s while anyone's
   connected (self-stops the interval when the last listener disconnects).
3. **`/ws/devices/system`** and **4. `/ws/devices/stats`** — the
   multi-device relay/aggregator. The Hub now opens its own outbound
   connection to every adopted device's own `/ws/system`/`/ws/stats`
   (`connectDeviceSystemRelay()`/`connectDeviceStatsRelay()`, 5s reconnect
   loop, `deviceSystemSockets`/`deviceStatsSockets: Map<deviceId, {ws, ip,
   port, reconnectTimer}>`), caches the latest raw message per device
   (`deviceSystemCache`/`deviceStatsCache: Map<deviceId, rawMessage>`,
   exactly per the user's "save in a map by device id" spec), and relays
   every update to browsers connected to these two Hub-hosted endpoints as
   `{type:'device-system'|'device-stats', deviceId, data}`. A browser
   connecting to either gets the *entire current cache* immediately as one
   `{type:'snapshot', devices:{deviceId: data, ...}}` message, so a page
   loaded between device updates isn't blank. One Hub→browser connection
   now serves every device on a multi-device page instead of the browser
   opening one connection per device (which is what `device.html`'s
   earlier direct-to-device sockets still do for single-device pages —
   that stays as-is; this relay is the new mechanism intended for
   multi-device pages like `devices.html`/`dashboard.html`/`groups.html`,
   **whose frontends have not yet been updated to consume it** — this pass
   built and verified the backend relay only, per the literal ask
   ("Create a ... endpoint"); wiring the multi-device pages to use it
   instead of REST polling is a natural follow-up).
   - **Connection triggers**: (a) every `client-status` message over
     `/ws/client` (`ensureDeviceRelayConnections()`, using the device's own
     reported `local_port_number_api` setting — persisted onto the client
     record as `apiPort`, not currently exposed over the public REST API,
     just used internally for this) — self-healing, since this fires on
     every status report; (b) the adopt route
     (`POST /api/device/:id?`), using the mDNS-reported `commandPort` for
     an immediate first connection rather than waiting for the device's
     next status report; (c) Hub startup (`reconnectAllDeviceRelays()`),
     for devices already known from a previous run.
   - **Cleanup**: forgetting a device (`DELETE /api/device/:deviceId`,
     `POST /api/devices/forget-all`) calls `closeDeviceRelayConnections()`
     — closes both sockets, clears their reconnect timers, and drops the
     device from both caches, so it stops being reconnected to and
     disappears from the relay snapshot.
   - Verified with two live end-to-end tests (fake Client device standing
     in on a real port, driven through the real Hub, not mocked at the
     unit level): (1) snapshot delivery, live relay tagging with the
     correct `deviceId`, and cache updates all confirmed correct via
     scripted assertions; (2) forgetting a device closes its relay socket
     and does *not* reconnect even after waiting past the 5s retry window.
     Full page/API regression sweep still 200s, clean shutdown in both
     tests and standalone.

**Correction to something stated earlier this session**: I'd claimed
`client_api_server.js`'s raw stats fields (`String(os.arch)`,
`Number(os.uptime)` etc, no `()`) were bugs producing `NaN`/function-source
strings. They're not — Node's `os` module functions carry a
`Symbol.toPrimitive` that makes `String()`/`Number()` coercion invoke them
correctly (verified empirically: `String(os.arch)` → `'arm64'`). Fixed
`device.html`'s `applyDeviceRawStats()` to actually use `raw.osUptime` now
instead of deliberately ignoring it. My own new Hub-side code still calls
these explicitly (`os.arch()`, `os.uptime()`, etc.) rather than relying on
the coercion quirk — equally correct, just less surprising to read.

**Wired the multi-device pages to the relay endpoints** (follow-up to the
above, user request). Added a new shared client
`public/01-scripts/ws-devices.js` (`NDPiDevicesRelay` class), mirroring how
`ws-client.js` already wraps the single `/ws` GUI connection — one class
handles connecting to either `/ws/devices/system` or `/ws/devices/stats`,
buffers the snapshot + live relay messages into a local `cache` keyed by
deviceId, debounces bursts of per-device updates (200ms) so many devices
reporting close together coalesce into one re-render instead of one per
device, and auto-reconnects (5s) like every other socket in this app.
Exports two pure helper functions used by consuming pages:
`deriveDeviceStats(raw)` (converts a device's raw `/ws/stats` payload into
the `{cpu,memory,temperature,uptime}` shape `dev.systemStats` already uses
everywhere) and `getRelayedSetting(tuples, key)` (pulls one setting's
`{value,...}` out of a cached `/ws/system` tuple array).
- **`devices.html`** and **`group.html`**: both now additionally subscribe
  to the stats relay (updates each tile's `dev.systemStats` /
  `group.devices[].systemStats`, re-rendering) and the system relay
  (updates `currentSource` from the live `ndpi_status_ndi_source_target`
  setting) — supplementing their existing Hub-relayed `ws.onDevicesUpdate`
  (~5s cadence, stays as the fallback/baseline for Hub-only fields like
  group/status), so tile stats and source changes now reflect within
  ~1s instead of ~5s, using one shared connection each rather than one
  per device.
- **`dashboard.html`**: same device-tile wiring as above, **plus** this
  was the page the user explicitly named for the Hub's own `/ws/stats` —
  replaced the old `ws.onSystemStatsUpdate` handler (fed by the `/ws` GUI
  socket's ~5s `system-stats` broadcast, backed by the separate
  `hubSystemStats()` method, left untouched server-side) with a direct
  connection to the Hub's new dedicated `/ws/stats`, converting its raw
  shape to the summarized one `updateSystemStats()` already renders
  (`deriveHubStats()`, same formula as `deriveDeviceStats()` but inlined
  since it targets different DOM/shape — `diskUsage` has no raw
  equivalent, kept at `0` matching `hubSystemStats()`'s own placeholder).
  Also fixed a pre-existing latent bug noticed in passing but out of scope
  to chase further right now: `ws.onViewersUpdate` unconditionally called
  `updateViewersDisplay()`, which is fully commented out on this page —
  guarded with a `typeof` check (matches how `devices.html` already
  guards the same call) so a viewer-join/leave broadcast doesn't throw.
- `groups.html` (the plural list page — group *summaries*, not per-device
  tiles) was **not** wired — it has no per-device data displayed, so
  neither relay has anything to attach to there.
- **Verified three ways**: (1) syntax-checked all four edited files'
  extracted scripts plus the new shared script; (2) unit-tested
  `deriveDeviceStats()`/`getRelayedSetting()` against real payload shapes
  (the actual device's captured `/ws/stats` JSON, and realistic
  `/ws/system` tuples) — correct output confirmed; (3) loaded the *actual,
  unmodified* `ws-devices.js` file into Node with a minimal
  `window`/`WebSocket` shim and drove the real `NDPiDevicesRelay` class
  against the real running Hub plus a fake Client device on a real port —
  confirmed it correctly connects, receives the snapshot, and derives the
  right stats/settings shape, as close to an actual browser run as
  possible without one. Full page/API regression sweep still 200s, clean
  shutdown throughout.

Still open (lower priority, not blocking, nothing crashes): dead
`public/0app.js` / `public/01-scripts/set-page.js` (unused, loaded by no
page); orphaned `showNetworkSettings()`/`cecInactiveSource()`/
`showServerNetworkSettings()` (complete functions, no button wired — and
the backend routes they'd call are intentional `501 Not Implemented`
stubs, so low value to wire up); half-built "active viewers" UI (transport
works, no page renders it); duplicate `addRokuTv()` definition in
`settings.html`; `set-pin.html`'s live PIN-match validation listeners are
stubbed (server-side validation on submit still works). See "Frontend
audit findings" above for full detail on each.

### Dashboard REST removal + `/ws` devices snapshot + targeted tile patching

Two follow-up requests: (1) `dashboard.html` shouldn't poll `GET
/api/devices` at all — only `devices.html` needs it; (2) device/group tiles
across the app shouldn't fully re-render (rebuild `innerHTML`) on every
data update, only the specific changed DOM elements should be touched.

**Shape-consistency fix first (`service/hub_api_server.js`)**: the `/ws`
GUI socket's `broadcastDevices()` sent `this.settings.getClients()`
raw — a *different* shape than `GET /api/devices` (which maps through a
`deviceOut()` transform: renames `deviceId`→adds `id`, defaults
`currentSource`/`displayMode`/`streamStatus`/`group`). Dropping the REST
fetch in favor of pure WS data would have broken anything relying on
`dev.id` or the defaults. Fixed by hoisting `deviceOut()` out of
`__RoutesDevices()`'s local scope into a class method (`this.deviceOut()`),
used by both the REST route and `broadcastDevices()` now. Also added a
`devices-update` snapshot sent immediately on `/ws` connect (inside
`__ws_Gui()`, right after the existing `connected` message) so a
WS-only page isn't blank until the next broadcast — mirrors the snapshot
pattern the `/ws/devices/system`/`/ws/devices/stats` relay already used.
Verified live: booted the Hub and opened a raw WS client against `/ws` —
confirmed `connected` then `devices-update` (with `devices: []` against an
empty test datastore) arrive back-to-back on connect.

**`dashboard.html`**: removed `fetchDevices()` entirely (it had **two**
separate call sites — one in "Initial load" near the top of the script,
and a second leftover duplicate call at the very end of the same script
block; both gone) and the pointless `ws.onDiscoveredDevicesUpdate →
fetchDevices()` re-fetch (dashboard never displays discovered/unadopted
devices, only `devices.html` does). Also fixed a real bug found in
passing: `ws.onDevicesUpdate = (devices) => { window.devices = devices;
... }` was assigning to `window.devices`, not the outer `let devices`
`renderDevices()` actually reads (top-level `let` doesn't become a
`window` property) — so WS-driven device updates were silently never
rendered on this page prior to this fix; only the initial REST fetch ever
worked. Renamed the param and assigned to the real outer variable.
`devices.html` keeps its REST-based `fetchDevices()` per the user's
explicit instruction (it also needs `/api/discovered-devices`, which has
no WS equivalent).

**Targeted DOM patching** (replacing "wipe `container.innerHTML` and
rebuild every tile from a template string on every update" with "create
each tile's DOM once, then patch only the specific text/color/visibility
of the fields that can change"), applied consistently to every
device/group tile renderer in the app:
- `devices.html`: `renderDeviceSection()` → `reconcileDeviceSection()` +
  `createDeviceTile()`/`updateDeviceTile()`, keyed by
  `` `${containerId}:${id}` `` (a device moving between the
  online/discovered/offline sections gets a fresh tile — different key
  prefix — everything else patches in place).
- `dashboard.html` / `groups.html`: `renderDevices()`/`renderGroups()` →
  same create-once/patch-in-place split, keyed by device/group id.
- `group.html`: `updateDevicesList()`/`buildDeviceTileHtml()` → same
  pattern (`createGroupDeviceTile()`/`updateGroupDeviceTile()`). This page
  already had a partial optimization (skip full rebuild if the device
  id/order set was unchanged), but that fast path never patched the
  **source** field — so a device's live `currentSource` change relayed via
  `devicesSystemRelay` updated internal state but was never reflected in
  that device's tile in the group's device list (only the group-level
  header pill, via `updateGroupHeaderStats()`, updated). Fixed as part of
  this rewrite — `updateGroupDeviceTile()` now patches the source text/
  title unconditionally.
- All reconcilers maintain a `Map<id, refs>` across renders, diff the
  incoming list against `seenIds` to remove stale tiles, and use
  `insertBefore`/`nextSibling` comparisons to keep DOM order matching data
  order without reordering nodes that are already correctly placed.
- **Verified**: syntax-checked every edited file's extracted `<script>`
  block with `node --check`; booted the Hub and curl'd all four pages to
  confirm they still serve their container elements correctly; grepped for
  leftover references to the deleted `buildDeviceTileHtml()` (none) and
  confirmed exactly one `Map` declaration per page (no duplicate
  `deviceTiles`/`groupTiles` from a bad merge). Did **not** get a real
  browser/DOM smoke test (no `puppeteer`/`jsdom` in this repo's
  `node_modules`, and installing either wasn't authorized) — the
  create/patch DOM logic itself should be reviewed by eye or tested in a
  real browser before being fully trusted, since it's the one part of this
  change that couldn't be exercised outside a real DOM.

### Full visual redesign — dark UniFi-style control-center theme (user request)

User asked for the entire `public/` GUI to be redesigned to feel like
Ubiquiti's UniFi cloud console, specified as the "modern dark UniFi" variant
(not the light/white classic look) with the app's existing green
(`rgba(129,193,39,1)`) as the accent instead of UniFi's blue, and asked for
the accent to be user-selectable and persisted server-side rather than only
in browser localStorage.

- **`styles.css`** rewritten around CSS custom-property tokens: `--accent`/
  `--accent-rgb` (the one selectable value — everything else is fixed
  regardless of accent choice), a near-black `--bg-0`..`--bg-3` surface
  scale (flat, no blur/glass — the old `.card`/`.device-card` glassmorphism
  and the `#wallpaper` background image are gone), and fixed semantic
  status colors (`--online`/`--offline`/`--warning`/`--danger`) so
  online/offline meaning never depends on which accent is active. Added a
  new `.status-pill` component and a `.theme-swatch` picker component.
  Fixed a real pre-existing bug found while doing this: the back-button
  style targeted `#back-btn` (an id selector) but every page markup uses
  `class="back-btn"` — the rule never matched anything; now `.back-btn`,
  restyled as a circular icon button in the new header.
- **Shell replaced**: the old fixed `.topbar` (top) + `.bottombar` (bottom
  nav bar, 5 buttons: Dashboard/Devices/Groups/Settings/Account) is now a
  persistent left `.sidebar` (`.sidebar-logo` + `.sidebar-nav` +
  `.sidebar-footer` holding the account button) plus a slim `.topbar`
  header (page title only) above a scrollable `.content` pane — applied to
  all 12 pages that use the `.app` shell (`dashboard`, `devices`, `device`,
  `groups`, `group`, `settings`, `users`, `console`, `account-settings`,
  `advanced-account-settings`, `device-discovery`). Added real sidebar
  entries for **Users** and **Console** — both pages existed already but
  were previously unreachable from any nav (confirmed via repo-wide grep:
  nothing linked to `users.html` or `console.html` before this pass); each
  had been faking `applyActiveNav('navAccount')` since no real nav button
  existed for them, now fixed to their own `navUsers`/`navConsole`.
  `01-scripts/functions.js`'s `setNavigationButtons()` rewritten to match
  (sets a `.nav-btn-label` span instead of the whole button's
  `textContent`, since nav buttons now also carry an inline SVG icon); the
  old `syncAppPaddingToBars()`/`initAppPaddingSync()` ResizeObserver hack
  and every page's duplicated `topbarLogo` width/height-from-clientHeight
  JS snippet are both gone — no longer needed since the new shell sizes
  itself with plain CSS (fixed sidebar width, fixed header height) instead
  of measuring bars at runtime. Below 860px width the sidebar collapses
  back into a bottom icon bar (flex-direction switch in CSS only) so
  kiosk touchscreens/phones keep the original thumb-reachable bottom nav.
- **Selectable, server-persisted accent color**: added `ui_theme_color`
  to `hub_fs.js`'s settings `fileMap` (default `#81c127`, options list of
  6 preset colors) — persisted the same way every other Hub setting is
  (flat file under `DATA_NDPI_PATH`, picked up by the existing
  `fs.watch` debounce path). Reused the existing generic
  `POST /api/setting` write route as-is and added a matching
  `GET /api/setting/:name` (previously only a full-settings-array read
  existed, over `/ws/system`) so a page can read one setting back with a
  small REST call instead of opening a websocket just for that. Added
  `applyThemeColor()`/`fetchAndApplyThemeColor()`/`saveThemeColor()` to
  `01-scripts/functions.js`: every page applies the last-known color
  synchronously from `localStorage['ndpi_theme_color']` via a tiny inline
  `<script>` at the very top of `<head>` (before `styles.css`'s default
  ever paints), then reconciles against the Hub's authoritative value via
  the new GET route once `functions.js` loads. `settings.html` got a new
  "Appearance" card with a 6-swatch picker (`saveThemeColor()` on click)
  under "User Preferences" — deliberately a Hub-wide setting rendered next
  to the other Hub-wide settings (display resolution, etc.), not a
  per-account preference, matching the user's "saved to the device itself"
  framing.
- **All sizing converted from `px` to `rem`** (user follow-up request, for
  responsive PC/phone/tablet scaling): `styles.css` in full (322
  conversions) plus every page's inline `style="..."` attributes and
  embedded `<style>` blocks, via a script that deliberately skipped
  `<script>...</script>` contents everywhere (to avoid corrupting real
  pixel-math like `event.pageY`/`clientHeight`-based positioning) and
  skipped `public/02-custom-overlays/*.html` entirely (OBS
  compositing-overlay pages, calibrated in real pixels for stream layout —
  out of scope). One exception left as-is on purpose: `01-scripts/modal.js`
  and `01-scripts/screen-saver.js` inject their own `<style>` text via JS
  template strings mixed with real measured-pixel positioning
  (`logoBox.style.top = ...`) in the same file — converting those wasn't
  attempted, to avoid conflating authored sizing with measured coordinates
  in a higher-risk file.
- **Best-effort orientation lock** (same follow-up request): added
  `lockOrientation()` to `01-scripts/functions.js`, called once on every
  page load. Only actually takes effect when the page is fullscreen (true
  for the Hub's own kiosk-mode chromium per `config/kiosk.service`) — the
  Screen Orientation API rejects the lock request in an ordinary browser
  tab, so this is wrapped to fail silently there rather than throw; the
  sidebar/bottom-bar responsive breakpoint already handles both
  orientations regardless.
- **Verified**: booted the Hub locally (`DATA_NDPI_PATH=/tmp/... PORT_API=3081
  node server.js`), swept every page route (200), swept `/api/*` (200,
  except the pre-existing `/api/active-viewers` 404 — no route ever
  existed for it, unrelated to this change), round-tripped
  `GET`/`POST /api/setting(/ui_theme_color)`, confirmed `styles.css` has
  zero remaining `px`, confirmed the sidebar+content shell renders exactly
  once on all 11 relevant pages, ran a full HTML tag-balance check (Python
  `html.parser`) across every edited page (zero mismatches), and ran
  `node --check` against every extracted inline `<script>` block across
  every page plus the modified backend files (`hub_fs.js`,
  `hub_api_server.js`) and `01-scripts/functions.js` — all clean. **Not**
  verified in an actual browser (no visual/DOM smoke test available in
  this environment) — the create/patch DOM logic from the prior pass and
  the new CSS should still be reviewed visually before being fully
  trusted.

### Post-redesign fixes: account-settings crash, bigger sidebar logo, uploadable logo

Three follow-ups from the user after trying the redesigned UI:

1. **`account-settings.html` crashed on load**
   (`Cannot read properties of null (reading 'username')`) — same root
   cause as the other "reads `account.x` before it's loaded" crashes fixed
   earlier in this file (settings.html, set-pin.html): `account-settings.js`
   ran `populateFields()` as a top-level IIFE statement, which executes
   before `01-scripts/functions.js`'s async `loadUserAccount()` call has
   resolved, so the global `account` was still `null`. This was the one
   page that had never been fixed to the established pattern. Fixed by
   wrapping the same code in a plain `function initPage() {...}` instead —
   `functions.js`'s bootstrap already calls `initPage(account)` once
   `account` has actually loaded, and picks it up correctly even though
   `account-settings.js`'s `<script>` tag loads *after* `functions.js`'s,
   because `functions.js`'s own top-level IIFE yields at its first
   `await` (the account fetch) before `initPage` would need to exist,
   giving the browser time to synchronously load and execute
   `account-settings.js` (defining `initPage`) first.
2. **Sidebar logo enlarged** (user request) — `.topbar-logo` in
   `styles.css` bumped from `1.625rem` (26px) to `2.25rem` (36px); still
   fits comfortably inside the `3.5rem` sidebar header row.
3. **Uploadable custom Hub logo, with before/after preview** (user
   request) — new Hub-wide branding override:
   - **`hub_fs.js`**: new `custom-logo.json` collection file (mirrors the
     `favorited-sources.json`/`discovered-ndi-sources.json` pattern) via
     `loadCustomLogo()`/`getCustomLogo()`/`setCustomLogo()`. Stores
     `{ name, type, dataUrl, dateUploaded }` — the image itself as a
     base64 data URL, same idiom Client__v3_1_0 used for its (Hub-removed)
     `media_overlay_image` setting.
   - **`hub_api_server.js`**: new `/api/logo` route (registered inside
     `__RoutesSystem()`, i.e. before the generic page-serving routes, per
     this file's standing routing-order rule).
     `GET` decodes and serves the stored image with its real content type
     if one is set, otherwise **redirects to the bundled
     `/media/logo-page-header.svg`** — so every consumer (CSS
     `background-image`, an `<img src>`) can point at this one URL
     unconditionally and always get a valid image, with zero JS needed to
     choose between "custom" and "default". `POST` validates the MIME
     type (png/jpeg/webp/gif/svg only) and a 2MB cap before saving;
     `DELETE` clears it back to default. Also bumped the global
     `express.json()` body-size limit from Express's 100kb default to
     `5mb` (was previously undersized for *any* base64 image upload in
     this app, including the pre-existing device overlay-image route —
     not newly broken by this change, just newly noticed while adding a
     second image-upload route).
   - **Every place the old static logo path was hardcoded now points at
     `/api/logo` instead**: `styles.css`'s `.topbar-logo`
     `background-image` (covers the sidebar logo on all 12 shell pages
     from one place), and the centered `<img>` on `sign-in.html` and
     `not-found.html` (the only two standalone pages that had one).
   - **`settings.html`**: extended the "Appearance" card (added earlier
     this session for the theme-color picker) with a "Logo" row —
     side-by-side `.logo-preview-box` squares for "Current" (`<img
     src="/api/logo">`) and "New (unsaved)" (populated via
     `FileReader.readAsDataURL()` the moment a file is chosen, before
     anything is sent to the server), plus Choose/Save/Reset buttons.
     Save POSTs the pending data URL, then cache-busts (`?t=Date.now()`)
     both the current-logo `<img>` and every `.topbar-logo` element's
     inline `background-image` so the change is visible immediately
     without a full page reload; Reset calls `DELETE /api/logo` through
     the same `modal.confirm()` pattern used elsewhere in this app (e.g.
     sign-out).
   - **Verified live**: booted the Hub, round-tripped a real 1x1 PNG
     through `POST`/`GET`/`DELETE /api/logo` (byte-for-byte match via
     `diff` against the decoded original, confirmed `Content-Type:
     image/png`), confirmed `GET /api/logo` 302s to the default SVG both
     before upload and after reset, confirmed a non-image MIME type is
     rejected with 400, `node --check` on all modified backend files plus
     `account-settings.js` and `settings.html`'s extracted script, and a
     full page-route sweep (all still 200, including
     `account-settings.html`).

### Toast repositioning, star-to-favorite, theme contrast/hue, and the UI-scale bug

Four more user requests/fixes in one pass:

1. **Toast notifications moved to the bottom of the screen** (user
   request) — `01-scripts/modal.js`'s `Toast` class used to position
   itself off the live-measured vertical center of `.topbar`
   (`positionContainer()`, computed fresh on every `show()` call). Removed
   that entirely; `.toast-container` is now simply `position: fixed;
   bottom: 20px` (bumped higher on ≤860px viewports via
   `var(--mobile-navbar-height)` so it clears the collapsed bottom nav
   bar, same clearance `.floating-actions` already used), and the
   in/out keyframes animate via `translateY` from/to `0` instead of the
   old centering `translateY(-50%)` trick.
2. **Star-to-favorite on source cards** (user request) — previously the
   *only* way to favorite an NDI source was `settings.html`'s "Favorite
   NDI Sources" editor, a fully manual name/URL entry flow
   (`viewFavoriteSources()`/`publishFavoriteSources()`, bulk-replaces the
   whole list via `POST /api/favorite-ndi-sources`, unchanged). Source
   cards (`.source-card`, only ever rendered on `device.html` and
   `group.html` — confirmed via repo-wide grep) already carried a
   `src.favorite` flag from `getNDISources()`'s merge logic, but the only
   UI for it was a tiny non-interactive star badge that showed up *only
   when already favorited* (`.source-info.favorite` — also had a real
   layout bug: `position: fixed` instead of `absolute`, so it was
   actually positioned relative to the viewport, not its own card).
   Replaced with an always-visible, always-clickable `.source-fav-btn`
   (outlined when not favorited, filled accent-warning-colored when it
   is) in the same top-right corner spot, wired to a new single-source
   add/remove path: `hub_fs.js#toggleFavoritedSource()` (same
   exact-then-fuzzy name/url matching `getNDISources()`'s merge already
   used, so a source flagged `favorite: true` there is recognized as the
   same entry and removed rather than duplicated) behind a new
   `POST /api/favorite-ndi-sources/toggle` route, which also immediately
   re-broadcasts `{type:'ndi-sources'}` to every connected GUI (same
   shape the existing 10s polling interval already sends) so every
   browser's source grid updates right away instead of waiting up to
   10s. `device.html`/`group.html` each got their own
   `toggleFavoriteSource()` — duplicated per-page rather than shared,
   matching this codebase's existing convention of per-page copies of
   `parseSourceName()`/`parseNdiUrl()`/etc. rather than a shared module.
3. **More contrast + accent-tinted backgrounds** (user request: "a
   little more contrast" and "match the hue of all the background colors
   to match the selected theme color", after noticing a blue tint) — the
   `--bg-0`..`--bg-3` tokens (`styles.css`) were fixed hex values that
   happened to read slightly blue (each had B > R/G, e.g. `#16181d`).
   Rewritten as `color-mix(in srgb, var(--accent) N%, <base-hex>)`, so
   every surface's hue now follows whichever accent color is selected —
   and because custom properties recompute live, switching the accent
   swatch in Settings re-tints the whole app instantly with no JS
   changes needed beyond what already sets `--accent`. Also widened the
   lightness gap between layers (page background vs. card vs. nested
   surface like inputs) for more visible separation, bumped `--border`/
   `--border-strong` opacity (0.08→0.11, 0.16→0.22), and brightened
   `--text-0`/`--text-1` (pure white / lighter gray) for stronger
   text-on-surface contrast. Border colors were deliberately left
   hue-neutral (translucent white, not accent-tinted) — mixing an opaque
   accent into a low-alpha white via `color-mix` raises the *alpha* too
   (interpolated alongside color), which would have made every border
   far more prominent/colored than intended; only backgrounds were asked
   for and only backgrounds were changed.
4. **UI-scale setting broke the mobile bottom nav bar** (user-reported:
   floats above the bottom edge at <100% scale, renders off-screen at
   >100%) — root cause: `setScale()` (`01-scripts/functions.js`, plus
   duplicated live copies in `sign-in.html`, `not-found.html`, and
   `settings.html`'s `applyScale()`) scaled the whole page via
   `body.style.zoom` (falling back to `transform: scale()`), but `.app`'s
   `height: 100dvh` is a viewport-relative unit that's computed against
   the *real, unscaled* device viewport regardless of an ancestor's
   zoom/transform — so the two stopped matching at any scale other than
   100%: at <100% the visually-shrunk `.app` box no longer reached the
   bottom of the real screen (gap below the nav bar); at >100% the
   visually-grown box overflowed past it (nav bar rendered off-screen).
   Fixed by scaling via the root `<html>` font-size instead
   (`document.documentElement.style.fontSize = scale + '%'`) — viable
   now (wasn't before) because the entire app was converted from `px` to
   `rem` earlier this session, so every dimension rescales from root
   font-size alone, while `100dvh`/other viewport units stay correctly
   pinned to the real screen at any scale since font-size doesn't affect
   viewport-unit math at all. Fixed in all four live call sites; left
   two dead, already-commented-out duplicate copies in
   `advanced-account-settings.html` and `groups.html` untouched (verified
   both are inside `/* ... */` blocks that never execute).
5. **Verified**: booted the Hub, round-tripped the new toggle route twice
   (add then remove the same source, confirming the flip both ways) plus
   a missing-name/url 400 check, confirmed `styles.css` serves the new
   `color-mix()` tokens and `.source-fav-btn` rule, `node --check` on
   every modified backend file plus every touched page's extracted inline
   script (all clean), and a full page-route sweep (all 200s).

### Card contrast, modal/toast/screensaver consolidated into styles.css, and a real button-hover bug

Four more from the user after living with the redesign a bit:

1. **Device/group/user/source tiles were blending into their card
   container** (user-reported) — `.device-card`, `.group-tile`,
   `.user-tile`, `.source-card`, and `.source-card-none` all used
   `var(--bg-2)`, the *exact same* token as the `.card` container each of
   them sits inside, so they only read as separate via a faint 1px
   border. Added a new, deliberately darker `--bg-tile`/`--bg-tile-hover`
   token pair (same `color-mix(in srgb, var(--accent) N%, <base>)`
   pattern as the rest of the palette, sitting between `--bg-0` and
   `--bg-1` in darkness -- darker than the `.card` container per the
   user's explicit ask, reading as a recessed "well" rather than a raised
   panel) and switched all five to it.
2. **Modal buttons weren't following theme changes, plus a real
   dark-on-dark hover bug** (user-reported: "some buttons, when hovered,
   show the dark background, and the text color is also dark/black") —
   root cause confirmed by working out actual CSS specificity, not just
   inspecting colors: the base `select:hover, button:hover { background:
   var(--bg-3-hover); }` rule (specificity (0,1,1) -- one element + one
   pseudo-class) was *silently beating* every single-class button variant
   that changes its hover look via `filter:` instead of redeclaring
   `background` (`.button-primary`, `.discovery-button`,
   `.add-device-btn`, `.fab` -- all bare classes, specificity (0,1,0)).
   On hover, their `background` actually resolved to the neutral dark
   `--bg-3-hover` instead of their own bright accent color, while their
   `color` (chosen dark, e.g. `#0a0b0d`, specifically for contrast against
   that *bright* non-hover background, and with no competing hover rule
   to change it) stayed dark -- dark text on a dark background. Fixed at
   the root instead of patching each variant: changed the base rule to
   `select:where(:hover), button:where(:hover)`, which keeps its
   specificity at (0,0,1) -- exactly tied with the non-hover base
   `select, button {...}` rule above it (so it still wins that tie by
   source order for a plain unstyled button, preserving the intended
   default hover feedback) but now correctly loses to *any* single-class
   variant, fixing all four buggy buttons at once. Separately, and
   because the underlying complaint was really "modal buttons don't
   follow theme" -- see next item.
3. **Consolidated every script-injected stylesheet into styles.css**
   (user request: "add the modal styling, and the offline overlay
   styling, and any other script injected or rogue styles to the main
   style sheet for easier tracking") — audited every file under
   `01-scripts/` for runtime `document.createElement('style')` injection;
   found two (`.offline-overlay`/`.offline-modal`/etc. were already
   static in `styles.css`, not injected — `ws-client.js` just applies
   those existing classes to a DOM node it creates, nothing to move):
   - `01-scripts/modal.js`'s `Modal` class (`.modal-overlay`,
     `.modal-box`, `.modal-button*`, `.modal-option*`, etc.) and `Toast`
     class (`.toast*`) each had an `initStyles()` that injected a
     `<style>` full of hardcoded hex colors (`#2a2a2a`, `rgb(129, 193,
     39)`, etc.) — this is *why* modal buttons didn't follow theme
     changes: they were never wired to `--accent`/the `--bg-*` tokens at
     all. Both `initStyles()` methods deleted outright; the same rules
     now live in styles.css under new `MODAL`/`TOAST` sections, rewritten
     onto the shared tokens (`.modal-button-primary` → `var(--accent)`,
     `.toast-success`'s left border → `var(--online)`, etc.) — so both
     now re-theme live along with everything else, and both also picked
     up real (if minor) `:hover` states several sub-elements never had
     before (`.modal-option` had no hover feedback at all previously,
     only `:active`).
   - `01-scripts/screen-saver.js`'s `_createScreenSaverElements()` had
     the same pattern for `#screen-saver-modal`/`#logo-container`/
     `.logo-svg`/`@keyframes blurAnimation`, built from
     `transitionSettings.*.duration` JS constants that never actually
     change at runtime — moved to styles.css as static CSS with those
     durations (1000ms/0ms/1000ms) written out literally. Confirmed safe
     to drop `#logo-container`'s injected `width`/`height` entirely
     (rather than move them): they were already dead weight, immediately
     overridden by the inline `logoBox.style.width/height` the same
     function sets moments later — inline style always wins regardless.
     Also removed the now-pointless `styleTag.remove()` cleanup in
     `_hideScreenSaver()` (nothing left to remove).
4. **Verified**: booted the Hub, confirmed `styles.css` now serves
   `--bg-tile`, the `:where(:hover)` rule, and the moved-in
   `.modal-overlay`/`.toast-container`/`#screen-saver-modal` rules,
   confirmed neither `modal.js` nor `screen-saver.js` still contain a
   `createElement('style')` call, grepped for leftover references to the
   deleted `#modal-styles`/`#toast-styles`/`#screen-saver-styles` element
   IDs (none), `node --check` on both modified files, a full brace-balance
   check on `styles.css`, and a page-route sweep (all 200s).

### Fixed-position sidebar/topbar (overscroll bounce) + a live padding-sync mechanism

User request: `.topbar`/`.sidebar` should be `position: fixed` so they
stay visually locked in place through page-level overscroll/rubber-band
on phones (even though `.content` was already the only *scrolling*
region, iOS/Android can still bounce the whole page around fixed-height
flex layouts) -- user explicitly named the needed follow-up too: "this
will require a variable padding adjustment mechanism for the content of
the page," since a fixed-position bar is taken out of normal document
flow and no longer reserves space for itself.

This is exactly the mechanism an earlier pass in this file removed
(`syncAppPaddingToBars()`/`initAppPaddingSync()`, deleted when the shell
was first rewritten around a flexbox `.sidebar`+`.main` layout, on the
reasoning that a non-fixed flex sibling didn't need runtime height
measurement) — rebuilt here for the new fixed-position bars, adapted to
current class names/rem sizing:

- **`styles.css`**: `.app` is no longer `display: flex` — it's just a
  `position: relative` sizing/stacking context now, since its two former
  flex children behave completely differently: `.sidebar` is `position:
  fixed; top/left/bottom: 0` (full-height left column on desktop; the
  existing ≤860px media query now additionally repoints it to `left:0;
  right:0; bottom:0` — a bar docked to the bottom edge — instead of the
  old flex `order: 2`), and `.topbar` is `position: fixed; top: 0; left:
  var(--sidebar-width); right: 0` (`left: 0` on mobile, matching the
  collapsed sidebar). `.main` is a normal-flow block offset by a *static*
  `margin-left: var(--sidebar-width)` (`0` on mobile) — deliberately
  left this one non-dynamic, since a fixed column width never grows from
  text wrapping the way a bar's *height* can. **Caught and fixed one bug
  before it shipped**: initially also gave `.main` an explicit `width:
  100%`, which — combined with `margin-left` — overflowed `.main`'s
  right edge exactly `--sidebar-width` past the viewport (100% of the
  containing block *plus* a left margin overruns it; the fix is to leave
  `width` unset, since a block box with `width: auto` and a margin
  correctly auto-solves to fill just the remaining space). Two new
  tokens, `--live-topbar-height`/`--live-bottombar-height`, feed
  `.content`'s `padding-top`/`padding-bottom` (`:root` defaults to
  `var(--header-height)`/`0px` as the pre-JS first-paint fallback) —
  `.floating-actions` and `.toast-container`'s bottom offsets were also
  switched onto `--live-bottombar-height`, which *removed* their
  separate `@media (max-width: 860px)` overrides entirely (the token is
  `0px` on desktop and the real measured height on mobile, so one rule
  now covers both cases these two previously needed a media query for).
- **`01-scripts/functions.js`**: new `syncFixedBarMetrics()` reads
  `.topbar`/`.sidebar`'s real `offsetHeight` and writes both custom
  properties onto `<html>` (inline style, so they always win over the
  `:root` stylesheet fallback) — `--live-bottombar-height` is only ever
  set from `.sidebar`'s height when `window.matchMedia('(max-width:
  860px)')` currently matches (i.e. only while it's actually acting as a
  bottom bar; on desktop it's a full-viewport-height left column, and
  using that height as bottom padding would be wildly wrong), otherwise
  `0px`. `initFixedBarMetrics()` wires this to a `ResizeObserver` on both
  elements (only fires on genuine size changes, e.g. long text wrapping)
  plus a `matchMedia(...).addEventListener('change', ...)` (covers
  crossing the breakpoint on a tick where neither element's own box
  necessarily resizes enough to trigger the observer on its own), and
  runs immediately on script load/`DOMContentLoaded` — independent of
  the account-loading IIFE, so layout is correct before that async work
  resolves. No-ops via early return on the standalone auth pages
  (sign-in/set-pin/create-account/not-found), which have no
  `.topbar`/`.sidebar` at all.
- **Verified**: booted the Hub, confirmed `styles.css` serves the new
  `position: fixed` rules and both live-height tokens, confirmed
  `functions.js` serves `syncFixedBarMetrics`/`initFixedBarMetrics`, a
  full brace-balance check on `styles.css`, `node --check` on
  `functions.js`, cross-checked that every `--live-*` custom property
  name written by the JS has an exact matching consumer in the CSS (and
  vice versa), and a page-route sweep (all 200s). **Not** verified
  visually in an actual browser/on a real phone (no browser tooling in
  this environment) — the box-model reasoning above (particularly the
  `.main` width fix) should be sound but is worth a real-device check
  before fully trusting the overscroll behavior specifically, since
  that's the one part of this that can't be exercised outside real
  touch/rubber-band scrolling.

### Mobile padding-clobber bug, tamed-down background tint, and a collapsible desktop sidebar

Four more from the user after trying the fixed-bar change on a real phone:

1. **Mobile still hid content under both bars** (user-reported, despite
   the fixed-bar work above) — root cause found by re-reading, not
   guessing: a pre-existing `@media (max-width: 31.25rem) { .content {
   padding: 0.75rem; gap: 0.75rem; } }` rule (≈500px, i.e. effectively
   every phone) used the `padding` *shorthand*, which resets all four
   sides — including `padding-top`/`padding-bottom`, the two properties
   the new `--live-topbar-height`/`--live-bottombar-height` mechanism
   depends on. Same selector specificity as the base `.content` rule,
   declared later in the file, so per cascade order it silently won and
   wiped the fixed-bar compensation back to a flat `0.75rem` on every
   phone-width screen. Fixed by splitting it to `padding-left`/
   `padding-right` only, leaving `padding-top`/`padding-bottom`
   untouched so the live values keep applying.
2. **Backgrounds tamed down** (user: "make the lighter contrasted
   background colors more gray and transparent, and only make the
   darker background colors match the theme") — `--bg-2`/`--bg-2-hover`
   (card surfaces) and `--bg-3`/`--bg-3-hover` (nested surfaces: inputs,
   stat chips, buttons) were `color-mix()`-tinted the same way as every
   other layer; switched to plain neutral `rgba(255,255,255,α)`
   overlays (no accent hue at all) at α 0.05/0.075/0.09/0.12
   respectively, so they read as gray glass over whatever's beneath
   rather than a solid tinted block. `--bg-0` (sidebar), `--bg-1` (page
   background), and `--bg-tile`/`--bg-tile-hover` (device/group/source/
   user tile backdrops, added earlier this session) keep their
   `color-mix()` accent tint exactly as before — those are the "darker"
   layers the user meant.
3. **Desktop sidebar nav buttons: left-aligned, fit-content width, plus
   a collapse/expand toggle** (user request, explicitly scoped to the
   non-mobile configuration) — `.nav-btn` was `width: 100%`, and
   `.sidebar-nav`/`.sidebar-footer` had no explicit `align-items` (so
   defaulted to `stretch`), together forcing every nav button to fill
   the full sidebar width regardless of its short label. Changed the
   desktop default to `align-items: flex-start` on both containers and
   `max-width: 100%` (not a forced `width`) on `.nav-btn`, so each
   button now sizes to its icon+label content. Preserved mobile's
   existing equal-width bottom-bar look by explicitly restoring
   `align-items: stretch` / `flex: 1` inside the ≤860px media query
   (mobile's `.sidebar-nav` already had `align-items: stretch`
   explicitly; `.sidebar-footer` didn't, so needed adding). Added a new
   `#sidebarToggle` button (styled as another `.nav-btn`, a
   panel-with-divider icon) to `.sidebar-footer` on all 11 shell pages,
   wired in `01-scripts/functions.js` (`initSidebarToggle()`/
   `applySidebarCollapsed()`, persisted to `localStorage` as
   `ndpi_sidebar_collapsed`) to toggle a `.sidebar-collapsed` class on
   `.app`. That one class redefines `--sidebar-width` to a new
   `--sidebar-width-collapsed` (4.25rem) via `.app.sidebar-collapsed {
   --sidebar-width: ...; }` — since `.sidebar`/`.main`/`.topbar` already
   all key off that single variable (from the fixed-position work
   above), redefining it in one place resizes/repositions all three at
   once; collapsed-state rules then hide every `.nav-btn-label`/
   `.sidebar-logo-title`/`.sidebar-section-label` and center the
   now-icon-only buttons. Confirmed inert on mobile by construction
   (the ≤860px media query hardcodes `.sidebar`/`.main`/`.topbar`'s
   left/width/margin instead of reading `--sidebar-width` at all, so
   redefining it there has no effect) rather than needing an extra
   guard — `#sidebarToggle` is still explicitly hidden there via CSS
   for clarity, since collapsing a bottom bar isn't a meaningful action
   regardless.
4. **Verified**: booted the Hub, confirmed `styles.css` serves the new
   `.sidebar-collapsed`/`--sidebar-width-collapsed`/neutral-`rgba` rules
   and the corrected (split, not shorthand) mobile `.content` padding,
   confirmed `functions.js` serves the toggle functions, confirmed
   `#sidebarToggle` renders on a live page fetch, a full HTML
   tag-balance check across every page (via Python's `html.parser`,
   zero mismatches) after the mechanical 11-file button insertion, a
   full brace-balance check on `styles.css`, `node --check` on
   `functions.js`, and a page-route sweep (all 200s). **Not** verified
   visually — the mobile padding-clobber diagnosis is a confident read
   of the cascade rules (confirmed by grepping the actual rule text
   and its position in the file, not assumed), but should still be
   checked on a real phone alongside the still-outstanding overscroll
   verification from the previous pass.

### mDNS presence fighting the real `/ws/client` connection state (`/ws` broadcast flood + adopted cards flashing offline)

Two user-reported symptoms turned out to be **the same root cause**, confirmed by a dedicated research pass reading the actual event chain rather than guessing from symptoms:

- Adopted device cards' stats/status briefly flashed offline whenever a
  `discovered-devices-update` message arrived on `/ws`.
- Far more than the expected ~1 `devices-update` broadcast per 5s-per-device
  was arriving on `/ws` — user measured >10/sec.

**Root cause** (`hub_api_server.js`'s `startMdnsDiscovery()`, the
`bonjourBrowser.on('up'/'down', ...)` handlers): both unconditionally
called `this.settings.upsertClient(deviceId, {status: 'online'/'offline'})`
for *any* device with a saved record, with no check for whether that
device already has a live `/ws/client` connection (tracked in
`this.deviceConnections`, the actually-authoritative signal — updated on
real connect/disconnect, per-device). mDNS presence is a much flakier
signal than that persistent connection: `Client__v3_1_0/service/
client_bonjour.js`'s republish cycle does a `service.stop()` (→ mDNS
"goodbye", seen here as `down`) followed by `bonjour.publish()` (→ `up`)
**every 60 seconds, for every adopted device, regardless of whether
anything actually changed** — and that republish is *also* wired to 6
separate settings-change listeners, so a burst of settings changes (e.g.
at Client boot) could trigger several such cycles back to back. Each
down/up pair flipped an already-online device's `status` to `'offline'`
then immediately back to `'online'`, and each of those two writes
independently triggered `hub_fs.js`'s `clients-update` event →
`broadcastDevices()` → a **full** (not delta) device list sent to every
browser on `/ws`. The transient `status:'offline'` write is exactly what
briefly hid an adopted device's stats client-side (`devices.html`'s
`showStats` check gates on `dev.status === 'online'`) — the
`discovered-devices-update` message the user noticed alongside it was a
red herring correlated in time (both the `up` handler's
`upsertDiscoveredClient()` and its `upsertClient()` fire from the same
mDNS event), not itself capable of touching adopted-device data (verified
by tracing `devices.html`'s `onDiscoveredDevicesUpdate` handler: it only
ever touches the separate `discoveredDevices` array, never the adopted
`devices` array). **Fixed** by gating both mDNS handlers on
`!this.deviceConnections.has(deviceId)` — mDNS now only ever sets
`status` for a device that *doesn't* currently have a live `/ws/client`
socket (i.e. it's still a legitimate fallback for devices not yet
talking to the Hub, just no longer allowed to override the real
connection's own authority once one exists; that connection's own
`onclose` handler already marks it offline the instant it actually
drops).

**Also added, as defense-in-depth** (not itself the root cause, but a
real gap `hub_fs.js`'s settings-file writes don't have — those already go
through a 500ms debounce, `_fsEvent`/`__flushQueue`; `clients.json`
writes via `saveClients()` never did): debounced the `clients-update` →
`broadcastDevices()` wiring itself (trailing-edge, 150ms). This also
coalesces a separate legitimate burst source noticed while investigating:
`startDeviceTimeoutMonitor()`'s 20s-interval `forEach` over every client
calls `upsertClient()` once per newly-stale device found in the same
synchronous tick — if several devices go stale together (e.g. a network
blip), that used to fire one full broadcast per device instead of one
broadcast for the whole batch.

**Investigated and confirmed NOT a bug**: user also asked whether
`/ws/devices/system` (the per-device settings relay) was only ever
sending its initial snapshot. Traced `connectDeviceSystemRelay()` and
confirmed it forwards every message it receives from a device's own
`/ws/system`, not just the first — the reason it can appear to send only
one message for long stretches is that `Client__v3_1_0`'s `/ws/system`
itself only pushes when that device's *settings actually change*
(`fsData.on('update', ...)`), with no periodic heartbeat push (unlike
`/ws/stats`, which does have one) — so a quiet device with no setting
changes will legitimately go long stretches without a `device-system`
message. Correct behavior, not a relay bug; not changed.

**Verified**: booted the Hub against a live network with real discoverable
devices (unadopted in the fresh test datastore, so the exact
already-adopted-device-flapping scenario couldn't be directly reproduced
without adopting a real device's Hub connection — not done, per this
file's standing rule against side-effecting a real physical device
without explicit authorization), connected a raw `ws` client to `/ws` and
counted message types over a 10s window: exactly one `devices-update`
(the connect-time snapshot) plus the expected steady-state
`heartbeat`/`system-stats`/`ndi-sources` — no flood. `node --check` on
`hub_api_server.js`, and a page-route sweep (all 200s).

### `/ws` flood investigated against the REAL Hub — found the actual remaining cause, then removed `client-status`/`clientServer_websocket.js` entirely (user-directed, cross-repo)

The mDNS fix above was real but incomplete: the user connected me to the
**actual production Hub** (`ws://ndpi-server.localdomain:3080/ws`, 2 real
adopted devices) rather than a fresh local test instance, correctly
pointing out that a fresh datastore with no adopted devices can't
reproduce this. Captured 30s of real traffic with a raw `ws` client and
found the flood was still very real (~62 `devices-update` in 30s) with a
suspiciously *regular*, near-identically-repeating pattern every ~10s —
not consistent with "2 devices reporting every 5s," which pointed at the
`client-status` message pipeline itself rather than mDNS.

**Root cause, traced to `Client__v3_1_0/index.js`**: `connectToNDPiServer()`
registered a `.on('connected', ...)` listener on the persistent
`/ws/client` connection (`clientServer_websocket.js`) that started a new
5-second `setInterval` (`sendStatusToNDPiServer()`) *every time* that
connection reconnected — and the `ndpi_hub_hostname`/`ndpi_hub_port`
settings-change handlers nearby called `.close()` + `.connect()` on that
same connection directly, re-firing `'connected'` without ever clearing
the *previous* interval first. A genuine, unbounded `setInterval` leak:
every reconnect over a device's uptime added another 5s timer that ran
forever, on top of `clientServer_websocket.js`'s own internal 5s status
interval (started fresh and correctly stopped/restarted on each
reconnect — not itself leaking, just duplicated by the outer one). This
fully explains both the volume and the oddly regular repeating pattern
observed against the real Hub.

**User's decision, given this**: rather than patch the leak, delete
`clientServer_websocket.js` and the whole `client-status`/`/ws/client`
push mechanism outright — reasoning that everything it sent is already
obtainable from the Client's other two sockets (`/ws/system`, `/ws/stats`),
which the Hub already relays independently. Verified this was correct by
reading `clientServer_websocket.js`'s `buildStatusMessage()` field by
field: every single field (`currentSource`, `displayMode`, `streamStatus`,
`ndiInfo.*`, `deviceName`, `ip`, plus `systemStats` — fully redundant with
`/ws/stats`, and the full `settings` array, which literally *is* what
`/ws/system` already sends) is derivable from data the Hub already
receives over its existing outbound relay connections
(`connectDeviceSystemRelay()`/`connectDeviceStatsRelay()`,
`service/hub_api_server.js`). The one non-obvious dependency, found before
it could cause a real outage: `sendCommandToClient()` (the Hub's *only*
way to send commands like set-source/reboot/rename down to a device) also
used `/ws/client` exclusively — confirmed `Client__v3_1_0/service/
client_api_server.js`'s `/ws/system` handler already runs every inbound
message through the exact same `processCommand()` `/ws/client` used, so
commands were rerouted onto the already-open system-relay socket instead,
a drop-in replacement needing no Client-side change.

**Client__v3_1_0 changes** (explicitly authorized by the user):
- Deleted `service/clientServer_websocket.js`.
- `index.js`: removed the `wsConnection_ndpiHub`/`ndpiHubStatusUpdate`
  fields, the `ndpi_hub_hostname`/`ndpi_hub_port` reconnect listeners (the
  actual leak site), `connectToNDPiServer()`, and `sendStatusToNDPiServer()`
  (the duplicate/leaked status sender).
- `service/client_api_server.js`: `/api/v1/adopt`'s doc comment updated —
  the route itself is **unchanged** (still writes `ndpi_hub_hostname`/
  `ndpi_hub_port`), now purely informational bookkeeping since nothing
  reads those settings to open a connection anymore.

**Server__v3_1_0 (this repo) changes**:
- Removed `__ws_Devices()` (the `/ws/client` server-side handler
  entirely), its registration, the `deviceConnections` Map, and the
  `/ws/client` case in the HTTP upgrade router — replaced with nothing
  (falls through to the existing `socket.destroy()` default), so a
  not-yet-updated device still trying to reach `/ws/client` degrades
  gracefully instead of crashing the Hub (`this.ws_serv_devices` would
  otherwise be `undefined`).
- Added two module-level derivation helpers mirroring the deleted file's
  own logic exactly: `deriveStatusFieldsFromSettings(tuples)` (same keys/
  fallbacks as `buildStatusMessage()`, reading from a relayed
  settings-tuple array instead of the Client's direct fileMap access) and
  `deriveSystemStatsFromRaw(raw)` (mirrors `01-scripts/ws-devices.js`'s
  frontend `deriveDeviceStats()` and the deleted file's `getSystemStats()`).
- `connectDeviceSystemRelay()`'s message handler now also derives and
  `upsertClient()`s the summarized status fields on every settings-array
  push (same cadence class as before -- change-driven, not fixed-interval;
  the debounce on `clients-update` already added above absorbs any burst
  before it reaches browsers), and calls `removeDiscoveredClient()` (moved
  here from the deleted `/ws/client` handler).
- `connectDeviceStatsRelay()`'s message handler syncs `systemStats`/
  `status`/`lastSeen` into `this.clients` too, but throttled to once per
  10s per device (`lastStatsSyncAt` Map) -- this channel pushes every ~1s
  while connected, far more often than `devices-update`'s `systemStats`
  copy needs (live per-device stats already come from this same relay
  directly via `/ws/devices/stats`); skips writing `systemStats` entirely
  when derivation fails rather than overwriting a known-good value with
  `null` (upsertClient() is a shallow merge, so omitting a key leaves it
  alone).
- New `isDeviceRelayConnected(deviceId)` (true if either relay socket is
  currently `OPEN`) replaces the old `deviceConnections.has()` check in
  both mDNS handlers. New `markDeviceOfflineIfBothRelaysDown(deviceId)`,
  called from both relay sockets' `close` handlers, gives prompt offline
  detection (only when *both* channels are down, so one reconnecting
  while the other's still open doesn't cause a spurious flip) instead of
  waiting up to a minute for `startDeviceTimeoutMonitor()`'s sweep.
- mDNS's `up` handler now also calls `ensureDeviceRelayConnections()` for
  already-adopted devices (previously only the adopt route and Hub
  startup did) -- since `client-status` no longer bootstraps/refreshes
  relay connections on its own, mDNS is now the mechanism that keeps them
  self-healing if a device's IP changes.
- `sendCommandToClient()` now sends over `deviceSystemSockets.get(deviceId).ws`
  instead of the removed `deviceConnections`.
- Updated several now-stale comments referencing `/ws/client`/
  `clientServer_websocket.js` (`configureDeviceHubConnection()`, the
  adopt route, the design-tokens header) to describe the new reality.
- **`--live-topbar-height`/`--live-bottombar-height` mechanism this
  session already built (see the fixed-position-sidebar entry above) was
  a prerequisite for trusting this refactor's timing** — unrelated code
  path, noted only because both were touched in the same session.
- Followed by three CSS-only sidebar requests in the same pass:
  neutral-gray/less-transparent `--bg-2`/`--bg-3` tuned from
  `rgba(255,255,255,0.05)` to `rgba(100,100,100,0.25)`-class values, an
  opaque-ish `rgba(80,80,80,0.9)` + light backdrop-blur toast background
  (previously inherited the now-translucent `--bg-2` and read as "see
  through"), and `--sidebar-width` changed from a fixed `14.75rem` to a
  `10rem` **floor**: `.sidebar` is now `width: fit-content; min-width:
  var(--sidebar-width)`, sized to its widest child instead of a constant.
  Since `.main`'s `margin-left` and `.topbar`'s `left` can no longer just
  read the static `--sidebar-width`, `syncFixedBarMetrics()`
  (`01-scripts/functions.js`) now also measures `.sidebar.offsetWidth`
  and publishes `--live-sidebar-width` the same way it already did for
  the two bar-height variables; `applySidebarCollapsed()` calls it again
  immediately on toggle so the width offset updates in the same frame
  instead of waiting on ResizeObserver. `#sidebarToggle` moved from
  `.sidebar-footer` to the top of `.sidebar-nav` (above `#navDashboard`)
  on all 11 shell pages via the same mechanical find/replace pattern used
  earlier this session.
- **Verified**: booted the Hub locally (mDNS still discovers the two real
  devices on the network without incident against an empty test
  datastore -- no `upsertClient` side effects triggered, since neither is
  adopted there), confirmed the dead `/ws/client` upgrade path degrades
  via the existing `socket.destroy()` fallback rather than crashing,
  `node --check` on `hub_api_server.js` and `Client__v3_1_0/index.js`,
  confirmed `upsertClient()`'s shallow-merge semantics before relying on
  partial-update calls, a full HTML tag-balance check across every page
  after the mechanical button-move, a full brace-balance check on
  `styles.css`, and a page-route + `/ws` 10s traffic sweep (one
  `devices-update`, no flood). **Not** deployed or tested against the
  real Hub/Client devices — this repo isn't wired to actually push
  changes there, so the real fix still needs a manual deploy (git pull +
  service restart on the Hub and both Client devices) before the
  original real-traffic flood can be directly re-confirmed gone.

**Source-card context menu: Favorite/Unfavorite option, star badge now
favorited-only** (user request: "add 'Favorite'/'Unfavorite' option and
only show the star icon if it is a favorited source"):
- `device/device.html` and `group/group.html`'s `renderSources()`/
  source-card templates: the star badge in each source card now renders
  only when `src.favorite` is true (was previously always visible,
  outline when unfavorited / filled when favorited). Clicking it always
  means "remove from favorites" now, so its `title` is fixed at "Remove
  from favorites" instead of being computed.
- `01-scripts/modal.js`'s `buildContext_Source(event, source)` — the only
  page with a right-click context menu on source cards is `group.html`
  (`device.html` has no `#customMenu-source` div/menu CSS, so it wasn't
  touched here). Changed its second parameter from a bare source-name
  string to the full `{name, url, favorite}` object `group.html`'s
  `contextmenu` listener now passes, and added a second menu item
  (`menuItem_favoriteSource`) alongside the existing "Select: ‹name›" one,
  labeled "Favorite" or "Unfavorite" depending on `source.favorite`. It
  calls a page-level global, `toggleFavoriteSourceFromMenu(name, url)`
  (new, in `group.html`), the same way the existing item already calls
  the page-level `selectSource(name)`.
- `toggleFavoriteSourceFromMenu()` in `group.html` is a sibling of the
  existing `toggleFavoriteSource(btnEl, name, url)` (the star button's own
  handler) rather than a shared refactor of it: the star-button version
  needs a `btnEl` to patch in place, but the context-menu item has no
  button element to reference (there may not even be one in the DOM yet,
  if the source was unfavorited), and the star's own visibility is now
  favorite-state-dependent — so after the POST to
  `/api/favorite-ndi-sources/toggle` succeeds, it just calls the existing
  `renderGroup()` to fully rebuild the source grid, which naturally
  picks up the star showing/hiding and re-wires the context-menu listener
  with the new `favorite` value for next time.
- **Verified**: `node --check` on `modal.js` directly, plus every extracted
  `<script>` block in both `group.html` and `device.html` via a Python
  extraction + `node --check` pass — all clean. `showCustomMenu()`/
  `hideCustomMenu()` in `modal.js` operate on the whole `.context-menu`
  container generically (position + `active` class toggle), not on
  specific child items, so adding a second `.menu-item` needed no changes
  there. Not boot-tested against a real browser/device in this pass.

### `device.html`/`group.html` layout fixes (oversized/clunky, content overflowing the card) + context menu ported to `device.html`

User report: "the styling on the 'device' and 'group' page is looking a
little wonky. everything is huge and kinda clunky. also the main content
overflows the card. I also want to implement the context menu feature on
the device page." Traced to three concrete, verifiable bugs — not a vague
restyle — found by comparing these two pages' markup against every other
page's `.card` usage, which all follow one consistent pattern these two
had silently drifted from:

1. **Dead `!important` was defeating the pages' own narrower width.**
   `.card`'s CSS rule was `max-width: 106.25rem !important;` — but no
   other rule in the stylesheet ever targeted `.card`'s `max-width`, so
   the `!important` had no actual rule to out-rank; its only real effect
   was silently defeating `device.html`/`group.html`'s own inline
   `style="max-width:75rem"` (an inline style can never beat an
   `!important` rule, regardless of specificity), so both pages were
   rendering at the full 106.25rem (≈1700px) on wide screens instead of
   the narrower single-column reading width the markup was actually
   asking for — directly explaining "everything is huge." Fixed by
   dropping the `!important` (nothing else relies on it).
2. **Missing `.card-content` wrapper — the actual overflow bug.** Every
   other page that uses `.card` wraps its real content in a child
   `.card-content` div (`<div class="card"><h2>...</h2><div
   class="card-content">...real content...</div></div>` — confirmed via
   grep across every page). `.card-content` is what supplies the correct
   padding (0.75rem) and the `min-height:fit-content` growth behavior
   that lets `.content`'s own scrolling take over instead of content
   clipping or spilling past the box. `device.html`/`group.html` were the
   only two pages that skipped this wrapper — their real content sat
   directly inside `.card`, which only has `padding:0.25rem`. Against
   `.card`'s `border-radius: 0.875rem`, that padding is too thin to clear
   the rounded corners, so backgrounds/elements near the card's edges
   visually clipped into/past the rounded corner — this is what read as
   "the main content overflows the card." Fixed by wrapping both pages'
   header block + content div in `.card-content`, matching the
   established pattern exactly.
3. **Raw, unstyled `<h3>` section headers.** Every content section
   ("Select NDI Source", "Display Controls", "Device Information", etc.)
   was a bare `<h3 style="margin-bottom:8px;">...</h3>` with no class —
   rendered at the browser's native `<h3>` size/weight (large, bold, no
   letter-spacing), sticking out against the rest of this redesign's
   deliberately tightened type scale (`.card h2` is 0.875rem;
   `.device-section h3` elsewhere in the app is 0.75rem uppercase with
   letter-spacing). Added a new shared `.section-title` class in
   `styles.css` matching that established small-caps look, and applied it
   to every one of these `<h3>` tags in both pages (7 in `device.html`, 3
   in `group.html`) in place of their ad hoc inline `margin-bottom`.

**Context menu ported to `device.html`** (user request — previously only
`group.html` had one, added in the prior session's Favorite/Unfavorite
pass): added the same `<div id="customMenu-source" class="context-menu">`
at body level, and `renderSources()`'s source-card template now sets
`oncontextmenu="buildContext_Source(event, {name:'...', url:'...',
favorite:...})"` inline (matching this file's own existing convention of
inline `onclick="selectSource('...')"` string-templated calls, rather
than `group.html`'s alternate `createElement` + `addEventListener`
approach — no functional difference, just matching whichever idiom was
already established in each specific file). Added
`toggleFavoriteSourceFromMenu(name, url)` to `device.html`, a direct port
of `group.html`'s version from the prior session (POSTs the toggle, calls
`renderSources()` to refresh afterward instead of `renderGroup()`).
`buildContext_Source()` itself (`01-scripts/modal.js`) needed no changes
— it already took the generic `{name, url, favorite}` object shape from
the prior session's `group.html` work.

**Verified**: `node --check` on every extracted `<script>` block in both
files (clean); a Python `html.parser` tag-balance check on both files
(zero mismatches); a brace-balance check on `styles.css` (0); booted the
Hub locally and confirmed `device.html`/`group.html`/`styles.css` all
still serve 200 with the new `card-content`/`section-title`/
`customMenu-source` markup present in the live response body. **Not**
verified visually in an actual browser — the box-model/specificity
reasoning above is confident (verified by reading the actual CSS rules
and their cascade order, not guessed from symptoms alone), but should
still be checked on a real screen before fully trusting the corner-clip
diagnosis specifically, since layout-level visual bugs are the one thing
that can't be exercised outside a real browser in this environment.

### `.topbar` offset changed from `left` to `padding-left`, topbar background matched to sidebar

User report: "for the dynamic topbar, change the dynamic value from
modifying the 'left' property to be padding (plus the already existing
padding). The border is lagging behind during collapse and expansion and
if we change this, the border will essentially always be there just the
padding will change again." Root cause matched the user's own diagnosis
exactly: `.topbar` (`position:fixed; left: var(--live-sidebar-width);
right:0;`) resized its own box — and therefore the horizontal extent of
its `border-bottom` — every time `--live-sidebar-width` changed, while
`.sidebar` (the thing that variable is meant to track) resizes via its
own separate `width`/`min-width` transition on a different element.
Two independently-animated properties on two different elements chasing
the same target is exactly the kind of thing that can visibly desync
mid-transition, which is what read as the border "lagging behind."
Fixed by pinning `.topbar`'s `left: 0` permanently (full viewport width,
same as `.sidebar`'s own full-height column) and moving the dynamic part
onto `padding-left: calc(var(--live-sidebar-width) + 1.5rem)` instead —
`.sidebar` (`z-index:100`, opaque `--bg-0` background) simply renders on
top of the leftmost `--live-sidebar-width` of the now-static topbar, so
`border-bottom` spans the full width unconditionally and never has to
move at all; only the topbar's *content* (title, back button) shifts via
the animated padding, exactly as the user described. Also updated
`transition: left` → `transition: padding-left` on the same rule, and
fixed the one place this could have broken: the `<=53.75rem` mobile
media query, where `.sidebar` becomes a full-width *bottom* bar (so its
measured `offsetWidth` — what `--live-sidebar-width` actually holds —
would be the entire viewport width in that mode) — previously that query
just reset `.topbar`'s `left` back to `0` (now redundant, since the base
rule already does that unconditionally), so it was changed to instead
reset `padding-left` back to the flat `1.5rem` the right side already
uses, preventing the desktop calc() from pushing all of the mobile
topbar's content off-screen. Also applied the user's other request from
the same message thread: `.topbar`'s `background` changed from
`var(--bg-1)` (page-content background) to `var(--bg-0)` (the same token
`.sidebar` uses), so the two fixed bars read as one continuous surface.
**Verified**: brace-balance check on `styles.css` (0), booted the Hub
locally and confirmed `styles.css` serves the new rule live. Not checked
visually in a real browser — same standing caveat as the rest of this
session's CSS-only changes.

### Reboot/shutdown device commands only killed the Node service, never actually rebooted the hardware

User report: "I don't think the device reboot command is working properly."
Confirmed via the user's own live testing: pressing the Hub's Reboot
button on `device.html` caused the device's relay connection to drop and
reconnect with new reported child-process PIDs (`pid_chromium`,
`pid_ndi_player`, etc.) within only a few seconds — far too fast for an
actual Raspberry Pi boot cycle (kernel + systemd + X11/kiosk autostart
normally takes 15-60+ seconds) — meaning only the Node service (and the
child processes it spawns on startup) was being killed and relaunched;
`sudo reboot` itself was never actually taking effect. Pressing the same
logical command from the Client's own local UI (`system.html`, on the
device itself) does work correctly.

**Root cause, per the user's own key observation**: `Client__v3_1_0/
public/system.js`'s reboot/shutdown button handlers already call their
own `sendCommand({type:'reboot-device'}, /* viaWebSocket */ false)` —
explicitly opting OUT of that page's own WebSocket transport for these
two commands specifically (every other command on that page defaults to
`viaWebSocket: true`). That's direct evidence, in the Client's own
existing code, that whoever wrote it already knew/found that triggering
`reboot-device`/`shutdown-device` over a WS message doesn't reliably
work — yet the Hub's `sendCommandToClient()` (used for every device
command, including these two) always sends over the persistent
`/ws/system` relay socket, ignoring that precedent entirely.

Read all the way through to confirm *why* the Client's own author needed
that workaround: `client_api_server.js`'s `__ws_System()` message handler
calls `func.processCommand(JSON.parse(event.data))` without ever
`await`-ing it or attaching `.catch()`. `processCommand()`'s
`'reboot-device'` case does an internal self-fetch to
`http://localhost:3080/api/v1/__internal/reboot`, which — on success —
`emit`s `'reboot-command'`, which `index.js` picks up 1s later to run the
real `quitNDPi()` → `exec('sudo reboot')` sequence. If anything in that
async chain throws outside its own inner try/catch, it becomes an
unhandled promise rejection (since nothing is awaiting the outer call),
and `index.js`'s global `process.on('unhandledRejection', ...)` handler
calls `exit(1)` immediately — no graceful shutdown, no `exec('sudo
reboot')` ever reached, just an instant crash-and-respawn under whatever
process supervisor restarts the service. That matches the observed
symptom exactly (near-instant restart, new child PIDs). The REST route
(`/api/v1/rpc`), by contrast, properly `await`s `processCommand()` and
reports a real success/failure — which is presumably why the Client's own
author routed these two specific commands through it instead.

**Fix, entirely on the Hub side** (no `Client__v3_1_0` changes needed —
matching its own already-working code path instead of touching it): added
`sendRestCommandToClient(deviceId, command)` to `hub_api_server.js` —
POSTs directly to the device's own `http://<ip>:<apiPort>/api/v1/rpc`
(the device's `ip`/`apiPort` are already tracked per-client for the relay
connections), bypassing the WS relay entirely, using the same raw `http`
module + timeout/error-handling pattern `configureDeviceHubConnection()`
already established. `deviceCommandRoute()`/`groupCommandRoute()` (the
helpers backing every `/api/device/:id/*` and `/api/group/:id/*` command
route) gained a `viaWebSocket` parameter (default `true`, matching every
other command's existing behavior) — named to directly mirror
`system.js`'s own `sendCommand(command, viaWebSocket)` flag. Only the
`reboot`/`shutdown` routes (both the per-device and per-group versions)
now pass `false`; every other command (`set-source`, `set-setting`,
`send-cec`, overlay, rename, etc.) is untouched and still fire-and-forget
over the WS relay as before.

**Verified**: `node --check` on `hub_api_server.js`; booted the Hub
locally, confirmed real mDNS discovery of the user's actual network
devices still works, and confirmed the reboot route still correctly 404s
for an unknown device id. **Not** tested against a real device's actual
reboot behavior — deliberately not exercised live, since that's
disruptive to whatever the device is currently displaying and wasn't
explicitly authorized for this specific destructive action; the user
should confirm on their next real reboot attempt that it now takes the
normal full boot-cycle duration instead of a few seconds.

### Sync status as an icon instead of text, settings nav icon changed to a cog wheel

Two small user-requested UI tweaks:
1. **`device.html`'s "Sync" stat pill** (next to Uptime in the stats
   header) previously showed a text label ("In Sync" / "Xs Ahead/Behind" /
   "—"), color-coded. Replaced with one of four small SVG icons instead —
   shape carries the meaning, not just color, so it stays legible without
   depending on colorblind-unsafe green/yellow/red alone: a dash-in-circle
   for "unknown" (no `/ws/stats` data yet), a check-in-circle for in-sync,
   a clock face for a mild (≤10s) drift, and an alert triangle for a
   severe (>10s) drift — still colored the same green/yellow/red/gray as
   before, and the exact numeric diff moved into the `title` tooltip
   instead of being the visible label.
2. **The Settings sidebar nav icon** (`#navSettings`, identical markup
   duplicated across all 11 shell pages) was previously a 3-row slider
   icon — changed to a standard cog/gear icon (the well-known Feather
   Icons "settings" glyph) on all 11 pages via a mechanical exact-string
   find/replace, matching this app's existing convention of stroke-based
   nav icons (`.nav-btn-icon svg` supplies `fill:none; stroke:currentColor`
   globally, so the new `<path>`/`<circle>` needed no per-icon style
   attributes, same as every other nav icon).

**Verified**: `node --check` on `device.html`'s extracted scripts; a
Python `html.parser` tag-balance check across all 11 edited pages (zero
mismatches); confirmed via grep that all 11 pages picked up the new cog
markup; booted the Hub locally and confirmed `device.html`/
`settings.html`/`devices.html` all still serve 200, with the new
`SYNC_ICON_*` constants present in `device.html`'s live response body.
Not checked visually in a real browser.

### Global fix for "stuck" hover state after a click

User report: clicking a button and leaving the cursor sitting over it
afterward leaves the button looking stuck in its bright hover-highlighted
look. Root cause is a genuine CSS limitation, not a bug in any specific
button: `:hover` only ever reflects the cursor's literal position, so
when a click changes an element in place (a button's label swapping to
"REBOOTING...", a star toggling favorited, a card gaining `.selected`)
and the cursor doesn't move afterward, nothing ever tells the browser to
re-evaluate hover — there's no way to "time it out" with CSS alone.

**Fix, v1**: added `initHoverReset()` to `01-scripts/functions.js` — one
delegated `click` listener on `document` that toggled `pointer-events:
none` on the clicked element for one frame. That removes it from
hit-testing, which immediately clears `:hover` on it (the browser hands
hover to whatever's underneath); restoring `pointer-events` right after
does **not** bring `:hover` back on its own, since browsers only ever
recompute hover targets on an actual pointer-move event.

**Fix, v2** (user follow-up: "can we just have a hover timeout? like
'onmouseover'... reset for 'mousemove'"): click alone only resolves the
stuck look *after a click* — it did nothing for a cursor just resting on
an unclicked element. Generalized into a real idle timeout, keeping the
same underlying `pointer-events` trick (still the only reliable
cross-browser way to force `:hover` to clear from JS) but driving it from
a timer instead of only a click: `mouseover` starts a `HOVER_TIMEOUT_MS`
(1500ms) timer on whichever element the cursor is newly over,
`mousemove` resets that timer on every real movement while still over
the same element (so genuine movement/jitter keeps the hover alive
indefinitely), and `mouseout` cancels it once the cursor actually leaves.
If the timeout fires, `clearHoverVisual()` (the shared helper both
triggers now call) clears the look exactly as before; moving the mouse
again afterward brings the hover back with no extra code needed, since
restoring `pointer-events` lets the browser's own native hover recompute
handle that on the next real `mousemove`. The click-based trigger was
kept alongside the timeout (not replaced) since a click that swaps a
button's own label/disabled state should clear instantly, not wait out
the full 1500ms idle timer. All of this stays inside one delegated set of
listeners on `document` via a shared `HOVER_RESET_SELECTOR`
(`button, a, select, .nav-btn, [class*="card"], [class*="tile"],
[onclick]`) — deliberately a wide net matching this app's own convention
of wiring most custom clickable elements via inline `onclick="..."`
attributes, rather than hand-listing every specific class, so new
buttons/cards get this for free with no per-page wiring or opt-in.
Doesn't conflict with genuinely `:disabled` buttons (`button:disabled`'s
existing `pointer-events: none !important` still wins regardless of the
inline style being toggled back to `''`).

**Verified**: `node --check` on `functions.js`; booted the Hub locally
and confirmed `01-scripts/functions.js` serves the new function. Not
checked visually in a real browser — this is exactly the kind of
interaction-timing behavior that's hardest to verify without one, so
worth a quick real click-and-hold check before fully trusting it.

### Screen Saver settings merged into the User Preferences card

User request: "Add Screen Saver settings to the User Preferences section
on the settings page. they do not need to be separate since they are
local to the specific users browser." Confirmed the reasoning against the
actual persistence mechanism before merging: `getScreenSaverSettings()`/
`saveScreenSaverSettings()` (`settings/settings.html`) already store
`ndpi_screensaver_settings` in `localStorage`, not on the Hub — the exact
same browser-local nature as "Scaling" (`setScale()`, also localStorage),
which already lives in the "User Preferences" card. Only "Appearance"
(theme color, logo) and every admin-only card are genuinely Hub-wide,
server-persisted settings, so Screen Saver was the odd one out with its
own standalone card.

Moved the Screen Saver card's entire content (the inactivity-duration
input, the "won't activate during these times" schedule list, and the
"Add Block Period" button — `getScreenSaverSettings()`/
`saveScreenSaverSettings()`/`initializeScreenSaverSettings()`/
`renderSchedules()`/`addSchedule()` etc. all untouched, purely a markup
move) into `section_UserPreferences` as a second `.settings-row`
following "Scaling," with its own `.settings-label` "Screen Saver" header
matching the same per-row label pattern the "Appearance" card already
uses for "Theme Color"/"Logo". Removed the standalone `section_ScreenSaver`
card variable and its own `<h2>Screen Saver</h2>` + `mainContainer.
appendChild(section_ScreenSaver)` call entirely — one fewer card in the
grid, nothing lost. `.settings-row`'s existing `border-bottom` (auto-
removed on `:last-child` via the stylesheet's own pseudo-class rule, not
the cosmetic-only `.last-child` class name copied from this file's
existing convention elsewhere) gives the merged row its own visual
separator from "Scaling" above it for free, with no new CSS needed.

**Verified**: `node --check` on all three extracted `<script>` blocks; a
Python `html.parser` tag-balance check (zero mismatches); grepped the
live-served page and confirmed `section_ScreenSaver` no longer appears
anywhere, `screenSaverWait` still appears (its 3 real references — the
input id and its two JS call sites — untouched by the move), "User
Preferences" still renders once, and the standalone `<h2>Screen
Saver</h2>` is gone; booted the Hub locally and confirmed `settings.html`
still serves 200. Not checked visually in a real browser.

### Every endpoint added this engagement moved under `/api/v2/`

User feedback: routes added across this engagement were written as bare
`/api/{name}` instead of a versioned path, inconsistent with this
codebase's own existing `/api/v1/...` routes (the NDI-stream MJPEG-proxy
set, and `Client__v3_1_0`'s entire API) — "reckless," since nothing about
an unversioned path signals whether it's safe to change without manually
checking every caller. Asked to (1) identify every endpoint added since
this engagement started (~1 week), (2) move them to `/api/v2/...`, (3)
verify every caller (frontend and cross-repo) is updated to match, and
(4) check `Client__v3_1_0` too.

**Identifying "added this engagement" was done from git history, not
memory** — `service/hub_api_server.js`'s entire commit history in this
repo spans exactly 3 days (`git log --reverse`: first commit `33f45e6`,
"[3.1.58]", 2026-08-11; most recent "[3.1.155]", 2026-08-14), and that
first commit is the exact point this file was renamed from
`service/client_api_server.js` (929 lines removed) into
`service/hub_api_server.js` (2047 lines added) — i.e. the literal
Client→Hub clone-and-adapt commit a prior session did before this
engagement's own work began. That commit's route table is therefore the
true "pre-existing" baseline. Diffed `git show 33f45e6:service/
hub_api_server.js`'s route list against the current file's (including the
routes built dynamically inside `deviceCommandRoute()`/
`groupCommandRoute()`, which a plain text diff of literal `.route(...)`
calls would miss) to get a defendable, non-memory-dependent list of
exactly which endpoints didn't exist at that baseline:
- `POST /api/device/:deviceId/setting`
- `POST /api/device/:deviceId/overlay-image`
- `POST /api/device/:deviceId/check-for-update`
- `POST /api/device/:deviceId/install-update`
- `POST /api/favorite-ndi-sources/toggle`
- `GET/POST/DELETE /api/logo`
- `GET /api/ping`
- `POST /api/setting` (this one **replaced** an old `/api/resolution`
  GET/POST pair that did a raw `xrandr` call directly — not a rename of
  that route, a genuine redesign into a generic settings-write mechanism;
  confirmed via `git log -S"'/api/resolution'"`)
- `GET /api/setting/:name`
- `POST /api/system/check-for-update`
- `POST /api/system/install-update`

Also confirmed via the same diff which endpoints were removed outright
during this engagement (already covered in earlier entries above, listed
here only because the same audit surfaced them again as a cross-check):
`/api/active-viewers`, the old `/api/ndi-sources`, `/api/v1/rpc`,
`/api/v1/__internal/:path`, and the WS paths `/ws/client`/`/ws/display`
(plus `/ws/system`/`/ws/stats`/`/ws/sources` each being removed-then-
reinstated under the same name but a different, Hub-specific
implementation — not the same code, just coincidentally the same path).

**Scope decision**: only REST (`/api/...`) endpoints were versioned, not
the WebSocket paths (`/ws/...`) — the user's complaint was specifically
about the `/api/{name}` pattern, and `/ws/system`/`/ws/stats`/
`/ws/sources` on the Hub deliberately mirror Client__v3_1_0's own
identically-named (and equally unversioned) WS endpoints for protocol
symmetry; versioning only the Hub's side of that pair would break the
parity without a matching precedent anywhere in either codebase to be
consistent with. Not raised as a question — stated here as the reasoning
in case the user wants WS endpoints included in a future pass too.

**Client__v3_1_0 checked, no changes needed**: `client_api_server.js`'s
entire route table (`/`, `/display/idle`, `/api/v1/rpc`, `/api/v1/adopt`
— the one endpoint this engagement added there — `/api/v1/__internal/
:path`) is already consistently versioned `/api/v1/...` end to end, with
zero unversioned `/api/...` routes to be inconsistent with. `/api/v1/
adopt` already fits that existing convention correctly and was left as
version 1 rather than bumped to v2 on its own, which would have made it
the only mismatched route in an otherwise fully-consistent file.

**Execution**: `deviceCommandRoute()` (backs every `/api/device/:deviceId/
*` command route) gained a `basePath` parameter (default
`/api/device/:deviceId`, unchanged for the six routes that already
shipped under it — shutdown/reboot/overlay/blank/rename/cec, all
pre-existing paths this pass never touches to avoid a needless breaking
rename) — the four new ones now pass `/api/v2/device/:deviceId`
explicitly. `groupCommandRoute()` was left alone entirely (all four of
its routes — shutdown/reboot/overlay/blank — are pre-existing baseline
paths). The other seven new endpoints were renamed as direct literal
`.route()` string edits. Every caller was found by grepping the literal
old path string across the whole repo (`public/**/*.html`,
`public/01-scripts/*.js`, `styles.css`) rather than assuming the earlier
per-feature grep sweeps already had full coverage — this caught three
references a scoped search missed the first pass: `screen-saver.js`'s
bouncing-logo image path, and the `<link rel="icon">` favicon tag on
several pages that (inconsistently with the rest of the app, which uses
`/media/favicon.svg`) points at `/api/logo` directly. All fixed to
`/api/v2/logo` for consistency with everything else, without otherwise
touching that pre-existing favicon-source inconsistency itself.

**Verified**: `node --check` on every modified `.js` file and every
extracted `<script>` block across every modified `.html` file; a
repo-wide grep confirming zero remaining references to any of the 11 old
paths anywhere (`public/`, `service/`, `server.js`) outside of the
`/api/v2/` renames themselves; booted the Hub locally and round-tripped
every one of the 11 new `/api/v2/...` endpoints (all responded correctly
— `/api/v2/logo` 302s to the default SVG exactly as `/api/logo` used to),
confirmed all 11 old paths now cleanly 404 instead of silently still
working, confirmed the four new `/api/v2/device/:deviceId/*` routes and
the six pre-existing `/api/device/:deviceId/*` routes both correctly
reach their handler (404 "Device not found" for a fake id, not a
route-not-matched 404) for an unknown device, and confirmed untouched
routes (`/api/devices`, `/api/groups`, page routes) still serve normally.

### `settings.html` converted from JS-built markup to static HTML + CSS classes (user request)

`settings.html` was the one page left rendering its entire card skeleton
(all 8 cards -- User Preferences, Appearance, Server Management, Display
Resolution, and the 4 admin-only ones) via a `renderSections()` function
that built every card as an `innerHTML` template string and
`appendChild()`'d it into an empty `<section id="main-section">`. User
asked for the skeleton to be static HTML instead, with JavaScript only
adding event listeners and populating dynamic fields after
`DOMContentLoaded` -- plus consolidating the page's many inline `style="..."`
attributes into CSS classes.

- All 8 cards are now real markup in the `<body>`. The 4 admin-only cards
  (`section-SystemControls`, `section-ClientDeviceManagement`,
  `section-AdminControls`, `section-RokuTvs`) carry a `hidden` attribute
  by default; `revealAdminSections()` (called from `initPage()`, same
  `account`-must-be-loaded-first hook every other page on this app already
  uses) clears it when `account.isAdmin` -- replacing the old
  conditional-`appendChild` gate. Genuinely data-driven content (schedule
  list, Roku TV list, theme swatches, display-resolution info) is still
  rendered by its own function, since that content can't be known
  statically -- only the page's fixed skeleton moved.
- Every top-level button that used to carry an inline `onclick="..."`
  (Reset scale, Add Block Period, Restart/Check-for-update/Install-update,
  Reboot/Shutdown, Forget All Devices, User Accounts, Favorite NDI
  Sources, Add Roku TV, the resolution `<select>`'s `onchange`) is now
  wired in one place, `wireStaticButtons()`, via `addEventListener`.
  Buttons inside dynamically-rendered list rows (a single schedule's
  Remove button, a single Roku TV's Remove button) still use inline
  `onclick` in their template strings -- consistent with how every other
  per-item tile in this app (device tiles, group tiles, source cards)
  already wires its own per-item actions, and not something a
  page-load-time listener could reach anyway since those rows don't exist
  yet at that point.
- New shared CSS classes added to `styles.css` (a `SETTINGS PAGE` section)
  replacing this page's repeated inline styles: `.button-row`,
  `.settings-inline-row`, `.scale-slider`, `.screensaver-wait`/
  `-wait-row`, `.settings-hint`, `.settings-list`/`-wrap`/`-item`/
  `-item-title`/`-item-meta`/`-empty` (the schedule-row and Roku-row list
  items were two independent copies of the same hand-written inline style
  block -- now one shared class pair), `.info-grid-message`,
  `.logo-upload-row`/`.logo-preview-item`/`.logo-actions`,
  `.resolution-controls`, and `.modal-form`/`-label`/`-days`/`-day` (used
  by the "Add Block Period" modal's form, whose time inputs also lost
  their hardcoded `#1a1a1a`/`#444`/`#eee` colors in favor of this
  stylesheet's normal themed `input`/`select` rules -- an actual
  correctness fix, not just cleanup, since those hardcoded values ignored
  the selectable accent-color/theme system every other input in the app
  already follows). Also added a general-purpose `.card-content.flush`
  modifier (`padding: 0`) to the existing `CARD` section for cards like
  these whose first child is an `<h2>` that already supplies its own
  padding/border via `.card h2` -- stacking the default 0.75rem
  `.card-content` padding on top of that would have doubled the gap.
- One id had to be kept in sync by hand: the static "Install Update"
  button was written as `installHubUpdateBtn` (not `installUpdateBtn`) to
  match the pre-existing `connectHubSystemSocket()` handler elsewhere in
  the script, which looks that id up by `getElementById` every time a
  `/ws/system` message reports `ndpi_version_update_available` -- a
  mismatch here would have silently left that button permanently hidden.

**Verified**: `node --check` on the extracted `<script>` block; a Python
`html.parser` tag-balance check on the full file (zero mismatches); a
brace-balance check on `styles.css`; booted the Hub locally and confirmed
`settings.html` serves 200 with all 8 cards (including the 4
`hidden`-by-default admin ones) present in the raw response body, every
button id present exactly once; round-tripped `POST
/api/account/local-signin` (confirms `account.isAdmin` gating has real
data to key off) and `GET /api/v2/setting/ui_theme_color`; confirmed a
full page-route sweep across every other page still 200s (nothing else
was touched). **Not** verified visually in an actual browser -- the
DOM-structure and event-wiring reasoning above is sound by inspection,
but the on-page interactions (scale slider, schedule/Roku add-remove,
logo upload preview) are worth a real click-through before fully
trusting this refactor.

### `/ws/console` (remote shell terminal on `console.html`) ported from `server copy.js` (user request)

`console.html` + `01-scripts/ws-console.js` were already fully built to
open `ws://<host>/ws/console` and speak a specific protocol (`connected`/
`response` messages in, `command`/`command-kill` messages out), but
`hub_api_server.js` never had a handler for that path -- there was no
`/ws/console` case in the upgrade router at all, so every connection
attempt fell through to the default `socket.destroy()`. The actual
server-side logic already existed, working, in the deprecated
pre-refactor `server copy.js`'s `wsConsole` -- a raw shell session (exec a
command, stream stdout/stderr back line-by-line with color/weight hints,
track `cd` to keep a per-session working directory, support a kill
command for a running child process). Ported that logic into a new
`__ws_Console()` method matching this file's existing WS-handler
conventions (own `ws_serv_console`/`consoleSessions` fields, registered in
`start()`, its own branch in the `Server.on('upgrade', ...)` router,
cleaned up in `close()`) -- the message shapes were kept byte-for-byte
identical to the original so the existing frontend needed zero changes.
One pre-existing no-op bug in the original was carried over unchanged on
purpose (scope was "port the logic," not "fix it"): the `cd` handler's
double-slash cleanup computes `` `${workingDir}`.replaceAll('//', '/')
`` but never assigns the result back to `workingDir`, so it's actually a
no-op -- harmless (cosmetic only, doesn't affect which directory commands
actually run in), just worth knowing if it's ever revisited.

**Verified live**: booted the Hub locally and drove `/ws/console` with a
raw `ws` client end-to-end -- confirmed the `connected` message on open,
`echo` round-tripping through `response`, `cd /tmp && pwd` correctly
updating the session's tracked `pwd` (`/tmp` on the next response) and
persisting for subsequent commands, and `command-kill` against a running
`sleep` producing a real terminated response. `node --check` on
`hub_api_server.js`.

## Confirmed bugs (verified by source + live repro — fixed)

1. **CRITICAL — all internal navigation is broken.** Every page links via
   `window.location.href='/devices.html'` / `<a href="/account-settings.html">`
   etc. (single path segment + `.html`). The only generic page route is
   `.route('/:page/:ext/')` (two segments, e.g. `/devices/html`), and there's
   no flat `public/devices.html` for `express.static` to serve either. Live
   repro: `GET /devices.html` → `404`; `GET /devices/html` → `200`. This
   means essentially every button/link in the app 404s today. **Fix in
   `hub_api_server.js`**: add a route that maps `/:page.html` (and ideally
   `/:page` with no extension) to `public/<page>/<page>.html`, in addition to
   (or instead of) the slash-style route. Cheapest, lowest-risk fix — don't
   rewrite every HTML file's links instead.
2. **Shutdown crash.** `hub_api_server.js` `_tryCloseDiscovery()` does
   `if (!this.discoveryExec.killed)` without checking `this.discoveryExec`
   for `null` first. If no browser ever opened `/ws/sources` (so
   `startDiscovery()` never ran), `this.discoveryExec` is `null` and this
   throws inside a Promise executor → unhandled rejection → `process.exit(1)`
   on every graceful `SIGTERM`/`SIGINT`. Reproduced live.
3. **`show-overlay`/`show-blank` device commands blank the NDI source** — see
   protocol note above. `deviceCommandRoute('overlay', ...)` and
   `('blank', ...)` in `hub_api_server.js` need to send `set-setting` /
   `ndpi_status_no_source_display_mode` instead.
4. **Port mismatch**: `config/kiosk.service` and `complete-deploy-server.sh`
   hardcode `http://localhost:3000/`, but the server's real default port is
   `3080` (`local_port_number_api` / `PORT_API` default). Pick one
   canonical default (recommend `3080`, matching the actual app default and
   Client's convention) and fix the deploy/kiosk files to match.
5. Cosmetic leftovers from being cloned off the Client repo: `config/openbox/autostart` header comment says "NDPi Monitor - CLIENT".

## Frontend audit findings (not yet fixed)

Per-page JS files (`public/*/*.js`) are almost all **empty placeholders** —
real logic lives in inline `<script>` blocks in the paired `.html` file
instead (only `account-settings.js` is actually used). This is consistent,
not accidental, so don't "fix" it by moving code out into the empty `.js`
files unless asked — just be aware when searching for a page's logic to look
in the `.html`, not the `.js`.

Confirmed gaps, roughly by impact:

- `public/0app.js` and `public/01-scripts/set-page.js` are dead code, loaded
  by no page (legacy Socket.IO prototype / duplicate bootstrap). Safe to
  delete once confirmed unused, or leave alone — not currently doing harm.
- `01-scripts/functions.js`'s bootstrap IIFE calls `initPage(account)`
  unconditionally, but `initPage` is only defined on `console.html`. Every
  other page throws a `ReferenceError` in that IIFE on load (console-only
  noise today — the rest of each page's own inline script still runs
  independently — but worth a real fix, e.g. guard with
  `if (typeof initPage === 'function')`).
- `public/groups/groups.html` loads `/functions.js` (404 — no such file)
  instead of `/scripts/functions.js`. Breaks nav-bar wiring on that page
  specifically.
- "Active viewers" UI is half-removed: transport (`ws-client.js`,
  `active-viewers` messages) and per-page handler assignment all still
  exist, but the actual DOM-rendering function is commented out /
  guarded-false on every page. Either finish it or strip the dead wiring.
- `public/users/users.html`: grant/revoke-admin action is fully broken
  (`toggleAdminPrivileges` commented out, `currentUser` never populated so
  the button never even renders).
- Orphaned-but-complete functions never wired to a button:
  `device.html`'s `showNetworkSettings()` and `cecInactiveSource()`,
  `settings.html`'s `showServerNetworkSettings()`.
- `settings.html` defines `addRokuTv()` twice (once via
  `01-scripts/rokuControl.js`, once inline) — the inline one silently wins.
- `01-scripts/ws-client.js`'s `sendViewerLeave()` reads a bare `account`
  global instead of `localStorage` like `sendViewerJoin()` does — works only
  by accidental collision with `auth.js`'s module-scope `account`.
- Dead `showOfflineOverlay()`/`hideOfflineOverlay()` duplicates (referencing
  nonexistent DOM) on `devices.html`, `groups.html`, `users.html` — the real
  ones live inside `ws-client.js` itself.
- ~~`set-pin.html`'s live PIN-match validation listeners were stubbed out~~
  — fixed, see "Fixed 4 more bugs from real usage" above.

Pages that are otherwise complete/working end-to-end (module the routing bug
above, which affects all of them equally): `account-settings`,
`advanced-account-settings`, `create-account`, `set-pin`, `sign-in`,
`devices`, `groups`, `group`, `device`, `device-discovery`, `settings`,
`console`, `not-found`.

### AirPlay-to-NDI bridge (`ndi_receiver_v3__NDI6/uxplay_ndi_sender.cpp`) — fixed

Separate, self-contained feature: uxplay runs an AirPlay receiver on the
Hub; the goal is to re-broadcast whatever gets AirPlay-mirrored to it as a
discoverable NDI source. This existed in the repo already but had never
worked. Root cause: it encoded the capture to H.264 and handed the
compressed bytes to `NDIlib_send_send_video_v2` with `FourCC` cast to
`NDI_LIB_FOURCC('H','2','6','4')` — that value does not exist in
`NDIlib_FourCC_video_type_e` (confirmed by reading
`include/Processing.NDI.structs.h`; the enum only lists uncompressed pixel
formats, since NDI does its own compression internally). Every frame it
ever sent was structurally invalid — this could never have worked
regardless of bitrate/FPS tuning, on any hardware.

Rebuilt as **4 independent, independently-restarting systemd services**
instead of one process that forks/monitors `uxplay` and hunts for its X11
window via `xdotool`: `uxplay-xvfb` (a virtual `:1` display, deliberately
separate from the Hub's real kiosk display on `:0` — this Hub runs its own
kiosk chromium dashboard full-screen there per `config/kiosk.service`, so
uxplay can't share it), `uxplay-audio-setup` (oneshot, creates+defaults a
PulseAudio/PipeWire-pulse null-sink so uxplay's audio output is
capturable), `uxplay-airplay` (uxplay itself, `-fs` fullscreen on `:1`),
and `uxplay-ndi-sender` (the rewritten bridge). Capturing the *whole*
virtual display instead of hunting for uxplay's specific window removed
the need for `xdotool`/pipeline-teardown-and-rebuild entirely — the bridge
now just always captures `:1` (black when nothing's mirroring) and
restarts independently of uxplay's own lifecycle.

`uxplay_ndi_sender.cpp` now sends raw UYVY video (real, documented NDI
FourCC) instead of H.264, plus NDI audio — added per explicit user request,
not present in v1 at all. NDI's audio API only accepts planar float32
(`FLTP` is the only member of `NDIlib_FourCC_audio_type_e`, confirmed from
the same header), so the GStreamer audio branch requests
`format=F32LE,layout=non-interleaved` specifically to match, with
`channel_stride_in_bytes` computed as one channel's sample count — an easy
place to silently get wrong (interleaved vs. planar) that would have
produced the same class of "looks like it's sending something, receiver
can't make sense of it" failure as the original FourCC bug. Also added: a
GStreamer bus watchdog thread (the original had no bus error handling at
all, so a pipeline ERROR/EOS would go unnoticed and the process would just
sit there sending nothing) that exits the process on pipeline failure and
lets systemd's `Restart=on-failure` recover it; a video-only fallback if
the audio branch fails to parse/start (broken Pulse setup shouldn't take
down video monitoring); and a startup retry loop (Xvfb is a separate
service and may not be up yet on a cold boot race). Confirmed
`send_send_video_v2`/`send_send_audio_v3` (the non-`_async` variants) are
synchronous per the SDK header's own doc comment on the async variant, so
freeing frame memory immediately after the send call — which both this
file and the untouched sibling `window_to_ndi.cpp` already did — is
correct, not a bug.

Fixed a real shutdown race introduced while adding the bus watchdog: the
watchdog thread blocks indefinitely inside `gst_bus_timed_pop_filtered` on
the pipeline's bus; naively tearing down (unreffing) that bus/pipeline from
the main thread while the watchdog might still be parked in that call would
race. Fixed with a `gst_bus_set_flushing(bus, TRUE)` call (unblocks the
pop, returning NULL) followed by joining the watchdog thread, and only
*then* tearing down the pipeline — done in that order in `main()`.

**Not tested against real hardware** — no `uxplay`/GStreamer/NDI toolchain
on this macOS dev machine (consistent with every other ARM64-only piece of
this repo). Verified instead by: reading the actual NDI SDK headers in
this repo to confirm every FourCC/struct-field usage against their real
definitions (not assumed from memory), brace/paren balance check on the
`.cpp`, `bash -n` on both shell scripts, and a structural read-through of
all 4 systemd unit files (backslash line-continuation on
`uxplay-ndi-sender.service`'s multi-line `ExecStart=` is valid systemd
syntax, not a typo). The exact `uxplay` CLI flags in
`uxplay-airplay.service` (`-fs -vs ximagesink -as autoaudiosink -nc`) are
noted in that file as needing verification against `uxplay -h` on the
actual installed version, since flags have changed across uxplay releases
and this couldn't be checked locally. The systemd units also hardcode
`User=ndpi-server` and UID `1000` (for `XDG_RUNTIME_DIR`) — both flagged in
`BUILD_AND_SETUP.md` as needing to match the real deploy account before
installing.

**Follow-up fix, found during real deployment**: the 4 systemd unit files
above hardcoded the repo checkout path as `/home/ndpi-server/NDPi_Monitor__v3/Server__v3_1_0`
— guessed from this repo's own directory name, without checking how it's
actually deployed. Reading `git-hub-deploy-server` (the real deploy script)
showed the actual clone target is `~/ndpi` (`REMOTE_DIR_PGM="${REMOTE_DIR_HOME}/ndpi"`,
populated via `git clone` into `REMOTE_DIR_TMP` then `rsync`'d into
`REMOTE_DIR_PGM`) — so every `WorkingDirectory=`/`ExecStart=`/`Documentation=`
path in the 4 unit files, plus both docs, was wrong and would have made
`systemctl start` fail with a path-not-found even after a successful
`install-service`. Fixed by replacing every occurrence with `/home/ndpi-server/ndpi`.
**Lesson: when a repo has its own deploy tooling, read it before writing
paths into anything meant to run on the deployed device — don't infer the
deploy layout from the local dev checkout's directory name.**

**Also wired into `git-hub-deploy-server` itself** (user request — "the
point of the deploy script is so I don't need to remember to do all these
steps"): new `install_uxplay_ndi_bridge()` step, called from
`deploy_install()` right after `create_gui_service_file`, plus a standalone
`--install-uxplay-ndi` flag for re-running just this step on an
already-deployed device. It SSHes in and runs `uxplay-ndi.sh build` then
`install-service` then `start` directly — deliberately *not*
reimplementing that logic as a second copy in the deploy script (the
existing `create_node_service_file`/`create_gui_service_file` do generate
unit files inline via heredoc, but those need a script-level variable
(`PORT_API`) interpolated; the uxplay/NDI units don't, so reusing the
already-reviewed static files + script avoids two sources of truth for the
same content). The one genuinely device-specific value, the UID baked into
`uxplay-audio-setup.service`'s `XDG_RUNTIME_DIR`, is patched automatically
via a remote `id -u` + `sed`, so the manual "check `id -u`, hand-edit the
file" step from earlier in this session is no longer needed for a device
deployed this way. Matches `config_eeprom`'s existing non-fatal-on-failure
pattern (this is an optional add-on feature; a broken build shouldn't
block the rest of the deploy). Also added the 3 new apt packages
(`xvfb`, `gstreamer1.0-pulseaudio`, `pulseaudio-utils`) to
`update_install_system_dependencies()`'s existing install list.
**Not tested against a real device** — same standing limitation as the
rest of this feature; verified with `bash -n` only.

**Follow-up: locked NDI library loading to the bundled copy only** (user
request — worried the deploy script's `/opt/NDI SDK for Linux` variables
implied a dependency on a system-wide NDI install). `loadLibrary()`
previously tried a relative path (`lib/<arch>/libndi.so.6`, correct only
because `WorkingDirectory=` happens to be set right in the systemd unit),
then `/opt/NDI SDK for Linux/...` (a path `git-hub-deploy-server` never
actually populates — its `download_ndi_sdk` step is commented out and
never called), then generic `/usr/local/lib`/`/usr/lib`/bare `libndi.so.6`.
Rewrote it to resolve strictly relative to the running executable's own
path (via `readlink("/proc/self/exe", ...)`, correct regardless of
whatever the working directory happens to be) and removed every other
fallback entirely — if the bundled file for the running architecture isn't
there, it now fails immediately and names the exact path(s) it expected,
instead of silently trying to load a possibly-different NDI SDK version
from somewhere else on the system. `window_to_ndi.cpp` and
`ndi_receiver_v4.cpp` (pre-existing, unmodified this session) still use
their own older loading patterns — left as-is since they weren't part of
what was asked to be fixed here.

**Follow-up: global `.env` file for every Hub systemd service** (user
request). New `config/env/` folder, matching the existing architecture of
every other `config/*` subfolder exactly (a `00path` file whose 2 lines are
the source filename and destination directory, consumed by a `config_*()`
function in `git-hub-deploy-server`) — `config/env/00path` points at
`.env` → `/etc/ndpi`, and `config/env/.env` holds the actual default
key/value pairs. Both new files are picked up by this repo's existing
`*00path` and `.env` `.gitignore` rules automatically (confirmed via
`git ls-files` that every pre-existing `00path` and `git-hub-deploy-server`
itself are *already* untracked by design, not accidentally — this repo
deliberately keeps its real deploy tooling and per-folder path manifests
out of git; the new files match that convention with zero `.gitignore`
changes needed).

New `config_env()` in `git-hub-deploy-server`, added as sub-step `(6).07`
inside `relocate_config_files()` (i.e. STEP 5 — runs before STEP 6-8.5, so
`/etc/ndpi/.env` always exists before any service that reads it is
created/started), mirrors `config_unclutter()`/`config_autologin()`'s
existing pattern exactly (absolute destination, `sudo mkdir -p` if
missing, `sudo rsync`). Redeploys overwrite `/etc/ndpi/.env` from the repo
copy every time, same as every other file under `config/` already does —
not a special case.

`create_node_service_file()`/`create_gui_service_file()` (generate
`ndpi.service`/`ndpi-gui.service`) had their individual `Environment=`
lines (`PATH`, `LD_LIBRARY_PATH`, `DISPLAY`, `TMP_NDPI_PATH`,
`DATA_NDPI_PATH`, `PORT_API`, `XAUTHORITY`) replaced with a single
`EnvironmentFile=/etc/ndpi/.env` line (values preserved verbatim in the new
`.env`, including activating `XAUTHORITY`, which node.service had defined
but left commented-out/unused before this change). All 4
`config/systemd/uxplay-*.service` files got the same
`EnvironmentFile=/etc/ndpi/.env` line added. Two things needed care, not
just a mechanical add:
1. systemd applies `Environment=`/`EnvironmentFile=` directives in file
   order, with same-key duplicates resolved by whichever comes *last* — so
   `EnvironmentFile=` had to be placed *before* `uxplay-airplay.service`'s
   own `Environment="DISPLAY=:1"` line, not after, or the shared file's
   `DISPLAY=:0` default (the Hub's own kiosk display) would have
   silently won and broken the AirPlay bridge's virtual display. Verified
   this ordering explicitly in all 4 files after editing.
2. `uxplay-audio-setup.service`'s previously hardcoded
   `Environment="XDG_RUNTIME_DIR=/run/user/1000"` (added earlier this
   session, patched via a per-unit-file `sed` in `install_uxplay_ndi_bridge`
   when the deployed user's UID wasn't 1000) is now just another key in the
   shared `.env`, and `install_uxplay_ndi_bridge`'s UID patch was
   retargeted from the unit file to `/etc/ndpi/.env` — one patch site
   instead of one that would've needed to grow per-service if any other
   unit ever needed the same UID-dependent value.

**Not tested against a real device** — same standing limitation as the
rest of this feature; verified with `bash -n` on the deploy script and a
structural read-through of all 6 affected unit-file-generation sites.

### Local-only admin auto-signin + a protected 'admin' account (user request)

Two related features: the Hub's own kiosk browser (`http://localhost:PORT/`,
`config/kiosk.service`) should sign itself in as the admin account with no
PIN, and the `admin` account itself should be locked down (only its PIN
editable) so it can't accidentally be renamed/demoted/deleted out from
under that auto-signin.

**Auto-signin**: new `POST /api/account/local-signin`
(`hub_api_server.js`) — gated on `isLoopbackAddress(req.socket.remoteAddress)`
(127.0.0.1/::1, `::ffff:`-stripped), independent of anything the client
claims; always resolves to the account named `admin` specifically, not
"any admin". `auth.js`'s `loadUserAccount()` calls this (via new
`isLocalHost()`/`tryLocalAutoSignIn()` helpers) before falling back to
`redirectSignIn()`, both when there's no token and when an existing token
turns out to be invalid/stale. `sign-in.html` also calls it directly on
load — needed because its own top-of-file IIFE unconditionally clears any
token whenever that page loads, so without this an explicit sign-out (or
any bounce through that page) would otherwise strand the kiosk on the PIN
screen with no one there to type one.

**Protected `admin` account**: `handleAccountUpdate` (backs both
`PUT /api/account/:id` and `POST /api/account/:id/update`) now rejects any
update touching `firstName`/`lastName`/`username`/`isAdmin` when
`account.username.toLowerCase() === 'admin'` — regardless of who's asking,
including another admin, since the user's ask was literally "the only
thing editable is the PIN." `DELETE /api/account/:id` gained the same
username check ahead of the pre-existing last-admin-account check. Client-side
UX (not itself enforcement, matches this codebase's existing
`allowEditExternal`-is-UI-only convention): `users.html`'s Grant/Revoke
Admin button no longer renders for the `admin` account;
`account-settings.js` disables the firstName/lastName fields and the
update button when the signed-in account is `admin`.

**Verified live** (booted the Hub locally, real HTTP calls, not mocked):
`POST /api/account/local-signin` from actual `127.0.0.1` correctly returns
the admin account's token; attempts to change `admin`'s username, isAdmin
(including via its own requestor id), and firstName each correctly 400
with the new message; `DELETE` on it correctly 400s; a PIN-only update
still succeeds and the new PIN correctly signs in afterward; local-signin
still resolves correctly after the PIN change. Did not test the loopback
rejection path against a genuine non-loopback source (would need a real
remote host) — logic is a simple, directly-reviewed one-liner, not
exercised end-to-end.

### Custom on-screen keyboard for the kiosk touch display (user request)

Chromium kiosk mode never shows the native OS on-screen keyboard, so text
inputs were untypeable on the Hub's attached touchscreen. New
`public/01-scripts/on-screen-keyboard.js` — self-contained, self-initializing
(no dependency on functions.js/auth.js, since sign-in.html/set-pin.html
don't load those), full QWERTY + a separate 10-key numpad, styled in
styles.css's new `ON-SCREEN KEYBOARD` section.

Triggered on `touchstart` specifically (not `focus`), since a mouse click
also fires focus and shouldn't raise it — a real keyboard is assumed
attached wherever a mouse is. Disabled entirely inside the app's existing
mobile breakpoint (`(max-width: 860px)`, same value as
`functions.js`'s `MOBILE_BAR_QUERY` / styles.css's `53.75rem`, duplicated
as a literal rather than shared since this script must work without
functions.js loaded): a phone/tablet also delivers touchstart, but its own
native keyboard works fine there.

Key presses splice `input.value` directly at `selectionStart`/`selectionEnd`
(wrapped in try/catch -- some input types like `number` throw on
`selectionStart` access) and dispatch a real `input` event afterward so
existing app listeners still fire; `maxLength` is enforced manually since
direct `.value` writes bypass the browser's native enforcement. Keyboard
buttons use `pointerdown` + `preventDefault()` rather than `click`, so the
active input never blurs while typing (cursor/selection stay visible
throughout) — no need to re-focus between keypresses.

Positioning always targets directly under the touched input (per the
user's explicit spec, never flipping above it): if there isn't room below
in the viewport, the nearest scrollable ancestor is scrolled up just
enough instead. Horizontal position is centered under the input but
clamped within the viewport so it can never overflow either edge.
Deliberately not real DOM measurement gated behind a frame wait — the
keyboard is always `display:flex` (only `opacity`/`pointer-events` toggle
with `.osk-visible`), so `offsetHeight`/`offsetWidth` are valid to read
immediately on show.

Wired into all 14 pages with either a static text `<input>` or a
`modal.js`-driven `modal.prompt()` call (every page except
`not-found.html`) — the script tag itself is what matters (event
delegation on `document` means no other per-page wiring is needed), placed
consistently right after `functions.js`/`ws-hub-stats.js` (or after
`auth.js` on `sign-in.html`, which loads neither).

**Verified**: `node --check` on the new script and every extracted
`<script>` block across all 14 edited pages; an HTML tag-balance check on
all 14 (clean); booted the Hub locally and confirmed both new assets
(`/scripts/on-screen-keyboard.js`, the new CSS section in `/styles.css`)
serve with real content, plus a full page-route sweep (200s). **Not**
tested on an actual touchscreen — no touch input available in this
environment; the touch-vs-mouse distinction, live positioning/scroll
behavior, and cursor-splice correctness are the parts most worth checking
by hand on the real kiosk display before trusting this fully.

### Per-HDMI-port display settings (Hub + Client) + HDMI-2 becomes a real second output

User request: `output_display_*` settings in both `hub_fs.js` and
`client_fs.js` were one shared/universal key set for "whichever HDMI port
a display happens to be plugged into" (`output_display_port` picked the
target) — asked to split them so both HDMI-1 and HDMI-2 get their own
independent resolution settings on both the Hub and the Client. Follow-up
requirements: on the Client, both outputs should keep showing identical
content (single NDI-receiver design, just mirrored across two ports); on
the Hub, HDMI-2 should become the AirPlay-to-NDI bridge's real output
(previously a headless Xvfb, invisible on any physical screen) rather than
just a resolution-tracking placeholder — explicitly confirmed with the
user via AskUserQuestion before building this (the alternative, keeping
HDMI-2 virtual-only, was the lower-risk option; the user chose the real
second output).

**Settings layer** (`hub_fs.js` / `client_fs.js`): the ~10 shared
`output_display_*` keys (resolution/framerate current/preferred/
preference, manufacturer/model/model_number/serial_number, plus the old
disambiguating `output_display_port`) became `output_display_hdmi1_*` /
`output_display_hdmi2_*`, generated via one `['hdmi1','hdmi2'].flatMap()`
block in each file's `files` array so both ports stay in lockstep. Added
a new `output_display_hdmiN_connected` boolean per port (didn't exist
before — needed now that there's no single `output_display_port` value to
check for "is anything plugged in"). `output_display_port` itself is
gone entirely: previously it existed to disambiguate which literal xrandr
output name a single shared setting applied to; now both ports are always
addressed by their fixed real names (`HDMI-1`/`HDMI-2`), so there's
nothing left to disambiguate. The Hub's set also gained
`output_display_hdmiN_framerate_preference` (a real, user-editable
setting) — previously only the Client had this; the Hub's own
`setDisplayResolution()` referenced a same-named key that was never
actually in its fileMap, a pre-existing latent gap fixed as a side effect
of this rewrite. **CEC keys were deliberately left as a single shared set,
not split per port** — scoped out since the user's ask was specifically
about resolution, and it's genuinely unknown whether this hardware's CEC
adapter can address two independent HDMI connectors at all (unlike
resolution, which xrandr trivially handles per-output).

**`sh/current-resolution` rewritten in both repos** to tag every emitted
line with its port (`<key> : <PORT> :: <value>`, list_resolutions
additionally nesting a second ` :: ` for its label/value pair) instead of
producing one anonymous stream that only ever captured "whichever HDMI
line came last" into a single key set. The Client's version queries one
`xrandr` call on its single DISPLAY=:0 (both real outputs already appear
in one call, each in its own block — parsed via an awk state machine that
tracks the current unindented "PORT connected ..." header) and kept its
Client-only `allowed_framerates` feature, now computed per port. The
Hub's version queries `DISPLAY=:0.0` and `DISPLAY=:0.1` **separately**
(see Zaphod-mode note below) and passes a fixed label into the same awk
parser rather than trusting xrandr's own reported connector name, since
each screen is hard-constrained to exactly one connector by construction.
Both scripts' EDID section (unchanged sysfs paths, `card1-HDMI-A-1`/`-2`)
now tags its output with the real port name directly instead of the old
`_hdmi0`/`_hdmi1` key suffixes. `updateOutputDisplayFiles()` in both
`hub_fs.js`/`client_fs.js` rewritten to parse this tagged format into
each port's own keys, tracking resolution/framerate dropdown options
per-port instead of one shared list.

**`setDisplayResolution()` rewritten in both repos' `functions.js`**:
the Client now issues one `xrandr` call configuring both HDMI-1 and
HDMI-2 from their own preference settings, then mirrors HDMI-2 onto
HDMI-1 via `--same-as` (plus `--scale-from` when their preferred
resolutions actually differ, so mirroring still looks correct at each
port's own native resolution rather than just overlapping canvases of
different sizes). The Hub configures each port with its own **separate**
`xrandr` invocation against its own `DISPLAY` env override, since (per the
Zaphod design below) they're independent screens with independent
content, not a mirrored pair — no `--same-as` on the Hub side.
`server.js`/`index.js`'s old `output_display_port`/
`output_display_resolution_preference` change listeners (2 each) became 4
each (`output_display_hdmi{1,2}_{resolution,framerate}_preference`), all
just re-invoking the same `setDisplayResolution()`, which now internally
handles both ports in one call.

**HDMI-2 architecture on the Hub — "Zaphod mode," not a second Xorg
process.** The original plan (confirmed with the user) was two fully
independent X servers (:0 for HDMI-1, a new :1 for HDMI-2, replacing the
uxplay bridge's old headless Xvfb). Switched to a different, more
reliable implementation of the same requirement after finding
`config/boot_config/config.txt` had `max_framebuffers=1` — meaning the
VC4/KMS driver was only ever exposing one usable output pipeline in the
first place, unrelated to any Xorg-level configuration on top of it (now
`max_framebuffers=2`, required either way, needs a reboot to take
effect). Two separate Xorg processes each trying to become DRM master of
the same `/dev/dri/card1` concurrently is a real, unresolved risk (most
setups only allow one DRM master per card without lease-based hand-off);
**Zaphod mode** — one Xorg process (the one LightDM already starts for
the kiosk on :0), split into two independent screens via a
`ServerLayout`/two `Device`+`Screen` sections in a new
`config/xorg/10-hdmi-zaphod.conf` (`Option "ZaphodHeads" "HDMI-1"` /
`"HDMI-2"`, both against `kmsdev /dev/dri/card1`) — is the standard,
documented way to get two screens with completely independent content
from one GPU under one DRM master, and needs no new systemd unit at all:
HDMI-2 becomes `:0.1` (a second **screen** on the same X **display**
number, not a separate display number) the moment LightDM's Xorg starts.
**This substitutes `:0.1` everywhere the user said "`:1`"** — functionally
equivalent for uxplay/GStreamer's purposes (any DISPLAY string, `:0.1`
included, works the same as a literal `:1` would have for connecting a
client to a specific screen), just a different, more hardware-reliable X11
mechanism than what was literally asked for. `uxplay-xvfb.service` was
deleted outright (no longer needed — HDMI-2 now exists the instant
LightDM's Xorg starts, same lifecycle as the kiosk dashboard itself, not
a separately-managed virtual display); `uxplay-airplay.service` and
`uxplay-ndi-sender.service` now target `DISPLAY=:0.1`, depend on
`lightdm.service` (ordering only, not a hard `Requires=`/`BindsTo=` the
way they depended on the deleted Xvfb unit) instead of the deleted unit,
and `git-hub-deploy-server`'s `install_uxplay_ndi_bridge`/`UXPLAY_SERVICES`
dropped from 4 services to 3. New `config_xorg()` deploy step (mirrors
`config_boot_config()`'s absolute-destination pattern) installs the
Zaphod conf to `/etc/X11/xorg.conf.d/` and warns a reboot is required.
`uxplay-ndi.sh` (the manual CLI wrapper) and `BUILD_AND_SETUP.md` updated
to match throughout (3-service stack, `:0.1`, the reboot requirement, a
new troubleshooting row for Zaphod/connector-name mismatches).
**⚠️ This entire Zaphod xorg.conf approach is unverified against real
hardware** (no X11/DRM available in this dev environment) — it's the
textbook-documented recipe for the X.Org `modesetting` driver, but the
connector names (`HDMI-1`/`HDMI-2`) and `kmsdev` path (`/dev/dri/card1`)
should be double-checked against the actual device (`xrandr
--listmonitors`, `ls /dev/dri`) if Xorg fails to start after deploying it
— check `journalctl -u lightdm` / the Xorg log for the specific error
first, rather than assuming the whole approach is wrong.

**Root-caused (as best as possible without hardware/logs) the two AirPlay
bridge bugs the user reported from real testing**:
1. *"showed the airplay feed on DISPLAY=:0"* — under the old
   architecture this should have been structurally impossible (Xvfb :1
   was a fully separate, headless X server with no path to the real
   screen), which points at either a stale/pre-fix deployment (the
   `EnvironmentFile`+`Environment` override ordering was already correct
   in the files as they existed) or a manual test run that didn't
   actually go through the systemd units (inheriting an ambient DISPLAY
   from the SSH session instead). Not independently reproducible without
   the user's real device/logs — flagged rather than guessed further.
2. *"froze as soon as I stopped AirPlay"* — root-caused with higher
   confidence: `uxplay-airplay.service`'s `-nc` flag was added in an
   earlier session specifically to keep uxplay's render surface from
   being torn down on client disconnect, but its actual effect is that
   uxplay's last frame stays on screen **indefinitely** across sessions —
   contradicting `uxplay_ndi_sender.cpp`'s own doc comment claiming the
   bridge "keeps broadcasting a black frame" between sessions (aspirational,
   not actually true with `-nc` set). Removed `-nc` from
   `uxplay-airplay.service` so the window actually closes on disconnect,
   matching the documented/intended behavior.
3. *"wasn't able to see the NDI source"* — `g_ndi.send_create()` runs
   before pipeline creation in `main()`, so the NDI source name should
   register (discoverable) even if the GStreamer pipeline itself never
   comes up — meaning this symptom most likely means the
   `uxplay-ndi-sender` service didn't survive startup at all (missing
   GStreamer plugin, `/dev/dri` permission issue, etc.), not a partial
   failure. Not diagnosable further without `journalctl -u
   uxplay-ndi-sender -u uxplay-airplay -u uxplay-audio-setup` output from
   the real device.

**Frontend updates**: `settings.html`'s single "Display Resolution" card
split into two ("— HDMI-1" / "— HDMI-2"), `renderDisplayResolutionInfo()`/
`saveResolutionPreference()` parameterized by port instead of hardcoding
one set of element ids; gates on the new `_connected` key instead of the
removed `_port` value. `device.html`'s `applyDeviceSettingsTuples()`,
`hub_api_server.js`'s `deriveStatusFieldsFromSettings()`, and
`01-scripts/ws-devices.js`'s `getDeviceCardFields()` (all three read a
**Client device's** display info for status tiles) now pick whichever
port is actually connected (HDMI-1 first) as the representative value,
since a Client's two outputs always mirror the same content. `group.html`
needed no changes (already excludes the whole `output_display_` prefix
from its generic per-device settings grid). **Found and fixed a real
regression before it shipped**: Client's own local `system.html` renders
generic settings into a container looked up by literal `getElementById(
group)` — the old flat `id="Display_Resolution"` div would have made
every `output_display_hdmi{1,2}_*` setting throw on render (null
`.appendChild`) with the new per-port group names, since that container
no longer existed for either group. Added matching
`id="Display_Resolution_HDMI1"`/`"_HDMI2"` containers (mirrors the CEC
container's existing pattern) instead.

**Verified**: booted both the Hub and Client locally (`DATA_NDPI_PATH=...
PORT_API=... node server.js` / `node index.js`), confirmed all 26
`output_display_hdmi{1,2}_*` files are created correctly on both,
round-tripped `POST`/`GET /api/v2/setting` for
`output_display_hdmi2_resolution_preference` end-to-end (confirmed the
500ms fs-watch debounce, then the value landing in the in-memory
fileMap), confirmed the change fired `setDisplayResolution()` again via a
second "Resolution Set (HDMI-2)" log line, confirmed both `xrandr` calls
attempt the correct `--output`/`DISPLAY` combination each (fails
gracefully on macOS, expected, matches this repo's standing pattern for
Linux-only tooling), a full Hub page-route sweep (all 200s), `node
--check` on every modified `.js` file in both repos, `bash -n` on both
rewritten `sh/current-resolution` scripts and `git-hub-deploy-server`, an
HTML tag-balance check on `settings.html`/Client's `system.html` (clean,
modulo one pre-existing unrelated `<meta>` quirk confirmed present before
this change too), and a brace/paren/bracket balance check on
`uxplay_ndi_sender.cpp` (its `--display` default and help text updated to
`:0.1` to match, cannot be compiled/tested in this environment — no
GStreamer/NDI toolchain on macOS). **Not tested against real hardware at
all** — this is the largest unverified surface in this pass: the Zaphod
xorg.conf, the `max_framebuffers` bump, and both uxplay bug fixes all
need a real deploy + reboot to confirm.

## Priority order for remaining work

1. Fix routing bug (#1 above) — nothing else matters until navigation works.
2. Fix shutdown crash (#2).
3. Fix `show-overlay`/`show-blank` semantics (#3).
4. Fix port mismatch in kiosk/deploy config (#4).
5. Prune `hub_fs.js`'s fileMap to Hub-appropriate settings only.
6. Decide fate of vestigial single-Pi code in `hub_api_server.js` /
   `functions.js` (`/ws/display`, `/ws/system`, `/ws/stats`, `/ws/sources`,
   `/api/v1/rpc`, `/api/v1/__internal/*`) — likely remove, but confirm Hub
   kiosk-mode display-resolution/CEC needs before deleting those specific
   pieces.
7. Work through the frontend gap list above.
8. Re-verify end-to-end (boot locally, click through every page).
