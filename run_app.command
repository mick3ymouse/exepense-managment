#!/bin/bash

# Spostarsi nella directory dello script
cd "$(dirname "$0")"

# Nasconde la finestra del terminale
osascript -e 'tell application "Terminal" to set visible of front window to false'

# Crea l'ambiente virtuale se non esiste
if [ ! -d ".venv" ]; then
    echo "Creazione ambiente virtuale..."
    python3 -m venv .venv
fi

# Attiva l'ambiente virtuale
source .venv/bin/activate

# Installa i requisiti (silenziosamente)
if [ -f "requirements.txt" ]; then
    echo "Verifica requisiti..."
    pip install -r requirements.txt > /dev/null 2>&1
fi

# Funzione per avviare il browser in background
# Usiamo sleep per dare tempo al server di avviarsi, altrimenti il browser
# proverà a connettersi prima che il sito sia pronto.
(sleep 2 && open -a "Microsoft Edge" "http://127.0.0.1:8000") &

# Avvia il server (Uvicorn)
# Questo comando "blocca" lo script finché non chiudi l'app.
# Se mettessimo l'apertura del browser DOPO questo comando, non verrebbe mai eseguita.
python -m uvicorn backend.main:app --reload --port 8000