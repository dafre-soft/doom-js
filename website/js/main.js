function loadApp()
{
    new AppViewportStabilizer().install();

    // The saved language is applied once the settings are read (MenuNavigator._boot).
    appTranslator.addCatalog(AppMenuTranslations.CATALOG)
        .addCatalog(DoomTranslations.CATALOG)
        .setFallbackLanguage('en')
        .setLanguage('en');

    doomImageAssets.load();
    doomFinaleTexts.load();
    doomLevelPatches.load();

    AppMenuSound.setPlayer((event) => doomSound.playUi('menu/' + event));

    loader.world().setUserClass(DoomUser);

    const menu = new MenuNavigator();
    menu.start();
}

appBootstrap.setReadyCallback(() => {
    // The API file loaded first (synchronously in index.html) with _booted
    // false; the app's scripts are only all executed when this ready
    // callback runs — flip readiness here so waitReady()/launch() work.
    if ((window.doomApi !== undefined) && (window.doomApi !== null)) {
        window.doomApi.markBooted();
    }

    loadApp();
});
