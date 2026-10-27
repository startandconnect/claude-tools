# cache-context

Ein Mod für Claude Code, der lange Sessions billig hält. Teil von [claude-tools](../README.md).

Claude Code merkt sich den Chat in einem Cache, im Abo eine Stunde lang. Ist der Cache kalt oder der Kontext voll, liest die nächste Nachricht den ganzen Chat zum vollen Preis neu ein. cache-context zeigt dir, wie es steht. Bevor der Cache abläuft, lässt er den Chat seinen Stand sichern und komprimiert ihn dann.

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

## Installieren

**In Claude Code:**

```
/plugin marketplace add startandconnect/claude-tools
/plugin install cache-context@claude-tools
/reload-plugins
```

**Claude installieren lassen:** Gib Claude Code den Text aus [INSTALL-PROMPT.md](INSTALL-PROMPT.md).

**Als ZIP-Datei:** [cache-context.zip](https://github.com/startandconnect/claude-tools/releases/latest/download/cache-context.zip) herunterladen und entpacken. Dann in Claude Code `/plugin marketplace add <entpackter Ordner>` und `/plugin install cache-context@claude-tools` eingeben.

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

## Entfernen

```
/plugin uninstall cache-context@claude-tools
```

## Lizenz

MIT, siehe [LICENSE](../LICENSE).
