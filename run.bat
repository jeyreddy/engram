@echo off
cd C:\engram

:: Load environment variables
for /f "tokens=1,2 delims==" %%a in (.env) do set %%a=%%b

:: Kill existing processes
taskkill /F /IM electron.exe /T >nul 2>&1
taskkill /F /IM node.exe /T >nul 2>&1
timeout /t 2 >nul

:: Start Ollama if not running
tasklist /FI "IMAGENAME eq ollama.exe" | find "ollama.exe" >nul
if errorlevel 1 (
    start "" ollama serve
    timeout /t 3 >nul
)

:: Start Vite
start "" node node_modules\vite\bin\vite.js
timeout /t 4 >nul

:: Start Electron
node_modules\electron\dist\electron.exe . --enable-logging
