/**
 * Boot shim of AbstractGameProfile — see shim-object3dRenderers.js for the why.
 * Every game profile extends it; during a parallel boot the subclasses can be
 * evaluated before this file's real definition landed.
 */
(() => {
    if ((typeof window === 'undefined') || (window.__AbstractGameProfileDefined === true)) {
        return;
    }
    const C = function () {};
    C.prototype     = {};
    C._playerBodies = new Map();   // body data → its DoomMonsterDef
    window.AbstractGameProfile = C;

    // The whole game-profile family gets stand-ins at once (same trick as
    // shim-object3dRenderers.js): the real files MERGE their bodies into these
    // constructors instead of redeclaring them, so a subclass can evaluate
    // before its base file landed without "class heritage is not an object".
    const standIn = (name) => {
        if (window['__' + name + 'Defined'] === true) {
            return;                 // the real file already ran — nothing to shim
        }
        if (window[name] !== undefined) {
            return;                 // another shim already placed it
        }
        const S = function () {};
        S.prototype = {};
        window[name] = S;
    };
    standIn('DefaultGameProfile');
    standIn('DoomGameProfile');
    standIn('TntGameProfile');
    standIn('PlutoniaGameProfile');
    standIn('FreedoomGameProfile');
    standIn('HereticGameProfile');
})();
