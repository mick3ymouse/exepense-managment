import subprocess
import time
import urllib.request
import os
import sys
import signal
import webbrowser

def wait_for_server():
    """Aspetta che Uvicorn risponda sulla porta 8000"""
    max_retries = 15
    for _ in range(max_retries):
        try:
            req = urllib.request.Request("http://127.0.0.1:8000")
            with urllib.request.urlopen(req, timeout=1):
                return True
        except Exception:
            time.sleep(1)
    return False

def open_in_edge(url):
    """Tenta di aprire l'URL in una nuova scheda di Microsoft Edge; se fallisce o Edge non è disponibile, passa al browser predefinito."""
    opened = False
    
    if sys.platform == 'darwin':
        # macOS: usa AppleScript per attivare Edge e aprire una nuova scheda (new tab)
        applescript = f'''
        tell application "Microsoft Edge"
            if running then
                try
                    tell front window to make new tab with properties {{URL:"{url}"}}
                on error
                    make new window with properties {{URL:"{url}"}}
                end try
                activate
            else
                activate
                delay 1
                open location "{url}"
            end if
        end tell
        '''
        try:
            p = subprocess.Popen(["osascript", "-e", applescript], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            p.wait(timeout=5)
            if p.returncode == 0:
                opened = True
        except Exception:
            pass

        # Fallback 1 macOS: comando 'open -a "Microsoft Edge"'
        if not opened:
            try:
                p = subprocess.Popen(["open", "-a", "Microsoft Edge", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                p.wait(timeout=3)
                if p.returncode == 0:
                    opened = True
            except Exception:
                pass

        # Fallback 2 macOS: esegui direttamente l'eseguibile di Edge
        if not opened:
            edge_mac_bin = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
            if os.path.exists(edge_mac_bin):
                try:
                    subprocess.Popen([edge_mac_bin, url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    opened = True
                except Exception:
                    pass

    elif os.name == 'nt':
        # Windows: cerca l'eseguibile msedge nei percorsi standard
        edge_paths = [
            os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
            os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
            os.path.expandvars(r"%LocalAppData%\Microsoft\Edge\Application\msedge.exe"),
        ]
        for ep in edge_paths:
            if os.path.exists(ep):
                try:
                    subprocess.Popen([ep, url])
                    opened = True
                    break
                except Exception:
                    pass
        if not opened:
            try:
                subprocess.Popen(["cmd", "/c", "start", "msedge", url], shell=True)
                opened = True
            except Exception:
                pass

    else:
        # Linux
        try:
            subprocess.Popen(["microsoft-edge", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            opened = True
        except Exception:
            pass

    # Fallback al browser predefinito di sistema
    if not opened:
        try:
            webbrowser.open(url)
        except Exception:
            pass

def main():
    if os.name == 'posix':
        # MacOS / Linux: fork per far uscire subito il parent (così il terminale si chiude)
        try:
            if os.fork() > 0:
                sys.exit()  # Parent esce → start_app.command prosegue e chiude il Terminale
        except AttributeError:
            pass

        # Il child si sgancia completamente dalla sessione terminale
        os.setsid()
        signal.signal(signal.SIGHUP, signal.SIG_IGN)

        subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", "8000"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True
        )
    else:
        # Windows: sgancia dal cmd e nascondi la finestra (DETACHED_PROCESS | CREATE_NO_WINDOW)
        subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", "8000"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=0x08000008
        )

    if wait_for_server():
        open_in_edge('http://127.0.0.1:8000?fresh=true')

if __name__ == "__main__":
    main()

