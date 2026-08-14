/**
 *  Theme accent color -- Hub-wide setting (`ui_theme_color`, hub_fs.js),
 *  read/written through the existing generic `/api/setting` GET/POST
 *  routes so the chosen color is persisted on the Hub itself, not just in
 *  this one browser's localStorage. localStorage is still used as a
 *  same-device cache so the very first paint on a page load already has
 *  the right color instead of flashing the CSS default before the fetch
 *  resolves -- see the inline snippet at the top of every page's <head>
 *  that applies the cached value synchronously before this file even
 *  loads.
 */
const THEME_COLOR_CACHE_KEY = 'ndpi_theme_color';

function hexToRgbString(hex) {
	const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
	if (!match) return null;
	const r = parseInt(match[1], 16);
	const g = parseInt(match[2], 16);
	const b = parseInt(match[3], 16);
	return `${r}, ${g}, ${b}`;
}

function applyThemeColor(hex) {
	if (!hex) return;
	const rgb = hexToRgbString(hex);
	document.documentElement.style.setProperty('--accent', hex);
	if (rgb) { document.documentElement.style.setProperty('--accent-rgb', rgb); }
	localStorage.setItem(THEME_COLOR_CACHE_KEY, hex);
}

async function fetchAndApplyThemeColor() {
	try {
		const res = await fetch('/api/setting/ui_theme_color');
		if (!res.ok) return;
		const data = await res.json();
		if (data && data.value) { applyThemeColor(data.value); }
	} catch (e) { /* offline / not-yet-connected -- cached value already applied */ }
}

async function saveThemeColor(hex) {
	applyThemeColor(hex);
	try {
		await fetch('/api/setting', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'ui_theme_color', value: hex }),
		});
	} catch (e) { console.error('Failed to save theme color:', e); }
}

(async () => {
	setScale();

	// Auth-flow pages (set-pin, create-account) don't have the persistent
	// app shell (sidebar/topbar nav) -- skip shell-specific setup on them
	// instead of throwing, since that would abort this whole IIFE before
	// loadUserAccount()/initPage() ever run.
	await loadUserAccount();

	if (document.getElementById('navDashboard')) {
		setNavigationButtons();
	}

	fetchAndApplyThemeColor();

	if (typeof initPage === 'function') { initPage(account); }
})();


/**
 *  Best-effort screen-orientation lock -- keeps a phone/tablet from
 *  flipping its layout on rotation. The Screen Orientation API only
 *  grants a lock while the page is actually fullscreen (true in the
 *  Hub's own kiosk-mode chromium, per config/kiosk.service); in an
 *  ordinary mobile browser tab the lock request is rejected by the
 *  browser itself, so this is wrapped to fail silently rather than
 *  throw -- the responsive layout (sidebar -> bottom bar breakpoint)
 *  already handles both orientations fine either way.
 */
function lockOrientation() {
	try {
		const current = (screen.orientation && screen.orientation.type) || '';
		const target = current.startsWith('portrait') ? 'portrait' : 'landscape';
		if (screen.orientation && typeof screen.orientation.lock === 'function') {
			screen.orientation.lock(target).catch(() => {});
		}
	} catch (e) { /* not supported / not fullscreen -- ignore */ }
}
lockOrientation();

/**
 *  Scales via the root <html> font-size, not body.style.zoom/transform.
 *  Every dimension in this app is rem-based, so this alone rescales the
 *  whole UI -- and unlike zoom/transform, it doesn't fight with the
 *  viewport-relative units (.app's `height: 100dvh`, the mobile bottom
 *  nav's breakpoint) those layouts depend on. zoom/transform scale the
 *  *rendered* box after 100dvh has already been measured against the
 *  real, unscaled viewport, so the two stop matching: at <100% the
 *  scaled-down box no longer reaches the bottom of the screen (the
 *  bottom nav bar "floats" above it with a gap below); at >100% the
 *  scaled-up box overflows past the bottom edge (the bar renders
 *  off-screen). Root font-size doesn't touch viewport-unit math at all,
 *  so 100dvh keeps exactly filling the real screen at any scale.
 */
function setScale() {
    const savedScale = localStorage.getItem('ndpi_ui_scale') || '100';
	document.documentElement.style.fontSize = `${savedScale}%`;
}

const NAV_ACCOUNT_ICON = `<span class="nav-btn-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3"/><path d="M6.5 19a6 6 0 0 1 11 0"/></svg></span>`;

function wireNavButton(id, label, href) {
	const el = document.getElementById(id);
	if (!el) return;
	const labelEl = el.querySelector('.nav-btn-label');
	if (labelEl) { labelEl.textContent = label; }
	el.addEventListener('click', function (e) {
		this.onclick = null;
		e.preventDefault();
		window.location.href = href;
	});
}

function setNavigationButtons() {
	wireNavButton('navDashboard', 'Dashboard', '/');
	wireNavButton('navDevices', 'Devices', '/devices.html');
	wireNavButton('navGroups', 'Groups', '/groups.html');
	wireNavButton('navUsers', 'Users', '/users.html');
	wireNavButton('navConsole', 'Console', '/console.html');
	wireNavButton('navSettings', 'Settings', '/settings.html');

	const userAccountNavEl = document.getElementById('navAccount');
	if (userAccountNavEl) {
		userAccountNavEl.innerHTML = `${NAV_ACCOUNT_ICON}<span class="nav-btn-label">${account.username}</span>`;
		userAccountNavEl.addEventListener('click', function (e) {
			this.onclick = null;
			e.preventDefault();
			window.location.href = '/account-settings.html';
		});
	}
}

function applyActiveNav(element) {
	if (!element) return;
	document.getElementById(element).classList.add('active');
}


function addTouchScrollEventListener() {
	const list = document.querySelector('.content');
	if (!list) return;

	list.addEventListener('touchstart', (e) => {
		document.body.style.cursor = 'grab';
	});

	list.addEventListener('touchmove', (e) => {
		document.body.style.cursor = 'grabbing';
	});

	list.addEventListener('touchend', () => {
		document.body.style.removeProperty('cursor');
	});
}
addTouchScrollEventListener();