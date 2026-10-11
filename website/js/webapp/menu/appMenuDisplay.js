/**
 * Virtual 1920x1080 (or 1080x1920) letterboxed screen for the DOM menus: the
 * container is letterboxed in JS and its font-size scaled by the ratio, so the
 * em-based menu CSS stays proportional at any window size.
 */
class AppMenuDisplay {
    /**
     * @param {string} screenId
     * @param {string} orientation - AppMenuDisplay.LANDSCAPE | AppMenuDisplay.PORTRAIT
     */
    constructor(screenId, orientation = AppMenuDisplay.LANDSCAPE) {
        const portrait = (orientation === AppMenuDisplay.PORTRAIT);

        this._screen         = document.getElementById(screenId);
        this._width          = ((portrait) ? AppMenuDisplay.SHORT_SIDE : AppMenuDisplay.LONG_SIDE);
        this._height         = ((portrait) ? AppMenuDisplay.LONG_SIDE : AppMenuDisplay.SHORT_SIDE);
        this._ratio          = 1.;
        this._container      = null;
        this._resizeListener = this._resizeDelayed.bind(this);
    }

    /**
     * @param {boolean} transparent true = transparent display pinned over the
     *                              page content (a menu over a running game),
     *                              instead of the opaque standalone background
     */
    init(transparent = false) {
        // A re-init must not stack a second container: the orphan would push
        // the new menu aside.
        this.destroy();

        this._container = document.createElement('div');
        this._container.className = 'app-menu-display' + ((transparent) ? ' app-menu-display-transparent' : '');
        this._screen.appendChild(this._container);

        this.resize();
        window.addEventListener('resize', this._resizeListener);

        return this;
    }

    getContainer() {
        return this._container;
    }

    resize() {
        if (this._container === null) {
            return;
        }

        const maxW = window.innerWidth;
        const maxH = window.innerHeight;

        if (maxW * this._height < maxH * this._width) {
            this._ratio                  = maxW / this._width;
            this._container.style.width  = maxW + 'px';
            this._container.style.height = (maxW * this._height / this._width) + 'px';
        } else {
            this._ratio                  = maxH / this._height;
            this._container.style.width  = (maxH * this._width / this._height) + 'px';
            this._container.style.height = maxH + 'px';
        }

        this._container.style.fontSize = (AppMenuDisplay.BASE_FONT_SIZE * this._ratio) + 'px';
    }

    destroy() {
        window.removeEventListener('resize', this._resizeListener);

        if (this._container !== null) {
            this._container.remove();
            this._container = null;
        }
    }

    // --- Internal ---

    _resizeDelayed() {
        setTimeout(this.resize.bind(this), AppMenuDisplay.RESIZE_DELAY_MS);
    }
}

AppMenuDisplay.LANDSCAPE       = 'landscape';
AppMenuDisplay.PORTRAIT        = 'portrait';
AppMenuDisplay.LONG_SIDE       = 1920;
AppMenuDisplay.SHORT_SIDE      = 1080;
// Font size at ratio 1: the em unit of the menu CSS.
AppMenuDisplay.BASE_FONT_SIZE  = 33;
AppMenuDisplay.RESIZE_DELAY_MS = 250;
