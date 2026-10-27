#!/bin/sh
# Baut je Tool eine ZIP-Datei: der Katalog nur mit diesem Tool, dazu sein Ordner und die Lizenz.
# Jedes Release bekommt alle ZIP-Dateien, damit .../releases/latest/download/<tool>.zip für jedes Tool gilt.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$root/dist}
mkdir -p "$out"
for tool in $(python3 -c 'import json,sys; print(" ".join(p["name"] for p in json.load(open(sys.argv[1]))["plugins"]))' "$root/.claude-plugin/marketplace.json"); do
  tmp=$(mktemp -d)
  mkdir -p "$tmp/$tool/.claude-plugin"
  python3 - "$root/.claude-plugin/marketplace.json" "$tool" > "$tmp/$tool/.claude-plugin/marketplace.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["plugins"] = [p for p in d["plugins"] if p["name"] == sys.argv[2]]
print(json.dumps(d, ensure_ascii=False, indent=2))
PY
  (cd "$root" && git archive HEAD "$tool" LICENSE) | tar -x -C "$tmp/$tool"
  rm -f "$out/$tool.zip"
  (cd "$tmp" && zip -qr "$out/$tool.zip" "$tool")
  rm -rf "$tmp"
  echo "$out/$tool.zip"
done
