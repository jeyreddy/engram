@echo off
cd C:\engram
for /f "tokens=1,2 delims==" %%a in (.env) do set %%a=%%b
start "" node node_modules\vite\bin\vite.js
timeout /t 3
node_modules\electron\dist\electron.exe . --enable-logging
