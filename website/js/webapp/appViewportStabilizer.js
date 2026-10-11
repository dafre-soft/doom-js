/**
 * iOS Safari leaves a residual negative scroll after a rotation, which shifts
 * the centered #screen and the touch coordinates: the page is scrolled back to
 * the origin on every rotation or resize. The deferred passes catch iOS
 * settling the layout a few frames later.
 */
class AppViewportStabilizer {
    constructor() {
        this._onChange = () => this._stabilize();
    }

    install() {
        window.addEventListener('orientationchange', this._onChange);
        window.addEventListener('resize', this._onChange);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', this._onChange);
        }
        // A rotation during the loading screen happened before the listeners existed.
        this._stabilize();

        return this;
    }

    _stabilize() {
        window.scrollTo(0, 0);
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                window.scrollTo(0, 0);
            });
        });
        setTimeout(() => {
            window.scrollTo(0, 0);
        }, AppViewportStabilizer.SETTLE_MS);
    }
}

AppViewportStabilizer.SETTLE_MS = 250;
