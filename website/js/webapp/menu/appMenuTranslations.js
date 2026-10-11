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
            'key.arrowLeft': {
                fr: 'Flèche gauche',
                en: 'Left arrow',
                it: 'Freccia sinistra',
                es: 'Flecha izquierda'
            },
            'key.arrowRight': {
                fr: 'Flèche droite',
                en: 'Right arrow',
                it: 'Freccia destra',
                es: 'Flecha derecha'
            },
            'key.arrowUp': {
                fr: 'Flèche haut',
                en: 'Up arrow',
                it: 'Freccia su',
                es: 'Flecha arriba'
            },
            'key.arrowDown': {
                fr: 'Flèche bas',
                en: 'Down arrow',
                it: 'Freccia giù',
                es: 'Flecha abajo'
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
            // --- Control binding capture and labels ---
            'menu.capture.key': {
                fr: 'Appuyez sur la touche à utiliser pour « {action} »…',
                en: 'Press the key to use for "{action}"…',
                it: 'Premi il tasto da usare per «{action}»…',
                es: 'Pulsa la tecla que quieres usar para «{action}»…'
            },
            'menu.capture.padButton': {
                fr: 'Appuyez sur le bouton de la manette à utiliser pour « {action} »…',
                en: 'Press the gamepad button to use for "{action}"…',
                it: 'Premi il pulsante del controller da usare per «{action}»…',
                es: 'Pulsa el botón del mando que quieres usar para «{action}»…'
            },
            'menu.capture.padAxis.right': {
                fr: 'Poussez vers la droite le stick à utiliser pour « {action} »…',
                en: 'Push right on the stick to use for "{action}"…',
                it: 'Spingi a destra lo stick da usare per «{action}»…',
                es: 'Empuja hacia la derecha el stick que quieres usar para «{action}»…'
            },
            'menu.capture.padAxis.up': {
                fr: 'Poussez vers le haut le stick à utiliser pour « {action} »…',
                en: 'Push up on the stick to use for "{action}"…',
                it: 'Spingi in alto lo stick da usare per «{action}»…',
                es: 'Empuja hacia arriba el stick que quieres usar para «{action}»…'
            },
            'pad.button': {
                fr: 'Bouton {number}',
                en: 'Button {number}',
                it: 'Pulsante {number}',
                es: 'Botón {number}'
            },
            'pad.axis': {
                fr: 'Axe {number}',
                en: 'Axis {number}',
                it: 'Asse {number}',
                es: 'Eje {number}'
            },
            'menu.binding': {
                fr: '{action} : {control}',
                en: '{action}: {control}',
                it: '{action}: {control}',
                es: '{action}: {control}'
            },
            'menu.unbound': {
                fr: 'non attribuée',
                en: 'not set',
                it: 'non assegnato',
                es: 'sin asignar'
            },
            'pad.axisInverted': {
                fr: 'Axe {number} inversé',
                en: 'Axis {number} inverted',
                it: 'Asse {number} invertito',
                es: 'Eje {number} invertido'
            },
            'key.shift': {
                fr: 'Maj',
                en: 'Shift',
                it: 'Maiusc',
                es: 'Mayús'
            },
            'key.left': {
                fr: '{key} gauche',
                en: 'Left {key}',
                it: '{key} sinistro',
                es: '{key} izquierda'
            },
            'key.right': {
                fr: '{key} droite',
                en: 'Right {key}',
                it: '{key} destro',
                es: '{key} derecha'
            },
            'key.numpad': {
                fr: 'Num {key}',
                en: 'Numpad {key}',
                it: 'Num {key}',
                es: 'Num {key}'
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
