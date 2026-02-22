#!/bin/bash
# =====================================================
# macOS Launcher for Expense Management Web App
# =====================================================

cd "$(dirname "$0")"

# ── Libera porta 8000 se occupata (opzionale, per pulizia) ───────
PORT_PID=$(lsof -ti:8000 2>/dev/null)
if [ ! -z "$PORT_PID" ]; then
    kill -9 $PORT_PID 2>/dev/null
    sleep 1
fi

# ── Crea venv se non esiste ──────────────────────────────────────
if [ ! -d ".venv" ]; then
    python3 -m venv .venv
fi
source .venv/bin/activate
pip install -q -r requirements.txt

# ── Avvia il lanciatore Python in Background ─────────────────────
# Python stesso farà il daemonize e si sgancerà dal terminale
python3 backend/background_launcher.py

# ── Chiudi il Terminale immediatamente ───────────────────────────
osascript -e 'tell application "Terminal" to close front window' &
exit 0
