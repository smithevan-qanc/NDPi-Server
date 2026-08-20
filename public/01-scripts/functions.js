/**
 *  Theme accent color -- Hub-wide setting (`ui_theme_color`, hub_fs.js),
 *  read/written through the existing generic `/api/v2/setting` GET/POST
 *  routes so the chosen color is persisted on the Hub itself, not just in
 *  this one browser's localStorage. localStorage is still used as a
 *  same-device cache so the very first paint on a page load already has
 *  the right color instead of flashing the CSS default before the fetch
 *  resolves -- see the inline snippet at the top of every page's <head>
 *  that applies the cached value synchronously before this file even
 *  loads.
 */
const THEME_COLOR_CACHE_KEY = 'ndpi_theme_color';

/**
 *  Converts a UTC date string reported by a device/Hub's version settings
 *  (either a full ISO datetime like '2026-08-20T16:12:34Z', or a bare
 *  'YYYY-MM-DD' date -- version/current-date on both repos only ever holds
 *  a date, no time) into a human-readable string in the browser's own
 *  local timezone. A bare date has no real time component to convert, so
 *  it's shown as a date only rather than implying a (possibly
 *  timezone-shifted) midnight that was never actually reported.
 */
function formatHumanDate(dateString) {
	if (!dateString) return '';
	const str = String(dateString);
	const dateOptions = { year: 'numeric', month: 'short', day: 'numeric' };

	const bareDateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
	if (bareDateMatch) {
		// No time component was ever reported -- parse the Y/M/D directly
		// into a local-midnight Date instead of letting `new Date(str)`
		// interpret it as UTC midnight, which would shift the displayed
		// calendar date back a day for negative-UTC-offset timezones.
		const [, y, m, d] = bareDateMatch;
		const localDate = new Date(Number(y), Number(m) - 1, Number(d));
		return localDate.toLocaleDateString(undefined, dateOptions);
	}

	const date = new Date(str);
	if (isNaN(date.getTime())) return str;
	return date.toLocaleString(undefined, { ...dateOptions, hour: 'numeric', minute: '2-digit' });
}

/**
 *  Renders the installed/available-update version info shared by
 *  settings.html (Hub's own /ws/system feed) and device.html (a device's
 *  relayed settings tuples) -- same [key, {value,...}] tuple shape either
 *  way, so one function covers both.
 */
function renderVersionInfo(elementId, tuples) {
	const el = document.getElementById(elementId);
	if (!el || !Array.isArray(tuples)) return;

	const getValue = (key) => {
		const entry = tuples.find(([k]) => k === key);
		return entry ? entry[1].value : undefined;
	};

	const version = getValue('ndpi_version');
	const versionDate = getValue('ndpi_version_date');
	const updateAvailable = String(getValue('ndpi_version_update_available')) === 'true';
	const updateVersion = getValue('ndpi_version_update_version');
	const updateVersionDate = getValue('ndpi_version_update_version_date');

	if (!version) { el.innerHTML = ''; return; }

	let html = `Installed version: <strong>${version}</strong>`;
	if (versionDate) { html += ` (${formatHumanDate(versionDate)})`; }

	if (updateAvailable && updateVersion) {
		html += `<br>New version available: <strong>${updateVersion}</strong>`;
		if (updateVersionDate) { html += ` (${formatHumanDate(updateVersionDate)})`; }
	}

	el.innerHTML = html;
}

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
		const res = await fetch('/api/v2/setting/ui_theme_color');
		if (!res.ok) return;
		const data = await res.json();
		if (data && data.value) { applyThemeColor(data.value); }
	} catch (e) { /* offline / not-yet-connected -- cached value already applied */ }
}

async function saveThemeColor(hex) {
	applyThemeColor(hex);
	try {
		await fetch('/api/v2/setting', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'ui_theme_color', value: hex }),
		});
	} catch (e) { console.error('Failed to save theme color:', e); }
}

/**
 *  .topbar and .sidebar are `position: fixed` (see styles.css) so they
 *  stay put through page-level overscroll/rubber-band instead of
 *  drifting with it -- but that takes them out of normal flow, so
 *  .content needs compensating padding equal to their actual rendered
 *  size, or the fixed bars would just sit on top of (and hide) the first/
 *  last bit of content. --live-topbar-height / --live-bottombar-height
 *  (consumed by .content's padding, plus .floating-actions and
 *  .toast-container's bottom offset) exist because that size isn't a
 *  reliable constant: nominal `--header-height`/`--mobile-navbar-height`
 *  cover the common case, but a long page title, a long device name in
 *  the mobile bottom-bar nav, or a larger UI-scale setting can all make
 *  either bar's *real* height exceed its nominal estimate. Re-measured
 *  on load and whenever either bar's own box actually changes size, via
 *  ResizeObserver rather than a plain window 'resize' listener (only
 *  fires on real size changes, so it doesn't do wasted work on e.g. a
 *  width-only resize that leaves both bars' heights untouched) --
 *  runs independently of the account-loading IIFE below so layout is
 *  correct immediately, not after that async work resolves.
 *
 *  --live-bottombar-height is only ever the *bottom* bar's height, i.e.
 *  .sidebar's own size only counts on the <=860px breakpoint where it
 *  collapses into a horizontal bar docked to the bottom edge -- above
 *  that breakpoint .sidebar is a full-height left-hand column (.content
 *  already clears it horizontally via a static `margin-left:
 *  var(--sidebar-width)`, a value that's never subject to text-wrapping
 *  the way a height is), and using its (full viewport) height as bottom
 *  padding there would be wildly wrong.
 */
