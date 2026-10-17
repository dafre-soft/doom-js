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
        // The boot runs the scripts in ordered batches; a launch fired from
        // the console before the last batch landed would miss the classes it
        // needs (WadFile, profiles, DoomGame). Wait for the app instead of
        // crashing with a ReferenceError.
        if (!this.isReady()) {
            const booted = await this.waitReady({timeoutMs: options.timeoutMs ?? 120000});
            if (!booted) {
                throw new Error('doomApi.launch: the app is still loading after the timeout — check the console for boot errors');
            }
        }

        // A menu-built game may have been offered while none was bound yet.
        if ((this._game === null) && (this._pendingGame !== null)) {
            this.bindGame(this._pendingGame);
            this._pendingGame = null;
        }

        const resolved  = await this._resolveWadFile(options);
        const wadFile   = resolved.wadFile;
        const meta      = resolved.meta;
        // No profile probing through the IndexedDB registry: the code comes
        // straight from the call ({profile} / {wadId} — 'doom', 'freedoom',
        // 'heretic', 'tnt', 'plutonia'), or is sniffed from the WAD header.
        // Resolved lazily, after the whole boot finished — during a launch
        // fired early all the profile classes are guaranteed to be evaluated.
        const wantedCode = resolved.profileCode ?? DoomJsApi.sniffProfileCode(wadFile);
        const list       = ((typeof GameProfileList === 'function') ? new GameProfileList() : null);
        let profile      = ((list !== null) ? list.getByCode(wantedCode) : null);
        if ((profile === null) || (wantedCode === null)) {
            // Last resort (e.g. a stale cached manifest): probe the WAD bytes.
            profile = ((list !== null) ? list.getForWad(wadFile) : null);
        }
        let levelCode = options.levelCode;
        if ((levelCode === undefined) || (levelCode === null)) {
            const names = wadFile.getLevelNames();
            if (names.length === 0) {
                throw new Error('doomApi.launch: the WAD carries no levels');
            }
            levelCode = names[0];
        }
        if ((typeof doomSound !== 'undefined') && (doomSound !== null)) {
            doomSound.loadForWad(wadFile, meta.id);
        }

        const game = new DoomGame();
        this.bindGame(game);
        // The level's own sounds and music start with the level: a launch from
        // the console must not wait for the menu flow that normally does it.
        game.startSoundsForWad(wadFile, meta.id);
        await game.startFromWad(wadFile, levelCode, meta, null,
            ((options.skill !== undefined) && (options.skill !== null))
                ? options.skill : DoomSimulation.DEFAULT_SKILL, profile);
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
     * Named editions the API can fetch by URL without any profile/registry
     * lookup. Fill in your own local links (serve the .wad over http, e.g.
     * put it next to the site: "/wads/doom.wad"); a file:// path is offered
     * through the system file picker where the browser allows it.
     */
    static BUILT_IN_WADS = {
        doom:      {url: '/wads/doom1.wad',      name: 'doom1.wad',      profile: 'doom'},
        doom1:     {url: '/wads/doom1.wad',      name: 'doom1.wad',      profile: 'doom'},
        doom2:     {url: '/wads/doom2.wad',      name: 'doom2.wad',      profile: 'doom'},
        freedoom:  {url: '/wads/freedoom1.wad',  name: 'freedoom1.wad',  profile: 'freedoom'},
        heretic:   {url: '/wads/heretic.wad',    name: 'heretic.wad',    profile: 'heretic'},
        tnt:       {url: '/wads/tnt.wad',        name: 'tnt.wad',        profile: 'tnt'},
        plutonia:  {url: '/wads/plutonia.wad',   name: 'plutonia.wad',   profile: 'plutonia'}
    };

    /**
     * @returns {Promise<{wadFile: WadFile, meta: object, profileCode?: string}>}
     */
    async _resolveWadFile(options) {
        // 1. A raw ArrayBuffer handed over directly.
        if (options.arrayBuffer !== undefined) {
            return {
                wadFile: new WadFile(options.arrayBuffer).parse(),
                meta:    {id: ((options.wadId !== undefined) ? options.wadId : 'api'), name: 'api.wad'},
                profileCode: DoomJsApi._profileCodeOption(options)
            };
        }

        // 2. A link to the .wad file — http(s), or file:// when the page runs
        // from the filesystem. No profiles, no IndexedDB registry: fetch and parse.
        const url = options.url ?? options.path ?? options.file;
        if ((url !== undefined) && (url !== null)) {
            const wanted = DoomJsApi._profileCodeOption(options);
            if (String(url).toLowerCase().startsWith('file://')) {
                const buffer = await DoomJsApi._readFileUrl(url);

                return {
                    wadFile: new WadFile(buffer).parse(),
                    meta:    {id: wanted ?? 'file', name: DoomJsApi._fileNameOf(url)},
                    profileCode: wanted
                };
            }

            return {
                wadFile: await this._fetchWadFile(url),
                meta:    {id: wanted ?? 'url', name: DoomJsApi._fileNameOf(url)},
                profileCode: wanted
            };
        }

        // 3. Named editions load straight from the served /wads/ folder — no
        // profiles registry, no IndexedDB: fetch the link and parse it. The
        // table is editable at runtime: doomApi.addWad('my.wad', '/wads/my.wad', 'doom').
        const wanted = String(options.wadId ?? '').toLowerCase();
        const builtIn = DoomJsApi.BUILT_IN_WADS[wanted];
        if ((builtIn !== undefined) && (builtIn !== null)) {
            return {
                wadFile: await this._fetchWadFile(builtIn.url),
                meta:    {id: wanted, name: builtIn.name},
                profileCode: builtIn.profile
            };
        }

        // 4. Anything else: a WAD previously imported into storage, by id or title.
        let match = null;
        try {
            const registry = await new WadRegistry(new WadStorage()).init();
            const list = await registry.getList();
            match = list.find((meta) => String(meta.id) === wanted)
                ?? list.find((meta) => String(meta.name ?? '').toLowerCase().startsWith(wanted))
                ?? list.find((meta) => String(meta.title ?? '').toLowerCase().includes(wanted))
                ?? null;
            if ((match !== null) && (match.id !== undefined)) {
                return {wadFile: await registry.getWadFile(match.id), meta: match, profileCode: DoomJsApi._profileCodeOption(options)};
            }
        } catch (error) {
            console.warn('doomApi.launch: the WAD registry is unavailable', error);
        }

        throw new Error('doomApi.launch: no WAD for "' + wanted + '" — pass {url: "/path/game.wad"} (http/file link) or one of: '
            + Object.keys(DoomJsApi.BUILT_IN_WADS).join(', ')
            + '; register your own with doomApi.addWad(name, url, profileCode)');
    }

    /**
     * Register a downloadable WAD under a short name so launch({wadId: name})
     * resolves it without the storage registry.
     *
     * @param {string} name - key for launch({wadId})
     * @param {string} url - http(s) link to the .wad (e.g. '/wads/my.wad')
     * @param {string|null} profileCode - 'doom'|'doom2'|'freedoom'|'heretic'|'tnt'|'plutonia'|null to sniff
     */
    addWad(name, url, profileCode = null) {
        DoomJsApi.BUILT_IN_WADS[String(name).toLowerCase()] = {
            url: url, name: DoomJsApi._fileNameOf(url), profile: profileCode
        };

        return this;
    }

    /**
     * @param {string} url - http(s) link to a .wad
     * @returns {Promise<WadFile>}
     */
    async _fetchWadFile(url) {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('doomApi.launch: HTTP ' + response.status + ' on ' + url);
        }

        return new WadFile(await response.arrayBuffer()).parse();
    }

    static _profileCodeOption(options) {
        const code = options.profile ?? options.gameProfile ?? null;

        return ((code !== null) ? String(code).toLowerCase() : null);
    }

    static _fileNameOf(url) {
        try {
            return new URL(url, window.location.href).pathname.split('/').pop() || url;
        } catch (error) {
            return String(url);
        }
    }

    /**
     * Read a file:// URL through the File System Access API (showOpenFilePicker
     * only works over https/localhost). Throws a guiding error otherwise.
     *
     * @param {string} fileUrl
     * @returns {Promise<ArrayBuffer>}
     */
    static async _readFileUrl(fileUrl) {
        if ((window.showOpenFilePicker !== undefined) && (window.showOpenFilePicker !== null)) {
            const ext = (fileUrl.toLowerCase().endsWith('.iwad') ? 'iwad' : 'wad');
            const [handle] = await window.showOpenFilePicker({
                types: [{description: 'WAD', accept: {'application/octet-stream': ['.' + ext, '.wad', '.pk3']}}]
            });
            const file = await handle.getFile();

            return await file.arrayBuffer();
        }

        throw new Error('doomApi.launch: cannot open "' + fileUrl + '" — browsers forbid reading file:// from an http page. Serve the .wad over http and pass {url: "/path/game.wad"}, or hand over {arrayBuffer}.');
    }

    /**
     * Guess the game family from the level lump names when no profile code was
     * given: E1Mx lumps are the Doom I format, MAPxx the Doom II one, HEXMAPx
     * Heretic's.
     *
     * @param {WadFile} wadFile
     * @returns {string|null}
     */
    static sniffProfileCode(wadFile) {
        const names = wadFile.getLevelNames();
        if (names.some((name) => /^HEXMAP/i.test(name))) {
            return 'heretic';
        }
        if (names.some((name) => /^E\dM\d$/i.test(name))) {
            return 'doom';
        }
        if (names.some((name) => /^MAP\d\d$/i.test(name))) {
            return 'doom';
        }

        return null;
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
