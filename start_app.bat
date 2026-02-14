@echo off
REM =====================================================
REM Windows Launcher for Expense Management Web App
REM =====================================================

REM Spostarsi nella directory dello script
cd /d "%~dp0"

echo ========================================
echo   Expense Management App - Launcher
echo ========================================
echo.

REM Controllare se esiste l'ambiente virtuale
if not exist ".venv" (
    echo [1/4] Creazione ambiente virtuale...
    python -m venv .venv
    if errorlevel 1 (
        echo ERRORE: Impossibile creare l'ambiente virtuale.
        echo Verifica che Python sia installato correttamente.
        pause
        exit /b 1
    )
) else (
    echo [1/4] Ambiente virtuale trovato.
)

REM Attivare l'ambiente virtuale
echo [2/4] Attivazione ambiente virtuale...
call .venv\Scripts\activate
if errorlevel 1 (
    echo ERRORE: Impossibile attivare l'ambiente virtuale.
    pause
    exit /b 1
)

REM Installare le dipendenze
echo [3/4] Verifica e installazione dipendenze...
pip install -r requirements.txt
if errorlevel 1 (
    echo ERRORE: Installazione dipendenze fallita.
    pause
    exit /b 1
)

REM Aprire Microsoft Edge in background (senza bloccare)
echo [4/4] Apertura browser tra 2 secondi...
REM Timestamp per forzare il refresh della cache
set TIMESTAMP=%RANDOM%
start "" msedge "http://127.0.0.1:8000?v=%TIMESTAMP%"

REM Controllare se la porta 8000 è già occupata
echo.
echo Controllo porta 8000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8000 ^| findstr LISTENING') do set PORT_PID=%%a
if defined PORT_PID (
    echo %ESC%[33m!  Porta 8000 già in uso (PID: %PORT_PID%)%ESC%[0m
    echo Chiusura processo esistente...
    taskkill /F /PID %PORT_PID% >nul 2>&1
    timeout /t 1 /nobreak >nul
    echo OK Porta liberata
)

REM Avviare il server FastAPI
echo.
echo ========================================
echo   Server in avvio su porta 8000
echo   Premi CTRL+C per terminare
echo ========================================
echo.
python -m uvicorn backend.main:app --reload --port 8000

REM Pause finale in caso di crash
echo.
echo Il server si è arrestato.
pause
