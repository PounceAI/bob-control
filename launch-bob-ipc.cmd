@echo off
REM Launch IBM Bob with its Roo Code IPC server enabled.
REM IMPORTANT: fully QUIT Bob first (Bob is single-instance; relaunching while
REM it runs just focuses the existing process and will NOT apply this env var).
set "ROO_CODE_IPC_SOCKET_PATH=\\.\pipe\bob-ipc"
echo Launching IBM Bob with ROO_CODE_IPC_SOCKET_PATH=%ROO_CODE_IPC_SOCKET_PATH%

echo Ensuring Bob auto-approve is enabled (Bob must be closed)...
node "%~dp0set-bob-autoapprove.mjs"
echo.

start "" "%LOCALAPPDATA%\Programs\IBM Bob\IBM Bob.exe"
