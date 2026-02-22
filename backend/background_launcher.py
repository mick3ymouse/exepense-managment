import subprocess
import time
import urllib.request
import os
import sys
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
def main():
    if os.name == 'posix':
        # MacOS / Linux: daemonize base e sgancio dal terminale
        try:
            if os.fork() > 0:
                sys.exit()
        except AttributeError:
            pass # Fallback di sicurezza
            
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
        # Usa il modulo webbrowser di Python per aprire il browser
        try:
            if os.name == 'posix':
                browser = webbrowser.get('macosx')
                browser.open('http://127.0.0.1:8000?fresh=true')
            else:
                webbrowser.open('http://127.0.0.1:8000?fresh=true')
        except Exception:
            # Fallback generico
            webbrowser.open('http://127.0.0.1:8000?fresh=true')

if __name__ == "__main__":
    main()
