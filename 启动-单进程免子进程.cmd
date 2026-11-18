@echo off
rem ============================================================
rem  DSH Whale Desktop - single-process launcher
rem  Use this when a security suite (360 / Huorong / Lenovo PC
rem  Manager) blocks the Electron renderer child process.
rem  This mode creates NO child process at all.
rem ============================================================
setlocal
set "EXE=%~dp0DSH Whale Desktop.exe"
if not exist "%EXE%" set "EXE=%~dp0dist\win-unpacked\DSH Whale Desktop.exe"
if not exist "%EXE%" (
  echo [ERROR] DSH Whale Desktop.exe not found next to this script.
  echo Put this .cmd in the same folder as the .exe and run it again.
  pause
  exit /b 1
)
echo Starting in SINGLE-PROCESS mode ^(no child processes^):
echo   %EXE%
start "" "%EXE%" --single-process --no-sandbox --disable-gpu --in-process-gpu
endlocal
