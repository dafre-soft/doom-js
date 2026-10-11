let AppInputKeyboard_private = null;

/**
 * Physical keyboard state, read by `KeyboardEvent.code` (layout independent:
 * WASD = ZQSD on AZERTY), plus an optional action table (setActionDefaults /
 * setMapping) so a page reads actions the player can rebind.
 *
 * Soft singleton: `new AppInputKeyboard()` returns the page instance, its listeners
 * living as long as the page.
 */
class AppInputKeyboard {
    constructor() {
        if (AppInputKeyboard_private) {
            return AppInputKeyboard_private;
        }
        AppInputKeyboard_private = this;

        this._keys     = new Set();
        this._defaults = {};
        this._mapping  = {};

        document.addEventListener('keydown', (e) => {
            this._keys.add(e.code);
            // Browser shortcuts (Ctrl+S/D/F…) are cancelled outside text fields;
            // Ctrl+Q/Ctrl+W are privileged and cannot be.
            const typing = ((e.target instanceof HTMLInputElement) || (e.target instanceof HTMLTextAreaElement));
            if (e.ctrlKey && !typing && (e.code.startsWith('Key') || e.code.startsWith('Digit'))) {
                e.preventDefault();
            }
            // Tab would walk the browser focus, and a focused button then eats
            // the next Enter as a native re-click; Space would re-click it as
            // well, or scroll the page.
            if (((e.code === 'Tab') || (e.code === 'Space')) && !typing) {
                e.preventDefault();
            }
        });
        document.addEventListener('keyup', (e) => {
            this._keys.delete(e.code);
        });
        // A keyup fired while the page has lost focus (Alt+Tab with a key held)
        // never reaches us — clear everything so no key stays stuck down.
        window.addEventListener('blur', () => {
            this._keys.clear();
        });
    }

    /**
     * The page's actions and their default key, '' = unmapped. Resets the
     * player's choices.
     *
     * @param {object} defaults - {action: code}
     */
    setActionDefaults(defaults) {
        this._defaults = Object.assign({}, defaults);
        this._mapping  = Object.assign({}, defaults);

        return this;
    }

    /**
     * @param {object} mapping - {action: code}, '' unmapping the action
     */
    setMapping(mapping) {
        this._mapping = AppInputMapping.merge(this._defaults, mapping);

        return this;
    }

    // True while the key bound to the action is held ('' or unknown: never).
    readAction(action) {
        const code = this._mapping[action];
        if ((code === undefined) || (code === '')) {
            return false;
        }

        return this._keys.has(code);
    }

    // True while the given physical key code is held, whatever the mapping.
    readKey(code) {
        return this._keys.has(code);
    }
}
