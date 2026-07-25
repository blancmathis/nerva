---
context_room:
  kind: canonical
  scope: product
  status: draft
  canonical_for: comportement fonctionnel et organisation du produit cible
  last_verified: 2026-07-22
  sources: [docs/product/PAIRING_target.md]
---

# Nerva — spécification produit cible

## 0. Nom du produit

Le nom public confirmé est **Nerva**. L'interface visible, les métadonnées installables et le pairing portent ce nom. Les identifiants techniques historiques `codex-pad` / `CodexPad` restent une compatibilité interne pour ne pas perdre les appareils appairés, l'état global ou les scripts existants.

À terme, Nerva devient une interface générale de développement agentique : supervision et contrôle de sessions, interaction vocale, Context Room et surfaces temporaires montrées pendant l'échange. Ces surfaces suivent un schéma Nerva Card strict ; elles ne chargent pas de HTML, JavaScript ou styles arbitraires envoyés par un agent.

> Cette page décrit le produit validé pendant l'interview produit. Elle ne prouve pas que ces comportements sont déjà implémentés. L'état réellement observé reste dans [`CURRENT_STATE.md`](./CURRENT_STATE.md).

## 1. Positionnement

L'adaptateur Codex actuel de Nerva est une extension tactile et visuelle de Codex Desktop sur Mac, pas un remplacement. L'iPad permet de surveiller et choisir une session, organiser les sessions importantes, déclencher quelques actions natives, dicter avec le microphone du Mac, dessiner, ajouter des photos et revoir un site. Le Mac reste la source de vérité, le lieu d'exécution et le détenteur des permissions Codex.

Principes immuables :

1. Toute action distante vise l'identifiant exact de la session affichée. Aucun rapprochement par titre, projet, URL ou fenêtre au premier plan n'est une autorité de routage.
2. Les nouvelles sessions sont créées sur le Mac. L'iPad ne crée, ne fork, n'archive et ne supprime aucune session.
3. L'iPad ne propose ni terminal, ni commande shell arbitraire, ni contrôle CDP brut. Une URL HTTP(S) peut être saisie uniquement pour naviguer un onglet Codex Browser explicitement choisi et ré-attesté pour la Session exacte.
4. Toute l'interface visible et tout texte injecté dans un prompt sont en anglais.
5. Une information sur l'activité de l'agent n'est affichée que si elle vient d'un état fiable. L'interface n'invente jamais ce que l'agent est en train de faire.
6. Nerva invoque les actions natives de Codex ; il ne réimplémente pas ses règles d'envoi, de queue, de steer, de permission ou de modèle.

## 2. Carte des surfaces

| Surface | Rôle | Accès cible |
|---|---|---|
| `Pairing` | Installer et relier l'iPad au Mac en moins de deux minutes lorsque Tailscale est prêt | Conditionnel, avant l'app |
| `Home` | Voir et organiser de 0 à 12 sessions épinglées, puis focaliser temporairement le catalogue complet par priorité ou état | Page principale unique |
| `Capture Inbox` | Capturer photo, scan, dessin, fichier ou idée sans choisir immédiatement une Session ; réutiliser ensuite depuis la Session exacte, sans affectation ni auto-envoi | Bibliothèque autonome depuis Home et entrée directe dans chaque Session, utilisable Mac hors ligne |
| `Unpinned Sessions` | Chercher toutes les sessions non épinglées et en épingler | Tiroir depuis Home |
| `Session` | Agir sur une session exacte et consulter son contexte | Carte Home, session active du Mac ou recherche |
| `Site Review` | Naviguer puis annoter une page ouverte dans Codex Browser | Plein écran depuis Session |
| `Site QA Recorder` | Transformer un parcours tactile Site en reproduction structurée, expurgée et destinée à la Session exacte | Mode `Record flow` depuis Site Review, puis Review dédiée |
| `Drawing Editor` | Dessiner sur une toile ou une image | Depuis Draw, Photo, Site Review ou Saved Drawings |
| `Saved Drawings` | Retrouver les dessins conservés volontairement | Tiroir en un clic depuis chaque Session |
| `Settings` | Personnaliser cartes, modèles, notifications, apparence et appareils | Page secondaire |
| `System Diagnostics` | Comprendre quelle couche est réellement disponible, sa dernière preuve et sa compatibilité | Bouton explicite dans Settings, jamais dans le Home ou la barre globale |
| `Nerva Card` | Afficher un résultat agentique temporaire et strictement borné | Intégration validée, sans HTML arbitraire |

