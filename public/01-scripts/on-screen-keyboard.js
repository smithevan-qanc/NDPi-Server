/**
 * Custom on-screen keyboard for the Hub's touch-display kiosk. Chromium's
 * own kiosk mode never shows the native OS on-screen keyboard, so text
 * inputs are otherwise untypeable on a touch-only kiosk display.
 *
 * Deliberately triggered from `touchstart` on a text input, not `focus` --
 * focus fires for a mouse click too, and a real touch is the only thing
 * that should raise this (a mouse is assumed to have a real keyboard
 * attached). Also does nothing at all in the app's existing mobile
 * breakpoint (see OSK_MOBILE_QUERY below): an actual phone/tablet also
 * delivers touchstart, but its own native on-screen keyboard already works
 * fine there -- only the kiosk's suppressed one needs this.
 *
 * Self-contained and self-initializing (no dependency on functions.js/
 * auth.js, since auth-flow pages like sign-in.html/set-pin.html don't load
 * those but still have text inputs that need this) -- just including the
 * <script> tag is enough, it wires up document-level listeners on its own.
 */
(function () {
	'use strict';

	// Same breakpoint as 01-scripts/functions.js's MOBILE_BAR_QUERY / the
	// (max-width: 53.75rem) breakpoint in styles.css -- kept as a literal
	// copy rather than a shared reference, since this script must work on
	// pages that don't load functions.js at all.
	const OSK_MOBILE_QUERY = '(max-width: 860px)';

	const TEXT_INPUT_SELECTOR = [
		'input[type="text"]', 'input[type="password"]', 'input[type="number"]',
		'input[type="email"]', 'input[type="search"]', 'input[type="tel"]',
		'input[type="url"]', 'input:not([type])', 'textarea'
	].join(', ');

	function isMobileMode() {
		return window.matchMedia(OSK_MOBILE_QUERY).matches;
	}

	let keyboardEl = null;
	let activeInput = null;
	let shiftActive = false;

	const ROWS = [
		['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
		['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
		['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
		['shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', 'backspace'],
	];

	const NUMPAD_KEYS = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', 'numpad-backspace'];

	function keyLabel(key) {
		switch (key) {
			case 'shift': return '&#8679;';
			case 'backspace': return '&#9003;';
			case 'numpad-backspace': return '&#9003;';
			default: return shiftActive ? key.toUpperCase() : key;
		}
	}

	function buildKeyboard() {
		const el = document.createElement('div');
		el.id = 'onScreenKeyboard';

		const rowsHtml = ROWS.map((row) => {
			const keysHtml = row.map((key) => {
				const classes = ['osk-key'];
				if (key === 'backspace') classes.push('osk-key-wide');
				if (key === 'shift') { classes.push('osk-key-wide', 'osk-key-shift'); }
				return `<button type="button" class="${classes.join(' ')}" data-key="${key}">${keyLabel(key)}</button>`;
			}).join('');
			return `<div class="osk-row">${keysHtml}</div>`;
		}).join('');

		const numpadHtml = `
			<div class="osk-numpad">
				${NUMPAD_KEYS.map((key) => `<button type="button" class="osk-key" data-key="${key}">${keyLabel(key)}</button>`).join('')}
			</div>
		`;

		el.innerHTML = `
			<div class="osk-header">
				<button type="button" class="osk-hide-btn" data-key="hide" aria-label="Hide keyboard">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M6 9l6 6 6-6" />
					</svg>
				</button>
			</div>
			<div class="osk-body">
				<div class="osk-qwerty">
					${rowsHtml}
					<div class="osk-row osk-row-bottom">
						<button type="button" class="osk-key osk-key-space" data-key="space">Space</button>
						<button type="button" class="osk-key osk-key-enter" data-key="enter">Enter</button>
					</div>
				</div>
				${numpadHtml}
			</div>
		`;

		document.body.appendChild(el);

		// pointerdown (not click) + preventDefault so tapping a key never
		// blurs the active input -- the input stays focused (visible
		// cursor/selection) for the whole typing session, and there's no
		// need to separately re-focus it after every key.
		el.addEventListener('pointerdown', (e) => {
			const btn = e.target.closest('[data-key]');
			if (!btn) return;
			e.preventDefault();
			handleKey(btn.dataset.key);
		});

		return el;
	}

	function refreshKeyLabels() {
		if (!keyboardEl) return;
		keyboardEl.querySelectorAll('[data-key]').forEach((btn) => {
			const key = btn.dataset.key;
			if (key.length === 1) { btn.innerHTML = keyLabel(key); }
		});
		keyboardEl.querySelector('.osk-key-shift')?.classList.toggle('osk-key-shift-active', shiftActive);
	}

	// selectionStart/selectionEnd throw on some input types (number, email
	// with multiple, etc) -- fall back to "cursor at the end" there instead
	// of letting the whole keypress handler throw.
	function getSelection(input) {
		try {
			return { start: input.selectionStart, end: input.selectionEnd };
		} catch (e) {
			return { start: input.value.length, end: input.value.length };
		}
	}

	function setSelection(input, pos) {
		try { input.setSelectionRange(pos, pos); } catch (e) { /* unsupported on this input type */ }
	}

	function fireInputEvent(input) {
		input.dispatchEvent(new Event('input', { bubbles: true }));
	}

	function insertText(input, text) {
		const { start, end } = getSelection(input);
		const value = input.value;
		let next = value.slice(0, start) + text + value.slice(end);
		let cursor = start + text.length;

		if (input.maxLength >= 0 && next.length > input.maxLength) {
			next = next.slice(0, input.maxLength);
			cursor = Math.min(cursor, input.maxLength);
		}

		input.value = next;
		setSelection(input, cursor);
		fireInputEvent(input);
	}

	function backspace(input) {
		const { start, end } = getSelection(input);
		const value = input.value;
		if (start === end) {
			if (start === 0) return;
			input.value = value.slice(0, start - 1) + value.slice(end);
			setSelection(input, start - 1);
		} else {
			input.value = value.slice(0, start) + value.slice(end);
			setSelection(input, start);
		}
		fireInputEvent(input);
	}

	function handleKey(key) {
		if (!activeInput) return;

		switch (key) {
			case 'shift':
				shiftActive = !shiftActive;
				refreshKeyLabels();
				return;
			case 'backspace':
			case 'numpad-backspace':
				backspace(activeInput);
				return;
			case 'space':
				insertText(activeInput, ' ');
				return;
			case 'hide':
				hide(true);
				return;
			case 'enter': {
				const form = activeInput.form;
				if (form) {
					if (typeof form.requestSubmit === 'function') { form.requestSubmit(); }
					else { form.submit(); }
				} else {
					hide(true);
				}
				return;
			}
			default: {
				const char = shiftActive ? key.toUpperCase() : key;
				insertText(activeInput, char);
				if (shiftActive && /[a-z]/i.test(key)) {
					// Auto-revert after one letter, like a phone keyboard --
					// digits/punctuation don't consume the shift state.
					shiftActive = false;
					refreshKeyLabels();
				}
				return;
			}
		}
	}

	// Nearest scrollable ancestor of `el`, so the keyboard's "scroll the
	// input into view" behavior works both on the app shell's fixed-bar
	// pages (.content is the real scrolling region there, not the page
	// itself) and on auth-flow pages with no such wrapper (falls back to
	// the page's own scrolling element).
	function findScrollableAncestor(el) {
		let node = el.parentElement;
		while (node && node !== document.body) {
			const style = getComputedStyle(node);
			if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
				return node;
			}
			node = node.parentElement;
		}
		return document.scrollingElement || document.documentElement;
	}

	function positionKeyboard(input) {
		const margin = 12;
		const rect = input.getBoundingClientRect();
		const kbHeight = keyboardEl.offsetHeight;
		const kbWidth = keyboardEl.offsetWidth;
		const viewportHeight = window.innerHeight;
		const viewportWidth = window.innerWidth;

		const desiredTop = rect.bottom + margin;
		const overflowBelow = (desiredTop + kbHeight) - viewportHeight;

		if (overflowBelow > 0) {
			// Not enough room below -- scroll the input up just enough
			// instead of flipping the keyboard above it (always shows
			// directly under the touched field, per design).
			const scroller = findScrollableAncestor(input);
			scroller.scrollBy({ top: overflowBelow + margin, behavior: 'smooth' });
			// Reposition once the smooth scroll has had time to settle --
			// rect is stale until then.
			setTimeout(() => { if (keyboardEl.classList.contains('osk-visible')) { positionKeyboard(input); } }, 260);
		}

		const top = Math.min(desiredTop, viewportHeight - kbHeight - margin);
		let left = rect.left + rect.width / 2 - kbWidth / 2;
		left = Math.max(margin, Math.min(left, viewportWidth - kbWidth - margin));

		keyboardEl.style.top = `${Math.max(margin, top)}px`;
		keyboardEl.style.left = `${left}px`;
	}

	function show(input) {
		if (!keyboardEl) { keyboardEl = buildKeyboard(); }
		activeInput = input;
		shiftActive = false;
		refreshKeyLabels();
		keyboardEl.classList.add('osk-visible');
		// offsetHeight/offsetWidth below (via positionKeyboard) need a
		// layout pass with the keyboard actually laid out first -- it's
		// already `display: flex` at all times (see styles.css), only
		// opacity/pointer-events toggle with .osk-visible, so this is safe
		// to measure immediately rather than waiting a frame.
		positionKeyboard(input);
	}

	function hide(blur) {
		if (!keyboardEl) return;
		keyboardEl.classList.remove('osk-visible');
		if (blur && activeInput) { activeInput.blur(); }
		activeInput = null;
	}

	document.addEventListener('touchstart', (e) => {
		if (isMobileMode()) return;

		if (keyboardEl && e.target.closest('#onScreenKeyboard')) {
			// Handled by the keyboard's own pointerdown handler -- just
			// don't let this fall through to the outside-tap dismiss logic.
			return;
		}

		const input = e.target.closest(TEXT_INPUT_SELECTOR);
		if (input) {
			show(input);
		} else if (keyboardEl && keyboardEl.classList.contains('osk-visible')) {
			hide(true);
		}
	}, { passive: true });

	window.addEventListener('resize', () => {
		if (isMobileMode()) { hide(true); return; }
		if (keyboardEl && keyboardEl.classList.contains('osk-visible') && activeInput) {
			positionKeyboard(activeInput);
		}
	});
})();
