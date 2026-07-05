// Français — reflète chaque clé de en.ts (source de vérité) ; seules les valeurs sont traduites (tokens {name} et variantes .one/.other : voir en.ts).
const dict: Record<string, string> = {
  "app.name": "Komuboard",

  // common (reused across components)
  "common.close": "Fermer",
  "common.cancel": "Annuler",
  "common.save": "Enregistrer",
  "common.done": "Terminé",
  "common.remove": "Retirer",
  "common.delete": "Supprimer",
  "common.duplicate": "Dupliquer",
  "common.custom": "Personnalisé",
  "common.none": "Aucun",
  "common.color": "Couleur",
  "common.menu": "Menu",
  "common.help": "Aide",
  "common.undo": "Annuler",
  "common.redo": "Rétablir",
  "common.dismiss": "Ignorer",
  "common.group": "Grouper",
  "common.ungroup": "Dissocier",
  "common.lock": "Verrouiller",
  "common.unlock": "Déverrouiller",
  "common.bringToFront": "Premier plan",
  "common.sendToBack": "Arrière-plan",

  // tools
  "tool.dockLabel": "Outils",
  "tool.select": "Sélectionner",
  "tool.hand": "Main",
  "tool.pen": "Dessiner",
  "tool.eraser": "Gomme",
  "tool.insert": "Insérer",
  "tool.sticky": "Pense-bête",
  "tool.text": "Texte",
  "tool.shapes": "Formes et lignes",
  "tool.stamp": "Tampon",
  "tool.image": "Image",
  "insert.sticky": "Pense-bête",
  "insert.shape": "Forme",

  // draw bar
  "draw.barLabel": "Options de dessin",
  "draw.pen": "Stylo",
  "draw.highlighter": "Surligneur",
  "draw.lineStyle": "Style de ligne",
  "draw.colourAria": "Couleur",
  "draw.customColour": "Couleur personnalisée",
  "draw.strokeWidth": "Épaisseur du trait",
  "draw.solid": "Continu",
  "draw.dotted": "Pointillé",
  "draw.strokeWidthValue": "Épaisseur du trait · {w} px",

  // colors (COLOR_NAMES + highlight + sticky + user palettes)
  "color.black": "Noir",
  "color.red": "Rouge",
  "color.orange": "Orange",
  "color.yellow": "Jaune",
  "color.green": "Vert",
  "color.blue": "Bleu",
  "color.purple": "Pourpre",
  "color.pink": "Rose",
  "color.white": "Blanc",
  "color.cyan": "Cyan",
  "color.gray": "Gris",
  "color.teal": "Sarcelle",
  "color.amber": "Ambre",
  "color.violet": "Violet",
  "color.fuchsia": "Fuchsia",
  "color.lime": "Vert citron",
  "color.indigo": "Indigo",

  // shapes
  "shape.line": "Ligne",
  "shape.arrow": "Flèche",
  "shape.elbow": "Flèche coudée",
  "shape.block": "Flèche pleine",
  "shape.rectangle": "Rectangle",
  "shape.ellipse": "Ovale",
  "shape.rhombus": "Losange",
  "shape.triangle": "Triangle",

  // text bar
  "text.font": "Police",
  "text.fontSize": "Taille de police",
  "text.font.sans": "Sans",
  "text.font.serif": "Serif",
  "text.font.mono": "Mono",
  "text.font.handwriting": "Manuscrite",
  "text.size.small": "Petite",
  "text.size.medium": "Moyenne",
  "text.size.large": "Grande",
  "text.size.extraLarge": "Très grande",
  "text.size.huge": "Énorme",
  "text.textStyle": "Style de texte",
  "text.bold": "Gras",
  "text.italic": "Italique",
  "text.underline": "Souligné",
  "text.strikethrough": "Barré",
  "text.bulletedList": "Liste à puces",
  "text.link": "Lien",
  "text.textColor": "Couleur du texte",
  "text.highlight": "Surlignage",
  "text.alignment": "Alignement",
  "text.align.left": "Gauche",
  "text.align.center": "Centre",
  "text.align.right": "Droite",
  "text.shape": "Forme",
  "text.fillColor": "Couleur de remplissage",
  "text.border": "Bordure",
  "text.noFill": "Sans remplissage",
  "text.borderDashed": "Tirets",
  "text.noBorder": "Sans bordure",
  "text.linkPlaceholder": "Saisir ou coller une URL",
  "text.removeLink": "Supprimer le lien",
  "text.linkOpen": "Ouvrir",
  "text.linkEdit": "Modifier",
  "text.ungroupTitle": "Dissocier ({shortcut})",

  // connectors
  "connector.lineWeight": "Épaisseur du trait",
  "connector.startPoint": "Point de départ",
  "connector.endPoint": "Point d'arrivée",
  "connector.weightThin": "Fin",
  "connector.weightMedium": "Moyen",
  "connector.weightThick": "Épais",
  "connector.weightBold": "Très épais",
  "connector.capOutline": "Contour",
  "connector.capCircle": "Cercle",
  "connector.capDiamond": "Losange",
  "connector.styleSolid": "Continu",
  "connector.styleDashed": "Tirets",

  // zoom
  "zoom.out": "Zoom arrière",
  "zoom.in": "Zoom avant",
  "zoom.level": "Niveau de zoom",
  "zoom.levelPercent": "Niveau de zoom (pourcentage)",
  "zoom.reset": "Réinitialiser le zoom",
  "zoom.fullscreen": "Plein écran",

  // color picker
  "picker.pickFromScreen": "Prélever à l'écran",
  "picker.eyedropper": "Pipette",
  "picker.hex": "Couleur hexadécimale",
  "picker.hue": "Teinte",
  "picker.satBright": "Saturation et luminosité",

  // emoji / stamp
  "emoji.search": "Rechercher",
  "emoji.searchAria": "Rechercher un emoji",
  "emoji.noResults": "Aucun emoji trouvé",
  "emoji.more": "Plus d'emojis",
  "emoji.generic": "Emoji",
  "emoji.labeled": "Emoji {emoji}",
  "stamp.picker": "Sélecteur de tampons",
  "stamp.thumbsUp": "Autocollant pouce levé",
  "stamp.onePlus": "Autocollant +1",
  "stamp.star": "Autocollant étoile",
  "stamp.question": "Autocollant point d'interrogation",
  "stamp.thumbsDown": "Autocollant pouce baissé",
  "stamp.sparkle": "Autocollant étincelle",
  "stamp.avatar": "Autocollant de votre avatar",
  "stamp.heart": "Autocollant cœur",

  // sticky
  "sticky.barLabel": "Couleurs des pense-bêtes",

  // selection bar
  "selection.barLabel": "Actions de sélection",
  "selection.rotate": "Pivoter de 15°",

  // menus (context + app)
  "menu.cut": "Couper",
  "menu.copy": "Copier",
  "menu.paste": "Coller",
  "menu.selectAll": "Tout sélectionner",
  "menu.zoomToFit": "Ajuster à l'écran",
  "menu.editProfile": "Modifier le profil",
  "menu.enterVr": "Entrer en VR",
  "menu.export": "Exporter…",
  "menu.language": "Langue",

  // settings
  "settings.grid": "Grille",
  "settings.gridStyle": "Style de grille",
  "settings.dots": "Points",
  "settings.lines": "Lignes",
  "settings.theme": "Thème",
  "settings.darkTheme": "Thème sombre",

  // topbar
  "topbar.resetView": "Réinitialiser la vue",
  "topbar.shareBoard": "Partager le tableau",

  // share dialog
  "share.title": "Partager ce tableau",
  "share.qrLabel": "QR code du lien de la salle",
  "share.scanForLink": "Scanner pour obtenir le lien",
  "share.roomLink": "Lien de la salle",
  "share.copyLink": "Copier le lien",
  "share.copied": "Copié !",
  "share.helper": "Aucune inscription requise — toute personne disposant du lien peut le modifier.",
  "share.native": "Partager…",
  "share.shareText": "Rejoignez mon tableau",

  // profile dialog
  "profile.title": "Votre profil",
  "profile.uploadPhoto": "Importer une photo",
  "profile.displayName": "Nom affiché",
  "profile.namePlaceholder": "Votre nom",
  "profile.guestFallback": "Invité",
  "profile.updateCta": "Mettre à jour le profil",

  // export dialog
  "export.title": "Exporter",
  "export.fileType": "Type de fichier",
  "export.png": "PNG",
  "export.pdf": "PDF",
  "export.background": "Arrière-plan",
  "export.bgGrid": "Grille",
  "export.bgTransparent": "Transparent",
  "export.bgSolid": "Uni",

  // shortcuts dialog
  "shortcuts.title": "Raccourcis clavier",
  "shortcuts.handPan": "Main / déplacement",
  "shortcuts.deleteSelection": "Supprimer la sélection",
  "shortcuts.groupUngroup": "Grouper / dissocier",
  "shortcuts.lockUnlock": "Verrouiller / déverrouiller (bascule)",
  "shortcuts.rotate": "Pivoter (±15° / ±90° avec Maj)",
  "shortcuts.nudge": "Décaler la sélection (1 px / 10 px avec Maj)",
  "shortcuts.zorder": "Premier plan / arrière-plan",
  "shortcuts.pan": "Déplacement (maintenir)",
  "shortcuts.zoomInOut": "Zoom avant / arrière",
  "shortcuts.export": "Exporter (PNG / PDF)",
  "shortcuts.toggleMenu": "Afficher/masquer ce menu",

  // status / scrims / banner
  "status.preparingVr": "Préparation de la VR…",
  "status.exporting": "Exportation…",
  "status.reconnecting": "Reconnexion…",
  "status.backOnline": "De nouveau en ligne",

  // toasts
  "toast.vrStartFailed": "Impossible de démarrer la VR sur cet appareil.",
  "toast.imageAddFailed": "Impossible d'ajouter cette image.",
  "toast.nothingToExport":
    "Rien à exporter pour le moment — ajoutez d'abord un élément au tableau.",
  "toast.exportFailed": "Échec de l'exportation — veuillez réessayer.",
  "toast.imageTypeUnsupported":
    "Ce type d'image n'est pas pris en charge — utilisez PNG, JPG, WebP ou GIF.",
  "toast.imageEmpty": "Cette image semble vide ou corrompue.",
  "toast.imageProcessFailed": "Impossible de traiter cette image.",
  "toast.imageTooLarge":
    "Cette image est trop volumineuse (plus de 5 Mo même après redimensionnement).",
  "toast.uploadFailedConnection": "Échec de l'envoi — vérifiez votre connexion et réessayez.",
  "toast.uploadFailed": "Échec de l'envoi — veuillez réessayer.",

  // refused / disconnect dialog
  "refused.roomFullTitle": "Cette salle est pleine",
  "refused.disconnectedTitle": "Vous avez été déconnecté",
  "refused.roomFullBody":
    "Jusqu'à {max} personnes peuvent modifier un tableau à la fois. Réessayez dans un instant, ou créez un nouveau tableau.",
  "refused.rateLimitBody":
    "Vous envoyiez des mises à jour trop rapidement et avez été déconnecté. Le problème se résout généralement tout de suite.",
  "refused.newBoard": "Nouveau tableau",
  "refused.tryAgain": "Réessayer",
  "refused.reconnect": "Se reconnecter",
  "refused.roomFullDialogTitle": "Salle pleine",
  "refused.disconnectedDialogTitle": "Déconnecté",

  // presence (toasts / nudge / avatar row)
  "presence.joinedToast": "{name} a rejoint",
  "presence.youAre": "Vous êtes {name}",
  "presence.you": "{name} (vous)",
  "presence.overflowChip": "+{count}",
  "presence.showMore.one": "Afficher {count} personne de plus",
  "presence.showMore.other": "Afficher {count} personnes de plus",
  "presence.moreCollaborators": "Plus de collaborateurs",
  "presence.nudgeHint": "Choisissez un nom et une couleur que les autres verront.",

  // drawer
  "drawer.room": "Salle",

  // accessibility mirror + announcer
  "a11y.boardLabel": "Tableau blanc collaboratif",
  "a11y.roleDescription": "tableau blanc",
  "a11y.mirrorLabel": "Contenu du tableau",
  "a11y.empty": "Le tableau est vide.",
  "a11y.hintSelectable.one":
    "{count} objet sur le tableau. Placez le focus dessus pour le sélectionner, puis modifiez-le au clavier.",
  "a11y.hintSelectable.other":
    "{count} objets sur le tableau. Placez le focus sur l'un d'eux pour le sélectionner, puis modifiez-le au clavier.",
  "a11y.hintListed.one": "{count} objet sur le tableau, listé ci-dessous.",
  "a11y.hintListed.other": "{count} objets sur le tableau, listés ci-dessous.",
  "a11y.objStickyNote": "pense-bête",
  "a11y.objText": "texte",
  "a11y.objLabeled": "{kind} : {text}",
  "a11y.objEmpty": "{kind} vide",
  "a11y.objStroke": "dessin à main levée",
  "a11y.objConnector": "connecteur",
  "a11y.objImage": "image",
  "a11y.objEmojiSticker": "autocollant emoji",
  "a11y.objSticker": "autocollant",
  "a11y.objGeneric": "objet",
  "a11y.someone": "Quelqu'un",
  "a11y.joined": "{name} a rejoint le tableau.",
  "a11y.joinedMany": "{count} personnes ont rejoint le tableau.",
  "a11y.someoneLeft": "Quelqu'un a quitté le tableau.",
  "a11y.leftMany": "{count} personnes ont quitté le tableau.",

  // VR
  "vr.exit": "Quitter la VR",
};
export default dict;
