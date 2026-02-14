#!/bin/bash
# =====================================================
# macOS Launcher for Expense Management Web App
# =====================================================

# Nasconde la finestra del terminale
osascript -e 'tell application "Terminal" to set visible of front window to false' 2>/dev/null

# Spostarsi nella directory dello script
cd "$(dirname "$0")"

echo "========================================"
echo "  Expense Management App - Launcher"
echo "========================================"
echo ""

# Controllare se esiste l'ambiente virtuale
if [ ! -d ".venv" ]; then
    echo "[1/4] Creazione ambiente virtuale..."
    python3 -m venv .venv
    if [ $? -ne 0 ]; then
        echo "ERRORE: Impossibile creare l'ambiente virtuale."
        echo "Verifica che Python 3 sia installato correttamente."
        read -p "Premi INVIO per chiudere..."
        exit 1
    fi
else
    echo "[1/4] Ambiente virtuale trovato."
fi

# Attivare l'ambiente virtuale
echo "[2/4] Attivazione ambiente virtuale..."
source .venv/bin/activate
if [ $? -ne 0 ]; then
    echo "ERRORE: Impossibile attivare l'ambiente virtuale."
    read -p "Premi INVIO per chiudere..."
    exit 1
fi

# Installare le dipendenze
echo "[3/4] Verifica e installazione dipendenze..."
pip install -r requirements.txt
if [ $? -ne 0 ]; then
    echo "ERRORE: Installazione dipendenze fallita."
    read -p "Premi INVIO per chiudere..."
    exit 1
fi

# Aprire Microsoft Edge in background (senza bloccare)
echo "[4/4] Apertura browser tra 2 secondi..."
# Timestamp per forzare il refresh della cache
TIMESTAMP=$(date +%s)
(sleep 2 && open -a "Microsoft Edge" "http://127.0.0.1:8000?v=$TIMESTAMP") &

# Controllare se la porta 8000 è già occupata
echo ""
echo "Controllo porta 8000..."
PORT_PID=$(lsof -ti:8000 2>/dev/null)
if [ ! -z "$PORT_PID" ]; then
    echo "⚠️  Porta 8000 già in uso (PID: $PORT_PID)"
    echo "Chiusura processo esistente..."
    kill -9 $PORT_PID 2>/dev/null
    sleep 1
    echo "✓ Porta liberata"
fi

# Avviare il server FastAPI
echo ""
echo "========================================"
echo "  Server in avvio su porta 8000"
echo "  Premi CTRL+C per terminare"
echo "========================================"
echo ""
python3 -m uvicorn backend.main:app --reload --port 8000

# Messaggio finale in caso di arresto
echo ""
echo "Il server si è arrestato."
read -p "Premi INVIO per chiudere..."
