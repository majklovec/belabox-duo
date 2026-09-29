#!/bin/bash
# build.sh
#
# Runs the Armbian build natively on the host.
# Usage: ./build.sh [config-name]
#   config-name defaults to "orangepi5-plus"
#
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRAMEWORK_DIR="${SCRIPT_DIR}/armbian-build"
CONFIG_NAME="${1:-orangepi5-plus}"

# --- Clone the Armbian build framework if needed ---
if [[ ! -d "$FRAMEWORK_DIR/.git" ]]; then
	echo "Cloning Armbian build framework into $FRAMEWORK_DIR ..."
	git clone --depth=1 --branch=main \
		https://github.com/armbian/build.git "$FRAMEWORK_DIR"
fi

# --- Link our userpatches into the framework ---
# The framework reads userpatches from its own directory. We symlink
# our versioned userpatches into it so the framework sees our config.
if [[ -L "$FRAMEWORK_DIR/userpatches" || -d "$FRAMEWORK_DIR/userpatches" ]]; then
	rm -rf "$FRAMEWORK_DIR/userpatches"
fi
ln -s "${SCRIPT_DIR}/userpatches" "$FRAMEWORK_DIR/userpatches"

# --- Symlink output directory ---
mkdir -p "${SCRIPT_DIR}/output"
if [[ -L "$FRAMEWORK_DIR/output" || -d "$FRAMEWORK_DIR/output" ]]; then
	rm -rf "$FRAMEWORK_DIR/output"
fi
ln -s "${SCRIPT_DIR}/output" "$FRAMEWORK_DIR/output"

# --- Run the build ---
echo "=========================================="
echo "Starting native Armbian build"
echo "  Framework:  $FRAMEWORK_DIR"
echo "  Config:     $CONFIG_NAME"
echo "  Config file: userpatches/config-${CONFIG_NAME}.conf"
echo "=========================================="
echo ""

cd "$FRAMEWORK_DIR"
exec ./compile.sh "$CONFIG_NAME"
