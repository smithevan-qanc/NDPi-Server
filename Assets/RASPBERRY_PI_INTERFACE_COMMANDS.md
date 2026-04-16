# Raspberry Pi 5 Interface Commands & Requests

Complete documentation of all commands and requests used to interface with Raspberry Pi 5 devices in the NDPi Monitor system.

## System Control Commands

### Reboot System
```bash
sudo reboot
```
**WebSocket Command:**
```json
{
  "type": "reboot"
}
```

### Shutdown System
```bash
sudo shutdown now
```
**WebSocket Command:**
```json
{
  "type": "shutdown"
}
```

### Restart Service (Server)
```bash
sudo systemctl restart ndpi-monitor
# or via npm
npm restart
```

### Restart Service (Client)
```bash
sudo systemctl restart ndpi-monitor-client
```

---

## Network Configuration

### View Current Network Configuration
```bash
# View all network interfaces
ip addr show

# View specific interface (eth0 for ethernet, wlan0 for WiFi)
ip addr show eth0
ip addr show wlan0

# View routing table
ip route

# View DNS configuration
cat /etc/resolv.conf

# View DHCP client configuration
cat /etc/dhcpcd.conf
```

### Set Static IP Address
```bash
# Edit dhcpcd configuration
sudo nano /etc/dhcpcd.conf

# Add to file:
interface eth0
static ip_address=192.168.1.100/24
static routers=192.168.1.1
static domain_name_servers=8.8.8.8 8.8.4.4

# Restart networking
sudo systemctl restart dhcpcd
```

**WebSocket Command (Client/Server):**
```json
{
  "type": "set-network",
  "config": {
    "mode": "static",
    "staticIP": "192.168.1.100",
    "subnet": "255.255.255.0",
    "gateway": "192.168.1.1",
    "dns": "8.8.8.8"
  }
}
```

### Configure WiFi
```bash
# Edit WPA supplicant configuration
sudo nano /etc/wpa_supplicant/wpa_supplicant.conf

# Add network configuration:
network={
    ssid="YourNetworkName"
    psk="YourPassword"
}

# Reconfigure WiFi
sudo wpa_cli -i wlan0 reconfigure

# Restart interface
sudo ip link set wlan0 down
sudo ip link set wlan0 up
```

**WebSocket Command:**
```json
{
  "type": "set-network",
  "config": {
    "mode": "dhcp",
    "wifiSSID": "NetworkName",
    "wifiPassword": "password123"
  }
}
```

### Set DHCP Mode
```bash
# Remove static configuration from dhcpcd.conf
# Or comment out interface-specific config

# Restart DHCP client
sudo systemctl restart dhcpcd
```

**WebSocket Command:**
```json
{
  "type": "set-network",
  "config": {
    "mode": "dhcp"
  }
}
```

---

## NDI Source Management

### Set NDI Source (Client)
**WebSocket Command:**
```json
{
  "type": "set-source",
  "sourceName": "NDI_SOURCE_NAME",
  "user": "admin",
  "timestamp": 1234567890,
  "serverAddress": "192.168.1.15"
}
```

### Clear NDI Source
**WebSocket Command:**
```json
{
  "type": "set-source",
  "sourceName": null
}
```

### Show Overlay
**WebSocket Command:**
```json
{
  "type": "overlay",
  "user": "admin"
}
```

### Show Blank Screen
**WebSocket Command:**
```json
{
  "type": "blank",
  "user": "admin"
}
```

---

## System Information Commands

### Get System Stats
```bash
# CPU usage
top -bn1 | grep "Cpu(s)" | sed "s/.*, *\([0-9.]*\)%* id.*/\1/" | awk '{print 100 - $1}'

# Memory usage
free -m | awk 'NR==2{printf "%.0f", $3*100/$2 }'

# CPU temperature
vcgencmd measure_temp | egrep -o '[0-9]*\.[0-9]*'

# Disk usage
df -h / | awk 'NR==2{print $5}' | sed 's/%//'

# Uptime
uptime -p

# Hostname
hostname

# OS version
cat /etc/os-release
```

### Get Network Information
```bash
# Get local IP address
hostname -I | awk '{print $1}'

# Get MAC address
cat /sys/class/net/eth0/address

# Get WiFi signal strength
iwconfig wlan0 | grep -i quality

# Test internet connectivity
ping -c 1 8.8.8.8
```

---

## Service Management

