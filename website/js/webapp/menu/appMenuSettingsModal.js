/**
 * Settings modal: a page stack sharing one AppMenuListNavigation, whose title
 * shows the breadcrumb of the stack ("Options > Display"), and the building of
 * a settings page from the definitions of an AppSettings ('bool' and 'list'
 * cycle on Left/Right, 'text' opens the on-screen keyboard).
 *
 * A subclass builds its pages through _open / _pushPage and plugs in its own
 * setting types (_activateSetting, _customValueText), what a change applies
 * (_applySettings) and the settings that rewrite the whole page (_rebuildsPage).
 */
class AppMenuSettingsModal extends AppMenuAbstractListModal {
    /**
     * @param {AppMenuDisplay} display
     * @param {AppSettings}    settings
     */
    constructor(display, settings) {
        super(display);

        this._settings        = settings;
        this._titleEl         = null;
        this._bodyEl          = null;
        this._actionButton    = null;
        this._pageStack       = [];
        this._pageTimer       = null;
        this._pendingListView = null;
        this._standalone      = false;
    }

    /**
     * Opens the modal on its first page. A standalone page closes ("Close"),
     * the root of a stack goes back to what opened it ("Back"). A confirmation
     * ({label, action}) joins the back button in the bottom row.
     *
     * @param {boolean}     standalone
     * @param {string}      titleCode
     * @param {function}    builder    - fills this._bodyEl
     * @param {object|null} confirmation
     */
    _open(standalone, titleCode, builder, confirmation = null) {
        this._standalone = (standalone === true);
        const {titleEl, bodyEl, button} = this._openShell('', appTranslator.get('menu.close'), confirmation);
        this._titleEl      = titleEl;
        this._bodyEl       = bodyEl;
        this._actionButton = button;
        this._pageStack    = [];
        this._pushPage(titleCode, builder);

        return this;
    }

    _teardown() {
        this._clearPageTimer();
    }

    // --- Page stack ---

    // titleCode, not a resolved label: the breadcrumb is rebuilt from the codes
    // at every render, so a language switch reaches the pages already stacked.
    // A noBack page cannot be left by the back button (a capture page).
    _pushPage(titleCode, builder, noBack = false) {
        this._pageStack.push({titleCode: titleCode, builder: builder, noBack: (noBack === true)});
        this._renderPage();
    }

    _popPage() {
        this._pageStack.pop();
    }

    _onBack() {
        if (this._pageStack.length <= 1) {
            this.close();
            return;
        }
        this._popPage();
        this._renderPage();
    }

    _renderPage() {
        this._clearPageTimer();
        const current  = this._pageStack[this._pageStack.length - 1];
        const rootCode = ((this._standalone) ? 'menu.close' : 'menu.back');
        this._titleEl.textContent        = this._pageStack.map((page) => appTranslator.get(page.titleCode)).join(' > ');
        this._actionButton.textContent   = appTranslator.get(((this._pageStack.length > 1) ? 'menu.back' : rootCode));
        this._actionButton.style.display = ((current.noBack === true) ? 'none' : '');
        this._bodyEl.innerHTML           = '';
        this._nav.clear();
        current.builder();
        if (this._pendingListView !== null) {
            this._applyListView(this._pendingListView);
            this._pendingListView = null;
        }
    }

    // A page that must follow a live state (a device plugged in) polls it.
    _setPageTimer(callback, periodMs) {
        this._clearPageTimer();
        this._pageTimer = setInterval(callback, periodMs);
    }

    _clearPageTimer() {
        if (this._pageTimer !== null) {
            clearInterval(this._pageTimer);
            this._pageTimer = null;
        }
    }

    _readListView() {
        const list = this._bodyEl.querySelector('.app-menu-list');

        return {index: this._nav.getSelectedIndex(), scrollTop: ((list !== null) ? list.scrollTop : 0)};
    }

    // The scroll first: selecting a visible row then leaves it untouched.
    _applyListView(view) {
        const list = this._bodyEl.querySelector('.app-menu-list');
        if (list !== null) {
            list.scrollTop = view.scrollTop;
        }
        this._nav.selectIndex(view.index);
    }

    _rebuildKeepingView(view) {
        this._pendingListView = view;
        this._renderPage();
    }

    // --- Settings pages ---

    _addList() {
        return AppMenuDom.addElement(this._bodyEl, 'div', 'app-menu-list');
    }

    _buildSettingsList(definitions) {
        const list = this._addList();
        for (const definition of definitions) {
            this._addSettingItem(list, definition);
        }
        this._nav.selectFirst();
    }

    _addSettingItem(listEl, definition) {
        let valueEl = null;
        const cycles = ((definition.type === 'bool') || (definition.type === 'list'));
        const item   = this._nav.addItemIn(listEl, appTranslator.get(definition.nameCode), () => {
            if (definition.type === 'text') {
                this._openTextEntry(definition, valueEl);
                return;
            }
            if (this._activateSetting(definition, valueEl)) {
                return;
            }
            this._stepSettingValue(definition, valueEl, 1);
        }, (cycles ? (dir) => {
            this._stepSettingValue(definition, valueEl, dir);
        } : null));
        valueEl = AppMenuDom.addText(item, 'app-menu-item-value', this._settingValueText(definition));

        return item;
    }

    _stepSettingValue(definition, valueEl, dir) {
        const next = ((definition.type === 'bool')
            ? !(this._settings.get(definition.key) === true)
            : this._settings.nextListValue(definition, dir));

        this._settings.set(definition.key, next);
        this._applySettings();

        if (this._rebuildsPage(definition)) {
            this._rebuildKeepingView(this._readListView());
            return;
        }
        valueEl.textContent = this._settingValueText(definition);
    }

    // Stacked above the settings: the top-overlay rule mutes this modal meanwhile.
    _openTextEntry(definition, valueEl) {
        new AppMenuTextEntryModal(this._display).open(appTranslator.get(definition.nameCode), definition,
            this._settings.get(definition.key), (value) => {
                this._settings.set(definition.key, value);
                this._applySettings();
                valueEl.textContent = this._settingValueText(definition);
            });
    }

    _settingValueText(definition) {
        if (definition.type === 'bool') {
            return appTranslator.get(((this._settings.get(definition.key) === true) ? 'value.yes' : 'value.no'));
        }
        if (definition.type === 'list') {
            return this._settings.getListLabel(definition);
        }

        return (this._customValueText(definition) ?? String(this._settings.get(definition.key)));
    }

    // --- Hooks ---

    /**
     * Activation of a setting of a subclass type.
     *
     * @returns {boolean} true when handled
     */
    _activateSetting(definition, valueEl) {
        return false;
    }

    /**
     * Displayed value of a setting of a subclass type.
     *
     * @returns {string|null} null for the plain stored value
     */
    _customValueText(definition) {
        return null;
    }

    // Pushes the settings to what they drive, after every change.
    _applySettings() {
    }

    // A setting that rewrites the whole page (the language): the page is
    // rebuilt instead of patched, keeping the selection.
    _rebuildsPage(definition) {
        return false;
    }

    // --- Text pages ---

    _addLines(codes, params = {}) {
        for (const code of codes) {
            AppMenuDom.addText(this._bodyEl, 'app-menu-modal-line', appTranslator.get(code, params));
        }
    }

    _addHeading(text) {
        AppMenuDom.addText(this._bodyEl, 'app-menu-modal-heading', text);
    }

    // The URL is its own label: an address is a proper noun, never translated.
    _addExternalLink(url) {
        AppMenuDom.addLink(this._bodyEl, 'app-menu-modal-link', url, url);
    }
}
