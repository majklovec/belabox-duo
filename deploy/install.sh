sudo apt update
sudo apt install nano build-essential git tcl libssl1.0-dev nodejs npm usb-modeswitch libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev

sudo apt install gstreamer1.0-rockchip1 librga-dev librga2 librockchip-mpp-dev librockchip-mpp1

printf "\nnameserver 8.8.8.8\nnameserver 8.8.4.4\n" | sudo tee -a /etc/resolvconf/resolv.conf.d/head

sed "s#WorkingDirectory=.*#WorkingDirectory=$(pwd)#g" belaUI.service >/etc/systemd/system/belaUI.service &&
	cp belaUI.socket /etc/systemd/system/

systemctl daemon-reload &&
	systemctl restart belaUI &&
	systemctl enable belaUI.socket

systemctl enable belaUI.service

cp *.rules /etc/udev/rules.d/
