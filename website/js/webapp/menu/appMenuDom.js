/**
 * Shared DOM building helpers of the menus, used by the screens and the modals
 * — one single way to create an element, a text block or a button.
 */
class AppMenuDom {
    // Press feedback: a pressed control brightens for this long, then its
    // action fires — the press stays visible on mouse, keyboard, gamepad and
    // touch alike.
    static PRESS_FEEDBACK_MS = 250;
    static _pressing         = false;

    static isPressing() {
        return AppMenuDom._pressing;
    }

    // One press in flight at a time, across every button and list entry: a
    // second activation during the feedback beat is dropped, never queued. A
    // control removed meanwhile (its screen re-rendered) drops its action.
    static press(el, pressedClass, action, feedbackMs = AppMenuDom.PRESS_FEEDBACK_MS) {
        if (AppMenuDom._pressing === true) {
            return;
        }
        AppMenuDom._pressing = true;
        AppMenuSound.play(AppMenuSound.CHOOSE);
        el.classList.add(pressedClass);
        setTimeout(() => {
            AppMenuDom._pressing = false;
            el.classList.remove(pressedClass);
            if (!el.isConnected) {
                return;
            }
            action();
        }, feedbackMs);
    }

    static addElement(parent, tagName, className) {
        const element = document.createElement(tagName);
        element.className = className;
        parent.appendChild(element);

        return element;
    }

    // A colour square (a player's slot colour), first in its parent.
    static addColorSwatch(parent, color) {
        const swatch = AppMenuDom.addElement(parent, 'span', 'app-menu-color-swatch');
        swatch.style.background = color;
        parent.insertBefore(swatch, parent.firstChild);

        return swatch;
    }

    static addText(parent, className, text) {
        const element = AppMenuDom.addElement(parent, 'div', className);
        element.textContent = text;

        return element;
    }

    // Opens in a new tab: the app is a PWA, so following a link in place would
    // leave the app shell with no way back.
    static addLink(parent, className, text, href) {
        const element = AppMenuDom.addElement(parent, 'a', className);
        element.textContent = text;
        element.href        = href;
        element.target      = '_blank';
        element.rel         = 'noopener noreferrer';

        return element;
    }

    // Selectable list entry shell (item + label) — the caller registers it on
    // its AppMenuListNavigation and may append extra children (infos, buttons).
    static addListItem(listEl, labelText) {
        const item = AppMenuDom.addElement(listEl, 'div', 'app-menu-item');
        AppMenuDom.addText(item, 'app-menu-item-label', labelText);

        return item;
    }

    // Delete cross of a list row (press feedback included, row not selected).
    static addDeleteButton(item, titleText, onDelete) {
        const button = AppMenuDom.addButton(item, 'app-menu-button app-menu-item-delete', '\u2715', onDelete);
        button.title = titleText;

        return button;
    }

    // Overlay stacking rule: only the top-most overlay of a display reacts to
    // inputs (a nested modal suspends everything beneath it).
    static isTopOverlay(container, overlay) {
        const overlays = container.querySelectorAll('.app-menu-overlay');

        return (overlays[overlays.length - 1] === overlay);
    }

    static hasOverlay(container) {
        return (container.querySelector('.app-menu-overlay') !== null);
    }

    static formatSize(bytes) {
        const oneDecimal = (value) => new Intl.NumberFormat(appTranslator.getLocale(), {minimumFractionDigits: 1, maximumFractionDigits: 1}).format(value);
        if (bytes >= 1048576) {
            return oneDecimal(bytes / 1048576) + ' ' + appTranslator.get('unit.megabyte');
        }
        if (bytes >= 1024) {
            return oneDecimal(bytes / 1024) + ' ' + appTranslator.get('unit.kilobyte');
        }

        return bytes + ' ' + appTranslator.get('unit.byte');
    }

    /**
     * @param {int} totalSeconds
     * @param {int} minuteDigits - minutes padded to this many digits
     * @returns {string} M:SS or MM:SS
     */
    static formatClock(totalSeconds, minuteDigits) {
        return String(Math.trunc(totalSeconds / 60)).padStart(minuteDigits, '0') + ':' + String(totalSeconds % 60).padStart(2, '0');
    }

    static formatDay(timestamp) {
        return new Date(timestamp).toLocaleDateString(appTranslator.getLocale());
    }

    // Seconds are for the save slots: two saves may land in the same minute.
    static formatDate(timestamp, withSeconds = false) {
        const date        = new Date(timestamp);
        const locale      = appTranslator.getLocale();
        const timeOptions = {hour: '2-digit', minute: '2-digit'};
        if (withSeconds) {
            timeOptions.second = '2-digit';
        }

        return date.toLocaleDateString(locale)
            + ' ' + date.toLocaleTimeString(locale, timeOptions);
    }

    // The blur avoids a focused button: a focused one would swallow the next
    // Enter as a native re-click (e.g. reopening a freshly closed modal).
    // Propagation stops right away — a delete cross must not select its row.
    static addButton(parent, className, label, onClick, feedbackMs = AppMenuDom.PRESS_FEEDBACK_MS) {
        const button = AppMenuDom.addElement(parent, 'button', className);
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            event.currentTarget.blur();
            AppMenuDom.press(button, 'app-menu-button-pressed', () => {
                onClick(event);
            }, feedbackMs);
        });

        return button;
    }
}
