#!/bin/bash
# EndlessCast — start in background (pm2 → nohup fallback)
# Runs the compiled production build (dist/index.cjs), NOT tsx.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Load .env if it exists (sets PORT, etc.)
[ -f .env ] && source .env

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

export PORT=${PORT:-5000}
export NODE_ENV=production

# ── Build if needed ───────────────────────────────────────────────────────────
if [ ! -f "$SCRIPT_DIR/dist/index.cjs" ] || [ ! -d "$SCRIPT_DIR/dist/public" ]; then
    echo -e "${YELLOW}[!]${NC} Production build not found. Building now..."
    npm run build
    if [ $? -ne 0 ]; then
        echo -e "${RED}[✗]${NC} Build failed. Fix the error above and try again."
        exit 1
    fi
    echo ""
fi

echo -e "${GREEN}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║             STARTING ENDLESSCAST SERVER                   ║"
printf "║%*s║\n" -59 "                    Port: ${PORT}"
echo "╚═══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── pm2 (preferred) ──────────────────────────────────────────────────────────
if command -v pm2 &>/dev/null; then
    echo -e "${CYAN}[>]${NC} Using pm2 process manager..."

    pm2 delete endlesscast 2>/dev/null || true

    pm2 start "$SCRIPT_DIR/dist/index.cjs" \
        --name endlesscast \
        --cwd "$SCRIPT_DIR"

    pm2 save

    sleep 3
    STATUS=$(pm2 jlist 2>/dev/null | node -e "
        let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            try {
                const list = JSON.parse(d);
                const p = list.find(x=>x.name==='endlesscast');
                console.log(p ? p.pm2_env.status : 'unknown');
            } catch(e) { console.log('unknown'); }
        });
    " 2>/dev/null || echo "unknown")

    if [ "$STATUS" = "online" ]; then
        echo ""
        echo -e "${GREEN}[✓]${NC} EndlessCast running via pm2 (status: online)"
        echo -e "${GREEN}[✓]${NC} Access: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'your-ip'):${PORT}"
        echo -e "${CYAN}[i]${NC} Logs:   pm2 logs endlesscast"
        echo -e "${CYAN}[i]${NC} Stop:   ./stop.sh   or   pm2 stop endlesscast"
    else
        echo ""
        echo -e "${RED}[✗]${NC} Process started but status is '${STATUS}' — it may be crash-looping."
        echo -e "${CYAN}[i]${NC} Check logs:"
        echo -e "        pm2 logs endlesscast --lines 30"
        echo ""
        echo -e "${CYAN}[i]${NC} Last 30 lines from pm2 error log:"
        pm2 logs endlesscast --lines 30 --nostream 2>/dev/null || true
    fi
    exit 0
fi

# ── nohup fallback ────────────────────────────────────────────────────────────
echo -e "${CYAN}[>]${NC} Using nohup (background mode)..."

PID_FILE="$SCRIPT_DIR/endlesscast.pid"
LOG_FILE="$SCRIPT_DIR/endlesscast.log"

if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo -e "${YELLOW}[!]${NC} Already running (PID $OLD_PID). Stop it first with ./stop.sh"
        exit 1
    fi
    rm -f "$PID_FILE"
fi

nohup node "$SCRIPT_DIR/dist/index.cjs" > "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

sleep 3
if kill -0 "$NEW_PID" 2>/dev/null; then
    echo ""
    echo -e "${GREEN}[✓]${NC} EndlessCast running in background (PID $NEW_PID)"
    echo -e "${GREEN}[✓]${NC} Access: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'your-ip'):${PORT}"
    echo -e "${CYAN}[i]${NC} Logs:   tail -f $LOG_FILE"
    echo -e "${CYAN}[i]${NC} Stop:   ./stop.sh"
else
    echo -e "${RED}[✗]${NC} Process crashed immediately. Error log:"
    tail -30 "$LOG_FILE" 2>/dev/null
    rm -f "$PID_FILE"
    exit 1
fi
