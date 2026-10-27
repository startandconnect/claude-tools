# claude-tools

Werkzeuge für [Claude Code](https://claude.com/claude-code) von Start & Connect. Jedes Tool liegt in einem eigenen Ordner und lässt sich einzeln installieren.

| Tool | Was es tut |
|---|---|
| [cache-context](cache-context/) | Band über dem Eingabefeld mit Kontext, Cache-Restzeit und Nutzung. Nach 50 Minuten Ruhe sichert der Chat seinen Stand, nach 55 Minuten komprimiert er sich, bevor der Cache abläuft. |

## Installieren

Einmal den Katalog anmelden, dann je Tool installieren:

```
/plugin marketplace add startandconnect/claude-tools
/plugin install cache-context@claude-tools
/reload-plugins
```

Jedes Tool gibt es auch als ZIP-Datei unter `https://github.com/startandconnect/claude-tools/releases/latest/download/<tool>.zip` und mit einem Prompt, der Claude die Installation erledigen lässt (`<tool>/INSTALL-PROMPT.md`).

## Lizenz

MIT, siehe [LICENSE](LICENSE).
