' Build and launch hidden, then open the browser.
Option Explicit
Dim sh, fso, base, result
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
result = sh.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & base & "\tools\launch.ps1""", 0, True)
If result <> 0 Then
  MsgBox "Agent Atrium did not start. See " & base & "\data\launcher-error.log", vbExclamation, "Agent Atrium"
End If