Il n'existe plus de page `Library`. Il n'existe pas non plus de page Spatial séparée : l'organisation spatiale fait partie de Home.

Capture Inbox est désormais implémenté. Sa source de vérité actuelle, son modèle sans affectation, ses limites locales et sa séparation avec Dictation sont dans [`CAPTURE_INBOX.md`](./CAPTURE_INBOX.md).

La cible détaillée de Site QA Recorder — reçu atomique par action, cibles sémantiques, confidentialité, checkpoints, voix, transport exact et proposition Playwright — est définie dans [`SITE_QA_RECORDER_target.md`](./SITE_QA_RECORDER_target.md). Son état d'implémentation réel et ses preuves sont maintenus dans [`CURRENT_STATE.md`](./CURRENT_STATE.md).

## 3. Home et sessions épinglées

### 3.1 Ensemble affiché

- Home affiche uniquement les sessions épinglées, de 0 à 12.
- Il n'y a aucun slot vide et aucun minimum de six cartes. Une seule session épinglée utilise l'espace disponible au lieu de laisser cinq emplacements factices.
- Épingler une treizième session demande d'abord laquelle désépingler.
- Désépingler ne modifie pas la session Codex : elle retourne simplement dans `Unpinned Sessions`.
- Une session ouverte automatiquement depuis le Mac peut être consultée sur l'iPad sans être épinglée.
- Un bouton permanent `Open current Mac session` ouvre sur l'iPad la session actuellement active sur le Mac.

`Unpinned Sessions` contient toutes les sessions non épinglées. Le tiroir permet la recherche, le tri par dernière utilisation et le regroupement ou filtrage par projet. Épingler depuis ce tiroir ajoute immédiatement la session à Home.

### 3.2 Usage Codex

Home affiche un indicateur compact `Codex usage` pour suivre sans quitter la vue d'ensemble :

- les fenêtres affichent la quantité restante, comme Codex, et non la quantité consommée ;
- le contrôle a le même gabarit que `Open current Mac session` ;
- chaque fenêtre de limite réellement exposée par Codex affiche son pourcentage restant et sa durée ; sa prochaine remise à zéro reste accessible depuis le contrôle compact ;
- les durées connues utilisent des libellés directs comme `5-hour limit`, `Daily limit` ou `Weekly limit` ;
- la lecture se rafraîchit automatiquement lorsque l'app revient au premier plan, puis périodiquement tant qu'elle reste visible et connectée ;
- un bouton tactile permet un rafraîchissement immédiat ;
- si Codex est momentanément indisponible, le dernier relevé confirmé peut rester visible avec la mention `Last known usage` ; sans relevé confirmé, l'interface affiche `Usage unavailable` et n'invente jamais `0%`.

### 3.3 Cartes

Le réglage global `Rich cards` ou `Compact cards` s'applique à toutes les cartes.

Une carte riche peut afficher :

- nom de session ;
- projet ou dépôt ;
- worktree, uniquement s'il existe ;
- branche, uniquement si elle existe ;
- indicateur d'état coloré ;
- durée ou fraîcheur, par exemple `Working for 18 minutes`, `Completed 2 minutes ago` ou `Waiting for your answer` ;
- une ou deux lignes maximum décrivant l'activité fiable de l'agent.

La carte doit donner la sensation d'un bouton premium : matériau, profondeur, éclairage local et animation courte. L'information reste lisible et les effets disparaissent ou se simplifient avec `Reduce Motion`.

Lorsque plusieurs signaux sont présents, la classification suit cette priorité : `Needs approval`, `Error`, `Working`, `Waiting`, `Completed`, puis `Idle`.

### 3.4 Ouverture d'une carte

Toucher une carte ouvre immédiatement :

1. la page `Session` correspondante sur l'iPad ;
2. la même session exacte dans Codex Desktop sur le Mac.

L'historique de navigation de l'iPad conserve la surface précédente pour permettre un retour direct, sans perdre le dessin, le site, le zoom ou la sélection en cours.

Lorsqu'un changement venant du Mac remplace automatiquement la vue iPad en état `Following Mac`, un contrôle non bloquant `Return to previous iPad view` permet de reprendre immédiatement l'état sauvegardé. L'utilisateur peut passer à `Staying here` pour empêcher les prochains remplacements automatiques.

Dans le layout Home, il n'existe aucun mode `Arrange`. Un appui long intentionnel démarre directement le déplacement avec le même contact : la carte peut être glissée avant une autre carte, dans une autre case ou vers `Directly on Home`. Le clic synthétique qui suit un dépôt est bloqué sur toutes les cartes afin qu'aucune session ne s'ouvre après la réorganisation. Un appui court conserve toujours son rôle d'ouverture. Les alternatives accessibles sont rangées dans les actions compactes de la carte, tandis que `New section` reste visible en permanence dans la barre Home.

