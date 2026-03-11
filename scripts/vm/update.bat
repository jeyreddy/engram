@echo off
echo === ENGRAM Update Production ===
cd C:\engram
git pull origin main
call npm run build
pm2 restart engram-prod
pm2 list
echo === Production updated ===
pause