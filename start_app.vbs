' =====================================================
' Expense Management App - Launcher (effetto "app")
' Nessuna finestra visibile: avvia il server in background,
' aspetta che sia pronto, poi apre Edge.
' =====================================================
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Ricava la cartella dove si trova questo .vbs
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = scriptDir

' Lancia il .bat completamente nascosto (0 = hidden, False = asincrono)
WshShell.Run "cmd /c """ & scriptDir & "\start_app.bat""", 0, False

' Aspetta che il server sia pronto (polling porta 8000, max ~30 secondi)
Dim ready
ready = False
For i = 1 To 15
    WScript.Sleep 2000
    ' Controlla se la porta 8000 e' in ascolto
    Set exec = WshShell.Exec("cmd /c netstat -aon | findstr :8000 | findstr LISTENING")
    output = exec.StdOut.ReadAll
    If Len(Trim(output)) > 0 Then
        ready = True
        Exit For
    End If
Next

If ready Then
    ' Server pronto: apri Edge
    Randomize
    ts = Int(Rnd * 99999)
    WshShell.Run "msedge http://127.0.0.1:8000?v=" & ts, 1, False
Else
    ' Timeout: mostra errore
    MsgBox "Il server non si e' avviato entro 30 secondi." & vbCrLf & _
           "Prova a lanciare start_app.bat manualmente per vedere gli errori.", _
           vbExclamation, "Expense Management App"
End If