### 3.5 Navigation explicite entre sessions

Le layout manuel et les focus temporaires de Home ne définissent aucun ordre de voisinage pour une page Session. Session n'expose ni rail, ni bouton précédent/suivant, ni pagination, ni swipe global invisible.

Un mouvement horizontal, diagonal ou courbe sur la page Session ne déplace pas la surface et ne peut jamais ouvrir une autre tâche ou revenir à Home. Le scroll vertical reste natif. Les contrôles, Draw et Review conservent leurs propres gestes sans recognizer global concurrent.

La barre Session n'affiche pas de bouton `Home` séparé. La marque de l'application, toujours accessible en haut à gauche hors studios plein écran, est l'unique retour Home en un toucher. L'utilisateur choisit ensuite explicitement la session suivante depuis Home ; la carte utilise l'ouverture exacte décrite en 3.4 et ouvre la même tâche dans Codex Desktop.

## 4. Organisation et focus de Home

Home conserve un seul layout durable et propose des focus temporaires qui ne changent jamais son organisation.

### 4.1 Layout durable

Le mode manuel accepte un seul niveau de hiérarchie :

```text
section -> case -> session cards
```

- L'utilisateur crée, renomme, colore et réordonne les sections.
- Dans chaque section, il peut créer, renommer, colorer, redimensionner automatiquement et réordonner autant de cases qu'il souhaite.
- Il peut déplacer les cases entre sections et les sessions entre cases.
- Il peut réordonner les sessions à l'intérieur d'une même case ou parmi les cartes directes de Home par glisser-déposer tactile.
- Les sections, les cases et leurs cartes restent visibles ensemble sur Home. Une case ne se comporte pas comme un dossier qu'il faudrait ouvrir avant de choisir une session.
- Une session épinglée sans case reste directement visible sur Home ; il n'existe pas de zone artificielle `To arrange`.
- Supprimer une case ne désépingle ni ne supprime ses sessions : elles redeviennent des cartes directes de Home.
- Le déplacement change uniquement la présentation Nerva, jamais l'état ou le projet de la session Codex.

### 4.2 Focus priorité et état

La barre Home contient un petit bouton priorité sans bannière ni texte `Attention view`, puis cinq boutons directement actionnables : `Approval`, `Error`, `Working`, `Waiting`, `Completed`. Un second tap sur le bouton actif revient au layout durable exact.

Chaque filtre d'état parcourt le catalogue validé complet et montre les sessions épinglées puis non épinglées qui correspondent, avec exactement le composant de carte Home. Le bouton priorité montre toutes les sessions épinglées ainsi que les sessions non épinglées non-idle, selon l'ordre :

1. sessions épinglées qui demandent ou méritent une attention ;
2. autres sessions épinglées ;
3. sessions non épinglées qui demandent ou méritent une attention.

À l'intérieur de ces groupes, le statut fiable puis l'activité récente ordonnent les cartes. Aucun filtre ne stocke de second layout, ne déplace une carte, ne modifie un pin ou ne change l'état Codex. Les sessions Idle non épinglées restent accessibles dans `Unpinned Sessions`.

Une session Codex reste l'unité affichée ; les sous-agents internes ne deviennent jamais des cartes supplémentaires. Toucher une carte filtrée ouvre la Session exacte sur l'iPad et le même thread sur le Mac par le chemin existant. Tant qu'un focus Home est actif, un changement de task sur le Mac ne remplace pas la vue ; Follow Mac reprend après entrée dans une Session ou retour au layout sans filtre.

## 5 bis. Capture Inbox

- Capture Inbox ne demande aucune Session avant de capturer.
- `Photo`, `Scan`, `Sketch`, `File` et `Note` restent dans un store local neutre de l'iPad.
- Capture Inbox n'expose aucune action `Voice` et ne demande pas le microphone.
- L'utilisateur ouvre d'abord la Session exacte puis son entrée `Capture Inbox`; aucune destination n'est stockée sur les captures.
- `Use in session` copie les images et notes compatibles dans le Review local du `threadId` affiché. Les originaux restent disponibles et réutilisables depuis une autre Session.
- Cette copie locale ne constitue jamais un envoi. La reconnexion du Mac ne déclenche rien et Review conserve sa propre confirmation d'envoi.
- Un fichier non pris en charge reste local et n'est jamais supprimé silencieusement.

