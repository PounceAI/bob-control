@echo off
setlocal
REM launch-bob.cmd <workspace-folder> [user-data-dir]
REM Launch an IBM Bob instance bound to ONE workspace on its OWN IPC pipe, so two Bobs (e.g. two
REM worktrees) run side-by-side without cross-firing over the shared global pipe. [user-data-dir]
REM defaults to a per-workspace dir under %LOCALAPPDATA%\bob-instances; a DISTINCT one is REQUIRED to
REM run a 2nd Bob at once (Electron is single-instance per user-data-dir). A fresh dir is auto-seeded
REM with auto-approve; pass an existing dir to reuse a configured instance.

if "%~1"=="" (
  echo usage: launch-bob.cmd ^<workspace-folder^> [user-data-dir]
  exit /b 1
)
set "WORKSPACE=%~f1"

REM Pipe name + slug come from the single source of truth (src/pipe-name.ts, via the printer).
for /f "usebackq delims=" %%P in (`node "%~dp0tools\print-pipe-name.mjs" "%WORKSPACE%"`) do set "PIPE=%%P"
for /f "usebackq delims=" %%S in (`node "%~dp0tools\print-pipe-name.mjs" "%WORKSPACE%" --slug`) do set "SLUG=%%S"
if not defined PIPE (
  echo [launch-bob] could not compute the pipe name. Build dist first:  npm run build
  exit /b 1
)
REM Guard SLUG too — empty would collapse every workspace into the shared bob-instances root.
if not defined SLUG (
  echo [launch-bob] could not compute the instance slug. Build dist first:  npm run build
  exit /b 1
)

if "%~2"=="" ( set "UDD=%LOCALAPPDATA%\bob-instances\%SLUG%" ) else ( set "UDD=%~f2" )

REM Auto-approve: a fresh user-data-dir is seeded from your default Bob; an existing one is left as-is.
echo Bootstrapping auto-approve (user-data-dir %UDD%)...
node "%~dp0set-bob-autoapprove.mjs" --user-data-dir "%UDD%"
if errorlevel 1 echo [launch-bob] auto-approve bootstrap skipped (see above) — continuing to launch.

REM Scaffold bobTasks.pipe into the workspace's (gitignored) .vscode so the extension worker routes here.
node "%~dp0tools\scaffold-workspace-settings.mjs" "%WORKSPACE%"

set "ROO_CODE_IPC_SOCKET_PATH=%PIPE%"
echo Launching IBM Bob:
echo   workspace      = %WORKSPACE%
echo   pipe           = %ROO_CODE_IPC_SOCKET_PATH%
echo   user-data-dir  = %UDD%
start "" "%LOCALAPPDATA%\Programs\IBM Bob\IBM Bob.exe" --user-data-dir "%UDD%" "%WORKSPACE%"
endlocal
