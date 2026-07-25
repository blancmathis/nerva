---
context_room:
  kind: canonical
  scope: product
  status: draft
  canonical_for: parcours utilisateur et exigences de securite du pairing cible
  last_verified: 2026-07-20
  sources: [docs/adr/004-tailscale-serve.md]
---

# Nerva — pairing cible en moins de deux minutes

> Cette page décrit le parcours validé et son critère de fin. Le chemin sans formulaire est maintenant implémenté ; [`CURRENT_STATE.md`](./CURRENT_STATE.md) et [`ADR 004`](../adr/004-tailscale-serve.md) indiquent précisément les preuves physiques déjà obtenues et celles qui manquent encore.

## Résultat attendu

Lorsque le Mac et l'iPad sont déjà connectés au même tailnet, une personne non technique doit pouvoir ouvrir Nerva depuis l'iPad en moins de deux minutes avec une seule commande déjà copiée dans le Terminal, sans copier d'URL, saisir de code, nommer l'appareil ni utiliser un deuxième terminal.

Objectifs de qualité :

- temps médian visé : 30 à 45 secondes ;
- 95 % des pairings terminés en moins de 120 secondes sur une configuration supportée ;
- environ deux secondes d'action humaine sur le Mac : lancer une commande déjà copiée, puis attendre le QR ;
- une commande, un scan, les gestes système d'installation, puis un tap explicite `Connect` ;
- aucune permission ou confirmation qui n'ajoute pas une protection réelle ;
- accès révocable immédiatement depuis le Mac.

L'installation et l'authentification initiales de Tailscale sont un prérequis séparé. Leur durée dépend de l'App Store, du fournisseur d'identité et de la politique du tailnet ; le produit ne doit donc pas les inclure dans la promesse de deux minutes.

## Parcours principal

### 1. Mac

Il n'existe pas d'app macOS Nerva séparée. Après avoir cloné le dépôt, le parcours cible est :

```bash
cd codex-pad
npm run setup:mac
```

`setup:mac` est une commande idempotente qui réalise toute la préparation :

1. installer les dépendances manquantes et construire les artefacts nécessaires ;
2. vérifier Codex Desktop et le bridge ;
3. détecter Tailscale, son état et l'origine MagicDNS sans demander de copier cette origine ;
4. configurer uniquement la route Tailscale Serve appartenant à Codex Pad ;
5. installer ou mettre à jour un LaunchAgent utilisateur, sans `sudo`, pour lancer le bridge à l'ouverture de session ;
6. démarrer ou recharger le bridge ;
7. créer une invitation et afficher son QR dans ce même terminal ;
8. attendre la réussite du pairing, afficher `iPad connected`, puis rendre la main.

La durée murale du premier `npm ci` et du build dépend de la machine et du réseau ; la promesse de « deux secondes via Git » concerne l'effort utilisateur, pas la fin du téléchargement. Les exécutions suivantes sautent les étapes déjà à jour.

La commande effectue un preflight automatique :

1. bridge local démarré et sain ;
2. Tailscale installé, connecté et privé ;
3. route Tailscale Serve exacte de Codex Pad disponible ;
4. Funnel absent pour cette route ;
5. origine HTTPS stable et non sensible.

Elle maintient uniquement la route qu'elle possède et ne lance jamais un reset global de Tailscale Serve. L'exécution explicite de `setup:mac` autorise la création ou la réparation de cette seule route et du seul LaunchAgent Codex Pad. Un conflit avec une route tierce provoque un arrêt avec l'action exacte à effectuer, sans écraser la configuration.

Lorsque le preflight passe, le Mac affiche immédiatement :

- un grand QR ;
- `Scan with your iPad camera` ;
- un compte à rebours de cinq minutes ;
- `Press Ctrl-C to cancel` ;
- un message précis si le Mac perd Tailscale ou si le bridge s'arrête.

Une fois le premier pairing terminé, aucune commande quotidienne n'est nécessaire. Le LaunchAgent redémarre le bridge après reconnexion ou redémarrage du Mac, et le credential iPad reste valide jusqu'à révocation, changement d'origine ou effacement du stockage de la web app.

### 2. Safari et installation

