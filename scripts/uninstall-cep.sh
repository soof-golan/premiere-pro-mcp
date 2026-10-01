#!/usr/bin/env bash
# Remove only the MCP for Adobe Premiere Pro CEP connector. It restores
# Adobe's shared PlayerDebugMode setting to the values recorded by
# install-cep.sh, as long as no sibling MCP CEP connector is still installed
# at this scope.

set -euo pipefail

MODE="--user"
HOST="Premiere"
for arg in "$@"; do
  case "$arg" in
    --after-effects) HOST="AfterEffects" ;;
    --user|--uninstall|--system|--uninstall-system|--help|-h) MODE="$arg" ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done
if [ "$HOST" = "AfterEffects" ]; then
  PLUGIN_NAME="MCPAfterEffectsBridgeCEP"
  HOST_LABEL="After Effects"
  HOST_PROCESS="After Effects"
else
  PLUGIN_NAME="MCPBridgeCEP"
  HOST_LABEL="Premiere Pro"
  HOST_PROCESS="Adobe Premiere Pro"
fi

if [[ "$OSTYPE" != darwin* ]]; then
  echo "CEP uninstallation is supported only on macOS by this script." >&2
  exit 1
fi

if pgrep -if "$HOST_PROCESS" >/dev/null 2>&1; then
  echo "$HOST_LABEL is running. Fully quit it before removing the Connector." >&2
  exit 1
fi

case "$MODE" in
  --user|--uninstall)
    CEP_ROOT="$HOME/Library/Application Support/Adobe/CEP/extensions"
    ;;
  --system|--uninstall-system)
    if [[ "$(id -u)" -ne 0 ]]; then
      echo "The system-wide connector requires administrator permission." >&2
      echo "Run: sudo \"$0\" --system" >&2
      exit 1
    fi
    CEP_ROOT="/Library/Application Support/Adobe/CEP/extensions"
    ;;
  --help|-h)
    cat <<'EOF'
Usage: uninstall-cep.sh [--user|--system]

  --user    Remove the connector installed for the current user (default).
  --system  Remove the system-wide connector installed by the macOS .pkg.
EOF
    exit 0
    ;;
  *)
    echo "Unknown option: $MODE. Use --user or --system." >&2
    exit 1
    ;;
esac

DESTINATION="$CEP_ROOT/$PLUGIN_NAME"
case "$DESTINATION" in
  "$CEP_ROOT/$PLUGIN_NAME") ;;
  *)
    echo "Refusing to uninstall outside the CEP extensions directory." >&2
    exit 1
    ;;
esac

restore_player_debug_mode() {
  local cep_root="$1"
  local state_file="$cep_root/.premiere-pro-mcp-player-debug-mode.state"

  # Don't touch the shared Adobe setting while a sibling MCP CEP connector
  # (Premiere or After Effects) is still installed at this scope; it may
  # still need PlayerDebugMode enabled.
  if [ -e "$cep_root/MCPBridgeCEP" ] || [ -L "$cep_root/MCPBridgeCEP" ] \
    || [ -e "$cep_root/MCPAfterEffectsBridgeCEP" ] || [ -L "$cep_root/MCPAfterEffectsBridgeCEP" ]; then
    echo "Another MCP CEP connector is still installed at this scope; leaving PlayerDebugMode unchanged."
    return 0
  fi

  if [ ! -f "$state_file" ]; then
    echo ""
    echo "No PlayerDebugMode baseline was recorded at this scope (installed by an"
    echo "older version, or already restored), so it was left unchanged."
    echo "To turn PlayerDebugMode off manually for CSXS 8-14 (only if no other"
    echo "unsigned CEP extension on this machine needs it):"
    echo "  for v in 8 9 10 11 12 13 14; do defaults delete com.adobe.CSXS.\$v PlayerDebugMode; done"
    return 0
  fi

  echo ""
  echo "Restoring PlayerDebugMode to the values recorded before installation..."
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    key="${line%%=*}"
    rest="${line#*=}"
    existed="${rest%%:*}"
    value="${rest#*:}"
    version="${key#CSXS.}"
    if [ "$existed" = "1" ]; then
      defaults write "com.adobe.CSXS.$version" PlayerDebugMode "$value" 2>/dev/null || true
    else
      defaults delete "com.adobe.CSXS.$version" PlayerDebugMode 2>/dev/null || true
    fi
  done < "$state_file"
  rm -f -- "$state_file"
  echo "PlayerDebugMode restored for CSXS 8-14."
}

if [[ -e "$DESTINATION" || -L "$DESTINATION" ]]; then
  rm -rf -- "$DESTINATION"
  echo "Removed the $HOST_LABEL MCP Connector from $DESTINATION"
else
  echo "The $HOST_LABEL MCP Connector is not installed at this scope."
fi

restore_player_debug_mode "$CEP_ROOT"

echo "Remove the MCP server from your AI client's configuration separately if you no longer use it."
