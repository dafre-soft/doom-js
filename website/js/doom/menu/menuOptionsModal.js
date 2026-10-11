/**
 * Options modal of the menus: show() opens the options root (settings topics,
 * controls, reset), showAbout() and showHelp() open a standalone page. Adds to
 * AppMenuSettingsModal the Controls page and its key, button and axis captures.
 */
class MenuOptionsModal extends AppMenuSettingsModal {
    static get DEVICE_REFRESH_MS() {
        return 500;
    }

    static get DEVICE_KEY() {
        return 'controls.device';
    }

    static get GAMEPAD_NAME_MAX_LENGTH() {
        return 24;
    }

    static get CAPTURE_POLL_MS() {
        return 16;
    }

    // Travel from its rest value that captures an axis, then that brings it back to rest.
    static get AXIS_CAPTURE_DELTA() {
        return 0.5;
    }

    static get AXIS_REST_DELTA() {
        return 0.25;
    }

    // Sign of a push towards each capture direction, in the hardware convention (down positive).
    static get AXIS_DIRECTION_SIGNS() {
        return {right: 1, up: -1};
    }

    // Settings key prefixes of each input mode (DoomSettings definitions).
    static get SETTING_PREFIXES_BY_MODE() {
        return {
            gamepad:        ['pad.'],
            virtualGamepad: ['virtual_pad.'],
            keyboardMouse:  ['mouse.', 'keyboard.']
        };
    }

    // Keys whose layout / code-suffix name does not read well.
    static get KEY_LABELS() {
        return {
            Space: 'key.space'
        };
    }

    /**
     * @param {AppMenuDisplay} display
     */
    constructor(display) {
        super(display, doomSettings);

        this._shownDevices   = null;
        this._captureHandler = null;
        this._captureTimer   = null;
        this._layoutMap      = null;
        this._inGame         = false;
        this._rendererLocked = false;
    }

    // Over a running game: the multiplayer settings only apply to the next
    // game, so they are not offered there.
    setInGame(inGame) {
        this._inGame = (inGame === true);

        return this;
    }

    // A multiplayer session renders with WebGL whatever the setting: the
    // renderer is not offered meanwhile.
    setRendererLocked(locked) {
        this._rendererLocked = (locked === true);

        return this;
    }

    show() {
        return this._open(false, 'menu.game.options', () => this._buildRoot());
    }

    // The multiplayer section alone, from the shortcut of the Multiplayer screen.
    showMultiplayer() {
        return this._open(true, 'help.multiplayer', () => this._buildSettingsPage('multiplayer.'));
    }

    /**
     * The settings of the game about to open, shown to the main just before
     * its lobby: what is changed here is stored, the preset of the next game.
     * Back gives up the opening.
     *
     * @param {string[]} keys       - the settings of the launched mode
     * @param {function} onContinue - once the settings are chosen, after this modal closed
     */
    showGameSettings(keys, onContinue) {
        const continuation = {label: appTranslator.get('multiplayer.settings.continue'), action: () => {
            this.close();
            onContinue();
        }};

        return this._open(false, 'multiplayer.settings.title', () => this._buildSettingsList(keys.map((key) => doomSettings.getDefinition(key))), continuation);
    }

    showAbout() {
        return this._open(true, 'help.about', () => this._buildAbout());
    }

    showHelp() {
        return this._open(true, 'help.guide', () => this._buildHelp());
    }

    _open(standalone, titleCode, builder, confirmation = null) {
        this._loadLayoutMap();

        return super._open(standalone, titleCode, builder, confirmation);
    }

    _teardown() {
        this._stopCapture();
        super._teardown();
    }

    // Also blocked while a key or gamepad capture is running.
    _navBlocked() {
        return ((this._captureHandler !== null) || (this._captureTimer !== null) || !this._isTopOverlay());
    }

    // --- Pages ---

    _buildRoot() {
        const list = this._addList();
        this._nav.addItemIn(list, appTranslator.get('help.display'), () => this._pushPage('help.display', () => this._buildSettingsPage('display.')));
        this._nav.addItemIn(list, appTranslator.get('help.game'), () => this._pushPage('help.game', () => this._buildSettingsPage('game.')));
        if (!this._inGame) {
            this._nav.addItemIn(list, appTranslator.get('help.multiplayer'), () => this._pushPage('help.multiplayer', () => this._buildSettingsPage('multiplayer.')));
        }
        this._nav.addItemIn(list, appTranslator.get('help.sound'), () => this._pushPage('help.sound', () => this._buildSettingsPage('sound.')));
        this._nav.addItemIn(list, appTranslator.get('help.controls'), () => this._pushPage('help.controls', () => this._buildControls()));
        this._nav.addItemIn(list, appTranslator.get('help.reset'), () => this._confirmReset());
        this._nav.selectFirst();
    }

    // Wipes every saved setting after a confirmation.
    _confirmReset() {
        this._confirm(appTranslator.get('help.resetConfirm'), () => {
            doomSettings.resetAll();
            this._applySettings();
            this._renderPage();
        }, null, appTranslator.get('menu.back'));
    }