Le QR ouvre l'origine privée HTTPS de Nerva dans Safari. La page ne consomme pas encore l'invitation. Elle montre une instruction visuelle courte pour `Add to Home Screen` et demande de conserver `Open as Web App` activé.

iPadOS traite une web app Home Screen comme une application séparée de Safari. Le parcours ne dépend donc jamais d'un partage de credential ou d'IndexedDB entre Safari et l'app installée.

Le QR ouvre `/pair#pair=<invitation>`. Un fragment n'est pas envoyé dans la ligne de requête HTTP et n'atteint le bridge que lorsque la PWA le soumet dans le corps de `POST /api/pair`. Le manifeste utilise la `start_url` fixe `/pair` afin qu'une installation non appairée arrive toujours sur le parcours de connexion. iPadOS peut conserver l'URL courante avec son fragment lors de l'installation, ou revenir à cette `start_url` sans le fragment ; le produit ne dépend donc jamais de ce handoff et possède obligatoirement le fallback de la section suivante.

### 3. Première ouverture de la web app

L'app installée affiche :

```text
Connect to Mathis's Mac

Private connection through your tailnet.

[ Connect ]
```

Le tap `Connect` est l'unique confirmation explicite. Le nom de l'iPad est généré automatiquement, par exemple `iPad — Nerva`, puis peut être modifié plus tard dans Settings.

Après succès :

1. l'invitation est effacée de l'URL visible ;
2. l'app affiche une courte animation ; un haptic n'est ajouté que si la plateforme expose réellement une API compatible ;
3. le Mac affiche `iPad connected` ;
4. Home ouvre directement la session active sur le Mac, sans l'épingler automatiquement.

## Fallbacks sans saisie

### Invitation non transmise à l'app installée

Si iPadOS ignore la `start_url` ou perd son fragment, l'app affiche `Scan the QR again` et utilise sa caméra pour lire le même QR encore visible sur le Mac. Aucun code manuel n'est nécessaire.

### Nerva déjà installée

Une app installée mais non appairée ouvre directement son scanner interne. L'utilisateur lance `npm run pair` dans le dépôt sur le Mac puis vise le QR depuis Nerva ; le passage par Safari et l'installation sont sautés.

### Expiration ou annulation

- Une invitation est aléatoire, à usage unique et valable cinq minutes.
- Le Mac peut l'annuler immédiatement.
- Une expiration affiche `Pairing expired` et `Show a new QR on your Mac`.
- Générer une nouvelle invitation invalide l'ancienne.
- Un échec réseau ne consomme pas l'invitation avant l'émission durable du credential.

### Remplacement d'un iPad

Lorsqu'un appareil est déjà associé, `npm run pair` indique qu'il remplacera l'iPad actuel après réussite et demande une confirmation simple dans le terminal.

1. Le nouvel iPad effectue le parcours normal.
2. Il reçoit l'état global synchronisé depuis le Mac.
3. L'ancien credential est révoqué seulement après la réussite du nouveau pairing.

Cette séquence évite un verrouillage accidentel. Deux appareils actifs ne constituent pas un parcours produit principal, mais le stockage ne doit pas être corrompu si une période de chevauchement existe.

## Modèle de sécurité

### Invitation courte

- secret aléatoire de 256 bits ;
- transporté dans le fragment du QR et soumis au bridge uniquement dans le corps de l'échange ;
- exact origin HTTPS obligatoire ;
- usage unique, cinq minutes, comparaison en temps constant et rate limiting ;
- pairing possible uniquement à travers la route privée Tailscale Serve ;
- aucune invitation, credential ou ticket dans les logs, captures, cookies, `localStorage` ou cache du service worker.

### Credential de l'appareil

- credential aléatoire propre à l'installation, retourné une seule fois ;
- seul son hash est stocké sur le Mac dans un fichier privé ;
- la web app le conserve dans l'IndexedDB de son origine exacte, avec fallback mémoire uniquement ;
- HTTP utilise un header Authorization ;
- chaque WebSocket utilise un ticket séparé, lié à l'origine, à usage unique et de courte durée ;
- une révocation invalide le credential, les tickets inutilisés et les sockets actifs de cet appareil.

