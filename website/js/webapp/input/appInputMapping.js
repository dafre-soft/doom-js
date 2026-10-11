/**
 * Action → control tables shared by the keyboard and the gamepad: a page
 * declares its actions with their default control, the player's choices
 * override them one by one.
 */
class AppInputMapping {
    /**
     * Unknown actions are ignored, missing ones keep their defaults.
     *
     * @param {object}      defaults  - {action: control}
     * @param {object|null} overrides - {action: control}
     * @returns {object} a new table
     */
    static merge(defaults, overrides) {
        const merged = Object.assign({}, defaults);
        for (const key of Object.keys(overrides ?? {})) {
            if (merged[key] !== undefined) {
                merged[key] = overrides[key];
            }
        }

        return merged;
    }
}
