---
context_room:
  kind: index
  scope: product
  status: current
  canonical_for: navigation de la documentation produit
  last_verified: 2026-07-22
  sources: [docs/product/FEATURES_target.md, docs/product/SITE_QA_RECORDER_target.md, docs/product/CAPTURE_INBOX.md, docs/product/PAIRING_target.md, docs/product/CURRENT_STATE.md]
---

# Nerva — documentation produit

Ce dossier sert de source de vérité éditoriale pour clarifier le produit avant de poursuivre son implémentation.

## Ordre de vérification

1. [`FEATURES_target.md`](./FEATURES_target.md) — la spécification fonctionnelle cible validée pendant l'interview. C'est le document principal.
2. [`SITE_QA_RECORDER_target.md`](./SITE_QA_RECORDER_target.md) — le contrat cible du Recorder ; son implémentation actuelle et ses limites prouvées sont consignées dans `CURRENT_STATE.md`.
3. [`CAPTURE_INBOX.md`](./CAPTURE_INBOX.md) — la bibliothèque locale réellement implémentée pour capturer sans Session, réutiliser depuis une Session exacte sans affectation et ne jamais envoyer à la reconnexion.
4. [`PAIRING_target.md`](./PAIRING_target.md) — le parcours de pairing sans saisie, son objectif de moins de deux minutes et ses invariants de sécurité.
5. [`CURRENT_STATE.md`](./CURRENT_STATE.md) — ce qui existe réellement dans le dépôt, avec les preuves et les limites connues.
6. [`../RELIABILITY.md`](../RELIABILITY.md) — la preuve de capacités, les mises à jour PWA, les notifications et les intégrations bornées réellement implémentées.

## Règle de lecture

- `FEATURES_target.md`, `SITE_QA_RECORDER_target.md` et `PAIRING_target.md` décrivent ce que le produit **doit devenir**. `CAPTURE_INBOX.md` et `CURRENT_STATE.md` décrivent des surfaces actuellement implémentées. Une décision cible ne prouve pas à elle seule qu'un effet réel est déjà live sur le matériel.
- `CURRENT_STATE.md` décrit uniquement ce qui est **observable aujourd'hui** dans le code ou lors d'une vérification locale.
- La source de ces décisions est l'interview GRILL ME complète. Une correction ultérieure remplace une réponse antérieure ; après l'énoncé de la règle « absence de réponse = recommandation acceptée », une recommandation laissée sans réponse est confirmée.
- Les documents techniques existants dans le dossier parent `docs/` décrivent surtout l'architecture et le setup actuellement implémentés. Ils ne peuvent pas redéfinir la cible produit. Lorsqu'un ADR indique qu'il est partiellement remplacé par la cible produit, suivre les fichiers `_target` pour le futur comportement et `CURRENT_STATE.md` pour le présent.

## Vocabulaire de statut

- **Confirmé** : décision donnée explicitement par Mathis ou recommandation acceptée selon sa règle « absence de réponse = recommandation acceptée » ; l'implémentation doit la respecter.
- **Inconnu d'implémentation** : preuve runtime ou matérielle encore manquante, sans rouvrir la décision produit.
- **Cible** : comportement confirmé mais pas encore prouvé dans le produit actuel.
- **Actuel** : comportement observé dans le dépôt ou lors d'une vérification locale explicitement datée.

## Utilisation de la Context Room

La Context Room est volontairement limitée à ce dossier. Son ordre de revue commence par la spec fonctionnelle, le Site QA Recorder, le pairing, l'état actuel, puis cette page d'orientation.

Commandes locales :

```bash
npm run context-room:start
npm run context-room:doctor
```

La validation d'un document dans la room signifie seulement qu'il a été relu. Elle ne signifie pas que les fonctionnalités décrites sont implémentées.