La première version est volontairement observation/navigation : elle ne lance pas de prompt et n'expose aucun bouton Stop, Steer, Interrupt, réassignement ou shell. Ces mutations exigeraient chacune un contrat Codex exact et une décision produit séparée.

## 6. Relation Mac ↔ iPad

Les termes doivent rester distincts :

- `Pin to Home` / `Unpin from Home` contrôlent la présence de la session sur Home.
- L'état explicite `Following Mac` / `Staying here` contrôle la synchronisation de navigation.

### Following Mac

- Changer de session sur le Mac ouvre la même session sur l'iPad.
- Toucher une session sur l'iPad ouvre la même session sur le Mac.
- La page et l'état local précédents de l'iPad restent dans son historique pour pouvoir les reprendre.
- Réactiver le suivi depuis `Staying here` aligne immédiatement l'iPad sur la session déjà active sur le Mac, sans exiger un second changement côté Mac.
- Une session active hors des six slots reste suivie pour la navigation, mais ne reçoit aucune autorité de contrôle native.

### Staying here

- L'iPad reste sur la session affichée lorsque le Mac change de session.
- Draw, Photo, Site, Skills et tout envoi visent toujours cette session exacte.
- La dictée native peut ramener cette session au premier plan sur le Mac, car elle utilise l'interface et le microphone natifs de Codex Desktop.

Les contrôles `Pin to Home` et l'état `Following Mac` / `Staying here` sont indépendants et accessibles depuis la page Session.

## 7. Page Session

### 7.1 Actions principales

La page présente quatre actions principales :

- `Dictation`
- `Draw`
- `Photo`
- `Sites`, toujours visible

`Sites` ouvre toujours une liste unifiée, sans catégories linked/unlinked, mais strictement limitée aux pages dont Codex Desktop prouve l'appartenance à la Session exacte. Une page d'une autre Session, une association ambiguë ou une URL privée dupliquée n'apparaît pas et reste incontrôlable avec l'identifiant de cette Session. Le bouton ne dépend d'aucune inscription manuelle et ne bascule jamais vers l'import Photo/Files ou la Review d'images.

### 7.2 Contrôles secondaires en un clic

- `Skills` ouvre la liste des skills réellement accessibles à cette session, regroupés automatiquement par fournisseur ou portée.
- Un curseur linéaire unique change la combinaison `Model + Reasoning`.
- `Fast` est un bouton séparé.
- `Send prompt` est un bouton compact et tactile qui soumet le composer natif Mac déjà préparé.
- `Pin to Home` / `Unpin from Home` et `Following Mac` / `Staying here` restent immédiatement accessibles.

Les combinaisons proposées par le curseur sont définies et ordonnées dans Settings. Cette liste configurée est une allowlist stricte : aucun autre modèle du catalogue ne peut apparaître lorsque les presets choisis sont désactivés ou temporairement indisponibles. Le catalogue live complet sert seulement de valeur initiale tant qu'aucun preset n'a été configuré.

L'ordre recommandé parcourt les raisonnements d'un modèle, puis passe au modèle suivant. Le changement s'applique immédiatement à la session et persiste pour les messages suivants. Sur Safari tactile, la valeur finale reste autoritative même si le dernier événement `input` arrive après `pointerup`; un rejet définitif restaure la dernière combinaison live observée. Une combinaison ou un mode Fast non supporté est désactivé avec une explication ; aucun fallback silencieux n'est autorisé.

### 7.3 Contexte conditionnel

Il n'existe pas de barre d'actions permanente supplémentaire. Un panneau contextuel apparaît seulement lorsqu'il apporte une action fiable :

- approbation : `View command`, `Approve`, `Reject`, `Add instruction` ;
- erreur : message fiable, `Open on Mac`, `Add instruction` ;
- interface terminée : priorité à `Site` et `Review result`.

`View command` montre la commande complète et son répertoire de travail. `Add instruction` lance la dictée native de Codex sur le Mac ; il n'ouvre pas un clavier de prompt sur l'iPad. `Steer`, `Cancel` et `Interrupt` ne sont jamais proposés sur l'iPad.

Toute autre action native qui n'est pas prouvée pour la session exacte est cachée ou explicitement indisponible. Nerva ne simule jamais une action Codex manquante.

## 8. Skills, dictée et envoi

### 8.1 Skills

