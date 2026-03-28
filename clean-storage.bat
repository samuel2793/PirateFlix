@echo off
chcp 65001 >nul 2>&1
title PirateFlix - Limpiar Almacenamiento
color 0E

echo.
echo   ╔══════════════════════════════════════════════╗
echo   ║                                              ║
echo   ║     🏴‍☠️  PirateFlix - Limpiar Storage  🧹     ║
echo   ║                                              ║
echo   ╚══════════════════════════════════════════════╝
echo.

:: Calcular tamaños usando PowerShell
set "wt_size=0 bytes"
set "wt_files=0"
set "tc_size=0 bytes"
set "tc_files=0"

set "TEMP_FILE=%TEMP%\pf_sizes.txt"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0clean-storage-calc.ps1" -BaseDir "%~dp0" -OutFile "%TEMP_FILE%" 2>nul

if exist "%TEMP_FILE%" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%TEMP_FILE%") do (
        if "%%a"=="WT_SIZE" set "wt_size=%%b"
        if "%%a"=="WT_FILES" set "wt_files=%%b"
        if "%%a"=="TC_SIZE" set "tc_size=%%b"
        if "%%a"=="TC_FILES" set "tc_files=%%b"
    )
    del "%TEMP_FILE%" 2>nul
)

echo   ┌──────────────────────────────────────────────┐
echo   │  📁  Almacenamiento actual                   │
echo   ├──────────────────────────────────────────────┤
echo   │                                              │
echo   │  🎬  Torrents (webtorrent)                   │
echo   │      Tamaño:   %wt_size%
echo   │      Archivos: %wt_files%
echo   │                                              │
echo   │  🔄  Cache transcodificado                   │
echo   │      Tamaño:   %tc_size%
echo   │      Archivos: %tc_files%
echo   │                                              │
echo   └──────────────────────────────────────────────┘
echo.
echo   ⚠️  Esto eliminará TODO el contenido descargado.
echo.

set /p confirm=  ¿Continuar? (S/N): 
if /i not "%confirm%"=="S" (
    echo.
    echo   ❌  Operación cancelada.
    echo.
    pause
    exit /b
)

echo.
echo   🗑️  Eliminando torrents descargados...
rd /s /q "%~dp0server\storage\webtorrent" 2>nul
if not exist "%~dp0server\storage\webtorrent" mkdir "%~dp0server\storage\webtorrent"
echo   ✅  webtorrent limpiado

echo   🗑️  Eliminando cache transcodificado...
rd /s /q "%~dp0server\storage\transcoded" 2>nul
if not exist "%~dp0server\storage\transcoded" mkdir "%~dp0server\storage\transcoded"
echo   ✅  transcoded limpiado

echo.
echo   ╔══════════════════════════════════════════════╗
echo   ║                                              ║
echo   ║     ✅  Limpieza completada con éxito!  ✅   ║
echo   ║                                              ║
echo   ╚══════════════════════════════════════════════╝
echo.
pause
