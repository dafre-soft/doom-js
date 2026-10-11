/**
 * Options modal of the menus: show() opens the options root (settings topics,
 * controls, reset), showAbout() and showHelp() open a standalone page. Adds to
 * AppMenuSettingsModal the Controls page (device choice, then the settings of
 * that device; their key, button and axis captures are the socle's).
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

    // Settings key prefixes of each input mode (DoomSettings definitions).
    static get SETTING_PREFIXES_BY_MODE() {
        return {
            gamepad:        ['pad.'],
            virtualGamepad: ['virtual_pad.'],
            keyboardMouse:  ['mouse.', 'keyboard.']
        };
    }

    /**
     * @param {AppMenuDisplay} display
     */
    constructor(display) {
        super(display, doomSettings);

        this._shownDevices   = null;
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

    _applySettings() {
        doomSettings.applyToInputs(new Inputs()).applyToTranslator(appTranslator);
        doomSound.applyVolumes();
    }

    _rebuildsPage(definition) {
        return (definition.key === MenuOptionsModal.LANGUAGE_KEY);
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
