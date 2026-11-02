#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
source .venv/bin/activate

# Find the first free port starting at 8005.
port=8005
while python - "$port" <<'EOF'; do
import socket
import sys

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
    s.settimeout(0.2)
    in_use = s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0
sys.exit(0 if in_use else 1)
EOF
    port=$((port + 1))
    if [ "$port" -gt 8100 ]; then
        echo "No free port found in 8005-8100" >&2
        exit 1
    fi
done

echo "Starting LLM Hub on port $port"
LLMHUB_PORT="$port" python main.py

