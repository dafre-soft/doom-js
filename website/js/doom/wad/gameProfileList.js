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
GameProfileList.__instance = null;
GameProfileList.__cache    = null;

class GameProfileList {
    constructor() {
        if ((GameProfileList.__instance !== null) && (GameProfileList.__instance !== undefined)) {
            return GameProfileList.__instance;
        }
        const byCode = GameProfileList._byCode();
        this._profiles = [
            byCode.heretic,
            byCode.freedoom,
            byCode.tnt,
            byCode.plutonia,
            byCode.doom
        ];
        this._fallback = new DefaultGameProfile();
        GameProfileList.__instance = this;
    }

    // Built lazily on first use — see the note above the class.
    static _byCode() {
        if ((GameProfileList.__cache ?? null) === null) {
            GameProfileList.__cache = {
                heretic:   new HereticGameProfile(),
                freedoom:  new FreedoomGameProfile(),
                tnt:       new TntGameProfile(),
                plutonia:  new PlutoniaGameProfile(),
                doom:      new DoomGameProfile(),
                doom1:     new DoomGameProfile(),
                doom2:     new DoomGameProfile(),
                default:   new DefaultGameProfile()
            };
        }

        return GameProfileList.__cache;
    }

    /**
     * @param {WadFile} wadFile
     * @returns {AbstractGameProfile}
     */
    getForWad(wadFile) {
        for (const profile of this._profiles) {
            if (profile.matchesWad(wadFile)) {
                return profile;
            }
        }

        return this._fallback;
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
        for (const profile of this._profiles) {
            if (profile.getCode() === code) {
                return profile;
            }
        }

        return this._fallback;
    }

    /**
     * Every registered profile plus the fallback — for the boot-time loaders
     * that must cover all games before any WAD is picked (decal graphics).
     *
     * @returns {AbstractGameProfile[]}
     */
    getAll() {
        return [...this._profiles, this._fallback];
    }
}
