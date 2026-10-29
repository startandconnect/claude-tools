# compact

Ein Mod für Claude Code, der lange Sessions billig hält. Teil von [claude-tools](../README.md).

Claude Code merkt sich den Chat in einem Cache, im Abo eine Stunde lang. Ist der Cache kalt oder der Kontext voll, liest die nächste Nachricht den ganzen Chat zum vollen Preis neu ein. compact zeigt dir, wie es steht. Bevor der Cache abläuft, lässt er den Chat seinen Stand sichern und komprimiert ihn dann.

## Was er tut

**Band über dem Eingabefeld**
- **Kontext:** wie viel jede Nachricht gerade einliest, im Verhältnis zum Fenster des Modells. Ab 70 % in Warnfarbe.
- **Cache:** die Restzeit ab dem Ende der letzten Antwort. Im Abo ist das eine Stunde, mit API-Schlüssel fünf Minuten. Danach steht dort, wie viele Tokens die nächste Nachricht neu einliest.
- **Nutzung:** die Auslastung der 5-Stunden- und der Wochengrenze, ab 80 % in Warnfarbe.

**Automatik**, in jeder Session an:
- **50 Minuten nach der letzten Antwort** schickt der Mod einen Prompt zum Session-Abschluss. Der Chat sichert seinen Stand (Erledigtes, Offenes, nächste Schritte, Entscheidungen) und setzt jede Aufgabe auf den echten Status. Fertig heißt erledigt, alles andere wird mit Datum zurückgestellt.
- **55 Minuten nach der letzten Antwort** folgt der Compact (komprimieren, nicht leeren), noch mit warmem Cache.
- **Bei 95 % Kontext** sichert der Chat nach dem laufenden Durchgang seinen Stand und komprimiert sich sofort.
- **Neue Nachricht:** Jede Nachricht von dir oder einem anderen Chat setzt die Uhr zurück. Wer arbeitet, wird nicht komprimiert.
- **Neustart durch die Desktop-App:** Die App beendet ruhende Chats manchmal selbst. Startet sie einen Chat ohne neue Nachricht neu und war der Abschluss überfällig, holt der Mod Abschluss und Compact nach.

## Mit Atlas

Der Abschluss-Prompt schickt den gesicherten Stand und den Status der Aufgaben nach [Atlas](https://startandconnect.com/atlas), wenn dein Projekt mit Atlas verbunden ist. Dort siehst du nach jedem Compact, was erledigt ist, was offen ist und wie es weitergeht, auch über mehrere Chats hinweg. Ohne Atlas landet der Stand dort, wo dein Projekt Aufgaben und Notizen führt, zum Beispiel in Dateien im Repo.

## Installieren

**Mit einem Prompt (empfohlen):** Kopiere den Text aus [INSTALL-PROMPT.md](INSTALL-PROMPT.md) in einen Chat mit Claude Code. Das geht in der Desktop-App und im Terminal. Claude lädt die ZIP-Datei herunter und legt den Mod nach `~/.claude/skills/compact`. Claude Code lädt Mods aus diesem Ordner von selbst. Du brauchst also keinen Befehl mit Schrägstrich, keinen Marketplace und keine Einstellung. Der Mod ist ab dem nächsten neuen Chat aktiv. Ein Update ist derselbe Prompt noch einmal.

**Von Hand:** [compact.zip](https://github.com/startandconnect/claude-tools/releases/latest/download/compact.zip) herunterladen und entpacken. Dann den Ordner `compact/compact` nach `~/.claude/skills/compact` kopieren, mit dem versteckten Ordner `.claude-plugin`. Ist `CLAUDE_CONFIG_DIR` gesetzt, gehört er stattdessen nach `$CLAUDE_CONFIG_DIR/skills/compact`.

**Über den Plugin-Katalog (Terminal):**

```
/plugin marketplace add startandconnect/claude-tools
/plugin install compact@claude-tools
/reload-plugins
```

Nutze nur einen dieser Wege, sonst läuft der Mod doppelt.

## Befehle

- `/session-automatik` zeigt den Stand.
- `/session-automatik aus` und `/session-automatik an` schalten die Automatik für die laufende Session aus und wieder ein.
- `/session-automatik test` startet einen Testlauf: Abschluss nach 2 Minuten, Compact gleich danach.
- `/cache-anzeige` blendet das Band aus oder ein.

## Was er bewusst nicht tut

- Er leert nie einen Chat (kein Clear), er komprimiert nur.
- Er schickt nichts ins Netz und liest keine Schlüssel.
- Läuft gerade ein Turn oder steht ein Entwurf im Eingabefeld, wartet er.
- Ein Compact verliert Einzelheiten. Was der Chat behalten soll, sichert er deshalb vorher selbst.

## Umstieg von cache-context

Bis Version 1.0.0 hieß der Mod cache-context. Hast du ihn so installiert, entferne ihn zuerst mit `/plugin uninstall cache-context@claude-tools`, dann `/plugin marketplace update claude-tools` und `/plugin install compact@claude-tools`.

## Entfernen

Den Ordner `~/.claude/skills/compact` löschen und einen neuen Chat öffnen. Über den Plugin-Katalog installiert: `/plugin uninstall compact@claude-tools`.

## Lizenz

MIT, siehe [LICENSE](../LICENSE).
