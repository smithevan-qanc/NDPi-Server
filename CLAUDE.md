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