const MOBILE_BAR_QUERY = '(max-width: 860px)';

function syncFixedBarMetrics() {
	const topbarEl = document.querySelector('.topbar');
	const sidebarEl = document.querySelector('.sidebar');
	if (!topbarEl || !sidebarEl) return;

	const root = document.documentElement.style;
	root.setProperty('--live-topbar-height', `${topbarEl.offsetHeight}px`);

	const isBottomBar = window.matchMedia(MOBILE_BAR_QUERY).matches;
	root.setProperty('--live-bottombar-height', isBottomBar ? `${sidebarEl.offsetHeight}px` : '0px');

	// .sidebar is `width: fit-content` with --sidebar-width only as a
	// floor (min-width) now, not a fixed size -- it grows to fit whatever
	// its widest child (a nav label, the logo title, ...) actually needs.
	// .main/.topbar can't just read --sidebar-width for their own
	// left offset any more, since the real rendered width may be wider;
	// this publishes the true measured value for them to use instead.
	// Not meaningful in bottom-bar mode (mobile hardcodes .main/.topbar's
	// offset to 0 regardless), but harmless to keep measuring there too.
	root.setProperty('--live-sidebar-width', `${sidebarEl.offsetWidth}px`);
}

function initFixedBarMetrics() {
	const topbarEl = document.querySelector('.topbar');
	const sidebarEl = document.querySelector('.sidebar');
	if (!topbarEl || !sidebarEl) return;

	syncFixedBarMetrics();

	if (typeof ResizeObserver === 'function') {
		const observer = new ResizeObserver(syncFixedBarMetrics);
		observer.observe(topbarEl);
		observer.observe(sidebarEl);
	} else {
		window.addEventListener('resize', syncFixedBarMetrics);
	}

	// Crossing the responsive breakpoint changes which measurement
	// applies to --live-bottombar-height (see above) even on a tick
	// where neither element's own box size changes enough to fire
	// ResizeObserver on its own.
	window.matchMedia(MOBILE_BAR_QUERY).addEventListener('change', syncFixedBarMetrics);
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', initFixedBarMetrics);
} else {
	initFixedBarMetrics();
}

/**
 *  Desktop-only sidebar collapse/expand (icons-only vs. icons+labels),
 *  toggled by #sidebarToggle -- hidden on mobile via CSS (see styles.css),
 *  where the sidebar is a bottom bar and collapsing it isn't meaningful.
 *  Toggling is a pure CSS-variable swap (.app.sidebar-collapsed
 *  redefines --sidebar-width), so unlike syncFixedBarMetrics() above,
 *  this never needs to re-measure anything: collapsing/expanding changes
 *  .sidebar's *width*, not either fixed bar's *height*, so
 *  --live-topbar-height/--live-bottombar-height stay valid either way.
 */
const SIDEBAR_COLLAPSED_KEY = 'ndpi_sidebar_collapsed';

function applySidebarCollapsed(collapsed) {
	// On <html>, not .app -- so the inline <head> snippet (see every
	// page's <head>) can apply this before .app even exists in the DOM,
	// avoiding a flash-of-expanded-then-animate-to-collapsed on load.
	const toggleBtn = document.getElementById('sidebarToggle');

	document.documentElement.classList.toggle('sidebar-collapsed', collapsed);

	if (toggleBtn) {
		toggleBtn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
		const label = toggleBtn.querySelector('.nav-btn-label');
		if (label) { label.textContent = collapsed ? '' : ''; }
	}

	// Collapsing/expanding changes .sidebar's real width immediately --
	// ResizeObserver (see syncFixedBarMetrics()) picks this up on its own
	// shortly after, but re-syncing here too avoids even a single-frame
	// lag where .main/.topbar are still offset by the old width.
	if (typeof syncFixedBarMetrics === 'function') { syncFixedBarMetrics(); }
}

function initSidebarToggle() {
	const toggleBtn = document.getElementById('sidebarToggle');
	if (!toggleBtn) return;

	applySidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true');

	toggleBtn.addEventListener('click', () => {
		const collapsed = !document.documentElement.classList.contains('sidebar-collapsed');
		applySidebarCollapsed(collapsed);
		localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
	});
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', initSidebarToggle);
} else {
	initSidebarToggle();
}

