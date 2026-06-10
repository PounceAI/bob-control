@echo off
REM Start the Bob auto-dispatch worker as a STANDING process: it drains this
REM project's task board (data\tasks.db) and idle-polls, dispatching each task to
REM IBM Bob over IPC and writing back the result. With a worker always draining,
REM the plugin's dispatch skills (bob-review / plan / refactor / security) run
REM end-to-end hands-off: they create a task, then await_task hooks back with the
REM result the moment Bob settles it.
REM
REM Make it autostart at logon (so "standing" really means always up):
REM   schtasks /create /tn "BobWorker" /sc onlogon /tr "\"%~f0\"" /f
REM Remove it:   schtasks /delete /tn "BobWorker" /f
REM
REM Requires IBM Bob running with IPC enabled (see launch-bob-ipc.cmd).
REM Extra worker flags pass through, e.g.:  launch-worker.cmd --no-notify --max-risk safe
cd /d "%~dp0"
node "dist\worker.js" %*
