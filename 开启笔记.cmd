@echo off
setlocal
cd /d "%~dp0"

rem Electron must run as an app (this machine may set ELECTRON_RUN_AS_NODE=1)
set "ELECTRON_RUN_AS_NODE="

set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"
rem %~dp0 ends with a backslash; "%APP%" would end with \" and break the quote,
rem so append a dot to the folder path.
set "APP=%~dp0."

if not exist "%ELECTRON%" goto noelectron

echo [%date% %time%] launch "%ELECTRON%" "%APP%" >> "%~dp0launch.log"
start "" "%ELECTRON%" "%APP%"
exit /b 0

:noelectron
echo.
echo   Electron runtime not found:
echo   %ELECTRON%
echo.
echo   Run this once inside the project folder:
echo       npm install
echo.
pause
exit /b 1
