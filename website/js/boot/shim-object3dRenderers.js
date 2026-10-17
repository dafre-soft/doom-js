/**
 * Boot shim of the object3d renderer family (index.html loads it BEFORE the
 * batched appBootstrap, so it is always among the first scripts to run).
 *
 * Why: the bootstrap downloads all ~250 js files in parallel and executes each
 * one as a separate <script>. A subclass such as Object3dRendererFast can be
 * evaluated while its base file is still downloading — "Object3dRendererBase
 * is not defined". The shim gives every class of the family an empty stand-in
 * GLOBAL binding at once; the real files then MERGE their full bodies into the
 * same objects (never redeclaring them), so execution order stops mattering.
 */
(() => {
    if (typeof window === 'undefined') {
        return;
    }

    const standIn = (name) => {
        if (window['__' + name + 'Defined'] === true) {
            return;         // the real file already ran — nothing to shim
        }
        const C = function () {};
        C.prototype = {};
        window[name] = C;
    };

    standIn('Object3dRendererBase');
    standIn('Object3dRendererFast');
    standIn('Object3dRendererFlat');
    standIn('Object3dRendererFull');
    standIn('Object3dRendererWebGL');
})();
