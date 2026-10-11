/**
 * Settings modal: a page stack sharing one AppMenuListNavigation, whose title
 * shows the breadcrumb of the stack ("Options > Display"), and the building of
 * a settings page from the definitions of an AppSettings ('bool' and 'list'
 * cycle on Left/Right, 'text' opens the on-screen keyboard, a control binding
 * 'char' / 'padButton' / 'padAxis' opens its capture page).
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
        this._captureHandler  = null;
        this._captureTimer    = null;
        this._layoutMap       = null;
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
        this._loadLayoutMap();
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
        this._stopCapture();
        this._clearPageTimer();
    }

    // Also blocked while a key or gamepad capture is running.
    _navBlocked() {
        return ((this._captureHandler !== null) || (this._captureTimer !== null) || super._navBlocked());
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
            if (this._startBindingCapture(definition)) {
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
        if (definition.type === 'char') {
            return this._keyLabel(this._settings.get(definition.key));
        }
        if (definition.type === 'padButton') {
            return this._padButtonLabel(this._settings.get(definition.key));
        }
        if (definition.type === 'padAxis') {
            return this._padAxisLabel(this._settings.get(definition.key));
        }

        return (this._customValueText(definition) ?? String(this._settings.get(definition.key)));
    }

    // --- Control binding capture ---

    _startBindingCapture(definition) {
        if (definition.type === 'char') {
            this._startKeyCapture(definition);
            return true;
        }
        if (definition.type === 'padButton') {
            this._startPadButtonCapture(definition);
            return true;
        }
        if (definition.type === 'padAxis') {
            this._startPadAxisCapture(definition);
            return true;
        }

        return false;
    }

    // A page left only by pressing a key: one key, one action, so the key is
    // unbound elsewhere. Capture phase, so neither the list navigation nor the
    // game shortcuts see the press.
    _startKeyCapture(definition) {
        const returnView = this._openCapturePage(definition, 'menu.capture.key');

        this._captureHandler = (event) => {
            // F1-F12 stay with the browser; Escape is the fixed pause key.
            if ((event.code.startsWith('F') && (event.code.length <= 3)) || (event.code === 'Escape')) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (event.repeat) {
                return;
            }
            this._saveBinding(definition, event.code);
            this._endCapture(returnView);
        };
        document.addEventListener('keydown', this._captureHandler, true);
    }

    // A button held when the page opens (the one that opened it) is only
    // armed once released.
    _startPadButtonCapture(definition) {
        const pad   = new AppInputGamepad();
        const armed = pad.readRawButtons().map((down) => !down);
        let held    = null;

        this._pollPadCapture(definition, 'menu.capture.padButton', () => {
            const buttons = pad.readRawButtons();
            if (held !== null) {
                return ((buttons[held] === true) ? null : held);
            }
            buttons.forEach((down, index) => {
                armed[index] = (armed[index] || !down);
            });
            const index = buttons.findIndex((down, i) => (down && armed[i]));

            held = ((index >= 0) ? index : null);

            return null;
        });
    }

    _startPadAxisCapture(definition) {
        const pad    = new AppInputGamepad();
        const rest   = pad.readRawAxes();
        const travel = (axes, index) => (axes[index] - (rest[index] ?? 0));
        let pushed   = null;

        this._pollPadCapture(definition, 'menu.capture.padAxis.' + definition.direction, () => {
            const axes = pad.readRawAxes();
            if (pushed !== null) {
                return ((Math.abs(travel(axes, pushed.index)) < AppMenuSettingsModal.AXIS_REST_DELTA) ? pushed.code : null);
            }
            const index = axes.findIndex((value, i) => (Math.abs(travel(axes, i)) > AppMenuSettingsModal.AXIS_CAPTURE_DELTA));
            if (index < 0) {
                return null;
            }
            const inverted = (Math.sign(travel(axes, index)) !== AppMenuSettingsModal.AXIS_DIRECTION_SIGNS[definition.direction]);

            pushed = {index: index, code: AppSettings.axisCode(index, inverted)};

            return null;
        });
    }

    // `step` only returns the value once released: the press must not reach the
    // list navigation when the page closes.
    _pollPadCapture(definition, promptCode, step) {
        const returnView = this._openCapturePage(definition, promptCode);
        const pad        = new AppInputGamepad();

        this._captureTimer = setInterval(() => {
            if (!pad.isAvailable()) {
                this._endCapture(returnView);
                return;
            }
            const value = step();
            if (value !== null) {
                this._saveBinding(definition, value);
                this._endCapture(returnView);
            }
        }, AppMenuSettingsModal.CAPTURE_POLL_MS);
    }

    _openCapturePage(definition, promptCode) {
        const returnView = this._readListView();
        this._pushPage(definition.nameCode, () => {
            AppMenuDom.addText(this._bodyEl, 'app-menu-modal-line',
                appTranslator.get(promptCode, {action: appTranslator.get(definition.nameCode)}));
        }, true);

        return returnView;
    }

    _saveBinding(definition, value) {
        this._settings.bind(definition, value);
        this._applySettings();
    }

    _endCapture(returnView) {
        this._stopCapture();
        this._popPage();
        this._rebuildKeepingView(returnView);
    }

    _stopCapture() {
        if (this._captureHandler !== null) {
            document.removeEventListener('keydown', this._captureHandler, true);
            this._captureHandler = null;
        }
        if (this._captureTimer !== null) {
            clearInterval(this._captureTimer);
            this._captureTimer = null;
        }
    }

    // --- Control labels ---

    // Real keyboard layout (code → printed character), Chrome/Edge only.
    _loadLayoutMap() {
        if ((this._layoutMap !== null) || !navigator.keyboard || !navigator.keyboard.getLayoutMap) {
            return;
        }
        navigator.keyboard.getLayoutMap().then((map) => {
            this._layoutMap = map;
        }).catch(() => {
            this._layoutMap = null;
        });
    }

    _keyLabel(code) {
        if ((code === '') || (code === null) || (code === undefined)) {
            return '';
        }
        const labelCode = AppMenuSettingsModal.KEY_LABELS[code];
        if (labelCode !== undefined) {
            return appTranslator.get(labelCode);
        }
        const modifier = code.match(AppMenuSettingsModal.MODIFIER_CODE);
        if (modifier !== null) {
            return this._modifierLabel(modifier[1], modifier[2]);
        }
        if ((this._layoutMap !== null) && this._layoutMap.has(code)) {
            return this._layoutMap.get(code).toUpperCase();
        }
        if (code.startsWith('Key')) {
            return code.slice(3);
        }
        if (code.startsWith('Digit')) {
            return code.slice(5);
        }
        if (code.startsWith('Numpad')) {
            return appTranslator.get('key.numpad', {key: code.slice(6)});
        }

        return code;
    }

    // 'ShiftLeft' → 'Left Shift' / 'Maj gauche': the side reads in each language's order.
    _modifierLabel(name, side) {
        const key = ((name === 'Shift') ? appTranslator.get('key.shift') : AppMenuSettingsModal.MODIFIER_NAMES[name]);

        return appTranslator.get(((side === 'Left') ? 'key.left' : 'key.right'), {key: key});
    }

    _padButtonLabel(index) {
        return ((index !== null) ? appTranslator.get('pad.button', {number: index}) : '');
    }

    _padAxisLabel(code) {
        const binding = AppSettings.parseAxisCode(code);
        if (binding.index === null) {
            return '';
        }

        return appTranslator.get((binding.inverted ? 'pad.axisInverted' : 'pad.axis'), {number: binding.index});
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

    // The current binding of every action of a settings prefix ('keyboard.', 'pad.'), under a heading.
    _addBindings(heading, prefix) {
        this._addHeading(heading);
        for (const definition of this._settings.getDefinitions(prefix)) {
            AppMenuDom.addText(this._bodyEl, 'app-menu-modal-line', appTranslator.get('menu.binding', {
                action:  appTranslator.get(definition.nameCode),
                control: (this._settingValueText(definition) || appTranslator.get('menu.unbound'))
            }));
        }
    }

    // The URL is its own label: an address is a proper noun, never translated.
    _addExternalLink(url) {
        AppMenuDom.addLink(this._bodyEl, 'app-menu-modal-link', url, url);
    }
}

AppMenuSettingsModal.CAPTURE_POLL_MS      = 16;
// Travel from its rest value that captures an axis, then that brings it back to rest.
AppMenuSettingsModal.AXIS_CAPTURE_DELTA   = 0.5;
AppMenuSettingsModal.AXIS_REST_DELTA      = 0.25;
// Sign of a push towards each capture direction, in the hardware convention (down positive).
AppMenuSettingsModal.AXIS_DIRECTION_SIGNS = {right: 1, up: -1};
// Keys whose layout / code-suffix name does not read well.
AppMenuSettingsModal.KEY_LABELS           = {Space: 'key.space', ArrowLeft: 'key.arrowLeft', ArrowRight: 'key.arrowRight', ArrowUp: 'key.arrowUp', ArrowDown: 'key.arrowDown'};
AppMenuSettingsModal.MODIFIER_CODE        = /^(Shift|Control|Alt)(Left|Right)$/;
// Key cap names, the same in every language (Shift alone is translated).
AppMenuSettingsModal.MODIFIER_NAMES       = {Control: 'Ctrl', Alt: 'Alt'};
