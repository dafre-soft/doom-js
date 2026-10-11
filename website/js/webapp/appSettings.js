/**
 * Persistent settings, stored as {key, value} rows in one store of an
 * AppDatabase and described by a table of definitions, from which a settings
 * page is built (AppMenuSettingsModal).
 *
 * Definition: {key, nameCode, type, default, ...}. Types: 'bool', 'list' (the
 * stored value is one of `values: [{code, ...}]`) and 'text' (a free string
 * restricted to its `charset`, `maxLength` long at most, uppercased). A list
 * value carries exactly one of: `label` (a proper name, never translated),
 * `labelCode` (a translation code) or `format` (the code rendered in the current
 * locale: 'percent', 'number', 'minutes'). A subclass adds its own types by
 * overriding isValidValue.
 */
class AppSettings {
    /**
     * @param {number[]} percents
     * @returns {object[]} [{code, format}]
     */
    static percentValues(percents) {
        return percents.map((percent) => ({code: String(percent), format: 'percent'}));
    }

    /**
     * @param {object[]} definitions
     * @param {string}   store       - the AppDatabase store of the {key, value} rows
     * @param {string}   keyIndex    - its unique index on `key`
     */
    constructor(definitions, store, keyIndex) {
        this._definitions = definitions;
        this._store       = store;
        this._keyIndex    = keyIndex;
        this._database    = null;
        // Prototype-less: the keys come from the database, and '__proto__' must stay a plain key.
        this._values      = Object.create(null);
        this._defaults    = Object.create(null);
        for (const def of definitions) {
            this._defaults[def.key] = def.default;
        }
    }

    /**
     * A storage failure keeps all the defaults.
     *
     * @param {AppDatabase} database - the opened database holding the store
     */
    async init(database) {
        this._database = database;
        this._values   = Object.create(null);
        try {
            const rows = await database.getAll(this._store);
            for (const row of rows) {
                this._values[row.key] = row.value;
            }
        } catch (error) {
            console.warn(this.constructor.name + ' - unable to load the settings: ' + error.message);
        }
        this._repairValues();
        this._afterLoad();

        return this;
    }

    // Hook of a subclass, once the stored values are read and repaired.
    _afterLoad() {
    }

    // Resets every stored value its definition no longer accepts, before any
    // consumer reads it.
    _repairValues() {
        for (const def of this._definitions) {
            const value = this._values[def.key];
            if ((value === undefined) || this.isValidValue(def, value)) {
                continue;
            }
            console.warn(this.constructor.name + ' - [' + def.key + '] held an invalid value, repaired');
            this.set(def.key, AppSettings._repairedValue(def, value));
        }
    }

    // A text keeps what survives its sanitising; anything else falls back to the default.
    static _repairedValue(def, value) {
        if ((def.type === 'text') && (typeof value === 'string')) {
            return AppSettings.sanitizeText(def, value);
        }

        return def.default;
    }

    /**
     * Characters a typed character stands for, once uppercased and stripped of
     * its diacritics ('é' → 'E', 'ß' → 'SS'); '' when the charset refuses it.
     *
     * @param {object} def  - a 'text' definition
     * @param {string} char
     * @returns {string}
     */
    static normalizeTextChar(def, char) {
        const plain = char.toUpperCase().normalize('NFD').replace(AppSettings.DIACRITICS, '');

        return (Array.from(plain).every((c) => def.charset.includes(c)) ? plain : '');
    }

    /**
     * The value a 'text' setting stores: every character normalized, the
     * refused ones dropped, inner runs of spaces collapsed, trimmed, cut to its
     * maximum length.
     *
     * @param {object} def   - a 'text' definition
     * @param {string} value
     * @returns {string}
     */
    static sanitizeText(def, value) {
        const kept = Array.from(value, (char) => AppSettings.normalizeTextChar(def, char)).join('');

        return kept.replace(/ +/g, ' ').trim().slice(0, def.maxLength).trim();
    }