/**
 *  :hover only ever reflects the cursor's literal position -- CSS has no
 *  way to time it out on its own, so a button/card that changes in place
 *  (Reboot -> "REBOOTING...", a toggled star, a card gaining .selected)
 *  or one the cursor is simply resting on and not moving is left looking
 *  stuck in its bright hover-highlighted look for as long as the cursor
 *  happens to sit still over it.
 *
 *  The only reliable cross-browser way to force :hover to clear from JS
 *  is to toggle `pointer-events: none` on the element for one frame --
 *  that removes it from hit-testing, which immediately clears :hover on
 *  it (the browser hands hover to whatever's underneath). Restoring
 *  pointer-events right after does NOT bring :hover back on its own --
 *  browsers only ever recompute hover targets on an actual pointer-move
 *  event, not merely because an element became hoverable again -- which
 *  is exactly the mechanism this needs: clearHoverVisual() below is the
 *  one place that does this, used by two separate triggers:
 *   - on click, immediately (a click that swaps the button's own label/
 *     disabled state should never wait for the idle timeout below), and
 *   - on a plain HOVER_TIMEOUT_MS of the cursor sitting still over any
 *     one element with no click at all -- tracked via mouseover (start
 *     the timer on a new target) / mousemove (reset it while still over
 *     the same target, so genuine movement -- even jitter -- keeps the
 *     hover alive) / mouseout (cancel it once the cursor actually
 *     leaves). Moving the mouse again after the timeout fires brings the
 *     hover look back on its own too -- once pointer-events is restored,
 *     the browser's native hover recompute on the next real mousemove
 *     handles that with no code needed here.
 *  A single set of delegated listeners on `document` (not per-element)
 *  covers every button/card/nav-item app-wide, present and future, with
 *  no per-page wiring needed.
 */
const HOVER_TIMEOUT_MS = 1500;
const HOVER_RESET_SELECTOR = 'button, a, select, .nav-btn, [class*="card"], [class*="tile"], [onclick]';

function clearHoverVisual(el) {
	if (!el) return;
	el.style.pointerEvents = 'none';
	// Double rAF (not a single one, or an arbitrary setTimeout) guarantees
	// at least one full paint has actually happened with pointer-events
	// off before it's restored, which is the reliable way to force this
	// across browsers.
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			el.style.pointerEvents = '';
		});
	});
}

function initHoverReset() {
	document.addEventListener('click', (e) => {
		const target = e.target.closest(HOVER_RESET_SELECTOR);
		if (target) { clearHoverVisual(target); }
	});

	let hoverTarget = null;
	let hoverTimer = null;

	const armHoverTimer = () => {
		clearTimeout(hoverTimer);
		hoverTimer = setTimeout(() => { clearHoverVisual(hoverTarget); }, HOVER_TIMEOUT_MS);
	};

	document.addEventListener('mouseover', (e) => {
		const target = e.target.closest(HOVER_RESET_SELECTOR);
		if (!target || target === hoverTarget) return;
		hoverTarget = target;
		armHoverTimer();
	});

	document.addEventListener('mousemove', () => {
		if (hoverTarget) { armHoverTimer(); }
	});

	document.addEventListener('mouseout', (e) => {
		if (hoverTarget && (!e.relatedTarget || !hoverTarget.contains(e.relatedTarget))) {
			clearTimeout(hoverTimer);
			hoverTarget = null;
		}
	});
}

initHoverReset();

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
		userAccountNavEl.innerHTML = `${NAV_ACCOUNT_ICON}<span class="nav-btn-label">${String(account.username).toUpperCase()}</span>`;
		userAccountNavEl.addEventListener('click', function (e) {
			this.onclick = null;
			e.preventDefault();
			window.location.href = '/account-settings.html';
		});
	}
}

function applyActiveNav(element) {
	if (!element) return;
	const el = document.getElementById(element);
	if (!el) return;
	el.classList.add('active');
	// On mobile, .sidebar-nav (the button row) scrolls horizontally on its
	// own -- .sidebar-footer (the account/user icon) sits outside that
	// scroll area, so a button further down the list (e.g. Settings) can
	// land scrolled out of view underneath it. { block: 'nearest', inline:
	// 'nearest' } scrolls only .sidebar-nav just enough to reveal it,
	// without touching the page's own scroll position -- a no-op on
	// desktop, where .sidebar-nav doesn't overflow.
	el.scrollIntoView({ block: 'nearest', inline: 'center' });
}


function addTouchScrollEventListener() {
	const list = document.querySelector('.content');
	if (!list) return;

	list.addEventListener('touchstart', (e) => {
		document.body.style.cursor = 'none';
	});

	list.addEventListener('touchmove', (e) => {
		document.body.style.cursor = 'none';
	});

	list.addEventListener('touchend', () => {
		setTimeout(() => {
			document.body.style.removeProperty('cursor');
		}, 100);
	});
}
addTouchScrollEventListener();