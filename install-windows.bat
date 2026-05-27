@echo off
setlocal EnableExtensions EnableDelayedExpansion

title AlphaKiller 0.1 beta 1 Windows Installer

set "APP_NAME=AlphaKiller"
set "APP_VERSION=0.1.0-beta.1"
set "TARGET_ARCH=ia32"

if /I "%PROCESSOR_ARCHITECTURE%"=="AMD64" set "TARGET_ARCH=x64"
if /I "%PROCESSOR_ARCHITEW6432%"=="AMD64" set "TARGET_ARCH=x64"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "TARGET_ARCH=x64"

echo.
echo AlphaKiller 0.1 beta 1 Windows installer
echo ======================================
echo Target architecture: %TARGET_ARCH%
echo.

cd /d "%~dp0"

if not exist "package.json" (
  echo ERROR: package.json was not found.
  echo Run this batch file from the AlphaKiller project folder.
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js LTS is required to build AlphaKiller.
  echo.
  where winget >nul 2>nul
  if errorlevel 1 (
    echo winget was not found. Install Node.js LTS from:
    echo https://nodejs.org/
    echo.
    pause
    exit /b 1
  )

  choice /M "Install Node.js LTS with winget now"
  if errorlevel 2 (
    echo Installation cancelled.
    pause
    exit /b 1
  )

  winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo ERROR: Node.js installation failed.
    pause
    exit /b 1
  )

  set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;%PATH%"
)

where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm was not found. Restart this terminal after installing Node.js and try again.
  pause
  exit /b 1
)

echo.
echo Node version:
node --version
echo npm version:
npm --version
echo.

if exist "package-lock.json" (
  echo Installing exact dependencies with npm ci...
  call npm ci
) else (
  echo Installing dependencies with npm install...
  call npm install
)
if errorlevel 1 (
  echo ERROR: Dependency installation failed.
  pause
  exit /b 1
)

echo.
echo Building AlphaKiller for Windows...
call npm run dist:win
if errorlevel 1 (
  echo ERROR: Windows build failed.
  pause
  exit /b 1
)

set "INSTALLER_EXE=release\AlphaKiller-Setup-%APP_VERSION%-%TARGET_ARCH%.exe"

if not exist "%INSTALLER_EXE%" (
  echo ERROR: Could not find the %TARGET_ARCH% Windows installer:
  echo %INSTALLER_EXE%
  echo.
  echo Files found in release:
  dir /b "release\AlphaKiller-*.exe" 2>nul
  pause
  exit /b 1
)

echo.
echo Launching the AlphaKiller installer:
echo %INSTALLER_EXE%
echo.
echo This creates a normal Windows app install with Start Menu and Desktop
echo shortcuts. It should launch much faster than the old portable EXE,
echo which had to unpack itself on every run.
echo.

start "" /wait "%INSTALLER_EXE%"
if errorlevel 1 (
  echo ERROR: AlphaKiller installer exited with an error.
  pause
  exit /b 1
)

echo.
echo AlphaKiller installer finished.
pause
exit /b 0
