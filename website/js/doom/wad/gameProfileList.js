/**
 * Registry of the game profiles (same pattern as Object3dRendererList).
 * Every game registers one profile instance here; getForWad probes them in
 * order (most specific first — freedoom also carries M_DOOM and the TNT /
 * Plutonia textures, which in turn come with M_DOOM) and falls back
 * to the default profile: an unknown WAD (any PWAD/IWAD without a recognized
 * signature) is treated as a plain doom-format WAD.
 *
 * Adding a game = one DefaultGameProfile subclass + one entry in _profiles.
 */
// Singleton: every "new GameProfileList()" returns the same instance, and the
// profile objects are created once, lazily, on that first construction — long
// after all the profile classes have been evaluated. Constructing them at file
// scope (or touching another class's `const` bindings during evaluation) used
// to crash with "is not defined" / "can't access lexical declaration … before
// initialization": the bootstrap loads the scripts in parallel batches, so any
// file can be evaluated before its dependencies finished parsing.
// The statics are assigned INSIDE the class body: a top-level `class X` is a
// lexical (let-like) binding, so touching `GameProfileList.foo` before the
// declaration line ran would hit the temporal dead zone.
class GameProfileList {
    static __instance = null;
    static __cache    = null;

    constructor() {
        if ((GameProfileList.__instance !== null) && (GameProfileList.__instance !== undefined)) {
            return GameProfileList.__instance;
        }
        // The profile objects are NOT built here anymore: the boot used to
        // touch this class from doomImageAssets.load() before the profile
        // files finished evaluating ("can't access lexical declaration …").
        // Everything is resolved lazily, per call — see _make / _byCode.
        GameProfileList.__instance = this;
    }

    // Built lazily on first use — see the note above the class. Every entry is
    // wrapped in try/catch: during a fast parallel boot some profile classes
    // may still be evaluating, so we fall back to DefaultGameProfile (a plain
    // doom-format WAD) instead of crashing the whole launch.
    static _make(name) {
        try {
            const Ctor = globalThis[name];
            if (typeof Ctor === 'function') {
                return new Ctor();
            }
        } catch (error) {
            console.warn('GameProfileList: profile "' + name + '" not ready yet', error);
        }

        return new DefaultGameProfile();
    }

    static _byCode() {
        if ((GameProfileList.__cache ?? null) === null) {
            GameProfileList.__cache = {
                heretic:   GameProfileList._make('HereticGameProfile'),
                freedoom:  GameProfileList._make('FreedoomGameProfile'),
                tnt:       GameProfileList._make('TntGameProfile'),
                plutonia:  GameProfileList._make('PlutoniaGameProfile'),
                doom:      GameProfileList._make('DoomGameProfile'),
                doom1:     GameProfileList._make('DoomGameProfile'),
                doom2:     GameProfileList._make('DoomGameProfile'),
                default:   new DefaultGameProfile()
            };
        }

        return GameProfileList.__cache;
    }

    _orderedCodes() {
        return ['heretic', 'freedoom', 'tnt', 'plutonia', 'doom'];
    }

    // The list, resolved on every call (cheap: the profile objects are cached
    // in __cache once their classes exist). Never stored on the instance — an
    // early `new GameProfileList()` at boot must not freeze a half-loaded set.
    _profiles() {
        const byCode = GameProfileList._byCode();

        return this._orderedCodes().map((code) => byCode[code]);
    }

    _fallback() {
        return new DefaultGameProfile();
    }

    /**
     * @param {WadFile} wadFile
     * @returns {AbstractGameProfile}
     */
    getForWad(wadFile) {
        for (const profile of this._profiles()) {
            if (profile.matchesWad(wadFile)) {
                return profile;
            }
        }

        return this._fallback();
    }

    /**
     * @param {string} code - 'doom', 'freedoom', 'heretic', 'tnt', 'plutonia'…
     * @returns {AbstractGameProfile} the fallback profile when unknown
     */
    getByCode(code) {
        const wanted = String(code ?? '').toLowerCase();
        const direct = GameProfileList._byCode()[wanted];
        if ((direct !== undefined) && (direct !== null)) {
            return direct;
        }
        for (const profile of this._profiles()) {
            if (profile.getCode() === code) {
                return profile;
            }
        }

        return this._fallback();
    }

    /**
     * Every registered profile plus the fallback — for the boot-time loaders
     * that must cover all games before any WAD is picked (decal graphics).
     *
     * @returns {AbstractGameProfile[]}
     */
    getAll() {
        return [...this._profiles(), this._fallback()];
    }
}
