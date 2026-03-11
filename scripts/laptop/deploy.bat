@echo off
echo === ENGRAM Deploy to Production ===
cd C:\engram
git add .
set msg=%date% %time%
git commit -m "deploy: %msg%"
git push origin main
echo === Done. Now run update.bat on VM ===
pause