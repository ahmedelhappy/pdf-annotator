@echo off
setlocal enabledelayedexpansion
echo === PDF Annotator: stop ===

rem --- kill whatever owns the ports, then sweep any leftover node children
rem     (npm/concurrently/nodemon/vite) that outlive their listening socket ---
powershell -NoProfile -Command "$procs = Get-NetTCPConnection -LocalPort 5173,5174 -State Listen -ErrorAction SilentlyContinue | Select-Object -Expand OwningProcess -Unique; if ($procs) { $procs | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }; $orphans = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*pdf-annotator*' -or $_.CommandLine -like '*concurrently*' -or $_.CommandLine -like '*nodemon*' }; if ($orphans) { $orphans | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }; if ($procs -or $orphans) { Write-Output 'Stopped the app.' } else { Write-Output 'App was not running.' }"

rem --- stop MongoDB too, so nothing is left using RAM or CPU ---
sc query MongoDB >nul 2>&1
if errorlevel 1060 (
    echo MongoDB service is not installed, nothing to stop there.
    goto done
)

sc query MongoDB | find "RUNNING" >nul
if errorlevel 1 (
    echo MongoDB was already stopped.
    goto done
)

echo Stopping MongoDB, admin approval needed...
powershell -NoProfile -Command "Start-Process cmd -ArgumentList '/c net stop MongoDB' -Verb RunAs -Wait"

set tries=0
:waitstop
sc query MongoDB | find "RUNNING" >nul
if errorlevel 1 goto stopped
set /a tries+=1
if !tries! GEQ 15 (
    echo MongoDB would not stop. Check Services and stop it by hand if you want it off.
    goto done
)
timeout /t 1 >nul
goto waitstop
:stopped
echo MongoDB is stopped.

:done
endlocal
pause
