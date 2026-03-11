@echo off
echo === ENGRAM Update Sandbox ===
cd C:\engram
git pull origin dev
call npm run build
pm2 restart engram-sandbox
pm2 list
echo === Sandbox updated ===
pause