/**
 *  NDPiDevicesRelay — shared client for the Hub's multi-device relay
 *  endpoints (service/hub_api_server.js: /ws/devices/system,
 *  /ws/devices/stats). The Hub maintains its own outbound connection to
 *  every adopted device's own /ws/system and /ws/stats
 *  (Client__v3_1_0/service/client_api_server.js) and relays every message
 *  here, tagged by deviceId — so a page showing many devices only opens
 *  ONE connection to the Hub instead of one per device, and still gets a
 *  full snapshot immediately on connect instead of sitting blank between
 *  per-device updates.
 *
 *  Usage:
 *      const relay = new NDPiDevicesRelay('stats', (cache, changedDeviceId) => {
 *          // cache: { [deviceId]: derivedStats }, changedDeviceId: string|null
 *      });
 *      // ... later ...
 *      relay.close();
 */

/**
 * Convert a device's raw /ws/stats payload (client_api_server.js's
 * getSystemStats() — plain os.* fields) into the same
 * {cpu,memory,temperature,uptime} shape the Hub's own REST/`/ws`
 * device-relay already uses (device.systemStats), so existing per-page
 * rendering code doesn't need to know the two shapes are different.
 */
function deriveDeviceStats(raw) {
	if (!raw || !Array.isArray(raw.loadavg) || !Array.isArray(raw.cpus) || !raw.totalmem) return null;

	const totalMem = raw.totalmem;
	const usedMem = totalMem - raw.freemem;

	return {
		cpu: Math.round(Math.min(raw.loadavg[0] / raw.cpus.length, 1) * 1000) / 10,
		memory: {
			percent: Math.round((usedMem / totalMem) * 100),
			used: Math.round((usedMem / 1024 / 1024 / 1024) * 10) / 10,
			total: Math.round((totalMem / 1024 / 1024 / 1024) * 10) / 10,
		},
		temperature: (raw.thermal && raw.thermal.thermal_zone0) || 0,
		uptime: typeof raw.osUptime === 'number' ? raw.osUptime : 0,
		fan: (raw.thermal && typeof raw.thermal.fan1_input === 'number') ? raw.thermal.fan1_input : 0,
	};
}

/**
 * Look up a single setting's {value,...} object out of a cached
 * Array.from(fileMap)-shaped tuple array (as delivered by the 'system'
 * relay), or null if that device/key isn't known yet.
 */
function getRelayedSetting(tuples, key) {
	if (!Array.isArray(tuples)) return null;
	const entry = tuples.find(([k]) => k === key);
	return entry ? entry[1] : null;
}

/**
 * Pulls the handful of device-card display fields (physical display
 * manufacturer/model, current resolution, NDI stream status, installed
 * version) out of a cached settings-relay tuple array in one shot --
 * shared by every page that renders a device card (devices.html,
 * dashboard.html, group.html) so the same key names/formatting aren't
 * triplicated.
 */
function getDeviceCardFields(tuples) {
	if (!Array.isArray(tuples)) return null;

	const manufacturer = getRelayedSetting(tuples, 'output_display_manufacturer');
	const model = getRelayedSetting(tuples, 'output_display_model');
	const resolution = getRelayedSetting(tuples, 'output_display_resolution_current');
	const ndiStatus = getRelayedSetting(tuples, 'ndpi_status_ndi_status');
	const version = getRelayedSetting(tuples, 'ndpi_version');

	return {
		manufacturer: (manufacturer && manufacturer.value) || null,
		model: (model && model.value) || null,
		resolution: (resolution && resolution.value) || null,
		ndiStatus: (ndiStatus && ndiStatus.value) || null,
		version: (version && version.value) || null,
	};
}

class NDPiDevicesRelay {
	/**
	 * @param {string} kind - 'system' or 'stats' (connects to
	 *   /ws/devices/<kind>).
	 * @param {(cache: object, changedDeviceIds: string[]|null) => void} onUpdate
	 *   - called after the initial snapshot and after every update, debounced
	 *   so a burst of per-device messages (e.g. many devices reporting
	 *   stats within the same second) coalesces into one call instead of
	 *   triggering a re-render per device. `changedDeviceIds` is the list of
	 *   every device that actually changed since the last call (so a caller
	 *   can patch just those devices' UI instead of all of them), or `null`
	 *   for the initial/reconnect snapshot, where everything is new.
	 * @param {object} [options]
	 * @param {number} [options.debounceMs=200]
	 */
	constructor(kind, onUpdate, options = {}) {
		this.kind = kind; // 'system' | 'stats'
		this.onUpdate = onUpdate || (() => {});
		this.debounceMs = options.debounceMs ?? 200;

		this.ws = null;
		this.cache = {}; // deviceId -> latest data (raw tuples for 'system', derived stats for 'stats')
		this.reconnectTimer = null;
		this._debounceTimer = null;
		this._pendingChangedIds = new Set(); // accumulates across a debounce window -- a single "last changed id" would silently drop other devices that changed in the same window
		this._pendingIsSnapshot = false;
		this._closed = false;

		this.connect();
	}

	connect() {
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		this.ws = new WebSocket(`${protocol}//${window.location.host}/ws/devices/${this.kind}`);

		this.ws.onmessage = (event) => {
			let msg;
			try { msg = JSON.parse(event.data); }
			catch (e) { console.error(`Invalid /ws/devices/${this.kind} message:`, e); return; }

			if (msg.type === 'snapshot') {
				Object.entries(msg.devices || {}).forEach(([deviceId, data]) => {
					this.cache[deviceId] = this.kind === 'stats' ? deriveDeviceStats(data) : data;
				});
				this._scheduleUpdate(null);
			}
			else if (msg.type === 'device-system' || msg.type === 'device-stats') {
				this.cache[msg.deviceId] = this.kind === 'stats' ? deriveDeviceStats(msg.data) : msg.data;
				this._scheduleUpdate(msg.deviceId);
			}
		};

		this.ws.onclose = () => {
			if (this._closed) return;
			this.reconnectTimer = setTimeout(() => this.connect(), 5000);
		};
		this.ws.onerror = () => {};
	}

	_scheduleUpdate(changedDeviceId) {
		if (changedDeviceId === null) { this._pendingIsSnapshot = true; }
		else { this._pendingChangedIds.add(changedDeviceId); }

		if (this._debounceTimer) return;
		this._debounceTimer = setTimeout(() => {
			this._debounceTimer = null;
			const changedIds = this._pendingIsSnapshot ? null : Array.from(this._pendingChangedIds);
			this._pendingChangedIds = new Set();
			this._pendingIsSnapshot = false;
			this.onUpdate(this.cache, changedIds);
		}, this.debounceMs);
	}

	close() {
		this._closed = true;
		clearTimeout(this.reconnectTimer);
		clearTimeout(this._debounceTimer);
		try { this.ws && this.ws.close(); } catch (e) {}
	}
}
