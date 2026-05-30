#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_PATH="$SCRIPT_DIR/.venv"

if [ ! -d "$VENV_PATH" ]; then
  echo "venv not found at $VENV_PATH"
  exit 1
fi

source "$VENV_PATH/bin/activate"
echo "venv activated: $VENV_PATH"
