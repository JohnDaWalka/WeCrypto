@echo off
REM WECRYPTO Full Rebuild Script
REM Run this after system restart to build .exe with patches
REM
REM Usage: Run-with-admin.bat AFTER restarting Windows

setlocal enabledelayedexpansion

echo.
echo ╔════════════════════════════════════════════════════════════════╗
echo ║  WE-CRYPTO REBUILD SCRIPT v2.15.5 (PATCHES ENABLED)           ║
echo ║  Run AFTER system restart to generate fresh .exe              ║
echo ╚════════════════════════════════════════════════════════════════╝
echo.

REM Check admin rights
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Must run as Administrator
    echo Right-click this file and select "Run as administrator"
    pause
    exit /b 1
)

cd /d %~dp0

echo [1/5] Killing all WE-CRYPTO and Electron processes...
taskkill /F /IM electron.exe /T >nul 2>&1
taskkill /F /IM we-crypto-proxy.exe /T >nul 2>&1
taskkill /F /IM app-builder.exe /T >nul 2>&1
timeout /t 3 /nobreak

echo [2/5] Clearing npm cache...
call npm cache clean --force
timeout /t 2 /nobreak

echo [3/5] Removing node_modules and lock files...
rmdir /s /q node_modules >nul 2>&1
del package-lock.json >nul 2>&1
del dist >nul 2>&1

echo [4/5] Installing fresh dependencies...
call npm install --verbose

if %errorlevel% neq 0 (
    echo ERROR: npm install failed. Check output above.
    pause
    exit /b 1
)

echo.
echo [5/5] Building portable .exe with patches...
call npm run build:portable

if %errorlevel% equ 0 (
    echo.
    echo ╔════════════════════════════════════════════════════════════════╗
    echo ║  ✓ BUILD SUCCESSFUL                                           ║
    echo ║                                                                ║
    echo ║  Executable created with patches:                            ║
    echo ║  • Confidence floor: 70%% (blocks low-quality signals)        ║
    echo ║  • Close-window guard: Skip final 45s of 15m candle          ║
    echo ║                                                                ║
    echo ║  Ready to trade safely. Run RUN-WITH-PATCHES.bat             ║
    echo ╚════════════════════════════════════════════════════════════════╝
    echo.
) else (
    echo.
    echo ✗ Build failed. Check error output above.
    echo.
)

pause
