# EndlessCast — Deployment Guide

Installation and deployment instructions for every supported platform.

- [Ubuntu VPS / Linux Server](#ubuntu-vps--linux-server)
- [Windows PC](#windows-pc)
- [Android (Termux)](#android-termux)
- [Updating an Existing Install](#updating-an-existing-install)
- [Removing EndlessCast](#removing-endlesscast)

---

## Ubuntu VPS / Linux Server

**Recommended for 24/7 streaming.** A cheap VPS (2–4 vCPU, 2–4 GB RAM) is all you need for 1–2 simultaneous streams.

### Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| **OS** | Ubuntu 20.04+ / Debian 11+ | Ubuntu 22.04 LTS |
| **Node.js** | 18.x | 20.x |
| **RAM** | 1 GB | 2 GB+ |
| **Storage** | 10 GB | 200 GB+ |
| **FFmpeg** | Required | Required |

### 1. Install dependencies

```bash
# Node.js 20 (skip if already installed)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# FFmpeg and Git
sudo apt update && sudo apt install -y ffmpeg git
```

### 2. Clone and install

```bash
git clone https://github.com/leksmedias/EndlessCast.git
cd EndlessCast
chmod +x install.sh
./install.sh
```

The interactive installer will:
1. Check Node.js, FFmpeg, and Git are installed
2. Let you choose a port (default 5000, or enter a custom one like 5050)
3. Set up admin username and password (bcrypt-hashed)
4. Install npm dependencies
5. Create `endlesscast.service` for systemd — auto-installs it if `sudo` is available
6. Offer to start the server immediately in the background

### 3. Start the server

```bash
./start.sh      # starts in background — terminal returns immediately
./stop.sh       # stop the server
./status.sh     # check if running, shows port and log path
./restart.sh    # stop + start in one command
```

`start.sh` automatically picks the best available method:
- **pm2** — if installed, uses pm2 (survives reboots, has built-in monitoring)
- **nohup** — fallback; writes logs to `endlesscast.log`, PID to `endlesscast.pid`

> **Ctrl+C will not stop the server** when started with `./start.sh`. It runs in the background detached from your terminal session.

#### Optional: install pm2 for the best experience

```bash
npm install -g pm2
pm2 startup      # auto-start EndlessCast on server reboot
```

### 4. Run as a system service (auto-start on reboot)

The installer creates `endlesscast.service`. If `sudo` was available during install, it's already enabled. Otherwise:

```bash
sudo cp endlesscast.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable endlesscast
sudo systemctl start endlesscast
```

**Service management:**

```bash
sudo systemctl status endlesscast
sudo systemctl restart endlesscast
sudo systemctl stop endlesscast
sudo journalctl -u endlesscast -f                       # live logs
sudo journalctl -u endlesscast --since "1 hour ago"     # recent logs
```

### 5. Open the firewall

```bash
# UFW (Ubuntu)
sudo ufw allow 22/tcp          # SSH
sudo ufw allow YOUR_PORT/tcp   # EndlessCast port (e.g. 5050)
sudo ufw enable

# iptables alternative
sudo iptables -A INPUT -p tcp --dport YOUR_PORT -j ACCEPT
```

If you're on a cloud provider (AWS, DigitalOcean, Hetzner, Contabo etc.) also open the port in your provider's firewall or security group settings.

### 6. Custom domain with HTTPS (optional)

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo nano /etc/nginx/sites-available/endlesscast
```

Paste this config — replace `your_domain.com` and `5000` with your port:

```nginx
server {
    listen 80;
    server_name your_domain.com;

    client_max_body_size 5G;
    client_body_timeout 3600s;
    proxy_connect_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_read_timeout 3600s;

    location / {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_request_buffering off;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/endlesscast /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx

# Free SSL certificate
sudo certbot --nginx -d your_domain.com
```

### CPU & bandwidth requirements

| Simultaneous Streams | Resolution | CPU Cores | RAM | Upload Bandwidth |
|----------------------|------------|-----------|-----|-----------------|
| 1× | 1080p | 2 cores | 512 MB | ~6.2 Mbps |
| 2× | 1080p | 4 cores | 1 GB | ~12.4 Mbps |
| 4× | 1080p | 8 cores | 2 GB | ~24.8 Mbps |
| 6× | 1080p | 12 cores | 3 GB | ~37.2 Mbps |
| 1× | 720p | 1 core | 256 MB | ~3.2 Mbps |
| 4× | 720p | 4 cores | 1 GB | ~12.8 Mbps |

> Use the **Landscape 720p** output profile to halve CPU usage per stream.
> Use a VPS with **dedicated** CPU cores (not shared/burstable) for stable 24/7 operation.

---

## Windows PC

Run EndlessCast locally on Windows for testing or personal use. For 24/7 uninterrupted streaming, a Linux VPS is preferred since Windows desktops sleep and update.

### 1. Install prerequisites

**Node.js** — download and install from [nodejs.org](https://nodejs.org) (LTS version, 20.x recommended). This also installs `npm`.

**Git** — download from [git-scm.com](https://git-scm.com/download/win). Use the default options during setup.

**FFmpeg** — choose one method:

*Option A — Chocolatey (recommended):*
```powershell
# Run PowerShell as Administrator
Set-ExecutionPolicy Bypass -Scope Process -Force
[System.Net.ServicePointManager]::SecurityProtocol = 3072
iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

choco install ffmpeg -y
```

*Option B — Scoop:*
```powershell
# Run PowerShell as Administrator
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
irm get.scoop.sh | iex

scoop install ffmpeg
```

*Option C — Manual:*
1. Download a Windows build from [ffmpeg.org/download.html](https://ffmpeg.org/download.html) (choose a "release" build)
2. Extract the zip to `C:\ffmpeg`
3. Add `C:\ffmpeg\bin` to your system PATH:
   - Search "Environment Variables" in Start Menu
   - Edit "Path" under System variables
   - Add `C:\ffmpeg\bin`
4. Open a new terminal and run `ffmpeg -version` to confirm

Verify everything is installed:
```cmd
node -v
npm -v
git --version
ffmpeg -version
```

### 2. Clone and install

Open **Command Prompt** or **PowerShell** (not as Administrator):

```cmd
git clone https://github.com/leksmedias/EndlessCast.git
cd EndlessCast
npm install
```

### 3. Configure

Create a `.env` file in the EndlessCast folder:

```env
PORT=5000
NODE_ENV=production
ADMIN_USERNAME=admin
PASSWORD_HASH=$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi
```

> The `PASSWORD_HASH` above is the bcrypt hash of `admin123`. Change it after first login from inside the app's Settings page, or generate a new hash:
> ```cmd
> node -e "const b=require('bcryptjs');b.hash('yourpassword',10,(e,h)=>console.log(h))"
> ```

### 4. Start the server

**Option A — Foreground (simplest, closes when you close the window):**

```cmd
npm run build
node dist/index.cjs
```

Then open your browser at `http://localhost:5000`

**Option B — Background with pm2 (recommended, survives closing the terminal):**

```cmd
npm run build
npm install -g pm2
pm2 start dist/index.cjs --name endlesscast
pm2 save
```

pm2 commands:
```cmd
pm2 logs endlesscast      # view live logs
pm2 stop endlesscast      # stop the server
pm2 restart endlesscast   # restart it
pm2 status                # see all running processes
```

**Option C — Auto-start on Windows login with pm2:**

```powershell
# Run PowerShell as Administrator
pm2 startup
# Follow the instructions it prints — run the generated command
pm2 save
```

### 5. Access the dashboard

Open your browser and go to `http://localhost:5000` (or whatever port you set).

Default login: `admin` / `admin123`

### Troubleshooting on Windows

**"node" is not recognized** — Node.js not in PATH. Restart your terminal after installing Node.js.

**"ffmpeg" is not recognized** — FFmpeg not in PATH. Re-check the PATH setup in step 1 and open a new terminal.

**Port already in use:**
```cmd
netstat -ano | findstr :5000
taskkill /PID <PID> /F
```

**Windows Firewall blocking access from other devices on your network:**
1. Open Windows Defender Firewall
2. Click "Allow an app or feature through Windows Defender Firewall"
3. Click "Allow another app" → browse to `node.exe`
4. Or run in PowerShell as Administrator:
   ```powershell
   New-NetFirewallRule -DisplayName "EndlessCast" -Direction Inbound -Protocol TCP -LocalPort 5000 -Action Allow
   ```

---

## Android (Termux)

Run EndlessCast directly on an Android device using Termux. Good for testing or low-traffic personal streams. For 24/7 streaming, keep the screen on or use a wake lock app.

### 1. Install Termux

**Do not install Termux from the Google Play Store** — that version is outdated and broken.

Install from [F-Droid](https://f-droid.org/packages/com.termux/) instead:
1. Open F-Droid on your device (or download the F-Droid APK from [f-droid.org](https://f-droid.org))
2. Search for "Termux" and install it

### 2. Install dependencies

Open Termux and run:

```bash
pkg update && pkg upgrade -y
pkg install -y nodejs git ffmpeg
```

Verify:
```bash
node -v
ffmpeg -version
git --version
```

### 3. Clone and install

```bash
git clone https://github.com/leksmedias/EndlessCast.git
cd EndlessCast
npm install
```

### 4. Configure

```bash
cat > .env << 'EOF'
PORT=5000
NODE_ENV=production
ADMIN_USERNAME=admin
PASSWORD_HASH=$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi
EOF
```

### 5. Start the server

**Foreground (simplest):**
```bash
npm run build
node dist/index.cjs
```

**Background using Termux's built-in method** (so you can close the terminal pane):
```bash
npm run build
nohup node dist/index.cjs > endlesscast.log 2>&1 &
echo $! > endlesscast.pid
echo "Started. PID: $(cat endlesscast.pid)"
```

Stop it later:
```bash
kill $(cat endlesscast.pid) && rm endlesscast.pid
```

View logs:
```bash
tail -f endlesscast.log
```

### 6. Access the dashboard

**From the same Android device:**
Open the browser and go to `http://localhost:5000`

**From another device on your WiFi:**
```bash
# Find your Android's local IP address
ip addr show wlan0 | grep 'inet '
```
Then open `http://<your-android-ip>:5000` from any browser on the same WiFi network.

### Tips for Android streaming

- **Keep screen on:** Install a "Keep Screen On" app, or go to Settings → Developer Options → Stay Awake
- **Prevent Termux from being killed:** Go to Android Settings → Battery → find Termux → set to "Unrestricted" or disable battery optimization
- **Storage for videos:** Termux has access to `~/storage` after running `termux-setup-storage` — you can upload videos from your phone's gallery
- **Performance:** Android throttles CPU aggressively. For 24/7 reliable streaming, a Linux VPS is strongly recommended over a phone

---

## Updating an Existing Install

Works the same way on all platforms:

```bash
cd ~/EndlessCast          # or wherever you cloned it

# Pull the latest code
git pull origin main

# Install any new dependencies
npm install

# Restart the server
./restart.sh              # Linux/VPS
# or:
pm2 restart endlesscast   # if using pm2 (Windows or Linux)
```

> **First time updating from an old install?** The old `start.sh` generated by the installer ran in the foreground (Ctrl+C killed it). The new scripts run in the background. Get them:
> ```bash
> rm -f start.sh stop.sh status.sh restart.sh
> git pull origin main
> chmod +x start.sh stop.sh status.sh restart.sh
> ./start.sh
> ```

---

## Removing EndlessCast

### 1. Stop the server

```bash
./stop.sh                            # Linux with start.sh

pm2 stop endlesscast                 # if using pm2 (any platform)
pm2 delete endlesscast

sudo systemctl stop endlesscast      # Linux systemd
sudo systemctl disable endlesscast
```

### 2. Remove the systemd service (Linux only)

```bash
sudo rm -f /etc/systemd/system/endlesscast.service
sudo systemctl daemon-reload
```

### 3. Delete all files

> **Back up first** if you want to keep your videos or stream config:
> ```bash
> cp ~/EndlessCast/data/storage.json ~/endlesscast-backup.json
> cp -r ~/EndlessCast/uploads ~/endlesscast-uploads-backup
> ```

```bash
rm -rf ~/EndlessCast          # Linux / Android (Termux)
```

```cmd
rmdir /s /q C:\path\to\EndlessCast    :: Windows
```

### 4. Remove pm2 (optional)

Only if you installed pm2 just for EndlessCast:

```bash
pm2 delete all
npm uninstall -g pm2
```
### Update
```bash
cd ~/EndlessCast && git pull && npm install && npm run build && ./restart.sh
```



That's it. Your system is clean.
