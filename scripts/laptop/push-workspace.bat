@echo off
echo === Pushing workspace to git ===
cd C:\engram

git checkout workspace-sync 2>nul || git checkout -b workspace-sync

if exist workspace-data rmdir /S /Q workspace-data
mkdir workspace-data

xcopy "C:\Users\Jagan Reddy\AppData\Roaming\engram\engram-workspace" "workspace-data\" /E /I /Y /Q

:: Remove any nested .git folders that would confuse git
for /d /r "workspace-data" %%d in (.git) do (
    if exist "%%d" rmdir /S /Q "%%d"
)

git add -f workspace-data\
git commit -m "workspace sync %date% %time%"
git push origin workspace-sync
git checkout main

echo === Done. Run pull-workspace.bat on VM ===
pause