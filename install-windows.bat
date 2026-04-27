@echo off
setlocal EnableExtensions EnableDelayedExpansion

title AlphaKiller 0.1 beta Windows Installer

set "APP_NAME=AlphaKiller"
set "INSTALL_DIR=%LOCALAPPDATA%\Programs\AlphaKiller"
set "INSTALL_EXE=%INSTALL_DIR%\AlphaKiller.exe"
set "START_MENU_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\AlphaKiller"
set "DESKTOP_SHORTCUT=%USERPROFILE%\Desktop\AlphaKiller.lnk"
set "START_SHORTCUT=%START_MENU_DIR%\AlphaKiller.lnk"

echo.
echo AlphaKiller 0.1 beta Windows installer
echo ======================================
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

set "BUILT_EXE="
for /f "delims=" %%F in ('dir /b /a:-d /o:-d "release\AlphaKiller-*.exe" 2^>nul') do (
  set "BUILT_EXE=release\%%F"
  goto :found_exe
)

:found_exe
if not defined BUILT_EXE (
  echo ERROR: Could not find release\AlphaKiller-*.exe after the build.
  pause
  exit /b 1
)

echo.
echo Installing to:
echo %INSTALL_DIR%
echo.

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
if errorlevel 1 (
  echo ERROR: Could not create the install folder.
  pause
  exit /b 1
)

copy /Y "%BUILT_EXE%" "%INSTALL_EXE%" >nul
if errorlevel 1 (
  echo ERROR: Could not copy AlphaKiller.exe into the install folder.
  pause
  exit /b 1
)

if not exist "%START_MENU_DIR%" mkdir "%START_MENU_DIR%"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $shell=New-Object -ComObject WScript.Shell; $shortcut=$shell.CreateShortcut('%DESKTOP_SHORTCUT%'); $shortcut.TargetPath='%INSTALL_EXE%'; $shortcut.WorkingDirectory='%INSTALL_DIR%'; $shortcut.IconLocation='%INSTALL_EXE%,0'; $shortcut.Save(); $shortcut=$shell.CreateShortcut('%START_SHORTCUT%'); $shortcut.TargetPath='%INSTALL_EXE%'; $shortcut.WorkingDirectory='%INSTALL_DIR%'; $shortcut.IconLocation='%INSTALL_EXE%,0'; $shortcut.Save()"
if errorlevel 1 (
  echo WARNING: AlphaKiller was installed, but shortcut creation failed.
  echo You can run it directly from:
  echo %INSTALL_EXE%
) else (
  echo Shortcuts created on the Desktop and Start Menu.
)

echo.
echo AlphaKiller was installed successfully.
echo Installed executable:
echo %INSTALL_EXE%
echo.
choice /M "Launch AlphaKiller now"
if errorlevel 2 (
  echo Done.
  exit /b 0
)

start "" "%INSTALL_EXE%"
exit /b 0
