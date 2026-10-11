/**
 * The doom modals: the confirmation, information, loading and error ones of
 * AppMenuModal, plus the end-of-level tally and the finale texts.
 */
class MenuModal extends AppMenuModal {
    /**
     * End-of-level tally: the level's closing sentence as a title, one line per
     * score (label on the left, value on the right) and a single full-width
     * button. Not dismissable by clicking outside — the player has to press it.
     * Without a label (a sub following the main's), it only shows.
     *
     * A cooperative tally adds a table under the lines, in a wider shell: a
     * column per player, headed by its name in its colour, a row per score.
     *
     * @param {string}        title
     * @param {object[]}      lines  - [{label, value}], value already formatted
     * @param {string|null}   label  - button label, null for no button
     * @param {function|null} action
     * @param {object|null}   table  - {columns: [{name, color|null}], rows: [{label, values}]}, null for none
     */
    tally(title, lines, label, action, table = null) {
        const shellClass = ((table !== null) ? 'app-menu-modal doom-menu-modal-tally' : 'app-menu-modal');
        const {modal}    = this._createShell(title, shellClass, 'app-menu-modal-message');

        const body = AppMenuDom.addElement(modal, 'div', 'doom-menu-tally');
        for (const line of lines) {
            const row = AppMenuDom.addElement(body, 'div', 'doom-menu-tally-line');
            AppMenuDom.addText(row, 'doom-menu-tally-label', line.label);
            AppMenuDom.addText(row, 'doom-menu-tally-value', line.value);
        }
        if (table !== null) {
            this._addTallyTable(body, table);
        }

        this._addActionButton(modal, label, action);

        return this;
    }

    /**
     * Story text of the end of a chapter (or of the game), shown after the
     * tally. The text IS the message of the shell — no title, the tally just
     * announced the end of the level. Like the tally, it waits for its button,
     * or only shows without a label.
     *
     * @param {string}        text
     * @param {string|null}   label  - button label, null for no button
     * @param {function|null} action
     */
    finale(text, label, action) {
        const {modal} = this._createShell(text, 'app-menu-modal doom-menu-modal-finale', 'doom-menu-finale');

        this._addActionButton(modal, label, action);

        return this;
    }

    // --- Internal ---

    _addTallyTable(body, table) {
        const grid = AppMenuDom.addElement(body, 'div', 'doom-menu-tally-table');
        grid.style.gridTemplateColumns = 'auto repeat(' + table.columns.length + ', minmax(0, 1fr))';
        AppMenuDom.addElement(grid, 'div', 'doom-menu-tally-label');
        for (const column of table.columns) {
            const header = AppMenuDom.addText(grid, 'doom-menu-tally-player', column.name);
            if (column.color !== null) {
                AppMenuDom.addColorSwatch(header, column.color);
            }
        }
        for (const row of table.rows) {
            const label = AppMenuDom.addText(grid, 'doom-menu-tally-label', row.label);
            if ((row.color ?? null) !== null) {
                AppMenuDom.addColorSwatch(label, row.color);
            }
            for (const value of row.values) {
                AppMenuDom.addText(grid, 'doom-menu-tally-value', value);
            }
        }
    }

    // The single full-width button of the tally and the finale; none without a label.
    _addActionButton(modal, label, action) {
        if (label === null) {
            return;
        }
        const actions = AppMenuDom.addElement(modal, 'div', 'app-menu-modal-actions');
        const button = AppMenuDom.addButton(actions, 'app-menu-button app-menu-button-block', label, () => {
            this.close();
            action();
        });
        this._attachButtonsNav([button], button, 0);
    }
}
