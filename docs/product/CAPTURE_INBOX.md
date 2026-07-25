---
context_room:
  kind: canonical
  scope: product
  status: current
  canonical_for: comportement implemente de Capture Inbox
  last_verified: 2026-07-22
  sources: [apps/web/src/components/CaptureInboxPage.tsx, apps/web/src/lib/capture-inbox-store.ts, apps/web/src/lib/capture-review.ts, apps/web/e2e/codex-pad.spec.ts, apps/web/e2e/pwa-offline.spec.ts]
---

# Nerva — Capture Inbox

Capture Inbox est une bibliothèque locale réutilisable. Elle permet de capturer du contexte sans choisir immédiatement une Session, puis d'ouvrir cette même bibliothèque depuis la Session exacte où l'utilisateur veut employer ce contexte.

Une capture n'est jamais assignée à une Session. Nerva ne stocke ni destination, ni état de routage, ni marque `prepared` dans l'Inbox.

## Parcours utilisateur actuel

### Capturer et gérer depuis Home

1. Depuis Home, l'utilisateur ouvre `Capture Inbox`.
2. Il choisit `Photo`, `Scan`, `Sketch`, `File` ou `Note`.
3. La capture est enregistrée dans IndexedDB sur cet iPad, sans Session et sans appel au Mac.
4. Il peut rechercher, filtrer ou consulter les captures. Chaque carte possède une corbeille tactile directe ; `Select` permet aussi une suppression multiple avec un bouton `Delete` explicite.
5. Toute suppression demande confirmation. Annuler conserve l'original ; confirmer le retire seulement de cet iPad.

### Utiliser depuis une Session

1. L'utilisateur ouvre d'abord la Session exacte.
2. Dans `Choose an input`, il touche `Capture Inbox`.
3. L'Inbox affiche un contexte temporaire portant le titre de cette Session. Ce contexte n'est pas écrit sur les captures.
4. Il sélectionne une ou plusieurs notes ou images compatibles puis touche `Use in session`.
5. Nerva copie ces éléments dans le Review local du `threadId` exact et ouvre ce Review. Les originaux restent dans l'Inbox.
6. Le même élément peut être repris plus tard depuis une autre Session. La première utilisation ne le déplace, ne le consomme et ne l'assigne pas.

`Use in session` n'envoie rien au Mac. L'envoi reste celui du Review existant : aperçu explicite, capacité exacte et confirmation séparée. Une reconnexion ne déclenche aucune de ces étapes.

Le changement de Session sur le Mac ne ferme pas une capture commencée depuis Home. En revanche, lorsqu'une Session ouvre l'Inbox, le contexte d'utilisation reste borné à cette Session exacte jusqu'au retour explicite.

## Types de capture

| Type | Capture locale | Utilisation actuelle dans une Session |
|---|---|---|
| `Photo` | Caméra ou photothèque via le picker système | Oui, après validation et normalisation PNG/JPEG/WebP/HEIC/HEIF par le pipeline Review |
| `Scan` | Photo de document via la caméra arrière | Oui, comme une image. Nerva ne prétend pas fournir le scanner documentaire natif d'iPadOS. |
| `Sketch` | Canvas tactile/Pencil, Pencil-only par défaut, paume passive et navigation à deux doigts | Oui, sous forme de PNG borné |
| `File` | Un fichier reçu, sans exécution ni prévisualisation arbitraire | Seulement si le fichier est une image compatible. Les autres fichiers restent locaux. |
| `Note` | Texte local jusqu'à 20 000 caractères | Oui, dans l'instruction générale du Review. Une note seule exige encore une image ou annotation avant que Review puisse préparer un envoi valide. |

Capture Inbox ne propose aucune action `Voice` et ne demande jamais le microphone. La dictée d'une Session et la note vocale d'un checkpoint Site QA restent des fonctionnalités séparées avec leurs propres contrats.

Nerva ne supprime et ne convertit jamais silencieusement un fichier non pris en charge. Une sélection contenant un fichier non-image explique la limite et reste dans l'Inbox.

## Stockage et migration

- base IndexedDB séparée : `nerva-capture-inbox` ;
- 200 captures maximum ;
- 32 MiB maximum par capture ;
- 256 MiB maximum comptabilisés pour les données de l'Inbox ;
- bytes stockés comme `ArrayBuffer` pour éviter les clones `Blob` peu fiables de WebKit ;
- aucun champ de destination, affectation, préparation ou livraison ;
- suppression directe par carte ou multiple par sélection, toujours avec confirmation.

La version 2 du store migre sans perte les anciennes données locales : elle retire les anciens champs de destination/préparation et transforme un ancien enregistrement `voice` en fichier audio générique. Son titre devient `Audio file…`, ses bytes sont conservés et aucun microphone n'est réexposé dans l'interface.

Capture Inbox n'est pas synchronisé dans le Product State Mac et ne revient pas sur un iPad de remplacement. Ce choix est volontaire : les captures restent locales. Les layouts, préférences et Saved Drawings conservent leurs règles de synchronisation distinctes.

## Garanties de non-envoi

Le store Capture Inbox ne possède aucun champ `queued`, `pendingSend`, commande, retry ou replay. Capturer, consulter, sélectionner et supprimer n'appellent ni `/api/command`, ni le transport Sketch, ni `sendReview`.

`Use in session` écrit seulement dans le Review local du `threadId` affiché. La reconnexion du WebSocket ou du bridge ne lit pas l'Inbox et ne lance aucun effet de livraison. Seul un geste ultérieur dans Review peut construire puis confirmer un envoi.

## Preuves et limites

Les tests locaux couvrent le store, la migration v1 → v2, l'absence d'état de destination, le refus des fichiers non transportables, la copie note/image vers le Review exact, la réutilisation d'une même capture dans deux Sessions, le rechargement, l'offline/reconnexion, l'absence de commande Mac et le canvas Pencil émulé. Les parcours passent sous Chromium et WebKit en iPad paysage, iPad portrait et téléphone.

Restent à valider sur le matériel réel : caméra/Photos/Files, stockage sous pression iPadOS, Apple Pencil physique, suspension/arrière-plan et persistance après éviction iPadOS.
