#!/bin/bash
# userpatches/customize-image.sh

export DEBIAN_FRONTEND=noninteractive

# --- 1. Common: install packages, DNS, Bun, belabox-duo ---
echo "Installing standard packages..."
apt-get update
apt-get install -y \
	nano build-essential git tcl libssl-dev nodejs npm usb-modeswitch \
	libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev

echo "Adding Rockchip Multimedia PPA..."
apt-get install -y software-properties-common
add-apt-repository -y ppa:liujianfeng1994/rockchip-multimedia
apt-get update

echo "Installing libv4l-0 (pre-requisite)..."
apt-get install -y libv4l-0

echo "Installing Rockchip multimedia packages..."
apt-get install -y \
	gstreamer1.0-rockchip1 librga-dev librga2 \
	librockchip-mpp-dev librockchip-mpp1 \
	librockchip-vpu0 libv4l-rkmpp rockchip-multimedia-config

echo "Configuring DNS..."
mkdir -p /etc/systemd/resolved.conf.d
cat >/etc/systemd/resolved.conf.d/dns.conf <<EOF
[Resolve]
DNS=8.8.8.8 8.8.4.4
FallbackDNS=1.1.1.1
EOF
systemctl enable systemd-resolved 2>/dev/null || true

echo "Installing Bun..."
curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="/root/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

echo "Installing belabox-duo..."
git clone https://github.com/majklovec/belabox-duo.git /opt/belabox-duo
cd /opt/belabox-duo
[ -f "package.json" ] && bun install

# --- 2. eMMC-only: install the first-boot auto-installer ---
if [[ "${BUILD_VARIANT}" == "emmc" ]]; then
	echo "Installing first-boot eMMC installer..."

	install -m 0755 /tmp/overlay/usr/local/sbin/belabox-emmc-install.sh \
		/usr/local/sbin/belabox-emmc-install.sh

	install -m 0644 /tmp/overlay/etc/systemd/system/belabox-emmc-install.service \
		/etc/systemd/system/belabox-emmc-install.service

	systemctl enable belabox-emmc-install.service 2>/dev/null || true
fi

echo "Customization complete (variant: ${BUILD_VARIANT:-sd})."
