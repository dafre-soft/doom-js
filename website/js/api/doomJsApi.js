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

    // Resolves once window.DefaultGameProfile is the REAL class (its prototype
    // carries a working buildAmmoTypes) — the parallel boot may still be
    // running shim stand-ins when a launch is fired from the console early.
    async _waitProfilesReady(timeoutMs = 30000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const ListCtor = (typeof GameProfileList === 'function') ? GameProfileList : window.GameProfileList;
            if ((typeof ListCtor === 'function') && (typeof ListCtor._defaultReady === 'function')
                && (ListCtor._defaultReady() !== null)) {
                return true;
            }
            await new Promise((r) => setTimeout(r, 50));
        }

        return false;
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

        // If a local wad_server.py is up and the name is still unknown, give
        // auto-discovery one last chance to register it before resolving.
        const wantedName = String(options.wadId ?? options.wad ?? options.name ?? '').toLowerCase();
        if ((wantedName.length > 0) && (DoomJsApi.BUILT_IN_WADS[wantedName] === undefined)) {
            await this._autoDiscoverWads();
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
            await this._waitProfilesReady(options.timeoutMs ?? 30000);
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
        // A shim/half-merged profile would crash deep inside the engine with
        // "buildAmmoTypes must be implemented" — fail loudly here instead.
        const ListG = (typeof GameProfileList === 'function') ? GameProfileList : window.GameProfileList;
        if ((typeof ListG === 'function') && !ListG._isReal(profile.constructor)) {
            throw new Error('doomApi.launch: game profiles are not fully loaded yet ('
                + profile.getCode() + ' is still a boot stub). Hard-reload the page (Ctrl+Shift+R).');
        }
        let levelCode = this._ensureLevelCode(wadFile, options.levelCode);
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

        // 2. A link to the .wad file — http(s), a site-local '/wads/x.wad', or a
        // local disk path (file:///C:/…, C:\…, \\srv\share\…). Browsers cannot
        // read local paths directly, so a local path is transparently remapped
        // onto candidate URLs where the same file usually already is:
        //   /wads/<name>.wad on THIS site, and http://127.0.0.1:<port>/<name>.wad
        // on the side-servers started with `python -m http.server` (8090, 8000).
        // One of those three works without any code change in the browser.
        const url = options.wadUrl ?? options.url ?? options.path ?? options.src ?? options.wadPath;
        if ((url !== undefined) && (url !== null)) {
            const wanted     = DoomJsApi._profileCodeOption(options);
            const candidates = DoomJsApi._candidatesFor(url);
            const fileName   = DoomJsApi._fileNameOf(url);
            const stored     = await DoomJsApi._cachedWad(fileName.replace(/\.wad$/i, ''));
            if (stored !== null) {
                console.info('doomApi.launch("' + fileName + '"): loaded from browser storage (no download)');

                return {wadFile: stored.wadFile, meta: stored.meta, profileCode: wanted};
            }

            return {
                wadFile: await DoomJsApi._fetchFirstAvailable(candidates, {name: fileName}),
                meta:    {id: wanted ?? 'url', name: fileName},
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

        // 3. Named editions: the table BUILT_IN_WADS (editable at runtime with
        // doomApi.addWad(name, url, profileCode)). An unknown name is looked up
        // as '/wads/<name>.wad' first — and if that exists it IS the wanted WAD,
        // so its profile is sniffed from the bytes instead of guessing 'doom'.
        const wanted = String(options.wadId ?? options.wad ?? options.name ?? '').toLowerCase();
        // 3a. Browser storage first: a WAD cached by an earlier launch is read
        // from IndexedDB in milliseconds — no server, no download at all.
        const cached = await DoomJsApi._cachedWad(wanted);
        if (cached !== null) {
            console.info('doomApi.launch("' + wanted + '"): loaded from browser storage (no download)');

            return {wadFile: cached.wadFile, meta: cached.meta, profileCode: DoomJsApi._profileCodeOption(options)};
        }
        const builtIn = DoomJsApi.BUILT_IN_WADS[wanted];
        if ((builtIn !== undefined) && (builtIn !== null)) {
            return {
                wadFile: await DoomJsApi._fetchFirstAvailable(DoomJsApi._candidateUrls(builtIn), builtIn),
                meta:    {id: wanted, name: builtIn.name},
                profileCode: DoomJsApi._profileCodeOption(options) ?? builtIn.profile
            };
        }

        // 4. Unknown short name: try every casing of '/wads/<name>.wad' served
        // next to the site (Windows copies keep names like DOOM.WAD).
        if ((wanted.length > 0) && /^[a-z0-9_\-]+$/i.test(wanted)) {
            const probes = ['/wads/' + wanted + '.wad', '/wads/' + wanted.toUpperCase() + '.WAD'];
            try {
                const wadFile = await DoomJsApi._fetchFirstAvailable(probes, {name: wanted + '.wad'});

                return {
                    wadFile: wadFile,
                    meta:    {id: wanted, name: wanted + '.wad'},
                    // The real game (doom / heretic / a mod…) from the WAD itself;
                    // getForWad falls back to the plain doom-format profile for
                    // unknown WADs, so this also covers custom PWAD-style files.
                    profileCode: DoomJsApi._profileCodeOption(options)
                        ?? DoomJsApi.sniffProfileCode(wadFile)
                        ?? null
                };
            } catch (error) {
                console.warn('doomApi.launch: none of ' + probes.join(', ') + ' is available', error);
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
            + '\n  1) start the helper server in the WAD folder:  python wad_server.py --dir C:/users/daf/downloads/base'
            + '   — doomApi auto-registers everything it serves (open http://127.0.0.1:8090/api/launch for ready commands);'
            + '\n  2) copy the .wad next to the site and launch({url: "/wads/DOOM.WAD"}) or launch({wadId: "doom"}) — names fall back to /wads/<name>.wad;'
            + '\n  3) await doomApi.pickAndLaunch({levelCode: "E1M1"}) — opens the native file dialog once, then starts the game;'
            + '\n  4) host it over CORS-enabled http(s): addWad("dum", "https://…/DOOM.WAD") and launch({wadId: "dum"});'
            + '\nKnown names now: ' + Object.keys(DoomJsApi.BUILT_IN_WADS).join(', '));
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
        let raw = String(opts.url ?? opts.path ?? '');
        if (raw.length === 0) {
            throw new Error('doomApi.addWad: missing url for "' + key + '"');
        }
        // A Windows path or file:// link is remapped onto the places the browser
        // CAN read it from: /wads/<file> on this site and the localhost side
        // servers (`python -m http.server` in that folder). Copy the .wad into
        // website/wads/ OR start the side server — launch({wadId: name}) then works.
        if (DoomJsApi._isLocalPath(raw)) {
            const fileName = DoomJsApi._fileNameOf(raw);
            console.warn('doomApi.addWad: browsers cannot read local files ("' + raw + '").'
                + ' Either copy "' + fileName + '" into website/wads/, or run'
                + ' "python -m http.server 8090" inside its folder — launch({wadId: "' + key + '"})'
                + ' will find it automatically.');
            raw = '/wads/' + fileName;
        }

        DoomJsApi.BUILT_IN_WADS[key] = {
            local: raw.startsWith('/') ? raw : undefined,
            urls: [raw], name: DoomJsApi._fileNameOf(raw), profile: (opts.profileCode ?? opts.profile ?? null)
        };

        return this;
    }

    /**
     * Auto-register every WAD served by a local `python wad_server.py` instance
     * (repo root). The server parses each .wad and answers GET /api/wads with
     * {wads:[{name,file,profile,levels,…}]} plus CORS headers, so the browser
     * can read it from any port. Call style:
     *   await doomApi.addWadFromServer();                       // 127.0.0.1:8090
     *   await doomApi.addWadFromServer('http://127.0.0.1:9000');
     * After that: launch({wadId: 'DOOM', levelCode: 'E1M1'}).
     * Returns the list of registered names (empty array if server is down).
     */
    async addWadFromServer(baseUrl = null) {
        // Remember every server we successfully talked to (localStorage), so a
        // page reload or a fresh console session still knows about 'duom' etc.
        const bases = baseUrl
            ? [String(baseUrl)]
            : [...new Set([window.DOOM_WAD_SERVER ?? 'http://127.0.0.1:8090', ...this._savedServers()])];
        let lastDataError = null;
        for (const raw of bases) {
            const base = raw.replace(/\/+$/, '');
            let data = null;
            try {
                const response = await fetch(base + '/api/wads', {cache: 'no-store'});
                if (response.ok) {
                    data = await response.json();
                } else {
                    lastDataError = new Error('HTTP ' + response.status);
                }
            } catch (error) {
                lastDataError = error;
                continue; // try next remembered server
            }
            this._rememberServer(base);
            const registered = [];
            const cachedMeta = await DoomJsApi._cachedMetaMap().catch(() => new Map());
            for (const entry of (data?.wads ?? [])) {
                if (!entry.ok || !entry.file) {
                    continue;
                }
                const key   = String(entry.name).toLowerCase();
                const urls  = [base + entry.file, base + '/wad/' + encodeURIComponent(entry.fileName)];
                // A WAD already sitting in browser storage needs no URL at all:
                // launch() reads it straight from IndexedDB, offline and instant.
                const stored = cachedMeta.get(entry.fileName.toLowerCase())
                    ?? cachedMeta.get(key + '.wad')
                    ?? cachedMeta.get('srv-' + key + '.wad') ?? null;
                const record = {
                    local: (stored !== null) ? ('browser-storage:' + stored.name) : undefined,
                    urls:  urls,
                    name:  entry.fileName,
                    profile: entry.profile ?? null,
                    levels: entry.levels ?? []
                };
                // Register BOTH spellings: the plain file name ('duom') and a
                // server-prefixed alias ('srv-duom') so a launch({wadId}) never
                // collides with the built-in names (doom/heretic/…) it shadows.
                DoomJsApi.BUILT_IN_WADS[key]       = record;
                DoomJsApi.BUILT_IN_WADS['srv-' + key] = record;
                registered.push(entry.name);
            }
            console.info('doomApi.addWadFromServer: registered ' + registered.length
                + ' WAD(s) from ' + base + ': [' + registered.join(', ') + ']'
                + '\n  e.g. await doomApi.launch({wadId: "' + (registered[0] ?? 'doom')
                + '", levelCode: "E1M1", maxSpeed: true});');

            return registered;
        }
        console.warn('doomApi.addWadFromServer: no wad_server on [' + bases.join(', ')
            + '] — start it with: python wad_server.py --dir <папка с WAD>'
            + (lastDataError ? ' (' + lastDataError.message + ')' : ''));

        return [];
    }

    _savedServers() {
        try {
            return JSON.parse(localStorage.getItem('doomApi.wadServers') ?? '[]');
        } catch (e) {
            return [];
        }
    }

    _rememberServer(base) {
        try {
            const list = this._savedServers().filter((b) => b !== base);
            list.unshift(base);
            localStorage.setItem('doomApi.wadServers', JSON.stringify(list.slice(0, 5)));
        } catch (e) { /* private mode — ignore */ }
    }

    /**
     * The game engine refuses to start a level whose code is not in the WAD.
     * For a console launch this is pure friction — 'E1M1' on a MAP-structured
     * WAD (or vice versa) is almost always just a naming slip. Remap it onto
     * the closest existing level instead of throwing:
     *   E1M1 <-> MAP01 by number; otherwise the first level of the WAD.
     */
    _ensureLevelCode(wadFile, levelCode) {
        const names = wadFile.getLevelNames();
        if ((levelCode === undefined) || (levelCode === null) || names.includes(levelCode)) {
            return levelCode;
        }

        const wanted = String(levelCode).toUpperCase();
        const digits = wanted.match(/\d+/g);
        const guess  = names.find((name) => {
            const mine = name.toUpperCase().match(/\d+/g);

            return (mine !== null) && (digits !== null)
                && (mine[mine.length - 1] === digits[digits.length - 1]);
        });
        const fixed = guess ?? names[0];
        console.warn('doomApi.launch: level "' + wanted + '" is not in this WAD ('
            + names.join(', ') + ') — starting "' + fixed + '" instead.');

        return fixed;
    }

    /** True for file:// links and bare local paths like C:/dir/game.wad or \\srv\share\game.wad. */
    static _isLocalPath(url) {
        const s = String(url).trim().toLowerCase();

        return s.startsWith('file:') || /^[a-z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('\\');
    }

    /** Ports where a `python -m http.server` next to the WAD folder is usually started. */
    static LOCAL_SERVER_PORTS = [8090, 8000, 8080];

    /**
     * Turn any url/path into the ordered list of places to actually fetch from.
     *  - http(s)/site-local path  -> used as-is;
     *  - a local disk path (file:///C:/…, C:\…) cannot be read by the browser,
     *    so it is remapped onto '/wads/<file>' on this site plus the same file
     *    on the localhost side-servers (python -m http.server in that folder).
     * @returns {string[]}
     */
    static _candidatesFor(url) {
        const raw = String(url).trim();
        if (!DoomJsApi._isLocalPath(raw)) {
            return [raw];
        }

        const fileName = DoomJsApi._fileNameOf(raw);
        const encoded  = encodeURIComponent(fileName);
        const out      = ['/wads/' + encoded];
        for (const port of DoomJsApi.LOCAL_SERVER_PORTS) {
            out.push('http://127.0.0.1:' + port + '/' + encoded);
        }
        console.warn('doomApi: browsers cannot open "' + raw + '" directly — trying instead: '
            + out.join(', ') + '. If none answers, either copy the .wad into website/wads/,'
            + ' or run "python -m http.server 8090" inside its folder, or use doomApi.pickAndLaunch().');

        return out;
    }

    /** All download candidates of a table entry: explicit URLs plus the CDN mirrors of each repo reference. */
    static _candidateUrls(entry) {
        const out = [];
        const push = (u) => {
            if (!out.includes(u)) {
                out.push(u);
            }
        };
        for (const u of (entry.urls ?? [])) {
            if ((typeof u === 'string') && /^https?:/.test(u)) {
                push(u);
                // A wad_server URL can also be answered by THIS site when the
                // server was started with --dir pointing at the site folder
                // (then /wads/x.wad exists right here too). Add that local
                // spelling as an extra candidate — same file, no network hop.
                const fileName = DoomJsApi._fileNameOf(u);
                if (/^\/(wads|wad)\//i.test(new URL(u).pathname) || /\.wad$/i.test(fileName)) {
                    push('/wads/' + encodeURIComponent(fileName));
                }
                continue;
            }
            if ((typeof u === 'string') && u.startsWith('/')) {
                push(u);
                continue;
            }
            for (const build of DoomJsApi.CDN_HOSTS) {
                push(build(u));
            }
        }
        if (typeof entry.local === 'string') {
            if (entry.local.startsWith('browser-storage:')) {
                // Registered from a wad_server listing whose bytes are already
                // cached under the plain name — probe the cache spellings.
                const name = entry.local.slice('browser-storage:'.length);
                push('cache:' + name);
                push('cache:' + name.replace(/\.wad$/i, ''));
            } else {
                push(entry.local);
            }
        }
        // Last resort for any named entry: /wads/<name>.wad on this very site.
        if (typeof entry.name === 'string') {
            push('/wads/' + encodeURIComponent(DoomJsApi._fileNameOf(entry.name)));
        }

        return out;
    }

    /** Fetch every candidate in PARALLEL — the first answer that parses as a
     * WAD wins (a dead localhost port fails in milliseconds, so the slowest
     * mirror never decides how long the launch takes). */
    static async _fetchFirstAvailable(urls, meta = null) {
        // 'cache:<name>' candidates are answered straight from IndexedDB.
        const cacheHits = await Promise.all(urls.map(async (url) => {
            if (typeof url === 'string' && url.startsWith('cache:')) {
                return DoomJsApi._cachedWad(url.slice('cache:'.length));
            }

            return null;
        }));
        for (const hit of cacheHits) {
            if (hit !== null) {
                console.info('doomApi.launch: loaded "' + (hit.meta?.name ?? '') + '" from browser storage (no download)');

                return hit.wadFile;
            }
        }
        const attempts = urls.filter((url) => !(typeof url === 'string' && url.startsWith('cache:')))
            .map(async (url) => {
                const wadFile = await new (window.WadFile)(await DoomJsApi._fetchBuffer(url)).parse();

                return {url: url, wadFile: wadFile};
            });
        // Log each failure as it happens, without ever rejecting unhandled.
        const realUrls = urls.filter((url) => !(typeof url === 'string' && url.startsWith('cache:')));
        attempts.forEach((attempt, i) => {
            attempt.catch((error) => console.warn('doomApi: ' + realUrls[i] + ' failed:', error.message ?? error));
        });

        const winner = await Promise.any(attempts).catch(() => null);
        if (winner !== null) {
            if (winner.url !== realUrls[0]) {
                console.info('doomApi: loaded the WAD from "' + winner.url + '"');
            }
            // Cache the bytes in IndexedDB so the next launch({wadId}) is
            // instant and works even with the server turned off.
            DoomJsApi._cacheWad(winner.url, meta).catch(() => {});

            return winner.wadFile;
        }
        throw new Error('doomApi.launch: could not download the WAD from any source (' + realUrls.join(', ') + ')');
    }

    /** Read a launch-named WAD straight out of browser storage (IndexedDB).
     * Matches the exact stored name and its .wad spellings, so a WAD cached by
     * an earlier launch starts instantly with no server running.
     * @returns {Promise<{wadFile: WadFile, meta: object}|null>} */
    static async _cachedWad(wanted) {
        if ((wanted.length === 0) || (window.WadStorage === undefined)) {
            return null;
        }
        try {
            const storage = new (window.WadStorage)();
            await storage.open();
            const metas = await storage.listMeta();
            const match = metas.find((m) => {
                const n = String(m.name ?? '').toLowerCase();

                return (n === wanted) || (n === wanted + '.wad') || (n === 'srv-' + wanted)
                    || (n === 'srv-' + wanted + '.wad');
            }) ?? null;
            if (match === null) {
                return null;
            }
            const stored = await storage.readWad(match.id);

            return {wadFile: new (window.WadFile)(stored.data).parse(), meta: match};
        } catch (error) {
            console.warn('doomApi: browser-storage lookup failed:', error.message ?? error);

            return null;
        }
    }

    /** Save freshly downloaded bytes into the app's IndexedDB WAD store under
     * their exact URL as name — launch() checks that store before any fetch. */
    static async _cacheWad(url, meta) {
        try {
            const fileName = DoomJsApi._fileNameOf(url);
            const base     = fileName.replace(/\.wad$/i, '').toLowerCase();
            const extra    = String(meta?.name ?? '').trim();
            const names    = [fileName, base + '.wad', 'srv-' + base + '.wad',
                ((extra.length > 0) ? (extra.endsWith('.wad') ? extra : extra + '.wad') : '')]
                .filter((n, i, a) => ((n.length > 0) && (a.indexOf(n) === i)));
            const buffer   = await DoomJsApi._fetchBuffer(url);
            let stored     = 0;
            for (const name of names) {
                if (await DoomJsApi._storeBuffer(buffer, name, url)) {
                    ++stored;
                }
            }
            if (stored > 0) {
                console.info('doomApi: cached "' + fileName + '" in browser storage ('
                    + Math.round(buffer.byteLength / 1048576) + ' MB) — offline launches work now');
            }
        } catch (error) {
            console.warn('doomApi: could not cache the WAD locally:', error.message ?? error);
        }
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
        try {
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
        } catch (error) {
            console.warn('doomApi.sniffProfileCode: unreadable WAD', error.message ?? error);
        }

        return null;
    }

    /** @returns {Promise<Map<string, object>>} stored WAD metadata by lower-cased name */
    static async _cachedMetaMap() {
        if (window.WadStorage === undefined) {
            return new Map();
        }
        const storage = new (window.WadStorage)();
        await storage.open();
        const map = new Map();
        for (const meta of await storage.listMeta()) {
            map.set(String(meta.name ?? '').toLowerCase(), meta);
        }

        return map;
    }

    /** Store a raw ArrayBuffer in browser storage under an exact name — the
     * same cache launch({wadId}) reads back. */
    static async _storeBuffer(buffer, name, url) {
        const storage = new (window.WadStorage)();
        await storage.open();
        if (await storage.findByName(name) !== null) {
            return false; // already cached under this name
        }
        await storage.saveWad({name: name, size: buffer.byteLength, addedAt: Date.now(),
            source: {type: 'url', value: url}}, buffer.slice(0));

        return true;
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

// The singleton every script reaches. This file is loaded SYNCHRONOUSLY from
// index.html, before the app's ~300 boot scripts — so window.doomApi exists as
// a REAL object from the first millisecond (no Proxy stubs that miss methods).
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

// _booted stays false until the app's scripts landed; main.js's ready
// callback (which runs after the last batch executed) flips it via
// markBooted(), so waitReady()/launch() keep their meaning.
doomApi._booted = false;
DoomJsApi.prototype.markBooted = function () {
    this._booted = true;

    return this;
};
window.doomApiMarkBooted = () => doomApi.markBooted();

// Convenience aliases so every spelling works from the console:
// doomApi.launch({wad: 'doom'}), {name: ...}, {url: ...}, {path: ...} all resolve.
window.doomApiAddWad = (name, url, profileCode) => doomApi.addWad(name, url, profileCode);

// Auto-discovery of a local wad_server.py: if it answers, every WAD it serves
// is registered under its file name (lower-cased) before the first launch().
// Disable with: doomApi.autoDiscoverWads = false;  Set another port via
// window.DOOM_WAD_SERVER = 'http://127.0.0.1:9000';
doomApi.autoDiscoverWads = true;
DoomJsApi.prototype._autoDiscoverWads = async function () {
    if (!this.autoDiscoverWads) {
        return [];
    }
    const bases = [window.DOOM_WAD_SERVER ?? 'http://127.0.0.1:8090'];

    for (const base of bases) {
        const names = await this.addWadFromServer(base);
        if (names.length > 0) {
            return names;
        }
    }

    return [];
};
window.doomApiAddWadFromServer = (baseUrl) => doomApi.addWadFromServer(baseUrl);

// --- Browser storage management: every WAD ever downloaded by launch() is
// cached in IndexedDB; these calls list / delete / empty that cache.
DoomJsApi.prototype.listSavedWads = async function () {
    if (window.WadStorage === undefined) {
        throw new Error('doomApi.listSavedWads: the app has not finished loading yet');
    }
    const storage = new (window.WadStorage)();
    await storage.open();

    return (await storage.listMeta()).map((meta) => ({
        id: meta.id, name: meta.name, size: meta.size,
        mb: Math.round(((meta.size ?? 0) / 1048576) * 10) / 10,
        levels: (meta.levels ?? null), addedAt: meta.addedAt
    }));
};

DoomJsApi.prototype.removeSavedWad = async function (nameOrId) {
    const storage = new (window.WadStorage)();
    await storage.open();
    const key   = String(nameOrId).toLowerCase();
    const match = (await storage.listMeta()).find((m) => (String(m.id) === key)
        || (String(m.name).toLowerCase() === key)
        || (String(m.name).toLowerCase() === key.replace(/\.wad$/i, '') + '.wad')) ?? null;
    if ((match === null) || (match === undefined)) {
        throw new Error('doomApi.removeSavedWad: nothing stored under "' + nameOrId + '"');
    }
    await storage.deleteWad(match.id);

    return match.name;
};

DoomJsApi.prototype.clearSavedWads = async function () {
    const names = [];
    for (const w of await this.listSavedWads()) {
        names.push(w.name);
    }
    for (const name of names) {
        await this.removeSavedWad(name);
    }

    return names;
};

window.doomApiListSavedWads   = () => doomApi.listSavedWads();
window.doomApiRemoveSavedWad  = (n) => doomApi.removeSavedWad(n);
window.doomApiClearSavedWads  = () => doomApi.clearSavedWads();

doomApi._autoDiscoverWads();
