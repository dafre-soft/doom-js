let AppInputGamepad_private = null;

/**
 * Physical gamepad (Gamepad API), shared by the menus and the game of a page.
 *
 * The browser only exposes a gamepad after a button has been pressed on it
 * (anti-fingerprinting), so isAvailable() stays false until then. Gamepad
 * objects are snapshots: a fresh getGamepads() call is needed on every read.
 * The W3C "standard" mapping is preferred when several pads are connected.
 *
 * A page may declare its actions (buttons) and stick slots (axes) with their
 * defaults, then let the player rebind them; the menus follow those bindings
 * through setMenuBindings. Soft singleton: `new AppInputGamepad()` returns the page
 * instance.
 */
class AppInputGamepad {
    // The dead-zone rescale also used by on-screen sticks: the value restarts
    // at 0 on the dead-zone edge and still reaches 1 at full deflection.
    static rescaleDeadZone(magnitude, deadZone) {
        if (magnitude < deadZone) {
            return 0;
        }
        return (magnitude - deadZone) / (1 - deadZone);
    }

    constructor() {
        if (AppInputGamepad_private) {
            return AppInputGamepad_private;
        }
        AppInputGamepad_private = this;

        this._index          = null;
        this._deadZone       = AppInputGamepad.DEAD_ZONE;
        this._buttonDefaults = {};
        this._buttonMapping  = {};
        this._reboundActions = new Set();
        this._axisDefaults   = {};
        this._axisMapping    = {};
        this._menuBindings   = {stickX: null, stickY: null, start: null};
    }

    /**
     * The page's actions and stick slots with their defaults. Resets the
     * player's choices.
     *
     * @param {object} buttons - {action: index|null}, 0-based button indices
     * @param {object} axes    - {slot: {index, inverted}}, hardware convention (right and down positive)
     */
    setActionDefaults(buttons, axes) {
        this._buttonDefaults = Object.assign({}, buttons);
        this._buttonMapping  = Object.assign({}, buttons);
        this._reboundActions = new Set();
        this._axisDefaults   = Object.assign({}, axes);
        this._axisMapping    = Object.assign({}, axes);

        return this;
    }

    /**
     * @param {object} mapping - {action: index|null}, null unmapping the action
     */
    setButtonMapping(mapping) {
        this._buttonMapping  = AppInputMapping.merge(this._buttonDefaults, mapping);
        this._reboundActions = new Set(Object.keys(mapping ?? {}));

        return this;
    }

    /**
     * @param {object} mapping - {slot: {index, inverted}}, an index null unmapping the slot
     */
    setAxisMapping(mapping) {
        this._axisMapping = AppInputMapping.merge(this._axisDefaults, mapping);

        return this;
    }

    /**
     * Which slots and action drive the menus, so a stick or a Start button the
     * player rebound for the page also moves its menus. Without them, the menus
     * read the left stick and Start of the standard layout.
     *
     * @param {{stickX: string|null, stickY: string|null, start: string|null}} bindings
     */
    setMenuBindings(bindings) {
        this._menuBindings = Object.assign({stickX: null, stickY: null, start: null}, bindings);

        return this;
    }

    /**
     * Scans the connected gamepads and keeps one as active, preferring the
     * W3C "standard" mapping, with a fallback on the first connected pad.
     * @returns {boolean}
     */
    isAvailable() {
        if (!navigator.getGamepads) {
            this._index = null;
            return false;
        }
        const pads   = navigator.getGamepads();
        let index    = null;
        let fallback = null;
        for (let i = 0; i < pads.length; i++) {
            if ((pads[i] === null) || !pads[i].connected) {
                continue;
            }
            if (pads[i].mapping === 'standard') {
                index = i;
                break;
            }
            if (fallback === null) {
                fallback = i;
            }
        }
        if (index === null) {
            index = fallback;
        }
        this._index = index;
        return (this._index !== null);
    }

    // Human-readable name of the active pad (Gamepad.id), null without one.
    getName() {
        const pad = this._getPad();

        return ((pad !== null) ? pad.id : null);
    }