    _buildControls() {
        const inputs = new Inputs();
        const list   = this._addList();
        const device = this._nav.addItemIn(list, appTranslator.get('settings.controls.device'), () => {
            this._stepDevice(inputs, 1);
        }, (dir) => {
            this._stepDevice(inputs, dir);
        });
        AppMenuDom.addText(device, 'app-menu-item-value', this._deviceChoiceLabel(this._currentDeviceChoice(inputs), inputs));

        this._shownDevices = this._devicesState(inputs);
        for (const prefix of MenuOptionsModal.SETTING_PREFIXES_BY_MODE[inputs.getMode()]) {
            for (const definition of doomSettings.getDefinitions(prefix)) {
                this._addSettingItem(list, definition);
            }
        }
        this._nav.selectFirst();

        this._setPageTimer(() => {
            if (this._devicesState(inputs) !== this._shownDevices) {
                this._renderPage();
            }
        }, MenuOptionsModal.DEVICE_REFRESH_MS);
    }

    _deviceChoices(inputs) {
        return [DoomSettings.DEVICE_AUTO].concat(inputs.getAvailableModes());
    }

    // A saved device that is not available shows as the automatic choice it falls back on.
    _currentDeviceChoice(inputs) {
        const saved = doomSettings.get(MenuOptionsModal.DEVICE_KEY);

        return ((this._deviceChoices(inputs).includes(saved)) ? saved : DoomSettings.DEVICE_AUTO);
    }

    // The settings listed below follow the device: the page is rebuilt.
    _stepDevice(inputs, dir) {
        const choices = this._deviceChoices(inputs);
        const index   = choices.indexOf(this._currentDeviceChoice(inputs));
        const next    = choices[((index + dir + choices.length) % choices.length)];

        doomSettings.set(MenuOptionsModal.DEVICE_KEY, next).applyToInputs(inputs);
        this._renderPage();
    }

    // What the page shows depends on: the devices offered, the one in use, the gamepad's name.
    _devicesState(inputs) {
        return [inputs.getAvailableModes().join(','), inputs.getMode(), (inputs.getGamepadName() ?? '')].join('|');
    }

    _deviceChoiceLabel(choice, inputs) {
        if (choice === DoomSettings.DEVICE_AUTO) {
            return appTranslator.get('device.auto', {device: this._deviceLabel(inputs.getAutoMode(), inputs)});
        }

        return this._deviceLabel(choice, inputs);
    }

    _deviceLabel(mode, inputs) {
        if (mode === 'virtualGamepad') {
            return appTranslator.get('device.virtualPad');
        }
        if (mode === 'gamepad') {
            return appTranslator.get('device.gamepad', {name: MenuOptionsModal.gamepadDisplayName(inputs.getGamepadName() ?? '')});
        }

        return appTranslator.get('device.keyboardMouse');
    }