- Les provenances sont organisées automatiquement. Un dossier repliable est créé seulement lorsqu'une provenance contient au moins deux skills ; un skill seul reste directement visible. Les labels possibles incluent `Computer Use`, `GitHub`, `OpenAI Templates`, `Project Skills`, `My Skills` et `System Skills` selon le catalogue réel.
- Chaque groupe affiche son nombre de skills et le nombre sélectionné. Le regroupement ne change jamais l'identifiant exact envoyé à Codex et ne nécessite aucune configuration manuelle.
- Le Mac dérive seulement un identifiant de fournisseur borné depuis la provenance validée du skill. Aucun chemin local, version de plugin ou répertoire utilisateur n'est exposé à l'iPad.
- La sélection est multiple et visible sous forme de chips.
- Elle vaut uniquement pour le prochain envoi textuel composé par Nerva, puis s'efface après cet envoi accepté.
- Les skills sont ajoutés au moment de composer le payload final, jamais au moment de leur sélection.
- La sélection est liée à la session exacte. Un envoi de dessin image-only ne la consomme pas ; elle reste armée jusqu'au prochain envoi textuel contrôlé par Nerva ou jusqu'à son annulation explicite.
- Nerva ne prétend jamais modifier une saisie ou dictée envoyée directement par le composer natif du Mac s'il ne peut pas garantir cette interception pour la session exacte.
- Le suffixe anglais est toujours la toute dernière partie du message, même si la transcription a été produite après la sélection :

```text
Use the following skills for this task: skill-a, skill-b.
```

- Un envoi de dessin reste strictement image-only : aucun suffixe de skill ou texte invisible n'est joint au PNG.

### 8.2 Dictée native uniquement

- `Dictation` ne demande jamais l'accès au microphone de l'iPad : il commande le microphone natif du Mac. Capture Inbox n'enregistre aucune voix. Le microphone iPad reste réservé aux fonctions qui l'annoncent explicitement, comme une note vocale de checkpoint Site QA.
- Il n'emploie ni `MediaRecorder`, ni reconnaissance vocale web, ni stockage audio, ni transcription locale.
- `Dictation` déclenche la dictée native de Codex Desktop avec le microphone configuré sur le Mac.
- L'écriture manuelle reste sur le Mac ; l'iPad n'offre pas de clavier de prompt général.

À la fin d'une dictée, Codex Desktop reste propriétaire de son flux natif, de la transcription et de l'éventuel envoi. Nerva ne reproduit pas ce composer sur l'iPad et n'affiche ni transcript ni état de queue.

Le bouton compact `Send prompt` permet de soumettre depuis l'iPad le composer préparé sur le Mac. Hors dictée, il utilise directement l'identité native exacte `ACT12` / `CODEX` / `composer.submit` de la session sélectionnée. Pendant une dictée active, une pression relâche d'abord le geste `dictation.toggle` exact, attend sa confirmation et le snapshot natif actualisé, puis déclenche `composer.submit`. Si l'arrêt échoue ou reste d'issue inconnue, la soumission n'est pas tentée automatiquement. Le comportement effectif reste celui configuré dans Codex Desktop : Queue ou Steer. L'iPad ne choisit pas ce mode, ne rejoue pas l'action hors ligne et n'affiche pas un faux état `Queued` ou `Sent`.

Des images peuvent déjà être présentes dans le composer avant la dictée. Si la dictée ou son ajout échoue, les images déjà attachées au composer Mac y restent et les brouillons encore disponibles sur l'iPad ne sont ni supprimés ni envoyés automatiquement.

### 8.3 Images et action Send

Drawing et Photo offrent une seule action principale `Send`. Il n'existe ni champ d'instruction, ni étape `Review before send`, ni texte implicite. L'action ajoute seulement le PNG final au composer Mac de la session exacte ; elle ne soumet pas le composer et ne lance donc pas d'appel Codex.

Après confirmation réelle du transfert, l'image glisse latéralement vers Codex, le brouillon de travail local est supprimé et le studio se ferme. Rouvrir Draw pour cette session présente donc une nouvelle page. En cas d'échec ou d'issue inconnue, le dessin reste disponible et réessayable avec la même identité idempotente. Cette suppression ne concerne jamais un original conservé explicitement dans Saved Drawings.

L'utilisateur complète éventuellement le message sur le Mac, par saisie ou dictée native, puis l'envoie depuis Codex Desktop. Ce futur envoi suit les réglages queue/steer de Codex, mais l'action `Send` du studio iPad n'envoie elle-même aucun message. L'iPad n'affiche donc aucun état `Queued` ou `Sent` ; il confirme uniquement que l'image est visible dans le composer exact.

### 8.4 Futur mode Nerva Voice

