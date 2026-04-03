#!/bin/bash

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║                         ENDLESSCAST INSTALLER                              ║
# ║                     24/7 Multi-Platform Broadcasting                       ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'
BOLD='\033[1m'

print_banner() {
    echo -e "${GREEN}"
    echo "╔═══════════════════════════════════════════════════════════════════════════╗"
    echo "║                                                                           ║"
    echo "║   ███████╗███╗   ██╗██████╗ ██╗     ███████╗███████╗███████╗             ║"
    echo "║   ██╔════╝████╗  ██║██╔══██╗██║     ██╔════╝██╔════╝██╔════╝             ║"
    echo "║   █████╗  ██╔██╗ ██║██║  ██║██║     █████╗  ███████╗███████╗             ║"
    echo "║   ██╔══╝  ██║╚██╗██║██║  ██║██║     ██╔══╝  ╚════██║╚════██║             ║"
    echo "║   ███████╗██║ ╚████║██████╔╝███████╗███████╗███████║███████║             ║"
    echo "║   ╚══════╝╚═╝  ╚═══╝╚═════╝ ╚══════╝╚══════╝╚══════╝╚══════╝             ║"
    echo "║                                                                           ║"
    echo "║   ██████╗ █████╗ ███████╗████████╗                                       ║"
    echo "║  ██╔════╝██╔══██╗██╔════╝╚══██╔══╝                                       ║"
    echo "║  ██║     ███████║███████╗   ██║                                          ║"
    echo "║  ██║     ██╔══██║╚════██║   ██║                                          ║"
    echo "║  ╚██████╗██║  ██║███████║   ██║                                          ║"
    echo "║   ╚═════╝╚═╝  ╚═╝╚══════╝   ╚═╝                                          ║"
    echo "║                                                                           ║"
    echo "║                    24/7 Multi-Platform Broadcasting                       ║"
    echo "╚═══════════════════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

print_step()    { echo -e "${CYAN}[>]${NC} $1"; }
print_success() { echo -e "${GREEN}[✓]${NC} $1"; }
print_error()   { echo -e "${RED}[✗]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[!]${NC} $1"; }
print_info()    { echo -e "${BLUE}[i]${NC} $1"; }

check_command() { command -v "$1" &>/dev/null; }

check_port() {
    if lsof -Pi :"$1" -sTCP:LISTEN -t >/dev/null 2>&1; then
        return 1
    fi
    return 0
}

# ─── detect background method ────────────────────────────────────────────────
detect_bg_method() {
    if check_command pm2; then
        echo "pm2"
    elif check_command systemctl && [ -d /etc/systemd/system ]; then
        echo "systemd"
    else
        echo "nohup"
    fi
}

main() {
    clear
    print_banner

    echo ""
    echo -e "${BOLD}${MAGENTA}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}${MAGENTA}║              ENDLESSCAST INSTALLATION WIZARD                 ║${NC}"
    echo -e "${BOLD}${MAGENTA}╚══════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    # ── Step 1: System requirements ──────────────────────────────────────────
    print_step "Checking system requirements..."
    echo ""

    if check_command node; then
        NODE_VERSION=$(node -v)
        print_success "Node.js installed: $NODE_VERSION"
    else
        print_error "Node.js not found. Please install Node.js 18+ first."
        echo -e "    ${CYAN}Visit: https://nodejs.org/${NC}"
        exit 1
    fi

    if check_command npm; then
        NPM_VERSION=$(npm -v)
        print_success "npm installed: v$NPM_VERSION"
    else
        print_error "npm not found. Please install npm first."
        exit 1
    fi

    if check_command ffmpeg; then
        FFMPEG_VERSION=$(ffmpeg -version 2>&1 | head -n1 | awk '{print $3}')
        print_success "FFmpeg installed: $FFMPEG_VERSION"
    else
        print_warning "FFmpeg not found. Streaming will not work without it."
        echo -e "    ${CYAN}Install with: sudo apt install ffmpeg${NC}"
        echo ""
        read -p "Continue anyway? (y/n): " CONTINUE
        [[ "$CONTINUE" =~ ^[Yy]$ ]] || exit 1
    fi

    echo ""

    # ── Step 2: Port selection ────────────────────────────────────────────────
    print_step "Port Configuration"
    echo ""
    echo -e "${BOLD}Select a port to run EndlessCast:${NC}"
    echo ""

    PORTS=(3000 4000 5000 8000 8080 8888 9000 9090)

    echo -e "${CYAN}┌─────────────────────────────────────────────────────────────┐${NC}"
    echo -e "${CYAN}│  #   PORT    STATUS                                        │${NC}"
    echo -e "${CYAN}├─────────────────────────────────────────────────────────────┤${NC}"

    for i in "${!PORTS[@]}"; do
        PORT=${PORTS[$i]}
        if check_port "$PORT"; then
            STATUS="${GREEN}Available${NC}"
        else
            STATUS="${RED}In Use${NC}"
        fi
        printf "${CYAN}│${NC}  %-2s  %-6s  %-40b ${CYAN}│${NC}\n" "$((i+1))" "$PORT" "$STATUS"
    done

    echo -e "${CYAN}│${NC}  9   Custom port                                           ${CYAN}│${NC}"
    echo -e "${CYAN}└─────────────────────────────────────────────────────────────┘${NC}"
    echo ""

    while true; do
        read -p "Enter your choice (1-9) [default: 3]: " PORT_CHOICE
        PORT_CHOICE=${PORT_CHOICE:-3}

        if [[ "$PORT_CHOICE" == "9" ]]; then
            read -p "Enter custom port (1024-65535): " CUSTOM_PORT
            if [[ "$CUSTOM_PORT" =~ ^[0-9]+$ ]] && [ "$CUSTOM_PORT" -ge 1024 ] && [ "$CUSTOM_PORT" -le 65535 ]; then
                SELECTED_PORT=$CUSTOM_PORT
            else
                print_error "Invalid port. Please enter a number between 1024 and 65535."
                continue
            fi
        elif [[ "$PORT_CHOICE" =~ ^[1-8]$ ]]; then
            SELECTED_PORT=${PORTS[$((PORT_CHOICE-1))]}
        else
            print_error "Invalid choice. Please enter 1-9."
            continue
        fi

        if check_port "$SELECTED_PORT"; then
            print_success "Port $SELECTED_PORT selected and available!"
            break
        else
            print_warning "Port $SELECTED_PORT is in use. Choose another port."
        fi
    done

    echo ""

    # ── Step 3: Install dependencies & Build ─────────────────────────────────
    print_step "Installing dependencies..."
    echo ""

    if [ ! -f "package.json" ]; then
        print_error "package.json not found. Are you in the EndlessCast directory?"
        exit 1
    fi

    npm install 2>&1 | while IFS= read -r line; do echo -e "    ${CYAN}>${NC} $line"; done
    if [ ${PIPESTATUS[0]} -ne 0 ]; then
        print_error "npm install failed. Check the output above."
        exit 1
    fi
    print_success "Dependencies installed successfully!"

    echo ""
    print_step "Building production client and server..."
    npm run build 2>&1 | while IFS= read -r line; do echo -e "    ${CYAN}>${NC} $line"; done
    if [ ${PIPESTATUS[0]} -ne 0 ]; then
        print_error "Build failed. Check the output above."
        exit 1
    fi
    print_success "Build completed successfully!"

    echo ""

    # ── Step 4: Login credentials ─────────────────────────────────────────────
    print_step "Login Credentials Setup"
    echo ""
    echo -e "${BOLD}Configure your admin credentials:${NC}"
    echo ""
    echo -e "${CYAN}┌─────────────────────────────────────────────────────────────┐${NC}"
    echo -e "${CYAN}│  1   Use custom credentials ${GREEN}(Recommended)${NC}                  ${CYAN}│${NC}"
    echo -e "${CYAN}│  2   Use defaults ${YELLOW}(Not recommended for production)${NC}        ${CYAN}│${NC}"
    echo -e "${CYAN}└─────────────────────────────────────────────────────────────┘${NC}"
    echo ""

    read -p "Enter your choice (1-2) [default: 1]: " CRED_CHOICE
    CRED_CHOICE=${CRED_CHOICE:-1}

    if [[ "$CRED_CHOICE" == "1" ]]; then
        echo ""
        read -p "Enter admin username: " ADMIN_USERNAME
        ADMIN_USERNAME=${ADMIN_USERNAME:-admin}

        while true; do
            read -s -p "Enter admin password (min 6 characters): " ADMIN_PASSWORD
            echo ""
            if [ ${#ADMIN_PASSWORD} -lt 6 ]; then
                print_error "Password must be at least 6 characters."
                continue
            fi
            read -s -p "Confirm password: " ADMIN_PASSWORD_CONFIRM
            echo ""
            if [ "$ADMIN_PASSWORD" != "$ADMIN_PASSWORD_CONFIRM" ]; then
                print_error "Passwords do not match. Try again."
                continue
            fi
            break
        done

        print_success "Custom credentials configured!"
        USING_DEFAULTS=false
    else
        ADMIN_USERNAME="admin"
        ADMIN_PASSWORD="admin123"
        echo ""
        print_warning "Using default credentials (username: admin, password: admin123)"
        print_warning "Change these after first login for security!"
        USING_DEFAULTS=true
    fi

    print_step "Generating secure password hash..."
    PASSWORD_HASH=$(node -e "const bcrypt=require('bcrypt');bcrypt.hash('$ADMIN_PASSWORD',10).then(h=>console.log(h))" 2>/dev/null || true)

    if [ -z "$PASSWORD_HASH" ]; then
        print_warning "Could not generate password hash. Using default auth."
    else
        print_success "Password hash generated!"
    fi

    echo ""

    # ── Step 5: Write .env ────────────────────────────────────────────────────
    print_step "Configuring environment..."

    ENV_FILE=".env"
    if [ -f "$ENV_FILE" ]; then
        cp "$ENV_FILE" "${ENV_FILE}.backup"
        print_info "Existing .env backed up to .env.backup"
    fi

    cat > "$ENV_FILE" << ENVEOF
# EndlessCast Configuration
# Generated by install.sh

PORT=$SELECTED_PORT
ADMIN_USERNAME=$ADMIN_USERNAME
PASSWORD_HASH=$PASSWORD_HASH
NODE_ENV=production
ENVEOF

    print_success "Environment configured!"
    echo -e "  ${CYAN}•${NC} Port: ${GREEN}$SELECTED_PORT${NC}"
    echo -e "  ${CYAN}•${NC} Username: ${GREEN}$ADMIN_USERNAME${NC}"
    echo -e "  ${CYAN}•${NC} Password: ${GREEN}********${NC}"

    echo ""

    CURRENT_DIR=$(pwd)
    SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "your-ip")


    # ── Step 7: Systemd service ───────────────────────────────────────────────
    print_step "Creating systemd service file..."

    SERVICE_FILE="endlesscast.service"
    cat > "$SERVICE_FILE" << SVCEOF
[Unit]
Description=EndlessCast 24/7 Streaming Platform
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$CURRENT_DIR
EnvironmentFile=$CURRENT_DIR/.env
ExecStart=/usr/bin/env node $CURRENT_DIR/dist/index.js
Restart=always
RestartSec=5
StandardOutput=append:$CURRENT_DIR/endlesscast.log
StandardError=append:$CURRENT_DIR/endlesscast.log
LimitCPU=infinity
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
SVCEOF

    print_success "Created $SERVICE_FILE"

    # Try auto-installing systemd if sudo is available
    if command -v systemctl &>/dev/null && sudo -n true 2>/dev/null; then
        print_info "Sudo available — installing systemd service automatically..."
        sudo cp "$SERVICE_FILE" /etc/systemd/system/
        sudo systemctl daemon-reload
        sudo systemctl enable endlesscast
        print_success "Systemd service installed and enabled (auto-start on reboot)."
        SYSTEMD_AUTO=true
    else
        SYSTEMD_AUTO=false
        print_info "To install as a system service (auto-start on reboot):"
        echo -e "    ${CYAN}sudo cp $SERVICE_FILE /etc/systemd/system/${NC}"
        echo -e "    ${CYAN}sudo systemctl daemon-reload${NC}"
        echo -e "    ${CYAN}sudo systemctl enable endlesscast${NC}"
        echo -e "    ${CYAN}sudo systemctl start endlesscast${NC}"
    fi

    echo ""

    # ── Step 8: Final summary ─────────────────────────────────────────────────
    echo -e "${GREEN}"
    echo "╔═══════════════════════════════════════════════════════════════════════════╗"
    echo "║                    INSTALLATION COMPLETE!                                 ║"
    echo "╚═══════════════════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"

    echo -e "${BOLD}Configuration Summary:${NC}"
    echo -e "  ${CYAN}•${NC} Port:     ${GREEN}$SELECTED_PORT${NC}"
    echo -e "  ${CYAN}•${NC} Username: ${GREEN}$ADMIN_USERNAME${NC}"
    if [ "$USING_DEFAULTS" = true ]; then
        echo -e "  ${CYAN}•${NC} Password: ${YELLOW}admin123${NC} ${RED}← Change this!${NC}"
    else
        echo -e "  ${CYAN}•${NC} Password: ${GREEN}(as configured)${NC}"
    fi
    echo ""

    echo -e "${BOLD}Management Commands:${NC}"
    echo -e "  ${CYAN}Start:${NC}    ./start.sh          ${BLUE}# runs in background automatically${NC}"
    echo -e "  ${CYAN}Stop:${NC}     ./stop.sh"
    echo -e "  ${CYAN}Restart:${NC}  ./restart.sh"
    echo -e "  ${CYAN}Status:${NC}   ./status.sh"
    if [ "$SYSTEMD_AUTO" = true ]; then
        echo -e "  ${CYAN}Systemd:${NC}  sudo systemctl {start|stop|status|restart} endlesscast"
    fi
    echo ""

    echo -e "${BOLD}Access your dashboard at:${NC}"
    echo -e "  ${CYAN}Local:${NC}    ${GREEN}http://localhost:$SELECTED_PORT${NC}"
    echo -e "  ${CYAN}Network:${NC}  ${GREEN}http://$SERVER_IP:$SELECTED_PORT${NC}"
    echo ""

    # ── Start now? ────────────────────────────────────────────────────────────
    echo -e "${BOLD}Start EndlessCast now?${NC}"
    echo -e "  ${CYAN}b${NC}  Background (recommended) — keeps running after you close terminal"
    if [ "$SYSTEMD_AUTO" = true ]; then
        echo -e "  ${CYAN}s${NC}  Systemd   — managed by the OS, survives reboots"
    fi
    echo -e "  ${CYAN}f${NC}  Foreground — blocks terminal (useful for debugging)"
    echo -e "  ${CYAN}n${NC}  No — I'll start it later with ./start.sh"
    echo ""
    read -p "Choice [b/f/n]: " START_CHOICE
    START_CHOICE=${START_CHOICE:-b}

    echo ""

    case "$START_CHOICE" in
        [Bb])
            print_step "Launching EndlessCast in background..."
            ./start.sh
            ;;
        [Ss])
            if [ "$SYSTEMD_AUTO" = true ]; then
                print_step "Starting via systemd..."
                sudo systemctl start endlesscast
                sleep 2
                sudo systemctl status endlesscast --no-pager
                print_success "Running as a system service."
            else
                print_warning "Systemd not auto-installed. Run the commands above first."
                print_step "Falling back to background mode..."
                ./start.sh
            fi
            ;;
        [Ff])
            print_step "Starting in foreground (Ctrl+C to stop)..."
            echo ""
            export PORT=$SELECTED_PORT
            node dist/index.js
            ;;
        *)
            print_info "Run './start.sh' when ready to start EndlessCast."
            print_info "Run './status.sh' to check if it's running."
            ;;
    esac
}

main "$@"
