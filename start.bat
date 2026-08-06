@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo === PDF Annotator: start ===

rem --- MongoDB must be running before the server will boot ---
sc query MongoDB >nul 2>&1
if errorlevel 1060 (
    echo MongoDB service is not installed. Install MongoDB Community first.
    pause
    exit /b 1
)

sc query MongoDB | find "RUNNING" >nul
if errorlevel 1 (
    echo MongoDB is stopped. Requesting admin approval to start it...
    powershell -NoProfile -Command "Start-Process cmd -ArgumentList '/c net start MongoDB' -Verb RunAs -Wait"
)

set tries=0
:waitmongo
sc query MongoDB | find "RUNNING" >nul
if not errorlevel 1 goto mongoready
set /a tries+=1
if !tries! GEQ 20 (
    echo MongoDB did not start. Open Services, start it by hand, then run this again.
    pause
    exit /b 1
)
timeout /t 1 >nul
goto waitmongo
:mongoready
echo MongoDB is running.

rem --- clear anything left over from a previous run on our two ports ---
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 5173,5174 -State Listen -ErrorAction SilentlyContinue | Select-Object -Expand OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"

rem --- launch server + client in their own window, so logs stay visible ---
powershell -NoProfile -Command "Start-Process cmd -ArgumentList '/k','npm run dev' -WorkingDirectory '%~dp0'"

echo Waiting for the app to come up...
set tries=0
:waitapi
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri http://127.0.0.1:5174/api/health -UseBasicParsing -TimeoutSec 2 | Out-Null } catch { exit 1 }"
if not errorlevel 1 goto apiready
set /a tries+=1
if !tries! GEQ 30 (
    echo The server did not come up. Check the "PDF Annotator" window for the error.
    pause
    exit /b 1
)
timeout /t 1 >nul
goto waitapi
:apiready

powershell -NoProfile -Command "Start-Process 'http://localhost:5173/'"
echo Done. The app is open in your browser.
endlocal