Le futur contrôle vocal général reste un mode produit séparé de `Dictation` et des notes vocales bornées de Site QA. Il pourra utiliser le microphone de l'iPad uniquement après une action et une permission explicites, montrer des Nerva Cards pendant l'échange et demander confirmation avant toute mutation sensible. Capture Inbox n'implique ni agent vocal, ni transcription, ni transport audio vers Codex.

## 9. Draw, Photo et Saved Drawings

### 9.1 Éditeur partagé

Draw ouvre une toile blanche de la taille de l'écran, extensible verticalement mais non infinie. Photo propose `Camera`, `Photo Library` ou `Files`, puis ouvre exactement le même éditeur.

Outils : stylo, surligneur, gomme, flèche, rectangle, ellipse, texte, couleurs, tailles, annuler, rétablir, effacer avec confirmation et image de fond. En mode `Pencil only`, seul `pointerType="pen"` peut écrire ou placer un outil : un contact tactile unique, y compris la paume, reste passif et deux doigts sont nécessaires pour déplacer ou zoomer. Si iPadOS annule malgré tout le pointeur Pencil, les échantillons déjà visibles sont conservés comme trait partiel au lieu de disparaître. L'Apple Pencil dessine avec pression et inclinaison ; le rendu local vise 60/120 Hz et les orientations portrait et paysage.

Pendant l'édition, les traits, l'historique, le viewport et le brouillon restent locaux à l'iPad. Il n'existe pas de synchronisation en temps réel du dessin vers le Mac.

### 9.2 Fin du dessin

- `Send` transfère directement le PNG final dans le composer exact, sans champ de message et sans soumission, selon les règles de la section précédente.
- `Keep` transfère volontairement le dessin au stockage global géré par le Mac et le rend disponible dans `Saved Drawings` sur un futur iPad.
- Un brouillon non envoyé est restauré à la prochaine ouverture. Un `Send` confirmé supprime seulement ce brouillon de travail ; un échec ou un résultat inconnu le conserve pour retry.
- Les images conservent leur qualité d'origine autant que possible. Toute compression nécessaire est annoncée.

### 9.3 Saved Drawings

Le tiroir est disponible en un clic depuis toutes les pages Session, se filtre par session d'origine et conserve les dessins jusqu'à suppression manuelle. Utiliser un dessin dans une autre session ne crée pas une copie conceptuelle et ne modifie pas l'original conservé.

Le nombre d'images envoyables est une capacité runtime, pas une constante revendiquée par la documentation publique de Codex. La cible sûre actuelle est 12 images lorsque l'installation Codex utilisée a réussi l'attestation correspondante ; sinon l'interface applique la limite réellement vérifiée et l'explique.

### 9.4 Schémas collaboratifs

Depuis une Session exacte, Codex peut publier un schéma structuré vers Draw. Le document conserve des blocs, formes, couleurs, positions, dimensions, flèches et libellés modifiables ; il ne s'agit ni d'une image figée, ni de HTML/SVG arbitraire. À l'ouverture de Draw, la dernière révision non vue de cette Session s'affiche automatiquement.

L'utilisateur peut déplacer, redimensionner, renommer, recolorer, relier, ajouter ou supprimer les blocs au doigt, puis utiliser `Draw on top` pour annoter librement au Pencil. La structure et l'encre restent deux couches distinctes pendant l'édition. `Sync revision` renvoie uniquement la structure au stockage privé Mac ; `Keep` et `Send` synchronisent d'abord toute structure sale. `Send` conserve sa règle existante : un unique PNG aplati est attaché au composer exact, sans texte implicite et sans soumettre le message.

Chaque écriture utilise une révision optimiste. Une nouvelle révision Codex ne remplace jamais silencieusement des changements iPad non synchronisés. Après un Send confirmé, la page de travail locale est supprimée et la révision envoyée ne se rouvre pas ; une publication Codex ultérieure avec une révision plus récente la rend de nouveau disponible. Le contrat opérable et les commandes appartiennent à [`../COLLABORATIVE_DIAGRAMS.md`](../COLLABORATIVE_DIAGRAMS.md).

## 10. Site Review

Site Review doit également accueillir l'action cible `Record flow`. Le Recorder conserve une chronologie locale des contrôles confirmés, permet de marquer et annoter le problème, puis prépare un rapport expurgé pour la Session exacte. Il ne génère pas un trace Playwright brut et n'envoie, ne rejoue ou n'exécute rien automatiquement. Le contrat complet appartient à [`SITE_QA_RECORDER_target.md`](./SITE_QA_RECORDER_target.md) afin de ne pas dupliquer ici son modèle de données et ses règles de confidentialité.

### 10.1 Ouverture et identité

