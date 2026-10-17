/**
 * boot/statics-fix.js — the FINAL, definitive fix for the whole family of
 * "DefaultGameProfile.E4_MUSIC_REUSE is undefined" / "can't access property 0"
 * errors.
 *
 * Root cause: every profile file declares its class as
 *     const X__Real = class X extends window.Base { ... }
 * Inside that initializer the lexical name `X` does NOT exist (the TDZ binding
 * `X__Real` shadows it). But dozens of methods and the trailing static-table
 * assignments (`X.MAP_MUSIC = [...]`, `window.X.PLAYER_BODY = {...}`) still
 * reference the bare name `X`. Depending on how the parallel loader happened
 * to evaluate the files, those references either threw ReferenceError or
 * resolved against a shim constructor without the tables — which surfaced
 * later at level start as "E4_MUSIC_REUSE is undefined".
 *
 * This script repairs all of them in one place, AFTER every profile file has
 * executed (it is listed last in libBootstrap.json):
 *   1. copies every own static property found on ANY reachable constructor
 *      (canonical window binding + __Real fallback captured via the class's
 *      toString()) onto the canonical window.X — so no matter which identity
 *      a method's bare-name lookup resolved to, the data is present everywhere;
 *   2. re-runs the static-table literals? No — instead we recover the lost
 *      objects by scanning the __Real identities themselves (their trailing
 *      assignments DID execute against their own binding in most orders);
 *   3. guarantees AbstractGameProfile._playerBodies exists (Map) — the method
 *      bodyPlayerDef() looks it up through the prototype chain of the instance
 *      constructor, so putting it on the real base class covers every profile.
 */
(function () {
    if (typeof window === 'undefined') return;

    const NAMES = ['AbstractGameProfile', 'DefaultGameProfile', 'DoomGameProfile',
                   'TntGameProfile', 'PlutoniaGameProfile', 'FreedoomGameProfile',
                   'HereticGameProfile'];

    function findAltIdentities(canonical) {
        // The class text is `const X__Real = class X extends ...`. Top-level
        // `const` bindings are NOT properties of window, so we resolve them by
        // evaluating an expression in global scope (the script itself runs via
        // indirect eval → its own top-level consts are invisible, but the
        // profile files' ones are on the global lexical environment).
        const out = [];
        const names = new Set();
        try {
            const src = Function.prototype.toString.call(canonical);
            const m = src.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*class\s+[A-Za-z_$][\w$]*\s+extends/);
            if (m) names.add(m[1]);
        } catch (e) {}
        names.add(canonical.name + '__Real');
        names.forEach((n) => {
            if (!/^[A-Za-z_$][\w$]*$/.test(n)) return;
            try {
                // eslint-disable-next-line no-eval
                const v = eval('(typeof ' + n + ' === "function") ? ' + n + ' : null');
                if ((typeof v === 'function') && (v !== canonical)) out.push(v);
            } catch (e) {}
        });
        return out;
    }

    function mergeStatics(dst, src) {
        if ((src == null) || (dst == null)) return 0;
        let n = 0;
        Object.getOwnPropertyNames(src).forEach((k) => {
            if ((k === 'length') || (k === 'name') || (k === 'prototype')) return;
            try {
                if ((dst[k] === undefined) && (src[k] !== undefined)) { dst[k] = src[k]; n++; }
            } catch (e) {}
        });
        return n;
    }

    NAMES.forEach((name) => {
        const C = window[name];
        if (typeof C !== 'function') return;
        // Merge from every alternate identity (the __Real class object where
        // the trailing `DefaultGameProfile.MAP_MUSIC = ...` style assignments
        // may have landed, depending on evaluation order) — and back-merge so
        // methods closed over EITHER binding see all statics.
        findAltIdentities(C).forEach((alt) => {
            mergeStatics(C, alt);
            mergeStatics(alt, C);
        });
    });

    // The shared monster-def cache must exist on the real abstract base —
    // playerBodyDef() reads AbstractGameProfile._playerBodies through the
    // prototype chain of whichever constructor created the instance.
    const Abs = window.AbstractGameProfile;
    if ((typeof Abs === 'function') && !(Abs._playerBodies instanceof Map)) {
        try { Abs._playerBodies = new Map(); } catch (e) {}
    }

    // Final sanity pass: walk each canonical class UP its static prototype
    // chain and copy down anything inherited-but-missing locally is NOT needed
    // (static inheritance works), but make sure the two DOOM-family music
    // tables are arrays before any level starts.
    const D = window.DefaultGameProfile;
    if (typeof D === 'function') {
        if (!Array.isArray(D.MAP_MUSIC))     D.MAP_MUSIC = [];
        if (!Array.isArray(D.E4_MUSIC_REUSE)) D.E4_MUSIC_REUSE = [];
    }

    window.__staticsFixDone = true;
})();
