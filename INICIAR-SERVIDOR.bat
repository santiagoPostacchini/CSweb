@echo off
setlocal
cd /d "%~dp0"
title Counter-Strike 1.6 - Servidor LAN

where node >nul 2>nul
if errorlevel 1 (
    echo No se encontro Node.js. Instalalo desde https://nodejs.org ^(version 20 o superior^) y volve a ejecutar este archivo.
    pause
    exit /b 1
)

if not exist node_modules (
    echo Instalando dependencias ^(solo la primera vez^)...
    call npm install
    if errorlevel 1 goto :error
)

rem Prepara/actualiza el servidor y el paquete de archivos (rapido si ya esta todo listo)
node scripts\setup.mjs
if errorlevel 1 goto :error

node server\index.mjs %*
pause
exit /b 0

:error
echo.
echo Algo fallo. Revisa los mensajes de arriba.
pause
exit /b 1
