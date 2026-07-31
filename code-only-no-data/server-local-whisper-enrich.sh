#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/var/www/content-creator"
PORT="${PORT:-8788}"
ADMIN_TOKEN="${ADMIN_TOKEN:-1247}"
BATCH_LIMIT="${BATCH_LIMIT:-4}"
FORCE="${FORCE:-true}"

cd "$APP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$APP_DIR/data"

cp "$APP_DIR/data/store.json" "$APP_DIR/data/store.backup-$STAMP.json"
if [ -f "$APP_DIR/data/creator-os.db" ]; then
  cp "$APP_DIR/data/creator-os.db" "$APP_DIR/data/creator-os.backup-$STAMP.db"
fi

python3 -m pip install --upgrade pip
python3 -m pip install -r requirements-local-whisper.txt

if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ffmpeg
fi

python3 - <<'PY'
from pathlib import Path

env_path = Path(".env")
lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []

wanted = {
    "TRANSCRIPTION_PROVIDER": "local",
    "LOCAL_TRANSCRIPTION_PYTHON": "python3",
    "LOCAL_WHISPER_MODEL": "small",
    "LOCAL_WHISPER_COMPUTE_TYPE": "int8",
    "LOCAL_WHISPER_DEVICE": "cpu",
}

seen = set()
updated = []
for line in lines:
    if "=" not in line or line.lstrip().startswith("#"):
        updated.append(line)
        continue
    key, value = line.split("=", 1)
    key = key.strip()
    if key in wanted:
        updated.append(f"{key}={wanted[key]}")
        seen.add(key)
    else:
        updated.append(line)

for key, value in wanted.items():
    if key not in seen:
        updated.append(f"{key}={value}")

env_path.write_text("\n".join(updated) + "\n", encoding="utf-8")
print("updated .env for local whisper")
PY

node - <<'NODE'
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const store = fs.readFileSync('data/store.json', 'utf8');
const db = new DatabaseSync('data/creator-os.db');
db.prepare(`
  INSERT INTO app_store (key, value, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`).run('store', store, new Date().toISOString());
console.log('sqlite synced from store.json');
NODE

pm2 restart content-creator --update-env
sleep 3

curl -s -X POST "http://127.0.0.1:${PORT}/api/admin/reels/enrich" \
  -H "Content-Type: application/json" \
  -H "x-admin-token: ${ADMIN_TOKEN}" \
  -d "{\"limit\":${BATCH_LIMIT},\"force\":${FORCE}}" 

echo
echo "done"
