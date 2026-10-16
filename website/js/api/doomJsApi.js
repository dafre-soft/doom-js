/**
 * Public JavaScript API over the game (window.doomApi). It lets an outside
 * script — an AI agent, a bot, a test harness — start the player on a map,
 * read what the player sees, draw overlays on the view and on a minimap in
 * the top-right corner, and run the game at maximum speed.
 *
 * The current game registers itself here through DoomGame; before any game
 * is running only launch() (and its state queries) work.
 *
 *   await doomApi.launch({wadId: 'doom', levelCode: 'E1M1', maxSpeed: true});
 *   doomApi.showMap({corner: true});
 *   doomApi.draw((ctx, info) => { ... });            // overlay on the view
 *   setInterval(() => { const v = doomApi.getView(); /* feed the AI */ }, 50);
 */
class DoomJsApi {
    constructor() {
        this._game         = null;
        this._drawCallback = null;
        this._miniMapOn    = false;
    }

    // --- Game binding (called by DoomGame itself, not for the API user) ---

    bindGame(game) {
        this._game = game;
        if ((this._game !== null) && (this._drawCallback !== null)) {
            this._game.setDrawOverlay(this._drawCallback);
        }

        return this;
    }

    getGame() {
        return this._game;
    }

    // --- Runner: start the player on a map ---

    /**
     * Start the player on a map. Either pass a WAD already loaded as an
     * ArrayBuffer (`arrayBuffer`), or a `wadId` of one stored in the browser.
     *
     * @param {{wadId?: string, arrayBuffer?: ArrayBuffer, levelCode?: string,
     *          skill?: number, maxSpeed?: boolean|number, autoStart?: boolean}} options
     *          autoStart defaults to true: the menu's "start game" press is
     *          simulated so the level runs without a click.
     * @returns {Promise<DoomGame>}
     */
    async launch(options = {}) {
        const wadFile = await this._resolveWadFile(options);
        wadFile.parse();
        const meta  = {id: ((options.wadId !== undefined) ? options.wadId : 'api'), name: 'api.wad'};
        const profile = new GameProfileList().getForWad(wadFile);
        let levelCode = options.levelCode;
        if ((levelCode === undefined) || (levelCode === null)) {
            const names = wadFile.getLevelNames();
            if (names.length === 0) {
                throw new Error('doomApi.launch: the WAD carries no levels');
            }
            levelCode = names[0];
        }
        doomSound.loadForWad(wadFile, meta.id);

        const game = new DoomGame();
        this.bindGame(game);
        await game.startFromWad(wadFile, levelCode, meta, null,
            ((options.skill !== undefined) && (options.skill !== null))
                ? options.skill : DoomSimulation.DEFAULT_SKILL);
        if (options.maxSpeed !== undefined) {
            game.setMaxSpeed(options.maxSpeed);
        }
        if (options.autoStart !== false) {
            game.simulateStartPress();
        }

        return game;
    }

    /**
     * Take over a game already started from the menus, so the API can drive
     * it (a game launched by hand, then handed to the AI).
     *
     * @param {DoomGame} game
     */
    attach(game) {
        return this.bindGame(game);
    }

    isRunning() {
        return ((this._game !== null) && this._game.isRunning());
    }

    stop() {
        if (this._game !== null) {
            this._game.teardownLevel();
        }

        return this;
    }

    // --- Speed ---

    /**
     * Maximum movement speed (true), a chosen multiplier (number), or back to
     * normal (false).
     *
     * @param {boolean|number} value
     */
    setMaxSpeed(value = true) {
        this._requireGame().setMaxSpeed(value);

        return this;
    }

    // --- Map: full automap, or a minimap in the top-right corner ---

    /**
     * Open the automap over the view. With `{corner: true}` it shrinks into a
     * minimap pinned to the top-right corner instead of covering the screen.
     *
     * @param {{corner?: boolean}} options
     */
    showMap(options = {}) {
        const hud = this._requireHud();
        if (options.corner === true) {
            hud.setAutomapCorner(true);
            this._miniMapOn = true;
        } else if (options.corner === false) {
            hud.setAutomapCorner(false);
            this._miniMapOn = false;
        }
        hud.setAutomapVisible(true);

        return this;
    }

    hideMap() {
        this._requireHud().setAutomapVisible(false);
        this._miniMapOn = false;

        return this;
    }

    toggleMap(corner = false) {
        if (this.isMapVisible()) {
            this.hideMap();
        } else {
            this.showMap({corner});
        }

        return this;
    }

    isMapVisible() {
        return ((this._game !== null) && this._game.isAutomapVisible());
    }

    // --- What the player sees (for an AI) ---

    /**
     * Everything an agent needs about the current frame: the player pose and
     * vitals, the canvas size (the overlay callback draws in its pixels), and
     * the bodies around.
     *
     * @returns {object|null} null before a level is shown
     */
    getView() {
        if ((this._game === null) || !this._game.isRunning()) {
            return null;
        }

        return this._game.getPlayerView();
    }

    getPlayer() {
        const view = this.getView();

        return ((view !== null) ? view.player : null);
    }

    getThings() {
        const view = this.getView();

        return ((view !== null) ? view.things : []);
    }

    // --- Drawing over what the player sees (api.draw) ---

    /**
     * Register a callback invoked every rendered frame with a 2D context over
     * the game view: draw boxes, labels, crosshairs on anything the player
     * sees. Pass null to remove it.
     *
     * @param {function|null} callback - (ctx: CanvasRenderingContext2D, info: object)
     */
    draw(callback) {
        this._drawCallback = ((typeof callback === 'function') ? callback : null);
        if (this._game !== null) {
            this._game.setDrawOverlay(this._drawCallback);
        }

        return this;
    }

    // Spelled-out alias of draw(), for clarity at the call site.
    setDrawCallback(callback) {
        return this.draw(callback);
    }

    // --- Internals ---

    async _resolveWadFile(options) {
        if (options.arrayBuffer !== undefined) {
            return new WadFile(options.arrayBuffer);
        }
        if (options.wadId !== undefined) {
            const registry = new WadRegistry(new WadStorage());

            return await registry.getWadFile(options.wadId);
        }
        throw new Error('doomApi.launch: pass {wadId} or {arrayBuffer}');
    }

    _requireGame() {
        if (this._game === null) {
            throw new Error('doomApi: no game running, call launch() first');
        }

        return this._game;
    }

    _requireHud() {
        const hud = this._requireGame().getAutomapHud();
        if (hud === null) {
            throw new Error('doomApi: the level has no automap');
        }

        return hud;
    }
}

// The singleton every script reaches.
const doomApi = new DoomJsApi();
window.doomApi      = doomApi;
window.doomApi.api  = {draw: (callback) => doomApi.draw(callback)};
