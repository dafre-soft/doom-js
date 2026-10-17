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
 *   setInterval(() => { const v = doomApi.getView(); }, 50); // feed the AI from it
 * The app loads ~250 scripts at boot: until they are in, window.doomApi is a
 * placeholder — check doomApi.isReady(), or await doomApi.waitReady().
 */
class DoomJsApi {
    constructor() {
        this._game         = null;
        this._drawCallback = null;
        this._miniMapOn    = false;
        this._pendingGame  = null;
        this._booted       = false;
        this._launching    = false;
    }

    // --- Readiness: what "js долго грузятся" is about ---

    /**
     * The bootstrap loads ~250 scripts one after another before the app — and
     * with it this file — exists. Until then `doomApi` is undefined in the
     * console; poll this instead of guessing when the load finished.
     *
     * @returns {boolean} true once the app's scripts are in and a game can run
     */
    isReady() {
        return this._booted;
    }

    /**
     * Resolves when the app has booted and a game is running (started from the
     * menus or through launch()); never rejects, so it can be awaited right
     * after page load.
     *
     * @param {{timeoutMs?: number}} options
     * @returns {Promise<boolean>} false on timeout
     */
    async waitReady(options = {}) {
        const timeoutMs = options.timeoutMs ?? 120000;
        const deadline  = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (this.isReady() && this.isRunning()) {
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        return false;
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
        if (this._launching) {
            throw new Error('doomApi.launch: a launch is already in progress — wait for its promise');
        }
        this._launching = true;
        try {
            return await this._launchLocked(options);
        } finally {
            this._launching = false;
        }
    }

    async _launchLocked(options) {
        // A menu-built game may have been offered while none was bound yet.
        if ((this._game === null) && (this._pendingGame !== null)) {
            this.bindGame(this._pendingGame);
            this._pendingGame = null;
        }

        const resolved  = await this._resolveWadFile(options);
        const wadFile   = resolved.wadFile;
        const meta      = resolved.meta;
        let levelCode = options.levelCode;
        if ((levelCode === undefined) || (levelCode === null)) {
            const names = wadFile.getLevelNames();
            if (names.length === 0) {
                throw new Error('doomApi.launch: the WAD carries no levels');
            }
            levelCode = names[0];
        }
        await doomSound.loadForWad(wadFile, meta.id);

        const game = new DoomGame();
        this.bindGame(game);
        await game.startFromWad(wadFile, levelCode, meta, null,
            ((options.skill !== undefined) && (options.skill !== null))
                ? options.skill : DoomSimulation.DEFAULT_SKILL);
        if (options.maxSpeed !== undefined) {
            game.setMaxSpeed(options.maxSpeed);
        }
        if (options.cornerMap === true) {
            this.showMap({corner: true});
        }
        if (options.autoStart !== false) {
            this.simulateStartPress(game);
        }

        return game;
    }

    /**
     * The simulated "start game" press, safe to call at any time: a plain
     * single-player level needs nothing; a pending multiplayer start is run
     * once the lobby opened.
     */
    simulateStartPress(game = null) {
        const target = ((game !== null) ? game : this._requireGame());
        setTimeout(() => {
            try {
                target.simulateStartPress();
            } catch (error) {
                console.error('doomApi.simulateStartPress', error);
            }
        }, 300);

        return this;
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
            hud.setCorner(true);
            this._miniMapOn = true;
        } else if (options.corner === false) {
            hud.setCorner(false);
            this._miniMapOn = false;
        }
        hud.setVisible(true);

        return this;
    }

    hideMap() {
        this._requireHud().setVisible(false);
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

    /**
     * @returns {Promise<{wadFile: WadFile, meta: object}>}
     */
    async _resolveWadFile(options) {
        if (options.arrayBuffer !== undefined) {
            return {
                wadFile: new WadFile(options.arrayBuffer).parse(),
                meta:    {id: ((options.wadId !== undefined) ? options.wadId : 'api'), name: 'api.wad'}
            };
        }
        const registry = await new WadRegistry(new WadStorage()).init();

        // A numeric wadId is a stored record's id; 'doom', 'heretic', ... are
        // not: they match the known editions by name/title, then the url.
        let wanted = String(options.wadId ?? '');
        if (wanted === '') {
            if (options.url === undefined) {
                throw new Error('doomApi.launch: pass {wadId}, {arrayBuffer} or {url}');
            }
            const wadImport = await registry.addFromUrl(options.url);

            return {wadFile: await registry.getWadFile(wadImport.meta.id), meta: wadImport.meta};
        }

        const list = await registry.getList();
        const lower = wanted.toLowerCase();
        const match = list.find((meta) => String(meta.id) === wanted)
            ?? list.find((meta) => String(meta.name ?? '').toLowerCase().startsWith(lower))
            ?? list.find((meta) => String(meta.title ?? '').toLowerCase().includes(lower))
            ?? list[0]
            ?? null;
        if ((match === null) || (match.id === undefined)) {
            if (options.url !== undefined) {
                const wadImport = await registry.addFromUrl(options.url);

                return {wadFile: await registry.getWadFile(wadImport.meta.id), meta: wadImport.meta};
            }
            throw new Error('doomApi.launch: no WAD stored with id "' + wanted + '" — import one first, or pass {arrayBuffer} / {url}');
        }

        return {wadFile: await registry.getWadFile(match.id), meta: match};
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

// The singleton every script reaches. window.doomApi is a placeholder Proxy
// installed by index.html before the boot; once this file is in, the proxy
// forwards to the real object through window.realDoomApi — and window.doomApi
// itself, for any code (or console) that reads it directly.
const doomApi = new DoomJsApi();
window.realDoomApi = doomApi;
window.doomApi     = doomApi;
doomApi.api        = {draw: (callback) => doomApi.draw(callback)};
doomApi.setMaxSpeed = (value) => doomApi._requireGame().setMaxSpeed(value);

// The API loads before the game classes exist: it waits for the first game
// built by the menus, so an already-running game can be driven without a
// launch() call. DoomGame's constructor offers itself here; launch() binds
// its own game explicitly and is unaffected.
doomApi._pendingGame = null;
DoomJsApi.prototype.offerGame = function (game) {
    if ((this.getGame() === null) || (this.getGame() === undefined)) {
        this.bindGame(game);
    } else {
        this._pendingGame = game;
    }

    return this;
};

// A game offered while only the placeholder existed — the menu had already
// built one before this file loaded.
if ((window._earlyMenuGame !== undefined) && (window._earlyMenuGame !== null)) {
    doomApi.offerGame(window._earlyMenuGame);
    window._earlyMenuGame = null;
}

// The app is up: main.js's ready callback ran before this last script started.
doomApi._booted = true;
