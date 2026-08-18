/**
 * Drives the topbar clock (#sys-time) from the Hub's own /ws/hub-stats feed
 * (service/hub_api_server.js's __ws_HubStats()) instead of the browser's own
 * new Date() -- so the displayed time reflects the Hub's actual system
 * clock rather than whatever the viewing device's local clock happens to
 * read. Renders once immediately from the local clock as a first-paint
 * fallback (so the topbar isn't blank while the socket connects), then the
 * socket's ~1/sec pushes take over.
 *
 * Pages that already open their own /ws/hub-stats connection for other data
 * (currently just dashboard.html, for its stats card) should read
 * systemTime off that existing connection instead of calling this --
 * opening a second redundant connection to the same endpoint has no
 * benefit.
 */
function initHubStatsClock() {
	const el = document.getElementById('sys-time');
	if (!el) return;

	const render = (date) => {
		el.innerHTML = `${date.toDateString()}<br>${date.toLocaleTimeString()}`;
	};

	el.style.fontSize = '1.1rem';
	render(new Date());

	let socket = null;
	let reconnectTimer = null;

	function connect() {
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		socket = new WebSocket(`${protocol}//${window.location.host}/ws/hub-stats`);

		socket.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data);
				if (data && data.systemTime) { render(new Date(data.systemTime)); }
			} catch (e) {
				console.error('Invalid /ws/hub-stats message:', e);
			}
		};
		socket.onclose = () => {
			clearTimeout(reconnectTimer);
			reconnectTimer = setTimeout(connect, 5000);
		};
		socket.onerror = () => { };
	}
	connect();

	window.addEventListener('beforeunload', () => {
		clearTimeout(reconnectTimer);
		try { socket && socket.close(); } catch (e) { }
	});
}
