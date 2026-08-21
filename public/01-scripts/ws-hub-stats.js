/**
 * The one shared connection to the Hub's own /ws/hub-stats feed
 * (service/hub_api_server.js's __ws_HubStats()). Every page gets the
 * topbar clock (#sys-time) driven from its systemTime field for free,
 * instead of the browser's own new Date() -- so the displayed time
 * reflects the Hub's actual system clock rather than whatever the viewing
 * device's local clock happens to read. Renders once immediately from the
 * local clock as a first-paint fallback (so the topbar isn't blank while
 * the socket connects), then the socket's ~1/sec pushes take over.
 *
 * The /ws/hub-stats payload also carries CPU/memory/load/etc (see
 * getHubRawSystemStats() server-side) -- pass an onStats(rawMessage)
 * callback to react to those too. dashboard.html's stats card is the
 * current example: it derives its own shape from the raw payload and
 * feeds it to updateSystemStats(). Every page should go through this one
 * connection for anything /ws/hub-stats carries, rather than opening a
 * second one -- mirrors how 01-scripts/ws-devices.js's NDPiDevicesRelay is
 * the one shared connection for per-device data.
 *
 * Returns { close() } -- call it from the page's own beforeunload handler,
 * same as NDPiDevicesRelay instances already are (e.g. dashboard.html's
 * devicesStatsRelay.close() / devicesSystemRelay.close()).
 *
 * This is also where the offline overlay lives (moved from
 * 01-scripts/ws-client.js): /ws/hub-stats pushes on a steady ~1/sec
 * cadence, so "no message received in OFFLINE_TIMEOUT_MS" is a fast,
 * reliable liveness signal -- much faster than the /ws GUI socket's old
 * 30s heartbeat timeout, and it doesn't depend on `onclose` firing
 * promptly for every kind of disconnect. showOfflineOverlay()/
 * hideOfflineOverlay() are plain top-level functions (not nested in
 * initGlobalHubStats()'s closure) so ws-client.js can still drive the same
 * overlay directly for the two cases where it has better information than
 * a generic timeout would (the server announcing its own shutdown/reboot).
 */
const OFFLINE_TIMEOUT_MS = 2000;

const OFFLINE_PING_TIMEOUT_MS = 5000;

let offlinePingStartTimer = null;
let offlinePingActive = false;
let offlinePingAbortController = null;
let offlinePingTimeoutTimer = null;

/**
 *  Offline recovery: once the overlay is shown (connection silence,
 *  or the server announcing its own shutdown/reboot), poll the Hub's own
 *  /api/v2/ping rather than silently retrying the socket in place -- the
 *  Hub going down/coming back is exactly the kind of event where a lot of
 *  client-side state (settings, device lists, sockets) could otherwise
 *  drift out of sync, so once the Hub is confirmed reachable again the
 *  simplest correct recovery is a full page reload instead of trying to
 *  resume in place.
 *
 *  Each ping waits for that request to settle (response, network error, or
 *  a OFFLINE_PING_TIMEOUT_MS-second abort) before sending the next one,
 *  rather than firing on a blind fixed interval -- a plain setInterval
 *  would keep launching new requests on schedule even while an earlier one
 *  was still hanging (fetch() has no built-in timeout and a half-open
 *  connection to a Hub that's mid-restart can sit unresolved far longer
 *  than 1s), piling up overlapping in-flight requests instead of just
 *  trying again.
 */
function startOfflinePing() {
	if (offlinePingActive || offlinePingStartTimer) return;

	const sendPing = async () => {
		if (!offlinePingActive) return;

		offlinePingAbortController = new AbortController();
		offlinePingTimeoutTimer = setTimeout(() => offlinePingAbortController.abort(), OFFLINE_PING_TIMEOUT_MS);

		try {
			const res = await fetch('/api/v2/ping', { cache: 'no-store', signal: offlinePingAbortController.signal });
			clearTimeout(offlinePingTimeoutTimer);
			offlinePingTimeoutTimer = null;

			if (res.ok) {
				const data = await res.json();
				if (data && data.success) {
					stopOfflinePing();
					window.location.reload();
					return;
				}
			}
		} catch (error) {
			// Request failed, or timed out and was aborted above -- still offline.
			clearTimeout(offlinePingTimeoutTimer);
			offlinePingTimeoutTimer = null;
		}

		if (offlinePingActive) { sendPing(); }
	};

	// Debounce the first ping by 2s: right as the connection drops (e.g. a
	// software-update restart), the Hub's HTTP server can still be very
	// briefly reachable -- old process not fully torn down yet, or the OS
	// accepting the connection before the new process is actually
	// listening. Pinging immediately can catch it in that flaky window,
	// see a 200, and reload straight into a Hub that's still mid-restart --
	// which just repeats the whole offline/reload dance a few times in a
	// row. Waiting 2s first gives the restart time to actually take the
	// API down before polling starts.
	offlinePingStartTimer = setTimeout(() => {
		offlinePingStartTimer = null;
		offlinePingActive = true;
		sendPing();
	}, 2000);
}