- `Sites` reste accessible dans chaque Session et ouvre une page unique limitée aux pages HTTP(S) actuellement ouvertes dans Codex Browser pour cette tâche exacte.
- La page contient une barre d'adresse. L'utilisateur choisit d'abord une page prouvée, puis peut la naviguer vers une URL HTTP(S) saisie ou favorite. Sans page ré-attestée pour cette Session, `Go` reste indisponible.
- Les favoris sont globaux, synchronisés avec les autres préférences et ne deviennent jamais une autorité de routage : ils fournissent seulement une adresse à la page explicitement choisie.
- Les sites locaux, Nerva lui-même et les sites HTTPS externes ont exactement le même statut dans cette liste. L'interface ne montre aucune catégorie `Linked`, `Unlinked`, `Registered` ou équivalente.
- Toucher une ligne choisit explicitement cette page pour la Session actuellement visible. Aucun titre, URL, projet, onglet au premier plan ou historique ne crée automatiquement cette sélection.
- Si une page ouvre un nouvel onglet, celui-ci apparaît comme une ligne distincte au prochain rafraîchissement du sélecteur.
- Fermer ou naviguer l'onglet sur le Mac invalide ou met à jour sa représentation ; l'app ne réattribue jamais silencieusement une autre page au même choix.

### 10.2 Navigation et annotation

La surface Site est plein écran et se comporte d'abord comme une vue distante simple du site : tap, formulaires via saisie contrôlée, liens, défilement tactile, retour, avance et rechargement. La frame visible se rafraîchit depuis le Mac sans charger le site dans un iframe iPad.

Le premier contact Apple Pencil fige immédiatement la frame courante et commence le trait. En mode `Pencil only`, les doigts restent réservés à la navigation ; après activation de `Touch + Pencil`, le premier trait au doigt déclenche la même transition vers l'annotation. L'utilisateur peut aussi toucher `Annotate` explicitement.

La surface d'annotation reste volontairement minimale : couleurs, largeur, Undo, Clear, retour `Browse` et `Send`. Elle n'affiche ni filmstrip, ni `Blank frame`, ni Photo/Files, ni Camera, ni tiroir de comparaison. Les imports et la Review d'images restent des surfaces distinctes.

`Send` exporte uniquement la frame annotée en PNG et l'attache au composer Mac de la session exacte, sans texte implicite et sans soumettre le message. Revenir à `Browse` abandonne les traits de cette frame et reprend le site live.

### 10.3 Limites d'autorité

Cette navigation n'autorise pas un contrôle navigateur générique. Le bridge doit redécouvrir la page choisie dans le renderer Codex vérifié avant chaque opération et n'accepter qu'un petit vocabulaire typé. La PWA peut demander une navigation HTTP(S) explicite et bornée dans cet onglet ; elle ne reçoit jamais l'adresse du debugger, le protocole CDP, une primitive JavaScript, un sélecteur DOM, le presse-papiers, le système de fichiers ou le bureau complet.

Le dessin et la navigation restent utilisables pendant que l'agent travaille ; seule l'attache finale dépend de l'autorité live sur la session exacte. La preuve sur navigateur automatisé ne remplace pas la validation iPad/Pencil physique consignée dans [`CURRENT_STATE.md`](./CURRENT_STATE.md).

## 11. Persistance, hors ligne et changement d'iPad

Le Mac conserve et resynchronise, dans la limite des capacités disponibles :

- sessions épinglées ;
- disposition manuelle complète et ordre des sections automatiques ;
- réglages globaux ;
- presets du curseur Model + Reasoning ;
- Saved Drawings ;
- dernier site choisi par session.

Changer d'iPad retrouve donc le même état global après un nouveau pairing. Les brouillons de dessin non conservés avec Keep restent propres à l'iPad où ils ont été créés.

Deux iPads simultanés ne constituent pas un parcours produit à optimiser. Le stockage et les écritures doivent seulement rester cohérents et ne pas corrompre l'état si cela arrive.

Un changement local de layout, pins ou presets reste marqué comme non synchronisé tant que le Mac n'a pas confirmé son écriture. Le scope local distingue layout et préférences : après un conflit de révision, seuls les champs réellement modifiés localement remplacent la nouvelle copie Mac. Une fermeture, un conflit ou une déconnexion ne doit ni perdre cet intent local, ni écraser un changement distant indépendant. Une session n'est retirée des pins que par une action explicite `Unpin`, jamais parce qu'un snapshot de catalogue l'omet momentanément.

