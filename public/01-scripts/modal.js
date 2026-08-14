class Modal {
	constructor() {
		this.activeModal = null;
	}

	show(config) {
		return new Promise((resolve) => {
			// Remove any existing modal
			this.close();

			// Create overlay
			const overlay = document.createElement('div');
			overlay.className = 'modal-overlay';
			
			// Create modal box
			const box = document.createElement('div');
			box.className = 'modal-box';
			
			// Title
			if (config.title) {
				const title = document.createElement('div');
				title.className = 'modal-title';
				title.textContent = config.title;
				box.appendChild(title);
			}
			
			// Message
			if (config.message) {
				const message = document.createElement('div');
				message.className = 'modal-message';
				message.innerHTML = config.message;
				box.appendChild(message);
			}
			
			// Input field (only for prompt type, not select)
			let input = null;
			if (config.type === 'prompt') {
				input = document.createElement('input');
				input.className = 'modal-input';
				input.type = config.inputType || 'text';
				input.placeholder = config.placeholder || '';
				input.value = config.defaultValue || '';
				
				// Touch keyboard support
				if (config.inputMode) {
					input.inputMode = config.inputMode;
				} else if (config.inputType === 'number') {
					input.inputMode = 'numeric';
				} else {
					input.inputMode = 'text';
				}
				
				box.appendChild(input);
				input.select();
			}
			
			// Options list (for select-style prompts)
			let selectedOption = null;
			if (config.options && Array.isArray(config.options)) {
				const optionsContainer = document.createElement('div');
				optionsContainer.className = 'modal-options';
				
				config.options.forEach((option, index) => {
					const optionEl = document.createElement('div');
					optionEl.className = 'modal-option';
					// Support both string options and {value, label} objects
					const label = typeof option === 'object' ? option.label : option;
					const value = typeof option === 'object' ? option.value : option;
					optionEl.textContent = label;
					optionEl.dataset.value = value;
					
					// Pre-select if matches defaultValue
					if (config.defaultValue !== undefined && value === config.defaultValue) {
						optionEl.classList.add('selected');
						selectedOption = value;
					}
					
					optionEl.onclick = () => {
						// Deselect all
						optionsContainer.querySelectorAll('.modal-option').forEach(el => {
							el.classList.remove('selected');
						});
						// Select this one
						optionEl.classList.add('selected');
						selectedOption = value;
					};
					optionsContainer.appendChild(optionEl);
				});
				
				box.appendChild(optionsContainer);
			}
			
			// Buttons
			const buttons = document.createElement('div');
			buttons.className = 'modal-buttons';
			
			if (config.type === 'confirm') {
				const cancelBtn = document.createElement('button');
				cancelBtn.className = 'modal-button modal-button-secondary';
				cancelBtn.textContent = config.cancelText || 'Cancel';
				cancelBtn.onclick = () => {
					this.close();
					resolve(false);
				};
				buttons.appendChild(cancelBtn);
				
				const confirmBtn = document.createElement('button');
				confirmBtn.className = `modal-button ${config.danger ? 'modal-button-danger' : 'modal-button-primary'}`;
				confirmBtn.textContent = config.confirmText || 'Confirm';
				confirmBtn.onclick = () => {
					this.close();
					resolve(true);
				};
				buttons.appendChild(confirmBtn);
			} else if (config.type === 'select') {
				const cancelBtn = document.createElement('button');
				cancelBtn.className = 'modal-button modal-button-secondary';
				cancelBtn.textContent = config.cancelText || 'Cancel';
				cancelBtn.onclick = () => {
					this.close();
					resolve(null);
				};
				buttons.appendChild(cancelBtn);
				
				const okBtn = document.createElement('button');
				okBtn.className = 'modal-button modal-button-primary';
				okBtn.textContent = config.confirmText || 'Select';
				okBtn.onclick = () => {
					this.close();
					resolve(selectedOption);
				};
				buttons.appendChild(okBtn);
			} else if (config.type === 'prompt') {
				const cancelBtn = document.createElement('button');
				cancelBtn.className = 'modal-button modal-button-secondary';
				cancelBtn.textContent = config.cancelText || 'Cancel';
				cancelBtn.onclick = () => {
					this.close();
					resolve(null);
				};
				buttons.appendChild(cancelBtn);
				
				const okBtn = document.createElement('button');
				okBtn.className = 'modal-button modal-button-primary';
				okBtn.textContent = config.confirmText || 'OK';
				okBtn.onclick = () => {
					const value = input ? input.value : (selectedOption !== null ? selectedOption : null);
					this.close();
					resolve(value);
				};
				buttons.appendChild(okBtn);
				
				// Submit on Enter
				if (input) {
					input.addEventListener('keydown', (e) => {
						if (e.key === 'Enter') {
							this.close();
							resolve(input.value);
						}
					});
				}
			} else {
				// Alert - just OK button
				const okBtn = document.createElement('button');
				okBtn.className = 'modal-button modal-button-primary';
				okBtn.textContent = 'OK';
				okBtn.onclick = () => {
					this.close();
					resolve(true);
				};
				buttons.appendChild(okBtn);
			}
			
			box.appendChild(buttons);
			overlay.appendChild(box);
			document.body.appendChild(overlay);
			
			// Click outside to close (for cancellable modals)
			if (config.type !== 'alert' || config.cancellable) {
				overlay.onclick = (e) => {
					if (e.target === overlay) {
						this.close();
						resolve(config.type === 'confirm' ? false : null);
					}
				};
			}
			
			// Prevent clicks inside box from closing
			box.onclick = (e) => {
				e.stopPropagation();
			};
			
			// Show modal
			requestAnimationFrame(() => {
				overlay.classList.add('active');
			});
			
			// Focus input if present
			if (input) {
				setTimeout(() => input.focus(), 100);
			}
			
			this.activeModal = overlay;
		});
	}

	close() {
		if (this.activeModal) {
			this.activeModal.remove();
			this.activeModal = null;
		}
	}

	// Convenience methods
	alert(message, title = '') {
		return this.show({
			type: 'alert',
			title: title || 'Notice',
			message: message
		});
	}

	confirm(message, title = '', options = {}) {
		return this.show({
			type: 'confirm',
			title: title || 'Confirm',
			message: message,
			danger: options.danger || false,
			confirmText: options.confirmText,
			cancelText: options.cancelText
		});
	}

	prompt(message, defaultValue = '', title = '', options = {}) {
		return this.show({
			type: 'prompt',
			title: title || 'Input Required',
			message: message,
			defaultValue: defaultValue,
			placeholder: options.placeholder,
			inputType: options.inputType,
			inputMode: options.inputMode,
			confirmText: options.confirmText,
			cancelText: options.cancelText
		});
	}

	select(message, options, defaultValue = null, title = '', additional = {}) {
		return this.show({
			type: 'select',
			title: title || 'Select an Option',
			message: message,
			options: options,
			defaultValue: defaultValue,
			confirmText: additional?.confirmText,
			cancelText: additional?.cancelText
		});
	}

	custom(htmlContent, title = '', options = {}) {
		return new Promise((resolve) => {
			const overlay = document.createElement('div');
			overlay.className = 'modal-overlay';
			
			const box = document.createElement('div');
			box.className = 'modal-box';
			
			// Title
			if (title) {
				const titleEl = document.createElement('div');
				titleEl.className = 'modal-title';
				titleEl.textContent = title;
				box.appendChild(titleEl);
			}
			
			// Custom HTML content
			const contentDiv = document.createElement('div');
			contentDiv.innerHTML = htmlContent;
			contentDiv.style.marginBottom = '20px';
			box.appendChild(contentDiv);
			
			// Buttons
			const buttons = document.createElement('div');
			buttons.className = 'modal-buttons';
			
			const cancelBtn = document.createElement('button');
			cancelBtn.className = 'modal-button modal-button-secondary';
			cancelBtn.textContent = options.cancelText || 'Cancel';
			cancelBtn.onclick = () => {
				this.close();
				resolve(false);
			};
			buttons.appendChild(cancelBtn);
			
			const confirmBtn = document.createElement('button');
			confirmBtn.className = `modal-button ${options.danger ? 'modal-button-danger' : 'modal-button-primary'}`;
			confirmBtn.textContent = options.confirmText || 'OK';
			confirmBtn.onclick = () => {
				this.close();
				resolve(true);
			};
			buttons.appendChild(confirmBtn);
			
			box.appendChild(buttons);
			overlay.appendChild(box);
			document.body.appendChild(overlay);
			
			// Click outside to close
			overlay.onclick = (e) => {
				if (e.target === overlay) {
					this.close();
					resolve(false);
				}
			};
			
			// Prevent clicks inside box from closing
			box.onclick = (e) => {
				e.stopPropagation();
			};
			
			// Show modal
			requestAnimationFrame(() => {
				overlay.classList.add('active');
				if (options.onOpen) {
					options.onOpen();
				}
			});
			
			this.activeModal = overlay;
		});
	}
}

