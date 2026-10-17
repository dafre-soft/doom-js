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
if ((typeof window !== 'undefined') && (window.FreedoomGameProfile !== undefined) && (window.FreedoomGameProfile !== FreedoomGameProfile)) {
    Object.assign(window.FreedoomGameProfile.prototype, FreedoomGameProfile.prototype);
    Object.getOwnPropertyNames(FreedoomGameProfile).filter((k) => !['length','name','prototype'].includes(k))
        .forEach((k) => { try { window.FreedoomGameProfile[k] = FreedoomGameProfile[k]; } catch (e) {} });
} else if (typeof window !== 'undefined') {
    window.FreedoomGameProfile = FreedoomGameProfile;
}
