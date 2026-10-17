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
        // options.raw === true: no profiles at all — a plain default doom-format
        // profile straight from the WAD bytes (file:// / http links).
        let profile = null;
        if (options.raw !== true) {
            const wantedCode = resolved.profileCode ?? DoomJsApi.sniffProfileCode(wadFile);
            const ListCtor   = (typeof GameProfileList === 'function') ? GameProfileList : window.GameProfileList;
            const list       = ((typeof ListCtor === 'function') ? new ListCtor() : null);
            profile          = ((list !== null) ? list.getByCode(wantedCode) : null);
            if ((profile === null) || (wantedCode === null)) {
                // Last resort (e.g. a stale cached manifest): probe the WAD bytes.
                profile = ((list !== null) ? list.getForWad(wadFile) : null);
            }
        }
        if ((profile === null) || (profile === undefined)) {
            const ProfileCtor = (typeof DefaultGameProfile === 'function') ? DefaultGameProfile : window.DefaultGameProfile;
            profile = new ProfileCtor();
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

        const GameCtor = (typeof DoomGame === 'function') ? DoomGame : window.DoomGame;
        const game = new GameCtor();
        this.bindGame(game);
        // The level's own sounds and music start with the level: a launch from
        // the console must not wait for the menu flow that normally does it.
        game.startSoundsForWad(wadFile, meta.id);
        await game.startFromWad(wadFile, levelCode, meta, null,
            ((options.skill !== undefined) && (options.skill !== null))
                ? options.skill : ((typeof DoomSimulation === 'object' || typeof DoomSimulation === 'function') ? DoomSimulation.DEFAULT_SKILL : window.DoomSimulation.DEFAULT_SKILL), profile);
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

    // --- AI input: drive the player like a human (for bots / neural agents) ---

    /**
     * Hold or release a control, the way a key does; it keeps acting while held.
     * The API owns virtual actions on the keyboard device ('api_forward', ...)
     * that add to whatever a human presses — both work at once.
     *
     * @param {'forward'|'back'|'left'|'right'|'jump'|'crouch'|'run'|'use'|'attack'} key
     * @param {boolean} pressed
     */
    setInput(key, pressed = true) {
        const name = String(key).toLowerCase();
        if (!DoomJsApi.INPUT_KEYS.includes(name)) {
            throw new Error('doomApi.setInput: unknown key "' + name + '" — one of: ' + DoomJsApi.INPUT_KEYS.join(', '));
        }
        this._inputs[name] = (pressed === true);
        this._applyVirtualInputs();

        return this;
    }

    /**
     * Set the movement axes directly, -1..+1 (analog stick semantics):
     * move(x: strafe right, y: forward), plus optional look deltas in degrees.
     * Overrides any held keys until the next setInput/stopMovement call.
     */
    setMove(moveX = 0, moveY = 0, lookYaw = 0, lookPitch = 0) {
        this._moveX   = Math.max(-1, Math.min(1, Number(moveX)));
        this._moveY   = Math.max(-1, Math.min(1, Number(moveY)));
        this._lookYaw += Number(lookYaw);
        this._lookPitch += Number(lookPitch);
        this._applyVirtualInputs();

        return this;
    }

    /** Zero the analog axes and release every held key. */
    stopMovement() {
        this._moveX = 0;
        this._moveY = 0;
        for (const key of DoomJsApi.INPUT_KEYS) {
            this._inputs[key] = false;
        }
        this._applyVirtualInputs();

        return this;
    }

    /**
     * Wire the API's virtual actions into the game's input devices. Idempotent;
     * runs after launch and whenever the inputs are rebuilt.
     */
    _applyVirtualInputs() {
        const game = this._game;
        if ((game === null) || (typeof game.getInputs !== 'function')) {
            return;
        }
        const inputs = game.getInputs();
        if ((inputs === null) || (inputs === undefined)) {
            return;
        }
        if (!this._virtualBound) {
            this._virtualBound = true;
            const api = this;
            const sampler = ((typeof game.getCommandSampler === 'function') ? game.getCommandSampler() : null);
            // Virtual buttons ride the sampler: a button counts as pressed when
            // either the device or the API holds it.
            if ((sampler !== null) && (typeof sampler.addButton === 'function')) {
                sampler.addButton('fire', () => api._inputs.attack);
                sampler.addButton(UserCommand.JUMP,    () => api._inputs.jump);
                sampler.addButton(UserCommand.CROUCH,  () => api._inputs.crouch);
                sampler.addButton(UserCommand.RUN,     () => api._inputs.run);
                sampler.addButton(UserCommand.ACTION,  () => api._inputs.use);
            }
            // The keyboard gains 'api_*' actions; Inputs reads them beside the real keys.
            const keyboard = inputs._keyboard;
            if ((keyboard !== undefined) && (keyboard !== null)) {
                const defaults = {...AppInputKeyboard_privateDefaults(keyboard)};
                for (const action of ['api_forward', 'api_backward', 'api_strafeLeft', 'api_strafeRight']) {
                    if (defaults[action] === undefined) {
                        defaults[action] = '';
                    }
                }
                keyboard.setActionDefaults(defaults);
            }
        }
        // Axes: patch the read once per game — the API values add to the device's.
        if ((inputs._apiPatched !== true) && (typeof inputs.readJoy1X === 'function')) {
            inputs._apiPatched = true;
            const baseX = inputs.readJoy1X.bind(inputs);
            const baseY = inputs.readJoy1Y.bind(inputs);
            const api = this;
            inputs.readJoy1X = function () {
                const k = ((this._keyboard !== undefined) ? this._keyboard : null);
                let extra = 0;
                if (k !== null) {
                    extra = (k.readAction('api_strafeRight') ? 1 : 0) - (k.readAction('api_strafeLeft') ? 1 : 0);
                }
                return clampAxis(baseX() + (extra !== 0 ? extra : api._moveX));
            };
            inputs.readJoy1Y = function () {
                const k = ((this._keyboard !== undefined) ? this._keyboard : null);
                let extra = 0;
                if (k !== null) {
                    extra = (k.readAction('api_forward') ? 1 : 0) - (k.readAction('api_backward') ? 1 : 0);
                }
                return clampAxis(baseY() + (extra !== 0 ? extra : api._moveY));
            };
        }
        // Push the current key state into the virtual actions (a Set-backed
        // table would be cleaner, but the keyboard maps actions to key codes;
        // instead keep a live reader list on the keyboard object itself).
        if ((inputs._keyboard !== undefined) && (inputs._keyboard !== null)) {
            inputs._keyboard._apiActions = this._inputs;
            const k = inputs._keyboard;
            if (k._apiReadPatched !== true) {
                k._apiReadPatched = true;
                const baseRead = k.readAction.bind(k);
                k.readAction = function (action) {
                    if ((this._apiActions !== undefined) && DoomJsApi.VIRTUAL_ACTION_KEYS[action] !== undefined) {
                        return this._apiActions[DoomJsApi.VIRTUAL_ACTION_KEYS[action]] === true;
                    }

                    return baseRead(action);
                };
            }
        }

        return this;
    }

    /**
     * One-shot press: down for holdMs, then released. Async so an agent can
     * await it: `await doomApi.press('attack', 120)`.
     */
    async press(key, holdMs = 60) {
        this.setInput(key, true);
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, holdMs)));
        this.setInput(key, false);

        return this;
    }

    /** Release every held control. */
    releaseAll() {
        for (const key of DoomJsApi.INPUT_KEYS) {
            this.setInput(key, false);
        }

        return this;
    }

    /** The current held-key map {forward: bool, ...}. */
    getInputs() {
        return {...this._inputs};
    }

    /**
     * Turn the view by degrees (yaw += dx, pitch clamped += dy), relative.
     */
    look(dx = 0, dy = 0) {
        const user = this._requireUser();
        user.yaw   = DoomJsApi._normAngle(user.yaw + dx);
        user.pitch = Math.max(-89, Math.min(89, user.pitch + dy));

        return this;
    }

    /** Point the view at absolute yaw/pitch degrees (yaw 0..360, pitch -89..89). */
    setOrientation(yaw = null, pitch = null) {
        const user = this._requireUser();
        if (yaw !== null) {
            user.yaw = DoomJsApi._normAngle(Number(yaw));
        }
        if (pitch !== null) {
            user.pitch = Math.max(-89, Math.min(89, Number(pitch)));
        }

        return this;
    }

    /** Aim the view at a world position {x, y, z} (engine coords, metres). */
    faceTarget(target) {
        const user = this._requireUser();
        const pos  = DoomJsApi._asPosition(target);
        const dx   = pos.x - user.x;
        const dz   = pos.z - user.z;
        const dy   = pos.y - user.y;
        user.yaw   = DoomJsApi._normAngle(Math.atan2(dz, dx) * 180 / Math.PI);
        const flat = Math.sqrt(dx * dx + dz * dz);
        user.pitch = Math.max(-89, Math.min(89, Math.atan2(dy, Math.max(flat, 1e-6)) * 180 / Math.PI));

        return this;
    }

    /**
     * Teleport the player to a spot and snap it onto the sector's floor there.
     *
     * @param {{x?: number, y?: number, z?: number, yaw?: number}} target — engine
     *        coords (x/z the horizontal plane, y up); or Doom map coords via
     *        {doomX, doomY}. Pass only x/z to keep the current height.
     */
    teleportTo(target) {
        const user = this._requireUser();
        const SCALE = (typeof WadConstants !== 'undefined') ? WadConstants.SCALE : window.WadConstants.SCALE;
        let x = user.x, y = user.y, z = user.z;
        if ((target.doomX !== undefined) || (target.doomY !== undefined)) {
            x = (target.doomX !== undefined) ? (target.doomX * SCALE) : x;
            z = (target.doomY !== undefined) ? (target.doomY * SCALE) : z;
        } else {
            if (target.x !== undefined) { x = Number(target.x); }
            if (target.y !== undefined) { y = Number(target.y); }
            if (target.z !== undefined) { z = Number(target.z); }
        }
        user.x = x;
        user.z = z;
        // Snap onto the live floor of the sector under the landing point.
        try {
            const heights = this._levelHeights();
            if (heights !== null) {
                const si = heights.sectorIndexAt(x, z);
                if (si !== null) {
                    y = heights.floorOf(si);
                }
            }
        } catch (error) {
            console.warn('doomApi.teleportTo: floor snap skipped', error);
        }
        user.y = y;
        if (target.yaw !== undefined) {
            user.yaw = DoomJsApi._normAngle(Number(target.yaw));
        }

        return this;
    }

    /**
     * Warp to another level of the running WAD by its lump name ('E1M2', 'MAP05').
     * Keeps the player's equipment and speed settings.
     */
    async warpToLevel(levelCode) {
        const game = this._requireGame();
        const wadFile = game.getWadFile();
        const names = ((wadFile !== null) ? wadFile.getLevelNames() : []);
        const code = String(levelCode).toUpperCase();
        if (!names.includes(code)) {
            throw new Error('doomApi.warpToLevel: no level "' + code + '" in this WAD — available: ' + names.join(', '));
        }
        const snapshot = game.captureSnapshot();
        game.setRestoreSnapshot(snapshot);

        return await game.startFromWad(wadFile, code, null, null, null, game.getProfile());
    }

    /** Restart the current level, keeping the equipment. */
    async restartLevel() {
        return await this.warpToLevel(this._requireGame().getLevelCode());
    }

    /** Switch skill (1..5) right away. */
    setSkill(skill) {
        const value = Math.max(1, Math.min(5, Number(skill)));
        this._skill = value;
        const role = this._requireGame().getRole();
        if ((role !== null) && (typeof role.useProfile === 'function')) {
            role.useProfile(this._requireGame().getProfile(), null, value);
        }

        return this;
    }

    /** Give the player a weapon by code (e.g. 'shotgun'); returns whether it exists. */
    giveWeapon(code) {
        const user = this._requireUser();
        user.declareWeapon(code);
        user.giveWeapon(code);

        return user.hasWeapon(code);
    }

    /** Put a weapon in the hands (no-op when the player lacks it). */
    selectWeapon(code) {
        const user = this._requireUser();
        user.setActiveWeapon(code);

        return user.getActiveWeapon();
    }

    /** Refill health (and optionally armor) — god-mode helper for agents. */
    heal(energy = 100, armor = null) {
        const user = this._requireUser();
        user.setEnergy(Math.min(Number(energy), user.getMaxEnergy()));
        if (armor !== null) {
            user.setArmor(Math.min(Number(armor), user.getMaxArmor()));
        }

        return this;
    }

    /** Respawn a dead player at its start position with default equipment. */
    respawn() {
        const user = this._requireUser();
        if (user.isDead()) {
            user.kill();
        }
        user.setVitals(user.getMaxEnergy(), false, 0, 0);

        return this;
    }

    /**
     * A compact observation for a learning agent: numbers only, one object.
     * Same data as getView() but trimmed for a policy network's input.
     */
    observe() {
        const view = this.getView();
        if (view === null) {
            return null;
        }
        const p = view.player;

        return {
            level: view.levelCode,
            x: p.x, y: p.y, z: p.z,
            yaw: p.yaw, pitch: p.pitch,
            health: p.health, armor: p.armor, dead: p.dead,
            weapon: p.weapon, ammo: p.ammo.current,
            targets: view.things.slice(0, 64).map((t) => ({
                kind: t.kind, x: t.x, y: t.y, z: t.z,
                sx: ((t.screen !== null) ? t.screen.x : -1),
                sy: ((t.screen !== null) ? t.screen.y : -1),
                depth: ((t.screen !== null) ? t.screen.depth : -1)
            }))
        };
    }

    /**
     * Subscribe to per-frame events without drawing anything: the callback gets
     * the same info object the overlay receives. Returns an unsubscribe function.
     */
    onFrame(callback) {
        if (typeof callback !== 'function') {
            throw new Error('doomApi.onFrame: needs a function');
        }
        this._frameListeners.add(callback);
        this._installFrameHook();

        return () => this._frameListeners.delete(callback);
    }

    /** Wait until a condition over the view holds (or timeout): AI scripting. */
    async waitFor(condition, options = {}) {
        const timeoutMs = options.timeoutMs ?? 10000;
        const fn = (typeof condition === 'function')
            ? condition
            : (() => this.isRunning() && (this.getLevelCode() === String(condition).toUpperCase()));
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const view = this.getView();
            if ((view !== null) && fn(view)) {
                return view;
            }
            await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 50));
        }

        return null;
    }

    /** List the levels inside the running WAD. */
    getLevels() {
        const wadFile = this._requireGame().getWadFile();

        return ((wadFile !== null) ? wadFile.getLevelNames() : []);
    }

    /** A PNG data-URL of what the player sees right now — feed it to a vision model. */
    screenshot(mimeType = 'image/png', quality = 0.8) {
        const game = this._requireGame();
        const engine = game.getPresentation().getEngine();
        const canvas = engine.scrCanvas;
        if ((canvas === undefined) || (canvas === null)) {
            throw new Error('doomApi.screenshot: no game canvas yet');
        }

        return canvas.toDataURL(mimeType, quality);
    }

    /** Pause / resume the simulation. */
    setPaused(paused = true) {
        const game = this._requireGame();
        if (paused === true) {
            game.freeze();
        } else {
            game.unfreeze(true);
        }

        return this;
    }

    isPaused() {
        return ((this._game !== null) && this._game.isPaused());
    }

    // --- Internals ---

    /**
     * Named editions the API can fetch by URL without any profile/registry
     * lookup — plain links to .wad files. The default set points at the
     * canonical FreeDOOM release URLs (CORS-enabled), so launch({wadId:'doom'})
     * works out of the box with no local files and no IndexedDB profiles.
     * Override locally: doomApi.addWad('doom', '/wads/doom1.wad') or edit
     * doomApi.WADS directly; an unknown wadId also falls back to
     * '/wads/<id>.wad' served next to the site.
     */
    // CORS-friendly download hosts, tried in order for the repo references
    // below: jsDelivr mirrors GitHub repo files and answers with
    // Access-Control-Allow-Origin: *; github.com release-download links do NOT
    // (the browser blocks them — "NetworkError when attempting to fetch").
    // Entries may also carry plain 'urls' strings (any CORS-enabled host) and a
    // 'local' path served next to the site. The local copy is the reliable one:
    // drop freedoom-phase-1.wad etc. into website/wads/ and no download at all
    // is needed. A runtime override always wins:
    //   doomApi.addWad('dum', '/wads/DOOM.WAD', 'doom');
    static CDN_HOSTS = [
        (u) => 'https://cdn.jsdelivr.net/gh/' + u.owner + '/' + u.repo + '@' + u.ref + '/' + u.path,
        (u) => 'https://raw.githubusercontent.com/' + u.owner + '/' + u.repo + '/' + u.ref + '/' + u.path
    ];

    static _cdn(owner, repo, ref, path) {
        return {owner: owner, repo: repo, ref: ref, path: path};
    }

    static BUILT_IN_WADS = {
        doom:      {local: '/wads/freedoom1.wad', urls: ['https://distro.ibiblio.org/rootplex/dooM/freedoom1.wad'], name: 'freedoom1.wad', profile: 'freedoom'},
        doom1:     {local: '/wads/doom1.wad',     urls: ['https://distro.ibiblio.org/rootplex/dooM/doom1.wad'],      name: 'doom1.wad',     profile: 'doom'},
        doom2:     {local: '/wads/freedoom2.wad', urls: ['https://distro.ibiblio.org/rootplex/dooM/freedoom2.wad'],  name: 'freedoom2.wad', profile: 'freedoom'},
        freedoom:  {local: '/wads/freedoom1.wad', urls: [],                                                    name: 'freedoom1.wad', profile: 'freedoom'},
        freedoom1: {local: '/wads/freedoom1.wad', urls: [],                                                    name: 'freedoom1.wad', profile: 'freedoom'},
        freedoom2: {local: '/wads/freedoom2.wad', urls: [],                                                    name: 'freedoom2.wad', profile: 'freedoom'},
        heretic:   {local: '/wads/heretic.wad',   urls: ['https://distro.ibiblio.org/rootplex/dooM/heretic.wad'],  name: 'heretic.wad',   profile: 'heretic'},
        hexen:     {local: '/wads/hexen.wad',     urls: [],                                                    name: 'hexen.wad',     profile: 'hexen'},
        tnt:       {local: '/wads/tnt.wad',       urls: [],                                                    name: 'tnt.wad',       profile: 'tnt'},
        plutonia:  {local: '/wads/plutonia.wad',  urls: [],                                                    name: 'plutonia.wad',  profile: 'plutonia'}
    };

    /**
     * @returns {Promise<{wadFile: WadFile, meta: object, profileCode?: string}>}
     */
    async _resolveWadFile(options) {
        // 1. A raw ArrayBuffer handed over directly.
        if (options.arrayBuffer !== undefined) {
            return {
                wadFile: new (window.WadFile)(options.arrayBuffer).parse(),
                meta:    {id: ((options.wadId !== undefined) ? options.wadId : 'api'), name: 'api.wad'},
                profileCode: DoomJsApi._profileCodeOption(options)
            };
        }

        // 2. A link to the .wad file — http(s) or a site-local '/wads/x.wad'.
        // file:// links are impossible from an http page (the browser blocks
        // them); use pickAndLaunch() or copy the file next to the site instead.
        // Every spelling of the option is accepted: wadUrl / url / path / src.
        const url = options.wadUrl ?? options.url ?? options.path ?? options.src;
        if ((url !== undefined) && (url !== null)) {
            const wanted = DoomJsApi._profileCodeOption(options);
            if (String(url).toLowerCase().startsWith('file://')) {
                throw new Error('doomApi.launch: browsers forbid reading "' + url + '" from an http page.'
                    + ' Copy the .wad next to the site and pass {url: "/wads/DOOM.WAD"}, or call await doomApi.pickAndLaunch({levelCode: "E1M1"})'
                    + ' which opens the native file dialog once.');
            }

            return {
                wadFile: await DoomJsApi._fetchFirstAvailable([url]),
                meta:    {id: wanted ?? 'url', name: DoomJsApi._fileNameOf(url)},
                profileCode: wanted
            };
        }

        // 2b. A local file picked earlier via pickWadFile() / pickAndLaunch().
        if ((options.file !== undefined) && (typeof options.file.arrayBuffer === 'function')) {
            const buffer = await options.file.arrayBuffer();

            return {
                wadFile: new (window.WadFile)(buffer).parse(),
                meta:    {id: 'file', name: options.file.name},
                profileCode: DoomJsApi._profileCodeOption(options)
            };
        }

        // 3. Named editions load straight from a link — no profiles registry,
        // no IndexedDB: fetch the .wad and parse it (BUILT_IN_WADS table,
        // editable at runtime with doomApi.addWad(name, url, profileCode)).
        const wanted = String(options.wadId ?? options.wad ?? options.name ?? '').toLowerCase();
        const builtIn = DoomJsApi.BUILT_IN_WADS[wanted];
        if ((builtIn !== undefined) && (builtIn !== null)) {
            return {
                wadFile: await DoomJsApi._fetchFirstAvailable(DoomJsApi._candidateUrls(builtIn)),
                meta:    {id: wanted, name: builtIn.name},
                profileCode: DoomJsApi._profileCodeOption(options) ?? builtIn.profile
            };
        }

        // 4. Unknown short name: try '/wads/<name>.wad' served next to the site.
        if ((wanted.length > 0) && /^[a-z0-9_\-]+$/i.test(wanted)) {
            try {
                return {
                    wadFile: await DoomJsApi._fetchFirstAvailable(['/wads/' + wanted + '.wad']),
                    meta:    {id: wanted, name: wanted + '.wad'},
                    profileCode: DoomJsApi._profileCodeOption(options)
                };
            } catch (error) {
                console.warn('doomApi.launch: /wads/' + wanted + '.wad not available', error);
            }
        }

        // 5. Anything else: a WAD previously imported into storage, by id or title.
        let match = null;
        try {
            const registry = await new (window.WadRegistry)(new (window.WadStorage)()).init();
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

        throw new Error('doomApi.launch: no WAD for "' + wanted + '". Browsers forbid reading file:// links from an http page, so a local DOOM.WAD cannot be fetched by path. Working options:'
            + '\n  1) copy the .wad next to the site and launch({url: "/wads/DOOM.WAD"}) or launch({wadId: "doom"}) — names fall back to /wads/<name>.wad;'
            + '\n  2) await doomApi.pickAndLaunch({levelCode: "E1M1"}) — opens the native file dialog once, then starts the game;'
            + '\n  3) host it over CORS-enabled http(s): addWad("dum", "https://…/DOOM.WAD") and launch({wadId: "dum"});'
            + '\nKnown names: ' + Object.keys(DoomJsApi.BUILT_IN_WADS).join(', '));
    }

    /**
     * Register a downloadable WAD under a short name so launch({wadId: name})
     * resolves it without the storage registry. Accepts both call styles:
     *   doomApi.addWad('dum', 'http(s) link or /local/path.wad', 'doom');
     *   doomApi.addWad({name: 'dum', url: '…', profileCode: 'doom'}).
     * Plain github.com links are rewritten to a CORS-friendly mirror when the
     * path matches a repository file; release-download links stay as they are.
     */
    addWad(nameOrOptions, url = null, profileCode = null) {
        const opts = ((typeof nameOrOptions === 'object') && (nameOrOptions !== null)) ? nameOrOptions : {
            name: nameOrOptions, url: url, profileCode: profileCode
        };
        const key = String(opts.name ?? opts.id ?? '').toLowerCase();
        if (key.length === 0) {
            throw new Error('doomApi.addWad: missing name');
        }
        const raw = String(opts.url ?? opts.path ?? '');
        if (raw.length === 0) {
            throw new Error('doomApi.addWad: missing url for "' + key + '"');
        }

        DoomJsApi.BUILT_IN_WADS[key] = {
            urls: [raw], name: DoomJsApi._fileNameOf(raw), profile: (opts.profileCode ?? opts.profile ?? null)
        };

        return this;
    }

    /** All download candidates of a table entry: explicit URLs plus the CDN mirrors of each repo reference. */
    static _candidateUrls(entry) {
        const out = [];
        for (const u of (entry.urls ?? [])) {
            if ((typeof u === 'string') && (u.startsWith('/') || /^https?:/.test(u))) {
                out.push(u);
                continue;
            }
            for (const build of DoomJsApi.CDN_HOSTS) {
                out.push(build(u));
            }
        }
        if ((typeof entry.local === 'string') && !out.includes(entry.local)) {
            out.unshift(entry.local);
        }

        return out;
    }

    /** Fetch every candidate in order until one parses as a WAD. */
    static async _fetchFirstAvailable(urls) {
        let lastError = null;
        for (const url of urls) {
            try {
                return await new (window.WadFile)(await DoomJsApi._fetchBuffer(url)).parse();
            } catch (error) {
                lastError = error;
                console.warn('doomApi: ' + url + ' failed:', error.message ?? error);
            }
        }
        throw new Error('doomApi.launch: could not download the WAD from any mirror (' + urls.join(', ') + ')', {cause: lastError});
    }

    static async _fetchBuffer(url) {
        // swBypass keeps the Service Worker from caching a whole IWAD.
        const bypassed = ((window.WadRegistry !== undefined) && (window.WadRegistry.bypassUrl !== undefined))
            ? window.WadRegistry.bypassUrl(url) : url;
        const response = await fetch(bypassed);
        if (!response.ok) {
            throw new Error('HTTP ' + response.status);
        }

        return await response.arrayBuffer();
    }

    /**
     * Open the native file dialog and return the picked File (works on
     * localhost/https; on plain LAN http use <input type=file> instead).
     * @returns {Promise<File|null>} null when the user cancelled
     */
    async pickWadFile() {
        if ((window.showOpenFilePicker !== undefined) && (window.showOpenFilePicker !== null)) {
            try {
                const [handle] = await window.showOpenFilePicker({
                    types: [{description: 'WAD files', accept: {'application/octet-stream': ['.wad', '.iwad', '.pk3']}}]
                });

                return await handle.getFile();
            } catch (error) {
                if (error.name === 'AbortError') {
                    return null;
                }
                throw error;
            }
        }

        return await new Promise((resolve) => {
            const input = document.createElement('input');
            input.type  = 'file';
            input.accept = '.wad,.iwad,.pk3';
            input.onchange = () => resolve(input.files[0] ?? null);
            input.click();
        });
    }

    /** One step for local files: file dialog, then launch with the picked .wad. */
    async pickAndLaunch(options = {}) {
        const file = await this.pickWadFile();
        if (file === null) {
            throw new Error('doomApi.pickAndLaunch: no file picked');
        }

        return await this.launch({...options, file: file});
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

// Convenience aliases so every spelling works from the console:
// doomApi.launch({wad: 'doom'}), {name: ...}, {url: ...}, {path: ...} all resolve.
DoomJsApi.prototype.addWad = DoomJsApi.prototype.addWad;
window.doomApiAddWad = (name, url, profileCode) => doomApi.addWad(name, url, profileCode);
