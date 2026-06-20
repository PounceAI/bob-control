@echo off
REM Launch IBM Bob with its Roo Code IPC server enabled.
REM IMPORTANT: fully QUIT Bob first (Bob is single-instance; relaunching while
REM it runs just focuses the existing process and will NOT apply this env var).

echo Ensuring Bob auto-approve is enabled (Bob must be closed)...
node "%~dp0set-bob-autoapprove.mjs"
if errorlevel 1 (
  echo.
  echo [launch-bob-ipc] set-bob-autoapprove failed ^(is Bob still running?^).
  echo Fully quit Bob and run this again — aborting so IPC isn't enabled without it.
  exit /b 1
)
echo.

REM Export the IPC path only after auto-approve succeeds, so a present var means both ran
REM (the extension's worker pre-flight relies on that).
set "ROO_CODE_IPC_SOCKET_PATH=\\.\pipe\bob-ipc"
echo Launching IBM Bob with ROO_CODE_IPC_SOCKET_PATH=%ROO_CODE_IPC_SOCKET_PATH%
start "" "%LOCALAPPDATA%\Programs\IBM Bob\IBM Bob.exe"
