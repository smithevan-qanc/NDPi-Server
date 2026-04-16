class Modal {
	constructor() {
		this.activeModal = null;
		this.initStyles();
	}

	initStyles() {
		if (document.getElementById('modal-styles')) return;
		
		const style = document.createElement('style');
		style.id = 'modal-styles';
		style.textContent = `
			.modal-overlay {
				display: none;
				position: fixed;
				top: 0;
				left: 0;
				right: 0;
				bottom: 0;
				background: rgba(0, 0, 0, 0.7);
				backdrop-filter: blur(8px);
				-webkit-backdrop-filter: blur(8px);
				z-index: 10000;
				align-items: center;
				justify-content: center;
				padding: 20px;
				animation: fadeIn 0.2s ease;
			}
			
			.modal-overlay.active {
				display: flex;
			}
			
			@keyframes fadeIn {
				from { opacity: 0; }
				to { opacity: 1; }
			}
			
			.modal-box {
				background: #2a2a2a;
				border-radius: 12px;
				padding: 24px;
				max-width: 500px;
				width: 100%;
				box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
				animation: slideUp 0.3s ease;
			}
			
			@keyframes slideUp {
				from { 
					transform: translateY(20px);
					opacity: 0;
				}
				to { 
					transform: translateY(0);
					opacity: 1;
				}
			}
			
			.modal-title {
				font-size: 20px;
				font-weight: 600;
				color: #fff;
				margin-bottom: 16px;
			}
			
			.modal-message {
				font-size: 16px;
				color: rgba(255, 255, 255, 0.8);
				margin-bottom: 16px;
				padding-left: 8px;
				line-height: 1.5;
			}
			
			.modal-input {
				width: 100%;
				padding: 14px;
				font-size: 16px;
				background: #1a1a1a;
				border: 2px solid #444;
				border-radius: 8px;
				color: #fff;
				margin-bottom: 20px;
				box-sizing: border-box;
				font-family: inherit;
			}
			
			.modal-input:focus {
				outline: none;
				border-color: rgb(129, 193, 39);
			}
			
			.modal-buttons {
				display: flex;
				gap: 12px;
				justify-content: flex-end;
			}
			
			.modal-button {
				padding: 14px 24px;
				font-size: 16px;
				font-weight: 500;
				border: none;
				border-radius: 8px;
				cursor: pointer;
				font-family: inherit;
				transition: all 0.2s ease;
				min-width: 100px;
			}
			
			.modal-button-primary {
				background: rgb(129, 193, 39);
				color: #fff;
			}
			
			.modal-button-primary:active {
				background: #1a8cd9;
			}
			
			.modal-button-danger {
				background: #e74c3c;
				color: #fff;
			}
			
			.modal-button-danger:active {
				background: #c0392b;
			}
			
			.modal-button-secondary {
				background: #444;
				color: #fff;
			}
			
			.modal-button-secondary:active {
				background: #333;
			}
			
			/* Select/option list styling */
			.modal-options {
				max-height: 300px;
				overflow-y: auto;
				margin-bottom: 20px;
			}
			
			.modal-option {
				padding: 16px;
				background: #1a1a1a;
				border: 2px solid #444;
				border-radius: 8px;
				margin-bottom: 8px;
				cursor: pointer;
				color: #fff;
				font-size: 16px;
				transition: all 0.2s ease;
			}
			
			.modal-option:active {
				background: rgb(129, 193, 39);
				border-color: rgb(129, 193, 39);
			}
			
			.modal-option.selected {
				background: rgb(129, 193, 39);
				border-color: rgb(129, 193, 39);
			}
		`;
		document.head.appendChild(style);
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
		this.initStyles();
	}

	initStyles() {
		if (document.getElementById('toast-styles')) return;
		
		const style = document.createElement('style');
		style.id = 'toast-styles';
		style.textContent = `
			.toast-container {
				position: fixed;
				top: 100px;
				left: 50%;
				transform: translateX(-50%);
				z-index: 9998;
				display: flex;
				flex-direction: column-reverse;
				gap: 20px;
				pointer-events: none;
				transition: all 1s ease;
			}
			
			.toast {
				background: #2a2a2a;
				color: #fff;
				padding: 14px 24px;
				border-radius: 10px;
				font-size: 15px;
				box-shadow: 0 8px 20px rgba(0, 0, 0, 0.7);
				display: flex;
				align-items: center;
				gap: 10px;
				animation: toastIn 0.4s ease, toastOut 0.5s ease-out forwards;
				animation-delay: 0s, var(--toast-duration, 2s);
				pointer-events: auto;
				max-width: 90vw;
				min-width: clamp(70vw, 400px, 50vw);
				transition: all 1s ease;
			}
			
			.toast-success {
				border-left: 8px solid #4ade80;
			}
			
			.toast-error {
				border-left: 8px solid #e74c3c;
			}
			
			.toast-info {
				border-left: 8px solid #5e5e5e;
			}
			
			.toast-warning {
				border-left: 8px solid #f59e0b;
			}
			
			.toast-icon {
				font-size: 18px;
				flex-shrink: 0;
			}
			
			@keyframes toastIn {
				from {
					transform: translateX(20px);
					opacity: 0;
				}
				to {
					transform: translateX(0);
					opacity: 1;
				}
			}
			
			@keyframes toastOut {
				from {
					transform: translateX(0);
					opacity: 1;
				}
				to {
					transform: translateX(-20px);
					opacity: 0;
				}
			}
		`;
		document.head.appendChild(style);
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
		
		const toast = document.createElement('div');
		toast.className = `toast toast-${type}`;
		toast.style.setProperty('--toast-duration', `${duration / 1000}s`);
		
		const icons = {
			success: '✓',
			error: '✕',
			info: 'ℹ',
			warning: '⚠'
		};
		
		toast.innerHTML = `
			<span class="toast-icon">${icons[type] || icons.info}</span>
			<span>${message}</span>
		`;
		
		container.appendChild(toast);
		
		// Remove after animation completes
		setTimeout(() => {
			toast.remove();
		}, duration + 300);
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