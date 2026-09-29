#!/bin/bash
# setup-host.sh
#
# Installs all host-side dependencies required to build Armbian natively.
# Run once with: sudo ./setup-host.sh
#
# NOTE: Broken third-party repos on the host (e.g. hashicorp, claude-desktop)
#       will cause "apt-get update" to return non-zero. That is tolerated here
#       because the packages we need come from the main distro repositories.

if [[ $EUID -ne 0 ]]; then
	echo "This script must be run as root (use sudo)." >&2
	exit 1
fi

# IMPORTANT: do NOT use "set -e" globally, because we intentionally tolerate
# failures from unrelated apt repos and from optional binfmt commands.
set -u

echo "Updating package lists (tolerating unrelated repo failures)..."
apt-get update || echo "  -> Some repos failed, continuing anyway."

echo ""
echo "Installing software-properties-common..."
apt-get install -y software-properties-common || true

echo ""
echo "Enabling universe repository..."
add-apt-repository -y universe || true
apt-get update || true

echo ""
echo "Installing build dependencies..."
apt-get install -y \
	git \
	curl \
	wget \
	build-essential \
	bc \
	bison \
	flex \
	libncurses-dev \
	libssl-dev \
	device-tree-compiler \
	ccache \
	python3 \
	python3-pip \
	python3-setuptools \
	qemu-user-static \
	binfmt-support \
	debootstrap \
	parted \
	dosfstools \
	mtools \
	u-boot-tools \
	libarchive-zip-perl \
	linux-libc-dev \
	libc6-dev-armhf-cross \
	libc6-dev-arm64-cross \
	gcc-arm-linux-gnueabihf \
	gcc-aarch64-linux-gnu \
	gcc-riscv64-linux-gnu \
	pkg-config \
	libpython3-dev \
	rsync \
	kmod \
	cpio \
	fdisk \
	gdisk \
	kpartx \
	xz-utils \
	zstd \
	file \
	bzip2 \
	zip \
	unzip \
	locales \
	sudo \
	nano \
	vim

echo ""
echo "Enabling binfmt handlers for cross-architecture builds..."
systemctl restart systemd-binfmt 2>/dev/null || true
update-binfmts --enable qemu-aarch64 2>/dev/null || true

echo ""
echo "=========================================="
echo "Verifying critical tools..."
echo "=========================================="

MISSING=0

check_tool() {
	if command -v "$1" >/dev/null 2>&1; then
		printf "  [OK]   %-25s %s\n" "$1" "$($1 --version 2>/dev/null | head -n1 || echo '')"
	else
		printf "  [MISS] %-25s NOT FOUND\n" "$1"
		MISSING=$((MISSING + 1))
	fi
}

check_tool qemu-aarch64-static
check_tool aarch64-linux-gnu-gcc
check_tool debootstrap
check_tool git
check_tool rsync
check_tool kpartx

echo ""
if [[ $MISSING -gt 0 ]]; then
	echo "WARNING: $MISSING required tool(s) missing. The build will likely fail."
	echo "Fix the broken repos on your host, or install the missing packages manually."
	exit 1
fi

QEMU_VER=$(qemu-aarch64-static --version | head -n1 | grep -oE '[0-9]+\.[0-9]+' | head -n1)
echo "qemu-aarch64-static version: $QEMU_VER"

# Compare against 8.2 (minimum for Ubuntu 26.04 "resolute")
MAJOR=$(echo "$QEMU_VER" | cut -d. -f1)
MINOR=$(echo "$QEMU_VER" | cut -d. -f2)
if [[ "$MAJOR" -lt 8 ]] || { [[ "$MAJOR" -eq 8 ]] && [[ "$MINOR" -lt 2 ]]; }; then
	echo ""
	echo "WARNING: qemu-aarch64-static is older than 8.2."
	echo "         Building RELEASE=resolute will fail with:"
	echo "           tar: ... Cannot open: Function not implemented"
	echo ""
	echo "         Either upgrade qemu (sudo apt install --only-upgrade qemu-user-static)"
	echo "         or set RELEASE=noble in userpatches/config-orangepi5-plus.conf."
fi

echo ""
echo "Host setup complete."
