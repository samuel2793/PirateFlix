@echo off
chcp 65001 >nul 2>&1
title 🖥️ PirateFlix - Server
color 0A

echo.
echo   ╔══════════════════════════════════════════════╗
echo   ║                                              ║
echo   ║       🏴‍☠️  PirateFlix  -  Server  🖥️          ║
echo   ║                                              ║
echo   ╚══════════════════════════════════════════════╝
echo.
echo   ┌──────────────────────────────────────────────┐
echo   │  📡  Iniciando servidor Node.js...            │
echo   │  🔗  http://localhost:3000                    │
echo   └──────────────────────────────────────────────┘
echo.

cd /d "%~dp0server"
npm start
