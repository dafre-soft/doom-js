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
})();
