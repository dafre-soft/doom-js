/**
 * The Plutonia Experiment profile (CAMO1 texture, UZDoom iwadinfo). Same
 * behaviour as the id Doom II profile with its own level names; its finale
 * texts (P1TEXT…) are not transcribed, so its chapter ends stay silent.
 */
class PlutoniaGameProfile extends window.DoomGameProfile {
    getCode() {
        return 'plutonia';
    }

    /**
     * @param {WadFile} wadFile
     * @returns {boolean}
     */
    matchesWad(wadFile) {
        return (wadFile.getLump('CAMO1') !== null);
    }

    finaleAssets() {
        return null;
    }

    levelNameStringPrefix() {
        return 'PHUSTR';
    }

    // Level names of The Plutonia Experiment (linuxdoom d_englsh.h PHUSTR_*),
    // without the "level n: " prefix, normalized to title case.
    levelNames() {
        return {
            MAP01: 'Congo',
            MAP02: 'Well of Souls',
            MAP03: 'Aztec',
            MAP04: 'Caged',
            MAP05: 'Ghost Town',
            MAP06: 'Baron\'s Lair',
            MAP07: 'Caughtyard',
            MAP08: 'Realm',
            MAP09: 'Abattoire',
            MAP10: 'Onslaught',
            MAP11: 'Hunted',
            MAP12: 'Speed',
            MAP13: 'The Crypt',
            MAP14: 'Genesis',
            MAP15: 'The Twilight',
            MAP16: 'The Omen',
            MAP17: 'Compound',
            MAP18: 'Neurosphere',
            MAP19: 'NME',
            MAP20: 'The Death Domain',
            MAP21: 'Slayer',
            MAP22: 'Impossible Mission',
            MAP23: 'Tombstone',
            MAP24: 'The Final Frontier',
            MAP25: 'The Temple of Darkness',
            MAP26: 'Bunker',
            MAP27: 'Anti-Christ',
            MAP28: 'The Sewers',
            MAP29: 'Odyssey of Noises',
            MAP30: 'The Gateway of Hell',
            MAP31: 'Cyberden',
            MAP32: 'Go 2 It'
        };
    }
}

// Publish for the boot shims and early evaluators (see js/boot/shim-gameProfiles.js).
// The REAL class always wins on window — a boot shim must never shadow it.
// Subclasses created via `extends window.X` while the shim was in place are
// re-parented onto the real prototype so their own methods stay reachable.
if (typeof window !== 'undefined') {
    const _prev = window.PlutoniaGameProfile;
    window.PlutoniaGameProfile = PlutoniaGameProfile;
    if (_prev !== undefined && _prev !== PlutoniaGameProfile) {
        Object.setPrototypeOf(PlutoniaGameProfile.prototype, window.DoomGameProfile.prototype);
        try { Object.setPrototypeOf(_prev.prototype, PlutoniaGameProfile.prototype); } catch (e) {}
    }
}