// Create global modal instance
const modal = new Modal();

// Toast notification system for passive messages
class Toast {
	constructor() {
		this.container = null;
		// The one toast currently shown (if any) plus its auto-dismiss timer,
		// so a new toast() call can interrupt it instead of stacking beside it.
		this.currentToast = null;
		this.currentTimeout = null;
	}

	getContainer() {
		if (!this.container || !document.body.contains(this.container)) {
			this.container = document.createElement('div');
			this.container.className = 'toast-container';
			document.body.appendChild(this.container);
		}
		return this.container;
	}

	show(message, type = 'info', duration = 4000) {
		const container = this.getContainer();

		// Only one toast at a time -- motion the previous one out instead of
		// letting it sit alongside the new one.
		if (this.currentToast) {
			clearTimeout(this.currentTimeout);
			this.dismiss(this.currentToast);
		}

		const toastEl = document.createElement('div');
		toastEl.className = `toast toast-${type}`;

		const icons = {
			success: '✓',
			error: '✕',
			info: 'ℹ',
			warning: '⚠'
		};

		toastEl.innerHTML = `
			<span class="toast-icon">${icons[type] || icons.info}</span>
			<span>${message}</span>
		`;

		container.appendChild(toastEl);
		this.currentToast = toastEl;

		this.currentTimeout = setTimeout(() => {
			this.dismiss(toastEl);
		}, duration);
	}

