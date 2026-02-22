@echo off
REM =====================================================
REM Windows Launcher for Expense Management Web App
REM Pensato per essere lanciato da start_app.vbs (nascosto)
REM =====================================================

REM Spostarsi nella directory dello script
cd /d "%~dp0"

REM Controllare se esiste l'ambiente virtuale
if not exist ".venv" (
    python -m venv .venv
    if errorlevel 1 exit /b 1
)

REM Attivare l'ambiente virtuale
call .venv\Scripts\activate
if errorlevel 1 exit /b 1

REM Installare le dipendenze
pip install -q -r requirements.txt >nul 2>&1
if errorlevel 1 exit /b 1

REM Controllare se la porta 8000 e' gia' occupata e liberarla
set PORT_PID=
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8000 ^| findstr LISTENING') do set PORT_PID=%%a
if defined PORT_PID (
    taskkill /F /PID %PORT_PID% >nul 2>&1
    timeout /t 1 /nobreak >nul
)

REM Avviare il server invocando il launcher python invisibile in background
start "" pythonw backend\background_launcher.py
exit
