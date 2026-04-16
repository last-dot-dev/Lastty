#!/usr/bin/env bash
# Pane agent SDK for shell scripts.
#
# Source this file and call pane_emit to send agent UI messages.
#
# Usage:
#   source pane_emit.sh
#   pane_emit "Ready" '{"agent":"my-agent","version":"1.0"}'
#   pane_emit "Status" '{"phase":"thinking"}'
#   pane_emit "Finished" '{"summary":"Done!","exit_code":0}'

pane_emit() {
    printf '\033]7770;{"type":"%s","data":%s}\007' "$1" "$2"
}
