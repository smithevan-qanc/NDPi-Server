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
 */
function initGlobalHubStats(onStats) {
	const el = document.getElementById('sys-time');

	const render = (date) => {
		if (el) { el.innerHTML = `${date.toDateString()}<br>${date.toLocaleTimeString()}`; }
	};

	if (el) {
		el.style.fontSize = 'clamp(0.8rem, 1.7vw, 1.25rem)';
		render(new Date());
	}

	let socket = null;
	let reconnectTimer = null;

	function connect() {
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		socket = new WebSocket(`${protocol}//${window.location.host}/ws/hub-stats`);

		socket.onmessage = (event) => {
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
		try { socket && socket.close(); } catch (e) { }
	};
	window.addEventListener('beforeunload', close);

	return { close };
}