### NDPi Monitor Server Service
```bash
# Start service
sudo systemctl start ndpi-monitor

# Stop service
sudo systemctl stop ndpi-monitor

# Restart service
sudo systemctl restart ndpi-monitor

# Enable on boot
sudo systemctl enable ndpi-monitor

# Disable on boot
sudo systemctl disable ndpi-monitor

# Check status
sudo systemctl status ndpi-monitor

# View logs
sudo journalctl -u ndpi-monitor --no-pager -n 50

# Follow logs in real-time
sudo journalctl -u ndpi-monitor -f
```

### NDPi Monitor Client Service
```bash
# Start service
sudo systemctl start ndpi-monitor-client

# Stop service
sudo systemctl stop ndpi-monitor-client

# Restart service
sudo systemctl restart ndpi-monitor-client

# Enable on boot
sudo systemctl enable ndpi-monitor-client

# Disable on boot
sudo systemctl disable ndpi-monitor-client

# Check status
sudo systemctl status ndpi-monitor-client

# View logs
sudo journalctl -u ndpi-monitor-client --no-pager -n 50

# Follow logs in real-time
sudo journalctl -u ndpi-monitor-client -f
```

### Splash Screen Service (Client)
```bash
# Start splash
sudo systemctl start splash-client

# Stop splash
sudo systemctl stop splash-client

# Enable on boot
sudo systemctl enable splash-client

# Disable on boot
sudo systemctl disable splash-client

# Check status
sudo systemctl status splash-client

# View logs
sudo journalctl -u splash-client --boot --no-pager
```

### Kiosk Browser Service (Client)
```bash
# Start kiosk
sudo systemctl start kiosk-client

# Stop kiosk
sudo systemctl stop kiosk-client

# Restart kiosk
sudo systemctl restart kiosk-client

# Enable on boot
sudo systemctl enable kiosk-client

# Disable on boot
sudo systemctl disable kiosk-client

# Check status
sudo systemctl status kiosk-client
```

---

## File System Commands

### Mount/Unmount Partitions
```bash
# List block devices
lsblk

# Mount partition
sudo mount /dev/sda1 /mnt/sdcard

# Unmount partition
sudo umount /mnt/sdcard

# Check filesystem
sudo fsck /dev/sda1
```

### File Transfer (from development machine)
```bash
# Copy file to server
scp localfile.js ndpi-server@192.168.1.15:~/ndpi-monitor/

# Copy file to client
scp localfile.js ndpi-client@192.168.1.111:~/ndpi-monitor/

# Copy directory recursively
scp -r ./public ndpi-server@192.168.1.15:~/ndpi-monitor/

# Copy multiple files
scp file1.js file2.html ndpi-server@192.168.1.15:~/ndpi-monitor/
```

### SSH Access
```bash
# Connect to server
ssh ndpi-server@192.168.1.15

# Connect to client
ssh ndpi-client@192.168.1.111

# Connect as pi user
ssh pi@192.168.1.15

# Execute remote command
ssh ndpi-server@192.168.1.15 'command here'

# Execute multiple commands
ssh ndpi-server@192.168.1.15 'cd ~/ndpi-monitor && npm restart'
```

---

## Package Management

### Install Packages
```bash
# Update package lists
sudo apt update

# Upgrade all packages
sudo apt upgrade -y

# Install specific package
sudo apt install package-name -y

# Install Node.js dependencies
cd ~/ndpi-monitor
npm install

# Install global npm package
sudo npm install -g package-name
```

### Required System Packages
```bash
# NDI SDK dependencies
sudo apt install -y libavahi-client-dev libavahi-common-dev

# Framebuffer image viewer (for splash screen)
sudo apt install -y fbi

# X11 and browser for kiosk mode
sudo apt install -y xserver-xorg xinit chromium-browser

# Network tools
sudo apt install -y avahi-daemon avahi-utils

# Build tools
sudo apt install -y build-essential
```

---

## User Management

### Create Users
```bash
# Create ndpi-server user
sudo useradd -m -s /bin/bash ndpi-server
sudo passwd ndpi-server

# Create ndpi-client user
sudo useradd -m -s /bin/bash ndpi-client
sudo passwd ndpi-client

# Add user to sudo group
sudo usermod -aG sudo ndpi-server
sudo usermod -aG sudo ndpi-client

# Add user to video group (for framebuffer access)
sudo usermod -aG video ndpi-client
```