    /**
     * An unknown type accepts anything.
     *
     * @param {object} def - a definition
     * @param {*} value
     * @returns {boolean}
     */
    isValidValue(def, value) {
        if (def.type === 'list') {
            return def.values.some((item) => (item.code === value));
        }
        if (def.type === 'bool') {
            return (typeof value === 'boolean');
        }
        if (def.type === 'text') {
            return ((typeof value === 'string') && (AppSettings.sanitizeText(def, value) === value));
        }

        return true;
    }

    getDefinitions(prefix) {
        return this._definitions.filter((def) => def.key.startsWith(prefix));
    }

    getDefinition(key) {
        return (this._definitions.find((def) => (def.key === key)) ?? null);
    }

    get(key) {
        return ((this._values[key] !== undefined) ? this._values[key] : this._defaults[key]);
    }

    // Fire-and-forget write: the in-memory value stands even if the write fails.
    set(key, value) {
        this._values[key] = value;
        if (this._database !== null) {
            this._database.upsert(this._store, this._keyIndex, {key: key, value: value}).catch((error) => {
                console.warn(this.constructor.name + ' - unable to save [' + key + ']: ' + error.message);
            });
        }

        return this;
    }

    // Fraction 0..1 of a percent-coded 'list' value ('7.5' → 0.075).
    getPercent(key) {
        const percent = parseFloat(this.get(key));
        if (Number.isFinite(percent)) {
            return (percent / 100);
        }
        // A NaN reaching its consumer would silently break it (a frozen stick).
        console.warn(this.constructor.name + ' - [' + key + '] is not a number, falling back to its default');

        return (parseFloat(this._defaults[key]) / 100);
    }

    /**
     * Displayed label of the current value of a 'list' setting; a code missing
     * from the list shows as itself.
     *
     * @param {object} def - a 'list' definition
     * @returns {string}
     */
    getListLabel(def) {
        const value = this.get(def.key);
        const entry = def.values.find((item) => (item.code === value));
        if (entry === undefined) {
            return String(value);
        }

        return (entry.label ?? ((entry.labelCode !== undefined)
            ? appTranslator.get(entry.labelCode)
            : AppSettings.formatListValue(entry)));
    }

    /**
     * @param {object} entry - a 'list' value {code, format}
     * @returns {string}
     */
    static formatListValue(entry) {
        const locale = appTranslator.getLocale();
        if (entry.format === 'percent') {
            return new Intl.NumberFormat(locale, {style: 'percent', maximumFractionDigits: 1})
                .format(parseFloat(entry.code) / 100);
        }
        if (entry.format === 'number') {
            return new Intl.NumberFormat(locale).format(parseFloat(entry.code));
        }
        if (entry.format === 'minutes') {
            return new Intl.NumberFormat(locale, {style: 'unit', unit: 'minute', unitDisplay: 'long'})
                .format(parseFloat(entry.code));
        }

        return entry.code;
    }

    /**
     * Neighbour value of a 'list' setting, wrapping around; an unknown current
     * value restarts at the first entry.
     *
     * @param {object} def - a 'list' definition
     * @param {int} direction - 1 for the next value, -1 for the previous one
     * @returns {string} the new code
     */
    nextListValue(def, direction = 1) {
        const codes = def.values.map((item) => item.code);
        const index = codes.indexOf(this.get(def.key));

        return codes[((index + direction + codes.length) % codes.length)];
    }

    // Wipes the whole store, not just the known keys, so orphan rows of older
    // versions go too. Fire-and-forget like set().
    resetAll() {
        this._values = Object.create(null);
        if (this._database !== null) {
            this._database.clear(this._store).catch((error) => {
                console.warn(this.constructor.name + ' - unable to reset the settings: ' + error.message);
            });
        }

        return this;
    }
}

AppSettings.DIACRITICS = /\p{M}/gu;
