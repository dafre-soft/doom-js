/**
 * Texts of the js/webapp/ menus, in every language of the projects that use
 * them. A project adds this catalog next to its own (appTranslator.addCatalog).
 */
class AppMenuTranslations {
    static get CATALOG() {
        return {
            // --- Buttons ---
            'menu.back': {
                fr: 'Retour',
                en: 'Back',
                it: 'Indietro',
                es: 'Volver'
            },
            'menu.close': {
                fr: 'Fermer',
                en: 'Close',
                it: 'Chiudi',
                es: 'Cerrar'
            },
            'menu.confirm': {
                fr: 'Confirmer',
                en: 'Confirm',
                it: 'Conferma',
                es: 'Confirmar'
            },
            'menu.cancel': {
                fr: 'Annuler',
                en: 'Cancel',
                it: 'Annulla',
                es: 'Cancelar'
            },
            // --- On-screen keyboard ---
            'key.space': {
                fr: 'Espace',
                en: 'Space',
                it: 'Spazio',
                es: 'Espacio'
            },
            // Accessible name of the erase key.
            'menu.keyboard.erase': {
                fr: 'Effacer',
                en: 'Erase',
                it: 'Cancella',
                es: 'Borrar'
            },
            // --- Setting values ---
            'value.yes': {
                fr: 'Oui',
                en: 'Yes',
                it: 'Sì',
                es: 'Sí'
            },
            'value.no': {
                fr: 'Non',
                en: 'No',
                it: 'No',
                es: 'No'
            },
            // --- Units ---
            'unit.byte': {
                fr: 'o',
                en: 'B',
                it: 'B',
                es: 'B'
            },
            'unit.kilobyte': {
                fr: 'Ko',
                en: 'KB',
                it: 'KB',
                es: 'KB'
            },
            'unit.megabyte': {
                fr: 'Mo',
                en: 'MB',
                it: 'MB',
                es: 'MB'
            }
        };
    }
}
