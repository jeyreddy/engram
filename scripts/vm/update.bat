@echo off
echo === ENGRAM Update Production ===
cd C:\engram
git pull origin main
call npm install
call npm run build
if %errorlevel% neq 0 (
  echo === BUILD FAILED — aborting reload ===
  pause
  exit /b 1
)
pm2 reload engram-prod --update-env
pm2 list
echo === Production updated ===
pause