### Permissions
```bash
# Change ownership
sudo chown -R ndpi-server:ndpi-server ~/ndpi-monitor

# Make script executable
chmod +x script.sh

# Allow passwordless sudo for specific commands
sudo visudo
# Add: ndpi-server ALL=(ALL) NOPASSWD: /sbin/reboot, /sbin/shutdown
```

---

## Display Configuration

### Framebuffer Commands
```bash
# Display image on framebuffer
sudo fbi -d /dev/fb0 -T 1 --noverbose --autozoom /path/to/image.svg

# Kill framebuffer image viewer
sudo killall fbi

# Check framebuffer devices
ls -la /dev/fb*
```

### X11 Kiosk Mode
```bash
# Start X11 with Chromium in kiosk
startx /usr/bin/chromium-browser --kiosk --disable-infobars http://localhost:3001 -- :0 vt7

# Kill X session
pkill -f chromium
pkill -f Xorg
```

---

## Boot Configuration

### Enable/Disable Services at Boot
```bash
# Enable service
sudo systemctl enable ndpi-monitor.service

# Disable service
sudo systemctl disable ndpi-monitor.service

# Check if enabled
systemctl is-enabled ndpi-monitor.service
```

### Boot Configuration Files
```bash
# Edit boot config
sudo nano /boot/config.txt

# Edit command line parameters
sudo nano /boot/cmdline.txt
```

---

## Monitoring & Debugging

### Real-time System Monitoring
```bash
# CPU and memory usage
htop

# Network connections
sudo netstat -tulpn

# Active processes
ps aux | grep node

# Disk I/O
iostat

# Check WebSocket connections
ss -t | grep :3000
```

### Log Files
```bash
# System logs
sudo journalctl --no-pager -n 100

# Service-specific logs
sudo journalctl -u ndpi-monitor-client --since "10 minutes ago"
sudo journalctl -u ndpi-monitor --since "10 minutes ago"

# Boot logs
sudo journalctl -b

# Follow logs
tail -f /var/log/syslog
```

---

## mDNS Discovery

### Advertise Service
```bash
# Server publishes service
# Done automatically via bonjour in Node.js

# Check published services
avahi-browse -a

# Resolve specific service
avahi-resolve -n ndpi-monitor-server.local
```

### Find Devices
```bash
# Find all NDPi devices on network
avahi-browse -t _ndpi-monitor-client._tcp

# Find all HTTP services
avahi-browse -t _http._tcp
```

---

## WebSocket Communication

### Server → Client Messages

#### Set NDI Source
```json
{
  "type": "set-source",
  "sourceName": "NDI_SOURCE_NAME",
  "user": "admin",
  "timestamp": 1234567890,
  "serverAddress": "192.168.1.15"
}
```

#### Show Overlay
```json
{
  "type": "overlay",
  "user": "admin"
}
```

#### Show Blank Screen
```json
{
  "type": "blank",
  "user": "admin"
}
```

#### Reboot Device
```json
{
  "type": "reboot"
}
```

#### Shutdown Device
```json
{
  "type": "shutdown"
}
```

#### Configure Network
```json
{
  "type": "set-network",
  "config": {
    "mode": "static|dhcp",
    "staticIP": "192.168.1.100",
    "subnet": "255.255.255.0",
    "gateway": "192.168.1.1",
    "dns": "8.8.8.8",
    "wifiSSID": "NetworkName",
    "wifiPassword": "password"
  }
}
```

#### Ping
```json
{
  "type": "ping"
}
```

### Client → Server Messages

#### Register Device
```json
{
  "type": "register",
  "deviceId": "unique-device-id",
  "name": "Client Device Name",
  "ip": "192.168.1.111",
  "systemStats": {
    "cpu": 45.2,
    "memory": { "percent": 62.5 },
    "temperature": 55.3
  }
}
```

#### Status Update
```json
{
  "type": "status-update",
  "deviceId": "device-id",
  "status": "online|offline",
  "currentSource": "NDI_SOURCE_NAME"
}
```

#### Pong Response
```json
{
  "type": "pong",
  "deviceId": "device-id"
}
```

---

## HTTP API Endpoints

### Server API

#### Get Devices
```
GET /api/devices
```

#### Get Single Device
```
GET /api/device/:deviceId
```

#### Add Device
```
POST /api/device/:deviceId
Body: {
  "deviceId": "id",
  "deviceName": "name",
  "ip": "192.168.1.111"
}
```

