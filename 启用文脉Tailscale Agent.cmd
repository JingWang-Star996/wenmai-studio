@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

rem Tailscale's local API is protected by UAC. Open a visible elevated window
rem rather than silently calling the helper without administrator rights.
net session >nul 2>&1
if not "%ERRORLEVEL%"=="0" (
  echo Requesting administrator permission for Tailscale Serve...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$script = Join-Path $args[0] 'scripts\enable-wenmai-tailscale-agent.ps1'; Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-File',$script)" "%~dp0"
  if not "%ERRORLEVEL%"=="0" (
    echo Could not open the administrator window. Accept the UAC prompt and try again.
  ) else (
    echo An administrator window is open. Read its result, then close it when finished.
  )
  pause
  exit /b
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\enable-wenmai-tailscale-agent.ps1"
set "WENMAI_TAILSCALE_EXIT=%ERRORLEVEL%"
if not "%WENMAI_TAILSCALE_EXIT%"=="0" echo Enable helper exited with code %WENMAI_TAILSCALE_EXIT%. See the error above for the exact cause.
pause
exit /b %WENMAI_TAILSCALE_EXIT%
