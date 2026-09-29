#!/bin/bash
# userpatches/customize-image.sh
#
# Shared customization script for both the SD-card image and the eMMC
# auto-install image. The eMMC variant is selected by setting
# BUILD_VARIANT="emmc" in userpatches/config-orangepi5-plus-emmc.conf.

export DEBIAN_FRONTEND=noninteractive

# ============================================================
# Configuration
# ============================================================

HOSTNAME="belabox-duo"

# Versions / sources for the streaming dependency chain
CERACODER_REPO="https://github.com/CERALIVE/ceracoder.git"
CERACODER_DIR="/opt/ceracoder"

CERALIVE_SRT_REPO="https://github.com/CERALIVE/srt.git"
SRT_BUILD_DIR="/tmp/srt-build"

SRTLA_SEND_REPO="irlserver/srtla_send"
SRTLA_SEND_BIN="/usr/local/bin/srtla_send"

# ============================================================

# --- 1. Install standard packages ---
echo "Installing standard packages..."
apt-get update
apt-get install -y \
	nano \
	build-essential \
	git \
	tcl \
	libssl-dev \
	nodejs \
	npm \
	usb-modeswitch \
	libgstreamer1.0-dev \
	libgstreamer-plugins-base1.0-dev

# --- 2. Add Rockchip Multimedia PPA ---
echo "Adding Rockchip Multimedia PPA..."
apt-get install -y software-properties-common
add-apt-repository -y ppa:liujianfeng1994/rockchip-multimedia
apt-get update

# --- 3. Install libv4l-0 FIRST (required by rockchip-multimedia-config) ---
echo "Installing libv4l-0 (pre-requisite)..."
apt-get install -y libv4l-0

# --- 4. Install Rockchip multimedia packages ---
echo "Installing Rockchip multimedia packages..."
apt-get install -y \
	gstreamer1.0-rockchip1 \
	librga-dev \
	librga2 \
	librockchip-mpp-dev \
	librockchip-mpp1 \
	librockchip-vpu0 \
	libv4l-rkmpp \
	rockchip-multimedia-config

# --- 5. Install additional GStreamer plugins + build tools for ceracoder ---
echo "Installing GStreamer plugins and build tools..."
apt-get install -y \
	pkg-config \
	cmake \
	gstreamer1.0-plugins-base \
	gstreamer1.0-plugins-good \
	gstreamer1.0-plugins-bad \
	gstreamer1.0-plugins-ugly \
	gstreamer1.0-libav

# --- 6. Build and install libsrt (CERALIVE fork with BELABOX patches) ---
echo "Building libsrt from CERALIVE/srt..."
rm -rf "${SRT_BUILD_DIR}"
git clone --depth=1 "${CERALIVE_SRT_REPO}" "${SRT_BUILD_DIR}"
cd "${SRT_BUILD_DIR}"
mkdir -p build && cd build
cmake .. -DCMAKE_INSTALL_PREFIX=/usr/local
make -j"$(nproc)"
make install
ldconfig
cd /
rm -rf "${SRT_BUILD_DIR}"

# Verify libsrt is discoverable
if ! pkg-config --exists srt; then
	echo "ERROR: libsrt was not installed correctly."
	exit 1
fi

# --- 7. Build and install ceracoder ---
echo "Building ceracoder..."
git clone --depth=1 "${CERACODER_REPO}" "${CERACODER_DIR}"
cd "${CERACODER_DIR}"

# Verify GStreamer + SRT are visible to pkg-config before building
echo "ceracoder build dependencies:"
pkg-config --modversion gstreamer-1.0 gstreamer-app-1.0 srt || true

make -j"$(nproc)"

# Install the binary and pipelines
install -m 0755 "${CERACODER_DIR}/ceracoder" /usr/local/bin/ceracoder
mkdir -p /usr/local/share/ceracoder
cp -r "${CERACODER_DIR}/pipeline" /usr/local/share/ceracoder/ 2>/dev/null || true

