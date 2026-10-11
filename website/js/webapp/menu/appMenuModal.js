/**
 * Modal displayed above the menu screens: confirmation, information, loading
 * and error. A subclass adds its own kinds through the protected shell and
 * buttons-row helpers.
 */
class AppMenuModal {
    /**
     * @param {AppMenuDisplay} display
     */
    constructor(display) {
        this._display = display;
        this._overlay = null;
        this._nav     = null;
    }

    /**
     * @param {string}      message
     * @param {function}    onConfirm
     * @param {string|null} confirmLabel
     * @param {string|null} cancelLabel
     */
    confirm(message, onConfirm, confirmLabel = null, cancelLabel = null) {
        AppMenuSound.play(AppMenuSound.PROMPT);
        confirmLabel = (confirmLabel ?? appTranslator.get('menu.confirm'));
        cancelLabel  = (cancelLabel ?? appTranslator.get('menu.cancel'));

        const {modal} = this._createShell(message, 'app-menu-modal', 'app-menu-modal-message');

        const actions = AppMenuDom.addElement(modal, 'div', 'app-menu-modal-actions');

        const cancelButton = AppMenuDom.addButton(actions, 'app-menu-button app-menu-button-secondary', cancelLabel, () => {
            this.close();
        });

        const confirmButton = AppMenuDom.addButton(actions, 'app-menu-button', confirmLabel, () => {
            this.close();
            onConfirm();
        });

        // Confirm preselected (the user just asked for the action); every
        // back input plays the cancel button.
        this._attachButtonsNav([cancelButton, confirmButton], cancelButton, 1);
        this._dismissOnOverlayClick(() => this.close());

        return this;
    }

    /**
     * Loading modal: pulsing message, without buttons and not closable by
     * clicking. Closed programmatically via close().
     *
     * @param {string} message
     */
    showLoading(message) {
        this._createShell(message, 'app-menu-modal',
            'app-menu-modal-message app-menu-modal-loading');

        return this;
    }

    /**
     * Information modal: a message and a single "Back" button. The overlay
     * click dismisses it too.
     *
     * @param {string}        message
     * @param {function|null} onClose
     */
    info(message, onClose = null) {
        const {modal} = this._createShell(message, 'app-menu-modal', 'app-menu-modal-message');

        const actions = AppMenuDom.addElement(modal, 'div', 'app-menu-modal-actions');
        const dismiss = () => {
            this.close();
            if (onClose !== null) {
                onClose();
            }
        };

        const button = AppMenuDom.addButton(actions, 'app-menu-button', appTranslator.get('menu.back'), dismiss);
        this._attachButtonsNav([button], button, 0);
        this._dismissOnOverlayClick(dismiss);

        return this;
    }

    /**
     * Error modal: a prominent centred message plus an optional technical detail
     * (e.g. the top of a stack trace) and a single dismiss button.
     *
     * @param {string}      message
     * @param {string|null} detail
     * @param {function}    onClose
     */
    showError(message, detail, onClose) {
        const {modal} = this._createShell(message, 'app-menu-modal app-menu-modal-wide', 'app-menu-modal-message app-menu-modal-error');

        if (detail) {
            AppMenuDom.addText(modal, 'app-menu-modal-detail', detail);
        }

        const actions = AppMenuDom.addElement(modal, 'div', 'app-menu-modal-actions');

        const button = AppMenuDom.addButton(actions, 'app-menu-button', appTranslator.get('menu.close'), () => {
            this.close();
            onClose();
        });
        this._attachButtonsNav([button], button, 0);

        return this;
    }

    close() {
        this._removeShell();

        return this;
    }

    // --- Internal ---

    _removeShell() {
        if (this._nav !== null) {
            this._nav.detach().clear();
        }
        if (this._overlay !== null) {
            this._overlay.remove();
            this._overlay = null;
        }
    }

    // Overlays stack in the display container: only the top-most one may
    // react to inputs (a nested confirmation suspends the modal beneath it).
    _isTopOverlay() {
        if (this._overlay === null) {
            return false;
        }

        return AppMenuDom.isTopOverlay(this._display.getContainer(), this._overlay);
    }

    _dismissOnOverlayClick(action) {
        this._overlay.addEventListener('click', (event) => {
            if (event.target === this._overlay) {
                action();
            }
        });
    }

    // Horizontal navigation over a buttons row (Left/Right + hover select,
    // Enter/pad-validate clicks, every back input plays backButton).
    _attachButtonsNav(buttons, backButton, selectedIndex) {
        this._nav = new AppMenuListNavigation(() => backButton.click(), () => !this._isTopOverlay())
            .setEscapeAsBack(true)
            .setHorizontal(true);
        for (const button of buttons) {
            this._nav.addButtonItem(button);
        }
        this._nav.attach().selectIndex(selectedIndex);
    }

    // A re-render replaces the shell without closing the modal: its stacked
    // children and its owner's close hook are left alone.
    _createShell(message, modalClass, messageClass) {
        this._removeShell();

        this._overlay = AppMenuDom.addElement(this._display.getContainer(), 'div', 'app-menu-overlay');
        const modal = AppMenuDom.addElement(this._overlay, 'div', modalClass);
        const messageEl = AppMenuDom.addText(modal, messageClass, message);

        return {modal: modal, messageEl: messageEl};
    }
}
