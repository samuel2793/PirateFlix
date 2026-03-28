@echo off
chcp 65001 >nul 2>&1
title PirateFlix - Server + Frontend
color 0B

echo.
echo   ╔══════════════════════════════════════════════╗
echo   ║                                              ║
echo   ║       🏴‍☠️  PirateFlix  -  Launcher  🚀       ║
echo   ║                                              ║
echo   ╚══════════════════════════════════════════════╝
echo.
echo   ┌──────────────────────────────────────────────┐
echo   │  🖥️  Iniciando Backend (Node.js)...           │
echo   └──────────────────────────────────────────────┘
echo.

cd /d "%~dp0server"
start /b npm start

timeout /t 2 /nobreak >nul

echo.
echo   ┌──────────────────────────────────────────────┐
echo   │  🌐  Iniciando Frontend (Angular)...          │
echo   └──────────────────────────────────────────────┘
echo.
echo   ╔══════════════════════════════════════════════╗
echo   ║                                              ║
echo   ║   🖥️  Server  →  http://localhost:3000        ║
echo   ║   🌐  Frontend →  http://localhost:4200        ║
echo   ║                                              ║
echo   ╚══════════════════════════════════════════════╝
echo.

cd /d "%~dp0"
npm start -- --host 0.0.0.0 --port 4200

