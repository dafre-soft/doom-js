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
class GameProfileList {
    // The list is built lazily on first use: scripts load in parallel batches,
    // so constructing it at file scope could touch a profile class still in
    // the temporal dead zone ("can't access lexical declaration 'FreedoomGameProfile' before initialization").
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

    constructor() {
        const byCode = GameProfileList._byCode();
        this._profiles = [
            byCode.heretic,
            byCode.freedoom,
            byCode.tnt,
            byCode.plutonia,
            byCode.doom
        ];
        this._fallback = new DefaultGameProfile();
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
