/**
 * The physical gamepad as an FPS controller: the game actions and stick slots
 * of the engine laid over the page's AppInputGamepad, read through the same API as
 * InputVirtualGamepad. The menus share the same AppInputGamepad, so they follow the
 * player's stick and pause bindings.
 */
class InputGamepad {
    // Default button of each game action, indices (0-based) of the DualSense
    // raw layout; null = unmapped.
    static get DEFAULT_MAPPING() {
        return {
            run:        10,
            jump:       1,
            crouch:     0,
            action:     3,
            fire:       7,
            weaponPrev: 4,
            weaponNext: 5,
            map:        12,
            pause:      9
        };
    }

    // Default stick axis of each slot, in the hardware convention (right and
    // down positive), on the same DualSense raw layout [LX, LY, RX, L2, R2, RY].
    static get DEFAULT_AXIS_MAPPING() {
        return {
            moveX: {index: 0, inverted: false},
            moveY: {index: 1, inverted: false},
            lookX: {index: 2, inverted: false},
            lookY: {index: 5, inverted: false}
        };
    }

    constructor() {
        this._pad = new AppInputGamepad()
            .setActionDefaults(InputGamepad.DEFAULT_MAPPING, InputGamepad.DEFAULT_AXIS_MAPPING)
            .setMenuBindings({stickX: 'moveX', stickY: 'moveY', start: 'pause'});
    }

    getDevice() {
        return this._pad;
    }

    isAvailable() {
        return this._pad.isAvailable();
    }

    getName() {
        return this._pad.getName();
    }

    /**
     * @param {object} mapping - {action: int|null}, see DEFAULT_MAPPING
     */
    setButtonMapping(mapping) {
        this._pad.setButtonMapping(mapping);

        return this;
    }

    /**
     * @param {object} mapping - {slot: {index, inverted}}, see DEFAULT_AXIS_MAPPING
     */
    setAxisMapping(mapping) {
        this._pad.setAxisMapping(mapping);

        return this;
    }

    readJoy1X() {
        return this._pad.readSlot('moveX');
    }

    // Stick up is -1 in hardware, forward is +1 in the engine convention
    readJoy1Y() {
        return -this._pad.readSlot('moveY');
    }

    readJoy2X() {
        return this._pad.readSlot('lookX');
    }

    // Stick down is +1, same direction as a mouse moving down
    readJoy2Y() {
        return this._pad.readSlot('lookY');
    }

    readButtonCrouch() {
        return this._pad.readAction('crouch');
    }

    readButtonJump() {
        return this._pad.readAction('jump');
    }

    readButtonAction() {
        return this._pad.readAction('action');
    }

    readButtonFire() {
        return this._pad.readAction('fire');
    }

    readButtonPause() {
        return this._pad.readAction('pause');
    }

    readButtonRun() {
        return this._pad.readAction('run');
    }

    readButtonWeaponPrev() {
        return this._pad.readAction('weaponPrev');
    }

    readButtonWeaponNext() {
        return this._pad.readAction('weaponNext');
    }

    readButtonMap() {
        return this._pad.readAction('map');
    }
}
