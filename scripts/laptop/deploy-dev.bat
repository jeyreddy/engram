@echo off
echo === ENGRAM Deploy to Dev/Sandbox ===
cd C:\engram
git add .
set msg=%date% %time%
git commit -m "dev: %msg%"
git push origin dev
echo === Done. Now run update-sandbox.bat on VM ===
pause