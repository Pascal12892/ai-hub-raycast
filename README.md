# AI Hub für Raycast (macOS)

Raycast-Erweiterung für Gemini über Antigravity CLI, Claude Code und Codex CLI. Fragen gehen an einen Anbieter oder an alle drei parallel. Die Antworten erscheinen direkt in Raycast, mit Detailansicht und Rückfragen im selben Gespräch.

Mac-Umbau von [Alebabo/ScreenAi](https://github.com/Alebabo/ScreenAi) (PowerToys-Run-Plugin für Windows).

Die Erweiterung nutzt die vorhandenen Abo-Anmeldungen der lokalen CLIs. Sie braucht keine API-Schlüssel und wechselt nicht auf API-Abrechnung.

## Voraussetzungen

- macOS mit [Raycast](https://www.raycast.com)
- Node.js 22 oder neuer und npm (nur für die Installation der Erweiterung)
- Mindestens eine der drei CLIs, installiert und einmal im Terminal angemeldet:

```bash
claude auth status     # erwartet: authMethod "claude.ai"
codex login status     # erwartet: Logged in using ChatGPT
agy                    # Antigravity CLI für Gemini, einmal anmelden
```

Ein Anbieter ohne CLI zeigt in der Ergebnisliste nur eine Fehlermeldung. Die anderen funktionieren trotzdem.

## Installation

```bash
git clone https://github.com/Pascal12892/ai-hub-raycast.git
cd ai-hub-raycast
npm install
npm run dev
```

`npm run dev` importiert die Erweiterung in Raycast. Danach erscheinen in Raycast die Befehle. Den Entwicklungsmodus kannst du mit Ctrl+C beenden, die Erweiterung bleibt in Raycast installiert.

## Bedienung

Raycast öffnen (Standard: Cmd+Leertaste) und einen Befehl wählen:

| Befehl        | Anbieter                       |
| ------------- | ------------------------------ |
| Alle fragen   | Gemini, Claude, Codex parallel |
| Claude fragen | Claude                         |
| Gemini fragen | Gemini über Antigravity        |
| Codex fragen  | Codex                          |

Die Frage kann direkt als Argument hinter dem Befehl stehen. Dann startet die Anfrage sofort. Ohne Argument öffnet sich ein Eingabefeld, und erst Enter sendet.

- Links stehen die Anbieter mit Status, rechts die vollständige Antwort.
- Nach einer Antwort ins Suchfeld tippen und Enter drücken: Das ist eine Rückfrage mit dem bisherigen Verlauf.
- Ohne Text im Suchfeld kopiert Enter die Antwort des markierten Anbieters.
- Cmd+K zeigt alle Aktionen: Antwort einfügen (Cmd+Shift+V), Modell wählen (Cmd+M), Abbrechen (Ctrl+C), Neues Gespräch (Cmd+N), Einstellungen.

Tipp: In den Raycast-Einstellungen unter Extensions kannst du jedem Befehl einen Alias (z. B. `cl` für Claude fragen) oder einen eigenen Hotkey geben.

Alle drei Anbieter bekommen denselben Caveman-Ultra-Stilprompt wie das Original: kurze Antworten mit höchstens 35 Wörtern, außer die Frage verlangt ausdrücklich Details.

## Modelle wählen

Im Aktionsmenü (Cmd+K) gibt es pro Anbieter den Eintrag „Modell wählen“, direkt erreichbar mit **Cmd+M**. Im Befehl „Alle fragen“ öffnet Cmd+M ein Menü mit allen drei Anbietern, der markierte steht oben.

- **Standard:** Die CLI nutzt ihr voreingestelltes Modell.
- **Claude:** Aliase `fable`, `opus`, `sonnet`, `haiku` zeigen immer auf die neueste Version. Darunter stehen feste Versionen wie `claude-opus-5-5`, `claude-opus-5` oder `claude-opus-4-8`. Weitere Namen gehen über „Eigenes Modell eingeben…“.
- **Gemini:** Die Liste kommt live aus `agy models`.
- **Codex:** Modellname über „Eigenes Modell eingeben…“, zuletzt genutzte Modelle erscheinen danach im Menü.

Die Wahl wird gespeichert und gilt ab der nächsten Frage. Das gewählte Modell steht als Etikett neben dem Anbieter.

Unter jeder Antwort steht, welches Modell tatsächlich geantwortet hat, sofern die CLI das meldet. Claude meldet es immer. Meldet eine CLI nichts, steht dort das gewählte Modell mit einem Hinweis.

## Einstellungen

Raycast startet Erweiterungen nicht mit dem PATH deiner Shell. Die Erweiterung sucht die CLIs deshalb selbst an den üblichen Orten (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.npm-global/bin`, `~/.bun/bin` und weitere).

Wird eine CLI nicht gefunden, trag den Pfad in den Erweiterungs-Einstellungen ein. Den Pfad zeigt dir das Terminal:

```bash
which claude
which codex
which agy
```

## Sicherheit

Wie im Original:

- API-Schlüssel, alternative Basis-URLs und Cloud-Provider-Variablen werden nur aus den gestarteten Kindprozessen entfernt.
- Claude läuft ohne Tools, MCP, Chrome und Sitzungsablage.
- Codex läuft in einer Read-only-Sandbox ohne Sitzungsablage.
- Antigravity läuft im Plan-Modus mit Sandbox.
- Arbeitsverzeichnis ist ein eigener Ordner im Support-Verzeichnis der Erweiterung.

## Unterschiede zur Windows-Version

- Raycast statt PowerToys Run. Der C#-Teil und `Build.ps1` entfallen.
- Echte Detailansicht statt gekürzter Listenzeilen und Seitenblättern.
- CLI-Suche für macOS-Pfade, npm-Wrapper werden mit dem Node von Raycast gestartet.
- Abbrechen beendet die ganze Prozessgruppe (SIGTERM, danach SIGKILL) statt `taskkill`.

## Tests

```bash
npm test     # Bridge-Tests, inklusive Ablauf und Abbrechen mit einer gefälschten CLI
npm run lint
```

Die Anbieterlogos stammen aus [LobeHub Icons](https://github.com/lobehub/lobe-icons) und bleiben Marken ihrer jeweiligen Eigentümer.
