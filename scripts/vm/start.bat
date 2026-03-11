@echo off
cd C:\engram
pm2 start ecosystem.config.cjs
pm2 list
pause