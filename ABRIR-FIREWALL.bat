@echo off
rem Abre en el Firewall de Windows los puertos que usan tus companeros para conectarse.
rem Necesita permisos de administrador (se piden automaticamente).
net session >nul 2>&1
if errorlevel 1 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\firewall.ps1"
pause
