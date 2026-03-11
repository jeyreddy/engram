@echo off
cd C:\engram
git status
echo.
echo === Last 5 commits ===
git log --oneline -5
pause