#!/usr/bin/env bash
set -Eeuo pipefail

ALIAS_NAME="${1:-hub}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RUN_SCRIPT="$SCRIPT_DIR/run.sh"

if [[ ! "$ALIAS_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "Alias name must be a valid shell identifier, got: $ALIAS_NAME" >&2
    exit 1
fi

if [[ ! -f "$RUN_SCRIPT" ]]; then
    echo "Could not find run.sh at: $RUN_SCRIPT" >&2
    exit 1
fi

detect_rc_file() {
    case "${SHELL:-}" in
        */zsh) echo "$HOME/.zshrc" ;;
        */bash) echo "$HOME/.bashrc" ;;
        *) echo "$HOME/.profile" ;;
    esac
}

RC_FILE="${LLMHUB_ALIAS_RC:-$(detect_rc_file)}"
mkdir -p "$(dirname "$RC_FILE")"
touch "$RC_FILE"

START_MARKER="# >>> LLM Hub alias >>>"
END_MARKER="# <<< LLM Hub alias <<<"
ALIAS_LINE="alias ${ALIAS_NAME}='\"${RUN_SCRIPT}\"'"

tmp_file="$(mktemp)"
awk -v start="$START_MARKER" -v end="$END_MARKER" '
    $0 == start { skip = 1; next }
    $0 == end { skip = 0; next }
    !skip { print }
' "$RC_FILE" > "$tmp_file"

{
    cat "$tmp_file"
    printf '\n%s\n' "$START_MARKER"
    printf '%s\n' "$ALIAS_LINE"
    printf '%s\n' "$END_MARKER"
} > "$RC_FILE"
rm -f "$tmp_file"

echo "Installed alias in $RC_FILE:"
echo "  $ALIAS_LINE"
echo
echo "Restart your shell or run:"
echo "  source \"$RC_FILE\""
echo
echo "Then start LLM Hub with:"
echo "  $ALIAS_NAME"