Tailnet et credential applicatif sont deux barrières indépendantes. Le tailnet limite qui peut atteindre le bridge ; le credential décide quel appareil Codex Pad peut utiliser ses API typées.

### Ce qui n'est pas demandé

- aucun compte Codex Pad ;
- aucun mot de passe ;
- aucun Face ID supplémentaire : le verrouillage de l'iPad et la possession physique du QR constituent déjà les gestes utilisateur ;
- aucune confirmation Mac après le scan ;
- aucune app macOS supplémentaire ;
- aucun bearer durable dans le QR ;
- aucun fallback LAN ou Funnel.

## États d'interface

| État | Texte principal | Action |
|---|---|---|
| Dépôt prêt | `npm run setup:mac` | Installer, démarrer et afficher le QR |
| Preflight corrigeable | `Repairing Nerva secure access…` | Automatique dans la portée technique Nerva/CodexPad |
| Tailscale manquant | `Tailscale is required on both devices` | Installer/se connecter puis relancer la même commande |
| QR actif | `Scan with your iPad camera` | `Press Ctrl-C to cancel` |
| Installation Safari | `Add Nerva to your Home Screen` | Instruction système |
| App prête | `Connect to <Mac name>` | `Connect` |
| Succès | `iPad connected` | Ouvrir Home |
| Expiré | `Pairing expired` | Nouveau QR depuis le Mac |
| Révocation | `This iPad was disconnected` | `Pair again` |

## Critères d'acceptation

Le pairing cible n'est pas déclaré terminé tant qu'un test physique n'a pas prouvé :

1. parcours neuf avec iPadOS actuel en moins de 120 secondes après preflight vert ;
2. une seule commande de setup après le clone, sans deuxième terminal ni app macOS ;
3. aucune saisie de code, URL, origine ou nom d'appareil ;
4. installation Home Screen, `start_url` et fallback second scan ;
5. pairing déjà installé sans passage par Safari ;
6. persistance après fermeture du terminal, reconnexion et redémarrage du Mac ;
7. expiration, annulation, rejeu et rate limiting ;
8. absence du secret dans logs HTTP, historique serveur, cookies, service worker et captures de diagnostic ;
9. révocation avec fermeture immédiate du socket ;
10. remplacement d'iPad sans révoquer l'ancien avant la réussite du nouveau ;
11. Funnel absent et bridge toujours lié à loopback.

## Écart avec le dépôt actuel

Le dépôt actuel possède déjà la sécurité fondamentale : nonce fort, usage unique, expiration, origine exacte, rate limiting, bearer révocable, hash côté Mac, IndexedDB exact-origin et tickets WebSocket.

Le chemin Mac cible est implémenté et testé localement par fixtures : `npm run setup:mac`, bootstrap des dépendances, build, détection MagicDNS, refus Funnel, inspection et ajout bornés de la route Serve, LaunchAgent privé, health check, QR et attente dans le même terminal. `npm run pair` renouvelle ensuite l'invitation.

La partie iPad est également alignée dans le code : QR en fragment `/pair#pair=…`, durée de cinq minutes, écran Safari install-first sans consommation, `start_url` `/pair`, nom d'appareil automatique, bouton `Connect`, scanner interne et fallback Camera/Photos. Le propriétaire a confirmé un pairing physique via Tailscale et la persistance lors de la réouverture depuis l'écran d'accueil.

Ce qui manque encore pour fermer les critères d'acceptation : chronométrage instrumenté sous 120 secondes, test depuis un clone totalement neuf, annulation complète, expiration physique, remplacement d'iPad avec révocation différée et matrice iPadOS. Le handoff direct du fragment Safari vers la Home Screen PWA reste une capacité consultative d'iPadOS ; le second scan interne est donc le fallback produit réel, pas une promesse de partage de stockage entre Safari et la PWA.

## Références plateforme

- [WebKit — web apps sur l'écran d'accueil avec iOS et iPadOS 26](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)
- [WebKit — séparation d'une Home Screen web app et de Safari](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [WebKit bug 181849 — ne pas supposer un stockage partagé avec Safari](https://bugs.webkit.org/show_bug.cgi?id=181849)
- [W3C Web App Manifest — `start_url` est consultative](https://www.w3.org/TR/appmanifest/#start_url-member)
