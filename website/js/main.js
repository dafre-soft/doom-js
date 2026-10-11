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

appBootstrap.setReadyCallback(loadApp);
