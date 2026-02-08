#!/bin/bash
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv .venv
    source .venv/bin/activate
    echo "Installing requirements..."
    if [ -f "requirements.txt" ]; then
        pip install -r requirements.txt
    else
        pip install flet
    fi
else
    source .venv/bin/activate
fi

# Run the application
echo "Starting Expense Management App (FastAPI)..."
pip install -r requirements.txt
python -m uvicorn backend.main:app --reload --port 8000
