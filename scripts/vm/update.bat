@echo off
echo === ENGRAM Update Production ===
cd C:\engram
git pull origin main
call npm run build
pm2 reload engram-prod --update-env
pm2 list
echo === Production updated ===
pause