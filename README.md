# claude-tools

Werkzeuge für [Claude Code](https://claude.com/claude-code) von Start & Connect. Jedes Tool liegt in einem eigenen Ordner und lässt sich einzeln installieren.

| Tool | Was es tut |
|---|---|
| [compact](compact/) | Band über dem Eingabefeld mit Kontext, Cache-Restzeit und Nutzung. Nach 50 Minuten Ruhe sichert der Chat seinen Stand, nach 55 Minuten komprimiert er sich, bevor der Cache abläuft. |

## Installieren

Am einfachsten: Kopiere den Text aus `<tool>/INSTALL-PROMPT.md` in einen Chat mit Claude Code, in der Desktop-App oder im Terminal. Claude lädt das Tool herunter und legt es in den Ordner `~/.claude/skills/<tool>`. Von dort lädt Claude Code es in jedem neuen Chat von selbst. Dafür braucht es keine Befehle mit Schrägstrich und keinen Marketplace. Für compact steht der Prompt in [compact/INSTALL-PROMPT.md](compact/INSTALL-PROMPT.md).

Von Hand geht es genauso: `https://github.com/startandconnect/claude-tools/releases/latest/download/<tool>.zip` herunterladen und entpacken. Dann den Ordner `<tool>/<tool>` nach `~/.claude/skills/<tool>` kopieren, mit dem versteckten Ordner `.claude-plugin`.

Wer lieber mit dem Plugin-Katalog arbeitet, nimmt im Terminal:

```
/plugin marketplace add startandconnect/claude-tools
/plugin install compact@claude-tools
```

Bitte nur einen der Wege nutzen, sonst läuft das Tool doppelt.

## Lizenz

MIT, siehe [LICENSE](LICENSE).