Lorsque le Mac dort ou est hors ligne, l'app reste consultable, affiche `Mac unavailable`, préserve les brouillons et désactive les actions distantes. Elle attend la reconnexion sans envoyer automatiquement un brouillon ou répéter une action ambiguë.

## 12. Réglages, notifications et qualité d'interface

Settings contient :

- `Rich cards` / `Compact cards` ;
- thème `System`, `Light` ou `Dark` ;
- animations et respect de `Reduce Motion` ;
- haptics ;
- notifications ;
- appareils appairés et révocation ;
- combinaisons et ordre du curseur Model + Reasoning ;
- disposition Home par défaut ;
- gestion de Saved Drawings.
- accès à System Diagnostics et à l'état Context Room local en lecture seule.

Les notifications configurables couvrent `Needs approval`, `Completed`, `Error` et `Waiting for your answer`. La permission est toujours déclenchée par un geste explicite de l'utilisateur dans la PWA installée. L'abonnement appartient à l'appareil appairé et l'expéditeur Web Push reste dans le bridge privé du Mac.

Le moteur ne notifie que :

- une question réellement bloquante ;
- une approval ;
- une erreur ;
- la complétion importante d'une session épinglée ;
- plusieurs résultats importants regroupés.

Une notification ne contient aucun titre de session, prompt, output, commande, chemin ou résumé privé ; elle ouvre seulement la Session exacte ou le focus priorité de Home. Une approval sensible ne peut jamais être acceptée ou rejetée depuis l'écran verrouillé. Le badge reflète uniquement l'attention structurée des sessions épinglées.

Les haptics ne sont proposés que si la plateforme expose réellement une API compatible ; sinon le réglage reste indisponible avec une explication claire.

L'interface s'adapte au portrait et au paysage, privilégie le paysage pour Site Review, reste accessible au clavier et aux technologies d'assistance, et garde un aspect premium fondé sur la lumière, la matière, la profondeur et des animations brèves plutôt que sur une décoration excessive.

## 13. Pairing

Le pairing cible n'exige aucune app macOS séparée. Après le clone, une commande idempotente `npm run setup:mac` installe et démarre le bridge en arrière-plan, configure sa route privée et affiche le QR. L'utilisateur ne copie aucune URL, ne saisit aucun code et ne nomme pas l'appareil. L'iPad installe la web app puis confirme `Connect to <Mac name>`. Le parcours, sa sécurité, ses fallbacks et son objectif de moins de deux minutes sont canoniquement définis dans [`PAIRING_target.md`](./PAIRING_target.md).

## 14. Hors périmètre

- Recréer Codex Desktop, un IDE, un terminal ou un remote desktop sur l'iPad.
- Créer, forker, archiver ou supprimer des sessions depuis l'iPad.
- Capturer ou transcrire le microphone de l'iPad dans `Dictation`, Capture Inbox ou dans le mode actuel de contrôle des Sessions Codex. La note vocale bornée d'un checkpoint Site QA reste une exception séparée et explicitement déclenchée.
- Fournir un champ de prompt général dans le mode actuel de contrôle des Sessions Codex. Un futur mode Nerva Voice constitue une surface séparée avec permissions et confirmations dédiées.
- Fournir des boutons Steer, Cancel ou Interrupt.
- Transformer les cases en workflow ou déclencher une mutation Codex par drag-and-drop.
- Envoyer automatiquement un brouillon après reconnexion.
- Déduire une cible à partir d'un titre, d'une URL, d'une fenêtre active ou d'une ressemblance de projet.

## 15. Preuves encore nécessaires

Les décisions produit ci-dessus sont confirmées. Les points suivants sont des preuves d'implémentation à obtenir, pas des questions produit à rouvrir :

1. pairing complet sous deux minutes sur iPad physique, y compris installation Home Screen et fallback ;
2. propriété partagée vérifiée avec le Codex Desktop déjà ouvert ;
3. ouverture bidirectionnelle exacte des sessions et reprise de l'état iPad ;
4. dictée native réelle avec le microphone du Mac ;
5. envoi image-only exact, animation confirmée et récupération locale sans double action ;
6. suffixe Skills à la fin de tout futur payload textuel contrôlé par Nerva ;
7. Apple Pencil, pression, paume et rendu 60/120 Hz sur matériel ;
8. navigation Site Review sûre, fluide et liée à la bonne page ;
9. persistance globale après remplacement de l'iPad ;
10. comportement hors ligne, reprise et absence de double action.
11. catalogue complet dans les focus Home, ordre pinned/attention, statuts fiables et ouverture exacte d'une session sur le Mac/iPad du propriétaire.
