/**
 * Persistent game settings, stored in the `settings` store of the spipudoom
 * IndexedDB base. The settings UI is built from DEFINITIONS; the game reads the
 * dedicated getters.
 *
 * Types beyond those of AppSettings: 'char' (one physical key code),
 * 'padButton' (one gamepad button index, null unmapped) and 'padAxis' (a signed
 * axis code, see axisCode, AXIS_NONE unmapped).
 */
class DoomSettings extends AppSettings {
    // Fine steps at the low end: a floating touch stick re-centres at every
    // touch, so there is no hardware drift to absorb.
    static get DEAD_ZONE_VALUES() {
        return AppSettings.percentValues([0, 2.5, 5, 7.5, 10, 15]);
    }

    // 100 % = the speed of the non-firing aim gesture.
    static get SENSITIVITY_VALUES() {
        return AppSettings.percentValues([60, 70, 80, 90, 100]);
    }

    static get VOLUME_VALUES() {
        return AppSettings.percentValues([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    }

    /**
     * @param {number[]} numbers
     * @param {string}   format  - see formatListValue
     * @returns {object[]} "none" first, then [{code, format}]
     */
    static limitValues(numbers, format) {
        return [{code: DoomSettings.LIMIT_NONE, labelCode: 'value.noLimit'}]
            .concat(numbers.map((number) => ({code: String(number), format: format})));
    }

    static get FRAG_LIMIT_VALUES() {
        return DoomSettings.limitValues([5, 10, 15, 20, 30, 50], 'number');
    }

    static get TIME_LIMIT_VALUES() {
        return DoomSettings.limitValues([5, 10, 15, 20, 30], 'minutes');
    }

    // Deathmatch 1.0 and 2.0 ("altdeath"), named by what they do.
    static get DEATHMATCH_ITEMS_VALUES() {
        return [
            {code: DoomSettings.DEATHMATCH_WEAPONS_STAY, labelCode: 'value.deathmatchItems.weaponsStay'},
            {code: DoomSettings.DEATHMATCH_ITEMS_RESPAWN, labelCode: 'value.deathmatchItems.itemsRespawn'}
        ];
    }

    static get NICKNAME_CHARSET() {
        return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -';
    }

    static get DEFINITIONS() {
        return [
            {key: 'display.language',             nameCode: 'settings.display.language',           type: 'list', default: 'en', values: [{code: 'en', label: 'English'}, {code: 'fr', label: 'Français'}, {code: 'it', label: 'Italiano'}, {code: 'es', label: 'Español'}]},
            // Codes must match the keys of Object3dRendererList.
            {key: 'display.renderer',             nameCode: 'settings.display.renderer',           type: 'list', default: 'webgl', values: [{code: 'webgl', label: 'WebGL'}, {code: 'full', labelCode: 'value.renderer.softwareTextured'}, {code: 'flat', labelCode: 'value.renderer.softwareFlat'}, {code: 'fast', labelCode: 'value.renderer.softwareWireframe'}]},
            {key: 'display.crosshair',            nameCode: 'settings.display.crosshair',          type: 'bool', default: true},
            {key: 'display.distance_shading',     nameCode: 'settings.display.distanceShading',    type: 'bool', default: true},
            {key: 'display.texture_smoothing',    nameCode: 'settings.display.textureSmoothing',   type: 'bool', default: true},
            // Read when a level is built: a change shows from the next load on.
            {key: 'display.water_effects',        nameCode: 'settings.display.waterEffects',       type: 'bool', default: true},
            {key: 'display.show_fps',             nameCode: 'settings.display.showFps',            type: 'bool', default: false},
            // None of these exists in vanilla: fall damage stays off to match it,
            // jumping and crouching are on since they cost nothing when unused.
            {key: 'game.fall_damage',             nameCode: 'settings.game.fallDamage',            type: 'bool', default: false},
            {key: 'game.jump',                    nameCode: 'settings.game.jump',                  type: 'bool', default: true},
            {key: 'game.crouch',                  nameCode: 'settings.game.crouch',                type: 'bool', default: true},
            {key: 'multiplayer.nickname',         nameCode: 'settings.multiplayer.nickname',       type: 'text', default: '', charset: DoomSettings.NICKNAME_CHARSET, maxLength: 16},
            // The defaults of the original: friendly fire on, and a plain -deathmatch
            // keeps its monsters, has no limit and leaves the weapons in place.
            {key: 'multiplayer.friendly_fire',    nameCode: 'settings.multiplayer.friendlyFire',   type: 'bool', default: true},
            {key: 'multiplayer.dm_monsters',      nameCode: 'settings.multiplayer.dmMonsters',     type: 'bool', default: true},
            {key: 'multiplayer.frag_limit',       nameCode: 'settings.multiplayer.fragLimit',      type: 'list', default: DoomSettings.LIMIT_NONE, values: DoomSettings.FRAG_LIMIT_VALUES},
            {key: 'multiplayer.time_limit',       nameCode: 'settings.multiplayer.timeLimit',      type: 'list', default: DoomSettings.LIMIT_NONE, values: DoomSettings.TIME_LIMIT_VALUES},
            {key: 'multiplayer.dm_items',         nameCode: 'settings.multiplayer.dmItems',        type: 'list', default: DoomSettings.DEATHMATCH_WEAPONS_STAY, values: DoomSettings.DEATHMATCH_ITEMS_VALUES},
            // 100 % is the UZDoom default (snd_sfxvolume / snd_musicvolume).
            {key: 'sound.volume_music',           nameCode: 'settings.sound.volumeMusic',          type: 'list', default: '100', values: DoomSettings.VOLUME_VALUES},
            {key: 'sound.volume_effects',         nameCode: 'settings.sound.volumeEffects',        type: 'list', default: '100', values: DoomSettings.VOLUME_VALUES},
            // Codes must match Inputs.MODES; the Controls page offers the available ones only.
            {key: 'controls.device',              nameCode: 'settings.controls.device',            type: 'list', default: DoomSettings.DEVICE_AUTO, values: [{code: DoomSettings.DEVICE_AUTO, labelCode: 'device.auto'}, {code: 'keyboardMouse', labelCode: 'device.keyboardMouse'}, {code: 'gamepad', labelCode: 'device.gamepad'}, {code: 'virtualGamepad', labelCode: 'device.virtualPad'}]},
            {key: 'pad.y_inverse',                nameCode: 'settings.pad.yInverse',               type: 'bool', default: false},
            // Captured by pushing the stick towards `direction`; the defaults
            // mirror InputGamepad.DEFAULT_AXIS_MAPPING.
            {key: 'pad.move_x',                   nameCode: 'settings.pad.moveX',                  type: 'padAxis', default: '+0', action: 'moveX', direction: 'right'},
            {key: 'pad.move_y',                   nameCode: 'settings.pad.moveY',                  type: 'padAxis', default: '+1', action: 'moveY', direction: 'up'},
            {key: 'pad.look_x',                   nameCode: 'settings.pad.lookX',                  type: 'padAxis', default: '+2', action: 'lookX', direction: 'right'},
            {key: 'pad.look_y',                   nameCode: 'settings.pad.lookY',                  type: 'padAxis', default: '+5', action: 'lookY', direction: 'up'},
            // The defaults mirror InputGamepad.DEFAULT_MAPPING.
            {key: 'pad.run',                      nameCode: 'settings.action.run',                 type: 'padButton', default: 10, action: 'run'},
            {key: 'pad.jump',                     nameCode: 'settings.action.jump',                type: 'padButton', default: 1,  action: 'jump'},
            {key: 'pad.crouch',                   nameCode: 'settings.action.crouch',              type: 'padButton', default: 0,  action: 'crouch'},
            {key: 'pad.action',                   nameCode: 'settings.action.action',              type: 'padButton', default: 3,  action: 'action'},
            {key: 'pad.fire',                     nameCode: 'settings.action.fire',                type: 'padButton', default: 7,  action: 'fire'},
            {key: 'pad.weapon_prev',              nameCode: 'settings.action.weaponPrev',          type: 'padButton', default: 4,  action: 'weaponPrev'},
            {key: 'pad.weapon_next',              nameCode: 'settings.action.weaponNext',          type: 'padButton', default: 5,  action: 'weaponNext'},
            {key: 'pad.map',                      nameCode: 'settings.action.map',                 type: 'padButton', default: 12, action: 'map'},
            {key: 'pad.pause',                    nameCode: 'settings.action.pause',               type: 'padButton', default: 9,  action: 'pause'},
            {key: 'virtual_pad.y_inverse',        nameCode: 'settings.virtualPad.yInverse',        type: 'bool', default: false},
            // The firing gesture is the upper band of the aim stick, not a third stick.
            {key: 'virtual_pad.move_dead_zone',   nameCode: 'settings.virtualPad.moveDeadZone',    type: 'list', default: '15',  values: DoomSettings.DEAD_ZONE_VALUES},
            {key: 'virtual_pad.aim_dead_zone',    nameCode: 'settings.virtualPad.aimDeadZone',     type: 'list', default: '15',  values: DoomSettings.DEAD_ZONE_VALUES},
            {key: 'virtual_pad.fire_dead_zone',   nameCode: 'settings.virtualPad.fireDeadZone',    type: 'list', default: '7.5', values: DoomSettings.DEAD_ZONE_VALUES},
            {key: 'virtual_pad.fire_sensitivity', nameCode: 'settings.virtualPad.fireSensitivity', type: 'list', default: '80', values: DoomSettings.SENSITIVITY_VALUES},
            {key: 'mouse.y_inverse',              nameCode: 'settings.mouse.yInverse',             type: 'bool', default: false},
            // action = the engine mapping slot; the defaults mirror
            // Inputs.KEYBOARD_DEFAULT_MAPPING.
            {key: 'keyboard.forward',             nameCode: 'settings.keyboard.forward',           type: 'char', default: 'KeyW',      action: 'forward'},
            {key: 'keyboard.backward',            nameCode: 'settings.keyboard.backward',          type: 'char', default: 'KeyS',      action: 'backward'},
            {key: 'keyboard.strafe_left',         nameCode: 'settings.keyboard.strafeLeft',        type: 'char', default: 'KeyA',      action: 'strafeLeft'},
            {key: 'keyboard.strafe_right',        nameCode: 'settings.keyboard.strafeRight',       type: 'char', default: 'KeyD',      action: 'strafeRight'},
            {key: 'keyboard.run',                 nameCode: 'settings.action.run',                 type: 'char', default: 'ShiftLeft', action: 'run'},
            {key: 'keyboard.jump',                nameCode: 'settings.action.jump',                type: 'char', default: 'Space',     action: 'jump'},
            {key: 'keyboard.crouch',              nameCode: 'settings.action.crouch',              type: 'char', default: 'KeyC',      action: 'crouch'},
            {key: 'keyboard.action',              nameCode: 'settings.action.action',              type: 'char', default: 'KeyE',      action: 'action'},
            {key: 'keyboard.fire',                nameCode: 'settings.action.fire',                type: 'char', default: 'KeyQ',      action: 'fire'},
            {key: 'keyboard.weapon_prev',         nameCode: 'settings.action.weaponPrev',          type: 'char', default: 'KeyF',      action: 'weaponPrev'},
            {key: 'keyboard.weapon_next',         nameCode: 'settings.action.weaponNext',          type: 'char', default: 'KeyG',      action: 'weaponNext'},
            {key: 'keyboard.toggle_hud',          nameCode: 'settings.keyboard.toggleHud',         type: 'char', default: 'KeyH',      action: 'toggleHud'},
            {key: 'keyboard.map',                 nameCode: 'settings.action.map',                 type: 'char', default: 'Tab',       action: 'map'},
            {key: 'keyboard.look_down',           nameCode: 'settings.keyboard.lookDown',          type: 'char', default: 'KeyK',      action: 'lookDown'},
            {key: 'keyboard.look_up',             nameCode: 'settings.keyboard.lookUp',            type: 'char', default: 'KeyI',      action: 'lookUp'},
            {key: 'keyboard.look_right',          nameCode: 'settings.keyboard.lookRight',         type: 'char', default: 'KeyL',      action: 'lookRight'},
            {key: 'keyboard.look_left',           nameCode: 'settings.keyboard.lookLeft',          type: 'char', default: 'KeyJ',      action: 'lookLeft'}
        ];
    }

    constructor() {
        super(DoomSettings.DEFINITIONS, DoomDatabaseSchema.SETTING, DoomDatabaseSchema.SETTING_BY_KEY);
    }

    _afterLoad() {
        this._yieldTakenDefaults();
    }

    // A key, a button or an axis serves one action only: an action still on its
    // default gives it up when the player saved it for another action (a
    // default that moved onto a key the player had already chosen).
    _yieldTakenDefaults() {
        for (const type of DoomSettings.BINDING_TYPES) {
            const bindingDefs = DoomSettings.DEFINITIONS.filter((def) => (def.type === type));
            const saved       = new Set(bindingDefs.filter((def) => (this._values[def.key] !== undefined))
                .map((def) => DoomSettings.boundControl(def, this._values[def.key])));
            for (const def of bindingDefs) {
                if ((this._values[def.key] === undefined) && saved.has(DoomSettings.boundControl(def, def.default))) {
                    this.set(def.key, DoomSettings.UNBOUND_VALUES[type]);
                }
            }
        }
    }

    // A 'char' accepts any string, '' meaning unmapped.
    isValidValue(def, value) {
        if (def.type === 'char') {
            return (typeof value === 'string');
        }
        if (def.type === 'padButton') {
            return ((value === null) || (Number.isInteger(value) && (value >= 0)));
        }
        if (def.type === 'padAxis') {
            return ((value === DoomSettings.AXIS_NONE) || ((typeof value === 'string') && DoomSettings.AXIS_CODE.test(value)));
        }

        return super.isValidValue(def, value);
    }

    /**
     * Binds a key, a button or an axis to one action: every other binding of
     * the same kind holding it becomes unmapped.
     *
     * @param {object} definition - a 'char', 'padButton' or 'padAxis' definition
     * @param {string|int} value
     */
    bind(definition, value) {
        const target = DoomSettings.boundControl(definition, value);
        for (const def of DoomSettings.DEFINITIONS) {
            if ((def.type === definition.type) && (def.key !== definition.key) && (DoomSettings.boundControl(def, this.get(def.key)) === target)) {
                this.set(def.key, DoomSettings.UNBOUND_VALUES[def.type]);
            }
        }

        return this.set(definition.key, value);
    }

    // An axis is held whatever its direction: '+3' and '-3' hold the same axis.
    static boundControl(def, value) {
        return ((def.type === 'padAxis') ? DoomSettings.parseAxisCode(value).index : value);
    }

    // {action: code}: only the bindings saved by the player override the engine defaults.
    getKeyboardMapping() {
        return this._getSavedBindings('char');
    }

    // {action: index|null}, same rule as the keyboard.
    getPadButtonMapping() {
        return this._getSavedBindings('padButton');
    }

    // {slot: {index, inverted}}, same rule as the keyboard, a null index unmapping the slot.
    getPadAxisMapping() {
        const mapping = this._getSavedBindings('padAxis');
        for (const slot of Object.keys(mapping)) {
            mapping[slot] = DoomSettings.parseAxisCode(mapping[slot]);
        }

        return mapping;
    }

    _getSavedBindings(type) {
        const mapping = {};
        for (const def of DoomSettings.DEFINITIONS) {
            if ((def.type === type) && (this._values[def.key] !== undefined)) {
                mapping[def.action] = this._values[def.key];
            }
        }

        return mapping;
    }

    // Hardware convention: '+3' is axis 3, '-3' the same axis inverted.
    static axisCode(index, inverted) {
        return ((inverted ? '-' : '+') + index);
    }

    // AXIS_NONE gives a null index.
    static parseAxisCode(code) {
        if (!DoomSettings.AXIS_CODE.test(code)) {
            return {index: null, inverted: false};
        }

        return {index: parseInt(code.slice(1), 10), inverted: code.startsWith('-')};
    }

    applyToInputs(inputs) {
        inputs.setPreferredMode(this.getControlsDevice());
        inputs.setLookInvertY('gamepad', this.getPadYInverse());
        inputs.setLookInvertY('virtualGamepad', this.getVirtualPadYInverse());
        inputs.setLookInvertY('keyboardMouse', this.getMouseYInverse());
        inputs.setKeyMapping(this.getKeyboardMapping());
        inputs.setGamepadButtonMapping(this.getPadButtonMapping());
        inputs.setGamepadAxisMapping(this.getPadAxisMapping());
        inputs.setVirtualPadDeadZone('move', this.getVirtualPadMoveDeadZone());
        inputs.setVirtualPadDeadZone('aim', this.getVirtualPadAimDeadZone());
        inputs.setVirtualPadDeadZone('fire', this.getVirtualPadFireDeadZone());
        inputs.setVirtualPadSensitivity(this.getVirtualPadFireSensitivity());
        inputs.setVirtualPadControlAllowed('jump', this.getGameJump());
        inputs.setVirtualPadControlAllowed('crouch', this.getGameCrouch());

        return this;
    }

    applyToTranslator(translator) {
        translator.setLanguage(this.getDisplayLanguage());

        return this;
    }

    // --- Dedicated getters (game side) ---

    // The forced input mode, null for the automatic choice.
    getControlsDevice() {
        const device = this.get('controls.device');

        return ((device !== DoomSettings.DEVICE_AUTO) ? device : null);
    }

    getPadYInverse() {
        return (this.get('pad.y_inverse') === true);
    }

    getVirtualPadYInverse() {
        return (this.get('virtual_pad.y_inverse') === true);
    }

    // Fraction of the stick travel.
    getVirtualPadMoveDeadZone() {
        return this.getPercent('virtual_pad.move_dead_zone');
    }

    getVirtualPadAimDeadZone() {
        return this.getPercent('virtual_pad.aim_dead_zone');
    }

    getVirtualPadFireDeadZone() {
        return this.getPercent('virtual_pad.fire_dead_zone');
    }

    // 1 = the speed of the non-firing aim gesture.
    getVirtualPadFireSensitivity() {
        return this.getPercent('virtual_pad.fire_sensitivity');
    }

    getMouseYInverse() {
        return (this.get('mouse.y_inverse') === true);
    }

    getDisplayLanguage() {
        return this.get('display.language');
    }

    getDisplayRenderer() {
        return this.get('display.renderer');
    }

    getDisplayCrosshair() {
        return (this.get('display.crosshair') === true);
    }

    getDisplayShowFps() {
        return (this.get('display.show_fps') === true);
    }

    getDisplayDistanceShading() {
        return (this.get('display.distance_shading') === true);
    }

    getDisplayTextureSmoothing() {
        return (this.get('display.texture_smoothing') === true);
    }

    getDisplayWaterEffects() {
        return (this.get('display.water_effects') === true);
    }

    getGameFallDamage() {
        return (this.get('game.fall_damage') === true);
    }

    getGameJump() {
        return (this.get('game.jump') === true);
    }

    getGameCrouch() {
        return (this.get('game.crouch') === true);
    }

    // Linear fraction 0..1: the SoundEngine owns the loudness curve.
    getSoundVolumeMusic() {
        return this.getPercent('sound.volume_music');
    }

    getSoundVolumeEffects() {
        return this.getPercent('sound.volume_effects');
    }

    getMultiplayerNickname() {
        return this.get('multiplayer.nickname');
    }

    getMultiplayerFriendlyFire() {
        return (this.get('multiplayer.friendly_fire') === true);
    }

    getMultiplayerDeathmatchMonsters() {
        return (this.get('multiplayer.dm_monsters') === true);
    }

    // null: no limit.
    getMultiplayerFragLimit() {
        return this._getLimit('multiplayer.frag_limit');
    }

    // Minutes, null: no limit.
    getMultiplayerTimeLimit() {
        return this._getLimit('multiplayer.time_limit');
    }

    // DoomSettings.DEATHMATCH_WEAPONS_STAY | DEATHMATCH_ITEMS_RESPAWN
    getMultiplayerDeathmatchItems() {
        return this.get('multiplayer.dm_items');
    }

    _getLimit(key) {
        const value = this.get(key);

        return ((value === DoomSettings.LIMIT_NONE) ? null : parseInt(value, 10));
    }
}

DoomSettings.LIMIT_NONE               = 'none';
DoomSettings.DEVICE_AUTO              = 'auto';
DoomSettings.AXIS_NONE                = 'none';
DoomSettings.AXIS_CODE                = /^[+-]\d+$/;
DoomSettings.BINDING_TYPES            = ['char', 'padButton', 'padAxis'];
DoomSettings.UNBOUND_VALUES           = {char: '', padButton: null, padAxis: DoomSettings.AXIS_NONE};
DoomSettings.DEATHMATCH_WEAPONS_STAY  = 'weapons_stay';
DoomSettings.DEATHMATCH_ITEMS_RESPAWN = 'items_respawn';

const doomSettings = new DoomSettings();
