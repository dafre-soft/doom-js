/**
 * Base of the list-carrying modals (settings, a pause menu…): one
 * AppMenuListNavigation wired to the back action and the top-overlay rule, the
 * onClose contract fired on a real close, and the shared wide shell (title,
 * scrollable body, bottom action button joined to the navigation).
 */
class AppMenuAbstractListModal extends AppMenuModal {
    /**
     * @param {AppMenuDisplay} display
     */
    constructor(display) {
        super(display);

        this._nav = new AppMenuListNavigation(() => this._onBack(), () => this._navBlocked())
            .setEscapeAsBack(true);
        this._onClose = null;
    }

    /**
     * Hook fired once the modal is closed. The screen underneath is NOT
     * rebuilt while the modal covers it, so a setting changed here would
     * leave it stale: its owner re-renders it from here.
     *
     * @param {function|null} callback
     */
    setOnClose(callback) {
        this._onClose = callback;

        return this;
    }

    close() {
        // The owner's onClose only makes sense after a real display.
        const wasOpen = (this._overlay !== null);

        this._teardown();
        super.close();

        if (wasOpen && (this._onClose !== null)) {
            this._onClose();
        }

        return this;
    }

    // Wide list shell: subtitle-styled title, scrollable body, bottom actions
    // row joined to the navigation. With a confirmation ({label, action}) the
    // row centres [back] [confirmation], styled like a confirm modal's.
    _openShell(title, buttonLabel, confirmation = null) {
        const {modal, messageEl} = this._createShell(title,
            'app-menu-modal app-menu-modal-wide app-menu-modal-list', 'app-menu-subtitle');
        const bodyEl  = AppMenuDom.addElement(modal, 'div', 'app-menu-modal-list-body');
        const actions = AppMenuDom.addElement(modal, 'div', 'app-menu-modal-actions');
        const button  = AppMenuDom.addButton(actions, ((confirmation !== null) ? 'app-menu-button app-menu-button-secondary' : 'app-menu-button'),
            buttonLabel, () => {
                this._onBack();
            });
        if (confirmation === null) {
            this._nav.setBottomButton(button);
        } else {
            actions.classList.add('app-menu-modal-actions-pair');
            this._nav.setBottomButtons([button, AppMenuDom.addButton(actions, 'app-menu-button', confirmation.label, confirmation.action)]);
        }
        this._nav.attach();

        return {titleEl: messageEl, bodyEl: bodyEl, button: button};
    }

    // Extra teardown of a subclass (timers, key capture, stacked children).
    _teardown() {
    }

    _onBack() {
        this.close();
    }

    _navBlocked() {
        return !this._isTopOverlay();
    }

    // Nested confirmation stacked above this modal (its overlay suspends our
    // navigation through the top-overlay rule).
    _confirm(message, onConfirm, confirmLabel = null, cancelLabel = null) {
        return new AppMenuModal(this._display).confirm(message, onConfirm, confirmLabel, cancelLabel);
    }
}
