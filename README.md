# Chess coach

Analyse tes parties d'échecs et compare tes erreurs à ton entraînement, directement dans ton navigateur. Aucune installation, aucun serveur, aucun compte : tout tourne et tout reste chez toi.

- **Analyses** : importe tes parties Chess.com en un clic (ou colle un PGN). Stockfish analyse chaque coup dans le navigateur, puis une IA rédige les explications : les 3 choses bien faites, les 3 à changer (coup joué vs coup du moteur, échiquiers à faire défiler), et les questions de timing (« pu faire, plus vite, trop vite »).
- **Tableau de bord** : un radar des thèmes qui reviennent dans tes erreurs (fourchettes, clouages, finales…), croisé avec tes puzzles Lichess, pour savoir quoi travailler en priorité.

## Utiliser

**En ligne** : [juleslassoeur.com/lab/chess/live](https://juleslassoeur.com/lab/chess/live/)

**En local** : sers le dossier avec n'importe quel serveur statique, puis ouvre la page.

```bash
npx serve .            # ou : python3 -m http.server 8000
```

(Ouvrir `index.html` en `file://` ne suffit pas : le moteur tourne dans un Web Worker, qui exige un serveur.)

## Réglages (dans l'app)

Tout se configure dans l'onglet **Réglages**, et reste dans le localStorage de ton navigateur :

| Champ | Rôle |
|---|---|
| Pseudo Chess.com | Importer tes parties récentes et tes classements (API publique, aucune clé) |
| Jeton Lichess | Synchroniser tes puzzles. [Générer le jeton ici](https://lichess.org/account/oauth/token/create?scopes[]=puzzle:read&description=chess-coach) (lecture seule, scope `puzzle:read`), puis le coller |
| Clé API IA | Rédiger les explications : une clé [Gemini](https://aistudio.google.com/apikey) (`AIza…`) ou [Anthropic](https://console.anthropic.com/settings/keys) (`sk-ant-…`) |
| Modèle (optionnel) | Par défaut `gemini-3.8-flash` ou `claude-sonnet-5` selon la clé |

Sans clé IA, l'app marche quand même : moteur, échiquiers, évaluations et radar — seules les explications rédigées manquent. Les clés ne sont envoyées qu'aux services concernés (Lichess, Google, Anthropic) au moment des appels.

## Tes données

Analyses, puzzles et réglages sont stockés dans le navigateur (localStorage). L'onglet Réglages permet d'**exporter** le tout en JSON, de le **réimporter** sur une autre machine, ou de **tout effacer**. Si le stockage se remplit, les analyses les plus anciennes sont retirées en premier — exporte régulièrement si tu y tiens.

## Structure

```
index.html            interface (Tableau de bord / Analyses / Réglages)
app.js                tout le front : moteur, pipeline d'analyse, radar, stockage local, appels API
styles.css
data/example.json     une analyse d'exemple, affichée au premier chargement
vendor/stockfish.asm.js   moteur Stockfish (build asm.js, tourne en Web Worker)
vendor/chess.js       règles du jeu et lecture des PGN
```

## Licences

Ce projet est sous **GPL-3.0** (voir `LICENSE`) : il distribue [Stockfish.js](https://github.com/nmrugg/stockfish.js) (GPL-3.0, voir `vendor/stockfish-LICENSE.txt`). [chess.js](https://github.com/jhlywa/chess.js) est sous licence BSD-2-Clause.
