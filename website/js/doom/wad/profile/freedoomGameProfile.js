/**
 * Freedoom profile (FREEDOOM credits lump — phases 1 & 2 and FreeDM). Same
 * behaviour as the id Doom baseline, except the art shades that differ in
 * the Freedoom asset set (bluish BFG lightning instead of green).
 */
class FreedoomGameProfile extends window.DefaultGameProfile {
    getCode() {
        return 'freedoom';
    }

    /**
     * @param {WadFile} wadFile
     * @returns {boolean}
     */
    matchesWad(wadFile) {
        return ((wadFile.getLump('FREEDOOM') !== null) || (wadFile.getLump('FREEDM') !== null));
    }

    // Freedoom Phase 1 episode titles (freedoom.github.io manual). Phase 2
    // (MAPxx) has none, like Doom 2.
    episodeNames() {
        return {
            E1M1: 'Outpost Outbreak',
            E2M1: 'Military Labs',
            E3M1: 'Event Horizon',
            E4M1: 'Double Impact'
        };
    }

    bfgDecalShade() {
        return [128, 128, 255];
    }
}

// Publish for the boot shims and early evaluators (see js/boot/shim-gameProfiles.js).
// The REAL class always wins on window — a boot shim must never shadow it.
// Subclasses created via `extends window.X` while the shim was in place are
// re-parented onto the real prototype so their own methods stay reachable.
if (typeof window !== 'undefined') {
    const _prev = window.FreedoomGameProfile;
    window.FreedoomGameProfile = FreedoomGameProfile;
    if (_prev !== undefined && _prev !== FreedoomGameProfile) {
        Object.setPrototypeOf(FreedoomGameProfile.prototype, window.DefaultGameProfile.prototype);
        try { Object.setPrototypeOf(_prev.prototype, FreedoomGameProfile.prototype); } catch (e) {}
    }
}
