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
echo "Starting Expense Management App (Streamlit)..."
pip install -r requirements.txt
streamlit run app.py --browser.gatherUsageStats false --theme.base "light"