#### Update Device
```
PUT /api/device/:deviceId
Body: {
  "currentSource": "NDI_SOURCE_NAME"
}
```

#### Delete Device
```
DELETE /api/device/:deviceId
```

#### Get Groups
```
GET /api/groups
```

#### Create Group
```
POST /api/group
Body: {
  "name": "Group Name"
}
```

#### Update Group
```
PUT /api/group/:groupId
Body: {
  "currentSource": "NDI_SOURCE_NAME"
}
```

#### Delete Group
```
DELETE /api/group/:groupId
```

#### Add Device to Group
```
POST /api/group/:groupId/device
Body: {
  "deviceId": "device-id"
}
```

#### Remove Device from Group
```
DELETE /api/group/:groupId/device/:deviceId
```

#### Get NDI Sources
```
GET /api/ndi-sources
```

#### Reboot System
```
POST /api/system/reboot
```

#### Configure Network (Server)
```
POST /api/system/network
Body: {
  "mode": "static|dhcp",
  "staticIP": "192.168.1.15",
  "subnet": "255.255.255.0",
  "gateway": "192.168.1.1",
  "dns": "8.8.8.8"
}
```

#### Configure Network (Client Device)
```
POST /api/device/:deviceId/network
Body: {
  "mode": "static|dhcp",
  "staticIP": "192.168.1.111",
  "subnet": "255.255.255.0",
  "gateway": "192.168.1.1",
  "dns": "8.8.8.8",
  "wifiSSID": "NetworkName",
  "wifiPassword": "password"
}
```

---

## Environment Variables

### Server
```bash
PORT=3000
NODE_ENV=production
```

### Client
```bash
NODE_ENV=production
DISPLAY=:0
```

---

## Security & Permissions

### Sudo Permissions
Add to `/etc/sudoers.d/ndpi-monitor`:
```
ndpi-server ALL=(ALL) NOPASSWD: /sbin/reboot, /sbin/shutdown, /bin/systemctl
ndpi-client ALL=(ALL) NOPASSWD: /sbin/reboot, /sbin/shutdown, /bin/systemctl
```

### Firewall Rules
```bash
# Allow SSH
sudo ufw allow 22

# Allow HTTP
sudo ufw allow 80

# Allow Node.js server
sudo ufw allow 3000

# Allow Node.js client
sudo ufw allow 3001

# Enable firewall
sudo ufw enable
```

---

## Complete Installation Commands

### Server Installation
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install dependencies
sudo apt install -y nodejs npm git libavahi-client-dev libavahi-common-dev avahi-daemon

# Create user
sudo useradd -m -s /bin/bash ndpi-server

# Clone/copy files
cd /home/ndpi-server
git clone <repo> ndpi-monitor

# Install Node dependencies
cd ndpi-monitor
npm install

# Install systemd service
sudo cp config/ndpi-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable ndpi-monitor
sudo systemctl start ndpi-monitor
```

### Client Installation
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install dependencies
sudo apt install -y nodejs npm git libavahi-client-dev libavahi-common-dev avahi-daemon fbi xserver-xorg xinit chromium-browser

# Create users
sudo useradd -m -s /bin/bash ndpi-client
sudo usermod -aG video ndpi-client

# Clone/copy files
cd /home/ndpi-client
git clone <repo> ndpi-monitor-client

# Install Node dependencies
cd ndpi-monitor-client
npm install

# Install NDI SDK
bash install-ndi-sdk.sh

# Install systemd services
sudo cp client/config/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable splash-client ndpi-monitor-client kiosk-client
sudo systemctl start splash-client ndpi-monitor-client kiosk-client
```

---

## Troubleshooting Commands

### Check Service Status
```bash
systemctl status ndpi-monitor-client
journalctl -u ndpi-monitor-client -n 50 --no-pager
```

### Network Diagnostics
```bash
# Ping server
ping 192.168.1.15

# Check if port is open
nc -zv 192.168.1.15 3000

# View network connections
sudo netstat -tulpn | grep node
```

### Reset Network
```bash
sudo systemctl restart dhcpcd
sudo systemctl restart networking
sudo ip link set eth0 down && sudo ip link set eth0 up
```

### Kill Processes
```bash
# Kill node processes
pkill -f node

# Kill chromium
pkill -f chromium

# Kill X server
pkill -f Xorg
```
