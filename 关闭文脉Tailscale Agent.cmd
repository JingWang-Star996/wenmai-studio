@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\disable-wenmai-tailscale-agent.ps1"
set "WENMAI_TAILSCALE_EXIT=%ERRORLEVEL%"
if not "%WENMAI_TAILSCALE_EXIT%"=="0" echo Disable helper exited with code %WENMAI_TAILSCALE_EXIT%. Try Run as administrator.
pause
exit /b %WENMAI_TAILSCALE_EXIT%
