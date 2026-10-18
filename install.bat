@echo off
setlocal enabledelayedexpansion

REM Colors aren't supported in older cmd, so we'll use simple formatting
if "%1"=="" (
    echo.
    echo Error: Missing required parameter: IP address
    echo.
    echo Usage: install.bat ^<IP_ADDRESS^> [PORT]
    echo.
    echo Examples:
    echo   install.bat 10.0.0.5
    echo   install.bat 10.0.0.5 3000
    echo.
    exit /b 1
)

set TARGET_IP=%1
set REQUESTED_PORT=%2
if "!REQUESTED_PORT!"=="" set REQUESTED_PORT=8080

echo.
echo [*] Starting Modbus Scanner installation...
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [x] Node.js is not installed!
    echo.
    echo Please download and install Node.js from: https://nodejs.org/
    echo (Requires Node.js 16 or newer)
    echo.
    exit /b 1
)

for /f "tokens=*" %%i in ('node -v') do set NODE_VERSION=%%i
echo [+] Node.js detected: %NODE_VERSION%
echo.

REM Check if we need to clone
if not exist "package.json" (
    echo [*] Cloning Modbus Scanner repository...
    call git clone https://github.com/fishbeef/modbusscanner.git
    if %errorlevel% neq 0 (
        echo [x] Failed to clone repository. Make sure git is installed.
        exit /b 1
    )
    cd modbusscanner
    echo [+] Repository cloned
) else (
    echo [+] Already in project directory
)

echo.
echo [*] Installing dependencies (this may take a minute)...
call npm install
if %errorlevel% neq 0 (
    echo [x] Failed to install dependencies
    exit /b 1
)
echo [+] Dependencies installed
echo.

REM Check if port is in use
echo [*] Checking port availability...
set PORT=!REQUESTED_PORT!
set FOUND_PORT=0
set MAX_ATTEMPTS=10
set ATTEMPTS=0

:check_port_loop
if %ATTEMPTS% geq %MAX_ATTEMPTS% goto port_search_failed

REM Try to check if port is in use with netstat
netstat -ano 2>nul | findstr ":!PORT! " >nul 2>&1
if errorlevel 1 (
    set FOUND_PORT=1
    echo [+] Port !PORT! is available
    goto port_found
) else (
    echo [!] Port !PORT! is already in use, trying next port...
    set /a PORT=!PORT! + 1
    set /a ATTEMPTS=!ATTEMPTS! + 1
    goto check_port_loop
)

:port_search_failed
echo [x] Could not find an available port between %REQUESTED_PORT% and %PORT%
echo.
echo Please manually specify a different port:
echo   install.bat %TARGET_IP% ^<PORT^>
echo.
echo Or stop the process using port %REQUESTED_PORT% and try again.
exit /b 1

:port_found
echo.
echo [+] Installation complete!
echo.
echo ================================================================
echo.
echo [*] Starting Modbus Scanner...
echo [*] Target Modbus device: %TARGET_IP%:502
echo [*] Web server port: !PORT!
echo.
echo ================================================================
echo.
echo [+] Server running!
echo.
echo Open your browser and go to:
echo.
echo    http://localhost:!PORT!
echo.
echo Enter %TARGET_IP% as the Modbus device IP address
echo.
echo Press Ctrl+C to stop the server
echo.
echo ================================================================
echo.

set PORT=!PORT!
call npm start
