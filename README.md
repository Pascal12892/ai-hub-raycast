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
- Cmd+K zeigt alle Aktionen: Antwort einfügen (Cmd+Shift+V), Modell wählen (Cmd+M), Dateien anhängen (Cmd+O), Abbrechen (Ctrl+C), Neues Gespräch (Cmd+N), Einstellungen.

Tipp: In den Raycast-Einstellungen unter Extensions kannst du jedem Befehl einen Alias (z. B. `cl` für Claude fragen) oder einen eigenen Hotkey geben.

Alle drei Anbieter bekommen denselben Caveman-Ultra-Stilprompt wie das Original: kurze Antworten mit höchstens 35 Wörtern, außer die Frage verlangt ausdrücklich Details.

## Dateien anhängen

Dateien gehen mit der nächsten Frage an alle gewählten Anbieter.

- **Cmd+O:** Dateien über einen Dialog auswählen.
- **Cmd+Shift+O:** Die im Finder markierten Dateien anhängen.
- **Cmd+Shift+Löschen:** Anhänge wieder entfernen.

Ohne eingetippte Frage werden die Dateien zusammengefasst. Rückfragen beziehen sich weiter auf die Dateien.

Erlaubt sind Dateien bis 100 MB, zusammen bis 300 MB, auch PDFs, Bilder und Tabellen. Es gibt zwei Wege:

- **Kleine Textdateien** (zusammen bis 500 KB) werden direkt in die Frage eingefügt. Das ist schnell und klappt bei allen drei Anbietern gleich.
- **Größere Dateien, PDFs und Bilder** werden in einen eigenen Ordner kopiert. Die CLIs arbeiten in diesem Ordner und lesen die Dateien selbst. Claude bekommt dafür nur die Lese-Werkzeuge Read, Grep und Glob, Codex läuft in der Read-only-Sandbox, Gemini im Plan-Modus mit Sandbox. Die Originale werden nicht angefasst. Das Zeitlimit steigt in diesem Fall auf 10 Minuten. Die Kopien werden nach 24 Stunden gelöscht.

Bei sehr großen Dateien lesen die Modelle nicht alles, sondern suchen gezielt. Wie gut das klappt, hängt vom Anbieter und Dateityp ab. Claude kann PDFs und Bilder direkt lesen. Ob Codex und Gemini Bilder und PDFs aus dem Ordner auswerten, hängt von deren CLI-Version ab.

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

Es gibt drei Stufen. Die ersten beiden laufen ohne echte Modelle, die dritte braucht deinen Mac mit angemeldeten CLIs.

### 1. Automatische Tests

```bash
npm run check   # Typen, Formatierung und 16 Bridge-Tests
npm run lint    # Raycast-Lint (braucht Internet)
```

Die Bridge-Tests nutzen eine nachgebaute CLI. Geprüft werden unter anderem: nicht interaktive Aufrufe, Entfernen von API-Schlüsseln, Auslesen der Antworten und Fehler, Verlauf, Modellwahl, gemeldetes Modell, Anhänge in beiden Modi, nur lesende Werkzeuge im Datei-Modus und Abbrechen.

Bei jedem Push laufen diese Prüfungen zusätzlich auf GitHub (Reiter „Actions“).

### 2. Live-Test mit den echten CLIs

```bash
npm run test:live                  # alle drei Anbieter
npm run test:live -- claude        # nur einen Anbieter
```

Mit `npm run test:live -- --debug` werden zusätzlich alle Rohausgaben der CLIs in `~/aihub-debug.txt` geschrieben, hilfreich bei der Fehlersuche. Der Prompt selbst wird nicht protokolliert.

Pro Anbieter werden geprüft: Version, Anmeldung, Antwort mit Umlauten, Rückfrage mit Verlauf, gemeldetes Modell, eingefügte Textdatei, große Datei im Datei-Modus und Abbrechen. Der Test verbraucht etwas Abo-Kontingent und dauert einige Minuten.

### 3. Manuelle Prüfung in Raycast

Die Raycast-Oberfläche lässt sich nicht automatisch testen. Diese Punkte einmal von Hand durchgehen:

- [ ] „Alle fragen“ öffnen, Frage tippen: Es startet keine Anfrage, bevor Enter gedrückt wird.
- [ ] Enter: Alle drei zeigen „Antwort läuft“, danach einen grünen Haken.
- [ ] Rechts steht die volle Antwort und darunter das Modell.
- [ ] Rückfrage tippen und Enter: Die Antwort bezieht sich auf die vorherige.
- [ ] Enter ohne Text kopiert die markierte Antwort. Cmd+Shift+V fügt sie ein.
- [ ] Ctrl+C während einer Anfrage bricht ab, Status „Abgebrochen“.
- [ ] Cmd+N startet ein neues Gespräch.
- [ ] Cmd+M: Modell bei allen drei Anbietern ändern. Etikett und Modellzeile passen danach.
- [ ] Raycast schließen und neu öffnen: Die Modellwahl ist noch da.
- [ ] Cmd+O: Kleine Textdatei anhängen, Frage dazu stellen.
- [ ] Cmd+O: PDF oder Bild anhängen, Frage dazu stellen.
- [ ] Im Finder eine Datei markieren, Raycast öffnen, Cmd+Shift+O.
- [ ] „Claude fragen“ mit Argument direkt aus der Raycast-Suche: Die Anfrage startet sofort.

### Getesteter Stand

Nach einem erfolgreichen Live-Test hier eintragen:

|                 | Version |
| --------------- | ------- |
| macOS           |         |
| Raycast         |         |
| Node.js         |         |
| Claude Code     |         |
| Codex CLI       |         |
| Antigravity CLI |         |
| Datum           |         |

## Offizielle Referenzen

- [Raycast: Extension-Entwicklung](https://developers.raycast.com)
- [Claude Code: CLI-Referenz](https://code.claude.com/docs/en/cli-reference) und [Modellkonfiguration](https://code.claude.com/docs/en/model-config)
- [Codex CLI](https://developers.openai.com/codex/cli)
- [Antigravity CLI: Headless-Modus](https://antigravity.google/docs/cli/headless) und [Migration von Gemini CLI](https://antigravity.google/docs/cli/gcli-migration)
- Original für Windows: [Alebabo/ScreenAi](https://github.com/Alebabo/ScreenAi)

Die Anbieterlogos stammen aus [LobeHub Icons](https://github.com/lobehub/lobe-icons) und bleiben Marken ihrer jeweiligen Eigentümer.
