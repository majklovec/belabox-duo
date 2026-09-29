#!/bin/bash
# belabox-emmc-install.sh
#
# Runs on first boot from SD card. Detects eMMC, then uses armbian-install
# to migrate the system to eMMC (boot + rootfs on eMMC).
#
# After a successful install the service disables itself and the system
# can be rebooted; removing the SD card will boot from eMMC.

set -e

LOG_TAG="belabox-emmc-install"
EMMC_DEV="/dev/mmcblk0"

log() {
	echo "[$LOG_TAG] $*" | systemd-cat -t "$LOG_TAG" 2>/dev/null || echo "[$LOG_TAG] $*"
}

log "Starting eMMC installer check."

# --- 1. Verify we are running from SD, not eMMC ---
ROOT_DEV=$(findmnt -n -o SOURCE /)
log "Current root device: $ROOT_DEV"

if [[ "$ROOT_DEV" == *"mmcblk0"* ]]; then
	log "Already running from eMMC ($ROOT_DEV). Nothing to do."
	systemctl disable belabox-emmc-install.service 2>/dev/null || true
	exit 0
fi

# --- 2. Wait for eMMC device to appear ---
log "Waiting for eMMC device ($EMMC_DEV) to appear..."
for i in $(seq 1 30); do
	if [[ -b "$EMMC_DEV" ]]; then
		log "eMMC device found: $EMMC_DEV"
		break
	fi
	sleep 1
done

if [[ ! -b "$EMMC_DEV" ]]; then
	log "ERROR: eMMC device $EMMC_DEV not found after 30s. Aborting."
	exit 1
fi

# --- 3. Confirm armbian-install is available ---
if ! command -v armbian-install >/dev/null 2>&1; then
	log "ERROR: armbian-install not found. Aborting."
	exit 1
fi

log "Running armbian-install to migrate system to eMMC..."

# The interactive menu selections (piped in):
#   1 = Boot from SD, system on SATA / USB
#   2 = Boot from eMMC / NAND, system on eMMC / NAND   <-- we want this
#   3 = Boot from eMMC / NAND, system on SATA / USB / NVME
#   4 = Boot from SPI - system on SATA, USB or NVMe
#
# After selecting the storage scenario, the installer asks for a filesystem.
#   1 = ext4   (recommended default)
#
# Adjust these numbers if the menu order differs in your Armbian version.
printf '2\n1\ny\n' | armbian-install || {
	log "ERROR: armbian-install failed."
	exit 1
}

log "eMMC install completed successfully."

# --- 4. Disable the service so it doesn't run again ---
systemctl disable belabox-emmc-install.service 2>/dev/null || true

# --- 5. Write a marker so the user knows the install succeeded ---
touch /root/.emmc-install-complete

log "Done. Reboot and remove the SD card to boot from eMMC."

exit 0