function stopOfflinePing() {
	if (offlinePingStartTimer) {
		clearTimeout(offlinePingStartTimer);
		offlinePingStartTimer = null;
	}
	offlinePingActive = false;
	if (offlinePingTimeoutTimer) {
		clearTimeout(offlinePingTimeoutTimer);
		offlinePingTimeoutTimer = null;
	}
	if (offlinePingAbortController) {
		offlinePingAbortController.abort();
		offlinePingAbortController = null;
	}
}

function showOfflineOverlay(message = 'Server Offline - Waiting for signal...') {
	let overlay = document.getElementById('offlineOverlay');

	// Create overlay if it doesn't exist
	if (!overlay) {
		overlay = document.createElement('div');
		overlay.id = 'offlineOverlay';
		overlay.className = 'offline-overlay'
		overlay.innerHTML = `
			<div class="offline-modal">
				<div class="offline-spinner"></div>
				<h2>Lost Server Connection</h2>
				<p id="offlineMessage" class="offline-message">${message}</p>
			</div>
		`;
		document.body.appendChild(overlay);
	} else {
		// Update message if overlay exists
		const msgEl = overlay.querySelector('.offline-message');
		if (msgEl) msgEl.textContent = message;
	}

	overlay.classList.add('active');
	startOfflinePing();
}

function hideOfflineOverlay() {
	const overlay = document.getElementById('offlineOverlay');
	if (overlay) {
		overlay.classList.remove('active');
	}
	stopOfflinePing();
}

function initGlobalHubStats(onStats) {
	const el = document.getElementById('sys-time');

	const render = (date) => {
		if (el) { el.innerHTML = `${date.toDateString()}<br>${date.toLocaleTimeString()}`; }
	};

	if (el) {
		el.style.fontSize = 'clamp(0.8rem, 1.7vw, 1.15rem)';
		render(new Date());
	}

	let socket = null;
	let reconnectTimer = null;
	let offlineDetectTimer = null;

	// Started fresh on every connection attempt (not just once the socket
	// actually opens) so a connection that never establishes at all -- not
	// just one that drops after connecting -- also surfaces the overlay
	// within OFFLINE_TIMEOUT_MS instead of waiting on the browser's own
	// (much slower, and inconsistent across browsers) connection-attempt
	// timeout.
	function resetOfflineDetectTimer() {
		clearTimeout(offlineDetectTimer);
		offlineDetectTimer = setTimeout(() => {
			showOfflineOverlay('Server connection has been lost...');
		}, OFFLINE_TIMEOUT_MS);
	}

	function connect() {
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		socket = new WebSocket(`${protocol}//${window.location.host}/ws/hub-stats`);

		resetOfflineDetectTimer();

		socket.onopen = () => {
			resetOfflineDetectTimer();
		};

		socket.onmessage = (event) => {
			hideOfflineOverlay();
			resetOfflineDetectTimer();

			let data;
			try {
				data = JSON.parse(event.data);
			} catch (e) {
				console.error('Invalid /ws/hub-stats message:', e);
				return;
			}
			if (data && data.systemTime) { render(new Date(data.systemTime)); }
			if (typeof onStats === 'function') {
				try { onStats(data); } catch (e) { console.error('/ws/hub-stats onStats handler threw:', e); }
			}
		};
		socket.onclose = () => {
			clearTimeout(reconnectTimer);
			reconnectTimer = setTimeout(connect, 5000);
		};
		socket.onerror = () => { };
	}
	connect();

	const close = () => {
		clearTimeout(reconnectTimer);
		clearTimeout(offlineDetectTimer);
		try { socket && socket.close(); } catch (e) { }
	};
	window.addEventListener('beforeunload', close);

	return { close };
}
