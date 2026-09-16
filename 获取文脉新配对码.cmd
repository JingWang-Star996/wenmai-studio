@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\new-wenmai-pairing.ps1"
set "WENMAI_PAIRING_EXIT=%ERRORLEVEL%"
if not "%WENMAI_PAIRING_EXIT%"=="0" echo Pairing-code helper exited with code %WENMAI_PAIRING_EXIT%.
pause
exit /b %WENMAI_PAIRING_EXIT%