# --- 8. Install srtla_send from the latest arm64 .deb release ---
echo "Installing srtla_send (prebuilt arm64 .deb)..."
SRTLA_TMP="/tmp/srtla_send"
mkdir -p "${SRTLA_TMP}"
cd "${SRTLA_TMP}"

# Query the GitHub API for the latest release asset matching arm64 .deb
SRTLA_DEB_URL=$(curl -fsSL "https://api.github.com/repos/${SRTLA_SEND_REPO}/releases/latest" |
	grep -oE '"browser_download_url":\s*"[^"]*arm64\.deb"' |
	head -n1 |
	cut -d '"' -f4)

if [[ -z "${SRTLA_DEB_URL}" ]]; then
	echo "ERROR: Could not find an arm64 .deb in the latest srtla_send release."
	exit 1
fi

echo "Downloading: ${SRTLA_DEB_URL}"
curl -fL -o srtla_send.deb "${SRTLA_DEB_URL}"

# Install (dpkg -i will resolve deps via apt if any are missing)
apt-get install -y ./srtla_send.deb

cd /
rm -rf "${SRTLA_TMP}"

# Verify the binary landed on PATH
if ! command -v srtla_send >/dev/null 2>&1; then
	# Fallback: the .deb may install into /usr/bin instead of /usr/local/bin
	if [[ -x /usr/bin/srtla_send ]]; then
		ln -sf /usr/bin/srtla_send "${SRTLA_SEND_BIN}"
	else
		echo "WARNING: srtla_send binary not found after .deb install."
	fi
fi

# --- 9. Set hostname ---
echo "Setting hostname to ${HOSTNAME}..."
echo "${HOSTNAME}" >/etc/hostname
hostname -b "${HOSTNAME}"

if grep -q "^127.0.1.1" /etc/hosts; then
	sed -i "s/^127.0.1.1.*/127.0.1.1\t${HOSTNAME}/" /etc/hosts
else
	echo -e "127.0.1.1\t${HOSTNAME}" >>/etc/hosts
fi

# --- 10. Install and enable Avahi for mDNS (${HOSTNAME}.local) ---
echo "Installing Avahi for mDNS..."
apt-get install -y avahi-daemon avahi-utils libnss-mdns
systemctl enable avahi-daemon 2>/dev/null || true
sed -i 's/^hosts:.*/hosts:          files mdns4_minimal [NOTFOUND=return] dns myhostname/' \
	/etc/nsswitch.conf

# --- 11. Configure DNS (systemd-resolved) ---
echo "Configuring DNS..."
mkdir -p /etc/systemd/resolved.conf.d
cat >/etc/systemd/resolved.conf.d/dns.conf <<EOF
[Resolve]
DNS=8.8.8.8 8.8.4.4
FallbackDNS=1.1.1.1
EOF
systemctl enable systemd-resolved 2>/dev/null || true

# --- 12. Install Bun ---
echo "Installing Bun..."
curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="/root/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# --- 13. Install belabox-duo ---
echo "Installing belabox-duo..."
git clone https://github.com/majklovec/belabox-duo.git /opt/belabox-duo
cd /opt/belabox-duo
if [ -f "package.json" ]; then
	bun install
fi

# --- 14. eMMC-only: install the first-boot auto-installer ---
if [[ "${BUILD_VARIANT}" == "emmc" ]]; then
	echo "Installing first-boot eMMC installer..."

	install -m 0755 /tmp/overlay/usr/local/sbin/belabox-emmc-install.sh \
		/usr/local/sbin/belabox-emmc-install.sh

	install -m 0644 /tmp/overlay/etc/systemd/system/belabox-emmc-install.service \
		/etc/systemd/system/belabox-emmc-install.service

	systemctl enable belabox-emmc-install.service 2>/dev/null || true
fi

echo "Customization complete (hostname: ${HOSTNAME}, variant: ${BUILD_VARIANT:-sd})."
echo "Installed streaming stack:"
echo "  ceracoder:  $(command -v ceracoder || echo 'NOT FOUND')"
echo "  srtla_send: $(command -v srtla_send || echo 'NOT FOUND')"
