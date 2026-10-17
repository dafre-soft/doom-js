/**
 * Boot shim of AbstractMoverBuilder — see shim-object3dRenderers.js for the why.
 * wadDoorBuilder/wadLiftBuilder/wadRisingFloorBuilder/wadStairBuilder extend it.
 */
(() => {
    if ((typeof window === 'undefined') || (window.__AbstractMoverBuilderDefined === true)) {
        return;
    }
    const C = function () {};
    C.prototype = {};
    window.AbstractMoverBuilder = C;
})();
