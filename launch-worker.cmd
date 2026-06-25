@echo off
setlocal
REM launch-worker.cmd [workspace-folder] [extra worker flags]
REM Standing auto-dispatch worker: drains a task board and dispatches each task to IBM Bob over IPC.
REM   With <workspace-folder>: drain THAT worktree's board + dispatch to its per-instance pipe (pairs
REM     with `launch-bob.cmd <same-folder>`). Without it: legacy single-instance — connector board over
REM     the default pipe (pairs with launch-bob-ipc.cmd).
REM Defaults --answer-followups --review-plans; extra flags pass through. Autostart: shortcut in
REM shell:startup. Requires Bob running with IPC enabled.

REM First arg is a workspace only if it isn't a flag (doesn't start with "-").
set "WORKSPACE="
set "ARG1=%~1"
if defined ARG1 if not "%ARG1:~0,1%"=="-" set "WORKSPACE=%~f1"

if not defined WORKSPACE (
  cd /d "%~dp0"
  node "dist\worker.js" --answer-followups --review-plans %*
  exit /b %errorlevel%
)

REM Target this workspace's Bob via BOB_IPC_PIPE; an explicit --pipe in the flags still wins.
for /f "usebackq delims=" %%P in (`node "%~dp0tools\print-pipe-name.mjs" "%WORKSPACE%"`) do set "PIPE=%%P"
if not defined PIPE (
  echo [launch-worker] could not compute the pipe name. Build dist first:  npm run build
  exit /b 1
)
set "BOB_IPC_PIPE=%PIPE%"

REM Drop the workspace arg; collect the rest to pass through.
shift
set "REST="
:collect
if "%~1"=="" goto run
set "REST=%REST% %1"
shift
goto collect

:run
REM Run the connector's worker FROM the workspace so its git + board ops target that worktree.
cd /d "%WORKSPACE%"
node "%~dp0dist\worker.js" --answer-followups --review-plans%REST%
endlocal
