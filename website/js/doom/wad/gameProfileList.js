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

    // A real game profile has a concrete buildAmmoTypes somewhere on its
    // prototype chain: a boot shim (empty prototype) or the abstract base
    // (whose stub throws 'must be implemented') does not. Walking the whole
    // chain is what makes this robust against any load order — an early
    // subclass instance merged onto a shim still resolves to the concrete
    // DefaultGameProfile implementation once the real files have evaluated.
    static _isReal(Ctor) {
        try {
            if ((typeof Ctor !== 'function') || (Ctor.prototype == null)) {
                return false;
            }
            let proto = Ctor.prototype;
            while ((proto != null) && (proto !== Object.prototype)) {
                const fn = proto.buildAmmoTypes;
                if ((typeof fn === 'function')
                    && !String(fn).includes('must be implemented')) {
                    return true;
                }
                proto = Object.getPrototypeOf(proto);
            }

            return false;
        } catch (e) {
            return false;
        }
    }

    // Built lazily on first use — see the note above the class. Shim stand-ins
    // are rejected via _isReal so their empty stubs never reach the game; when
    // a profile class is not real yet we build its REAL base (DefaultGameProfile)
    // and graft the still-pending subclass's own prototype methods on top, so
    // even a half-evaluated Tnt/Freedoom/Plutonia entry keeps a concrete ammo
    // catalog instead of crashing with 'buildAmmoTypes must be implemented'.
    static _make(name) {
        let Ctor = null;
        try {
            // The boot publishes every class on window (shim interop); reading it
            // there is TDZ-safe even while the declaring file is still evaluating.
            Ctor = (typeof window !== 'undefined' ? window[name] : undefined) ?? globalThis[name];
            if (GameProfileList._isReal(Ctor)) {
                return new Ctor();
            }
        } catch (error) {
            console.warn('GameProfileList: profile "' + name + '" not ready yet', error);
        }

        const Base = GameProfileList._defaultReady();
        if (Base === null) {
            throw new Error('GameProfileList: DefaultGameProfile has not finished loading yet');
        }
        // Late-binding wrapper: if the real class lands on window later, the
        // next construction uses it; until then we patch the base prototype.
        const wrapper = function () {
            const Real = (typeof window !== 'undefined' ? window[name] : undefined) ?? globalThis[name];
            if ((Real != null) && (Real !== Ctor) && GameProfileList._isReal(Real)) {
                return new Real();
            }
            const instance = new Base();
            if ((Ctor != null) && (Ctor.prototype != null)) {
                for (const key of Object.getOwnPropertyNames(Ctor.prototype)) {
                    if (key === 'constructor') {
                        continue;
                    }
                    try {
                        Object.defineProperty(instance, key,
                            Object.getOwnPropertyDescriptor(Ctor.prototype, key));
                    } catch (e) {}
                }
            }

            return instance;
        };
        wrapper.prototype = Base.prototype;   // instanceof stays true

        return new wrapper();
    }

    static _defaultReady() {
        const Ctor = (typeof window !== 'undefined' ? window.DefaultGameProfile : undefined)
            ?? ((typeof DefaultGameProfile !== 'undefined') ? DefaultGameProfile : undefined);

        return GameProfileList._isReal(Ctor) ? Ctor : null;
    }

    static _byCode() {
        const cache = GameProfileList.__cache;
        // Rebuild while anything is still missing/half-loaded: once every real
        // profile class has been evaluated the cache becomes final and stable.
        const need = ['heretic', 'freedoom', 'tnt', 'plutonia', 'doom'];
        const complete = (cache !== null) && (cache.default instanceof Object)
            && GameProfileList._isReal(cache.default.constructor)
            && need.every((code) => GameProfileList._isReal(cache[code].constructor));
        if (!complete) {
            const defCtor = GameProfileList._defaultReady();
            if (defCtor === null) {
                return null;   // nothing real yet — caller must wait/retry
            }
            GameProfileList.__cache = {
                heretic:   GameProfileList._make('HereticGameProfile'),
                freedoom:  GameProfileList._make('FreedoomGameProfile'),
                tnt:       GameProfileList._make('TntGameProfile'),
                plutonia:  GameProfileList._make('PlutoniaGameProfile'),
                doom:      GameProfileList._make('DoomGameProfile'),
                doom1:     GameProfileList._make('DoomGameProfile'),
                doom2:     GameProfileList._make('DoomGameProfile'),
                default:   new defCtor()
            };
        }

        return GameProfileList.__cache;
    }

    _orderedCodes() {
        return ['heretic', 'freedoom', 'tnt', 'plutonia', 'doom'];
    }

    _profiles() {
        const byCode = GameProfileList._byCode();
        if (byCode === null) {
            return [];   // real profile classes are still evaluating — retry later
        }

        return this._orderedCodes().map((code) => byCode[code]);
    }

    _fallback() {
        return new window.DefaultGameProfile();
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

// Publish for the boot shims and early console callers (TDZ-safe window lookup).
if ((typeof window !== 'undefined') && (window.GameProfileList === undefined)) {
    window.GameProfileList = GameProfileList;
}
