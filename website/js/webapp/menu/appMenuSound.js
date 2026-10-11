/**
 * Hook through which the menus voice their interactions: the page plugs its own
 * sounds in (setPlayer), the menus stay silent without one.
 */
class AppMenuSound {
    /**
     * @param {function(string)|null} player - receives one of the AppMenuSound events
     */
    static setPlayer(player) {
        AppMenuSound._player = player;
    }

    /**
     * @param {string} event
     */
    static play(event) {
        if (AppMenuSound._player !== null) {
            AppMenuSound._player(event);
        }
    }
}

AppMenuSound._player = null;
// A control pressed, the highlight moved, a value cycled, a step back, a
// confirmation asked, a refused input.
AppMenuSound.CHOOSE  = 'choose';
AppMenuSound.CURSOR  = 'cursor';
AppMenuSound.CHANGE  = 'change';
AppMenuSound.BACKUP  = 'backup';
AppMenuSound.PROMPT  = 'prompt';
AppMenuSound.INVALID = 'invalid';