    /**
     * The browser's gamepad id stripped of its vendor / product numbers
     * (Firefox "054c-0ce6-Name", Chrome "Name (STANDARD GAMEPAD Vendor: 054c
     * Product: 0ce6)"), cut to fit the settings line.
     * @param {string} id
     * @returns {string}
     */
    static gamepadDisplayName(id) {
        const name = (id.replace(/^[0-9a-f]{1,4}-[0-9a-f]{1,4}-/i, '').replace(/\s*\([^)]*Vendor:[^)]*\)\s*$/i, '').trim() || id.trim());
        if (name.length <= MenuOptionsModal.GAMEPAD_NAME_MAX_LENGTH) {
            return name;
        }

        return name.slice(0, (MenuOptionsModal.GAMEPAD_NAME_MAX_LENGTH - 1)).trimEnd() + '…';
    }

    _buildSettingsPage(prefix) {
        const definitions = doomSettings.getDefinitions(prefix)
            .filter((definition) => (!this._rendererLocked || (definition.key !== MenuOptionsModal.RENDERER_KEY)));
        this._buildSettingsList(definitions);
    }

    // --- Settings hooks ---

    _activateSetting(definition, valueEl) {
        const inputs = new Inputs();
        if (definition.type === 'char') {
            this._startKeyCapture(definition, inputs);
            return true;
        }
        if (definition.type === 'padButton') {
            this._startPadButtonCapture(definition, inputs);
            return true;
        }
        if (definition.type === 'padAxis') {
            this._startPadAxisCapture(definition, inputs);
            return true;
        }

        return false;
    }

    _customValueText(definition) {
        if (definition.type === 'char') {
            return this._keyLabel(doomSettings.get(definition.key));
        }
        if (definition.type === 'padButton') {
            return this._padButtonLabel(doomSettings.get(definition.key));
        }
        if (definition.type === 'padAxis') {
            return this._padAxisLabel(doomSettings.get(definition.key));
        }

        return null;
    }

    _applySettings() {
        doomSettings.applyToInputs(new Inputs()).applyToTranslator(appTranslator);
        doomSound.applyVolumes();
    }

    _rebuildsPage(definition) {
        return (definition.key === MenuOptionsModal.LANGUAGE_KEY);
    }

    _padButtonLabel(index) {
        return ((index !== null) ? appTranslator.get('pad.button', {number: index}) : '');
    }

    _padAxisLabel(code) {
        const binding = DoomSettings.parseAxisCode(code);
        if (binding.index === null) {
            return '';
        }

        return appTranslator.get((binding.inverted ? 'pad.axisInverted' : 'pad.axis'), {number: binding.index});
    }

    // --- Binding capture ---

    // A page left only by pressing a key: one key, one action, so the key is
    // unbound elsewhere. Capture phase, so neither the list navigation nor the
    // game shortcuts see the press.
    _startKeyCapture(definition, inputs) {
        const returnView = this._openCapturePage(definition, 'help.keyCapture');

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
            this._saveBinding(definition, event.code, inputs);
            this._endCapture(returnView);
        };
        document.addEventListener('keydown', this._captureHandler, true);
    }

    // A button held when the page opens (the one that opened it) is only
    // armed once released.
    _startPadButtonCapture(definition, inputs) {
        const pad   = inputs.getGamepad();
        const armed = pad.readRawButtons().map((down) => !down);
        let held    = null;

        this._pollPadCapture(definition, inputs, 'help.padButtonCapture', () => {
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

    _startPadAxisCapture(definition, inputs) {
        const pad    = inputs.getGamepad();
        const rest   = pad.readRawAxes();
        const travel = (axes, index) => (axes[index] - (rest[index] ?? 0));
        let pushed   = null;

        this._pollPadCapture(definition, inputs, 'help.padAxisCapture.' + definition.direction, () => {
            const axes = pad.readRawAxes();
            if (pushed !== null) {
                return ((Math.abs(travel(axes, pushed.index)) < MenuOptionsModal.AXIS_REST_DELTA) ? pushed.code : null);
            }
            const index = axes.findIndex((value, i) => (Math.abs(travel(axes, i)) > MenuOptionsModal.AXIS_CAPTURE_DELTA));
            if (index < 0) {
                return null;
            }
            const inverted = (Math.sign(travel(axes, index)) !== MenuOptionsModal.AXIS_DIRECTION_SIGNS[definition.direction]);

            pushed = {index: index, code: DoomSettings.axisCode(index, inverted)};

            return null;
        });
    }

    // `step` only returns the value once released: the press must not reach the
    // list navigation when the page closes.
    _pollPadCapture(definition, inputs, promptCode, step) {
        const returnView = this._openCapturePage(definition, promptCode);
        const pad        = inputs.getGamepad();

        this._captureTimer = setInterval(() => {
            if (!pad.isAvailable()) {
                this._endCapture(returnView);
                return;
            }
            const value = step();
            if (value !== null) {
                this._saveBinding(definition, value, inputs);
                this._endCapture(returnView);
            }
        }, MenuOptionsModal.CAPTURE_POLL_MS);
    }

    _openCapturePage(definition, promptCode) {
        const returnView = this._readListView();
        this._pushPage(definition.nameCode, () => {
            AppMenuDom.addText(this._bodyEl, 'app-menu-modal-line',
                appTranslator.get(promptCode, {action: appTranslator.get(definition.nameCode)}));
        }, true);

        return returnView;
    }

    _saveBinding(definition, value, inputs) {
        doomSettings.bind(definition, value).applyToInputs(inputs);
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
        const labelCode = MenuOptionsModal.KEY_LABELS[code];
        if (labelCode !== undefined) {
            return appTranslator.get(labelCode);
        }
        const modifier = code.match(MenuOptionsModal.MODIFIER_CODE);
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
        const key = ((name === 'Shift') ? appTranslator.get('key.shift') : MenuOptionsModal.MODIFIER_NAMES[name]);

        return appTranslator.get(((side === 'Left') ? 'key.left' : 'key.right'), {key: key});
    }

    _buildHelp() {
        this._addLines(['help.guide.wad', 'help.guide.freedoom'], {
            addFile: appTranslator.get('menu.wad.addFile')
        });
        this._addExternalLink(DoomExternalLinks.FREEDOOM);
        this._addLines(['help.guide.own', 'help.guide.install', 'help.guide.controls'], {
            addUrl: appTranslator.get('menu.wad.addUrl')
        });

        this._addHeading(appTranslator.get('help.about'));
        this._buildAbout();
    }

    _buildAbout() {
        this._addLines(['help.about.what', 'help.about.author', 'help.about.source']);
        this._addExternalLink(DoomExternalLinks.PROJECT);
        this._addLines(['help.about.licence', 'help.about.wads']);
        this._addLines(['help.about.copyright'], {year: new Date().getFullYear()});
    }

}

MenuOptionsModal.RENDERER_KEY   = 'display.renderer';
MenuOptionsModal.LANGUAGE_KEY   = 'display.language';
MenuOptionsModal.MODIFIER_CODE  = /^(Shift|Control|Alt)(Left|Right)$/;
// Key cap names, the same in every language (Shift alone is translated).
MenuOptionsModal.MODIFIER_NAMES = {Control: 'Ctrl', Alt: 'Alt'};