	// Plays the exit animation, then removes the element once it finishes --
	// used both for a toast's own natural timeout and for interrupting one
	// early when a new toast replaces it.
	dismiss(toastEl) {
		if (this.currentToast === toastEl) { this.currentToast = null; }
		toastEl.classList.add('toast-exiting');
		toastEl.addEventListener('animationend', () => toastEl.remove(), { once: true });
	}

	success(message, duration = 3000) {
		this.show(message, 'success', duration);
	}

	error(message, duration = 8000) {
		this.show(message, 'error', duration);
	}

	info(message, duration = 8000) {
		this.show(message, 'info', duration);
	}

	warning(message, duration = 10000) {
		this.show(message, 'warning', duration);
	}
}

// Create global toast instance
const toast = new Toast();


function showCustomMenu(event, elId) {
	const customMenu = document.getElementById(elId);
	if (customMenu) {
		event.preventDefault();
		customMenu.style.top = `${event.pageY}px`;
		customMenu.style.left = `${event.pageX}px`;
		customMenu.classList.add('active');
		//ustomMenu.setAttribute('data-val', dataVal);
	}
}

function hideCustomMenu() {
	const customMenu = document.querySelectorAll('.context-menu');
	//const customMenu = document.getElementById("customMenu");
	//customMenu.classList.remove('active');
	customMenu.forEach(el => {
		el.classList.remove('active');
		//el.removeAttribute('data-val');
	});
}

document.addEventListener("click", function(e) {
	const customMenu = document.querySelectorAll('.context-menu');
	//const customMenu = document.getElementById("customMenu");
	/*
	if (!customMenu.contains(e.target)) {
		hideCustomMenu();
	}
	*/
	customMenu.forEach(menu => {
		if (!menu.contains(e.target)) {
			hideCustomMenu();
		}
	});
});

function buildContext_Source(event, sourceItem) {
	const menu = document.getElementById('customMenu-source');

	if (menu) {

		let menuItem_select = document.getElementById('menuItem_selectSource');
		if (!menuItem_select) {
			menuItem_select = document.createElement('div');
			menuItem_select.id = 'menuItem_selectSource';
			menuItem_select.className = 'menu-item';
			menu.appendChild(menuItem_select);
		}
		menuItem_select.innerText = `Select: ${sourceItem}`;
		menuItem_select.onclick = null;
		menuItem_select.onclick = () => {
			selectSource(sourceItem);
			hideCustomMenu();
		};
	}
	showCustomMenu(event, 'customMenu-source');
}