    /**
     * The browser's gamepad id stripped of its vendor / product numbers
     * (Firefox "054c-0ce6-Name", Chrome "Name (STANDARD GAMEPAD Vendor: 054c
     * Product: 0ce6)"), cut to fit a settings line.
     * @param {string} id
     * @returns {string}
     */
    static displayName(id) {
        const name = (id.replace(/^[0-9a-f]{1,4}-[0-9a-f]{1,4}-/i, '').replace(/\s*\([^)]*Vendor:[^)]*\)\s*$/i, '').trim() || id.trim());
        if (name.length <= AppInputGamepad.NAME_MAX_LENGTH) {
            return name;
        }

        return name.slice(0, (AppInputGamepad.NAME_MAX_LENGTH - 1)).trimEnd() + '…';
    }

    readRawButtons() {
        const pad = this._getPad();

        return ((pad !== null) ? Array.from(pad.buttons, (button) => this._isDown(button)) : []);
    }

    readRawAxes() {
        const pad = this._getPad();

        return ((pad !== null) ? Array.from(pad.axes) : []);
    }

    // A default on the d-pad is only trusted on the standard mapping, where
    // 12-15 are the d-pad (see readDpadUp); a button the player bound is.
    readAction(action) {
        const index = this._buttonMapping[action];
        if ((index === null) || (index === undefined)) {
            return false;
        }
        if (!this._reboundActions.has(action) && (index >= AppInputGamepad.DPAD_FIRST_BUTTON) && !this._isStandardMapping()) {
            return false;
        }

        return this._button(index);
    }

    /**
     * @param {string} slot
     * @returns {number} -1..+1 past the dead zone, hardware convention (right and down positive)
     */
    readSlot(slot) {
        const binding = this._axisMapping[slot];
        if ((binding === undefined) || (binding.index === null)) {
            return 0;
        }

        return this._axis(binding.index, binding.inverted);
    }

    // D-pad, only trusted on the standard mapping (buttons 12-15). Raw layouts
    // expose the d-pad as a hat axis on other slots, where 12-15 may be
    // unrelated physical buttons — there, the menus fall back on the stick.
    readDpadUp() {
        return (this._isStandardMapping() && this._button(AppInputGamepad.DPAD_FIRST_BUTTON));
    }

    readDpadDown() {
        return (this._isStandardMapping() && this._button(AppInputGamepad.DPAD_FIRST_BUTTON + 1));
    }

    readDpadLeft() {
        return (this._isStandardMapping() && this._button(AppInputGamepad.DPAD_FIRST_BUTTON + 2));
    }

    readDpadRight() {
        return (this._isStandardMapping() && this._button(AppInputGamepad.DPAD_FIRST_BUTTON + 3));
    }

    // Fixed menu buttons: validate on face button 0 (✕ on a DualSense), back
    // on face button 1 (○).
    readButtonValidate() {
        return this._button(AppInputGamepad.VALIDATE_BUTTON);
    }

    readButtonBack() {
        return this._button(AppInputGamepad.BACK_BUTTON);
    }

    readMenuStart() {
        const action = this._menuBindings.start;

        return ((action !== null) ? this.readAction(action) : this._button(AppInputGamepad.START_BUTTON));
    }

    readMenuStickX() {
        const slot = this._menuBindings.stickX;

        return ((slot !== null) ? this.readSlot(slot) : this._axis(AppInputGamepad.LEFT_STICK_X, false));
    }

    // Down positive, like the hardware.
    readMenuStickY() {
        const slot = this._menuBindings.stickY;

        return ((slot !== null) ? this.readSlot(slot) : this._axis(AppInputGamepad.LEFT_STICK_Y, false));
    }

    // --- Internal ---

    _isStandardMapping() {
        const pad = this._getPad();

        return ((pad !== null) && (pad.mapping === 'standard'));
    }

    _getPad() {
        if ((this._index === null) || !navigator.getGamepads) {
            return null;
        }
        const pad = navigator.getGamepads()[this._index];
        if ((pad === null) || (pad === undefined) || !pad.connected) {
            return null;
        }
        return pad;
    }

    // The dead zone only applies to the sticks: they all drift around zero.
    _axis(index, inverted) {
        const pad = this._getPad();
        if ((pad === null) || (pad.axes.length <= index)) {
            return 0;
        }
        const value  = ((inverted) ? -pad.axes[index] : pad.axes[index]);
        const scaled = AppInputGamepad.rescaleDeadZone(Math.abs(value), this._deadZone);
        return ((value < 0) ? -scaled : scaled);
    }

    _button(index) {
        const pad = this._getPad();
        if ((pad === null) || (pad.buttons.length <= index)) {
            return false;
        }
        return this._isDown(pad.buttons[index]);
    }

    // Analog triggers report a pressed flag at a light touch: a button counts
    // as down past half of its travel.
    _isDown(button) {
        return (button.value > AppInputGamepad.PRESS_THRESHOLD);
    }
}

AppInputGamepad.DEAD_ZONE         = 0.15;
AppInputGamepad.PRESS_THRESHOLD   = 0.5;
AppInputGamepad.VALIDATE_BUTTON   = 0;
AppInputGamepad.BACK_BUTTON       = 1;
AppInputGamepad.START_BUTTON      = 9;
AppInputGamepad.DPAD_FIRST_BUTTON = 12;
AppInputGamepad.LEFT_STICK_X      = 0;
AppInputGamepad.LEFT_STICK_Y      = 1;
AppInputGamepad.NAME_MAX_LENGTH   = 24;
