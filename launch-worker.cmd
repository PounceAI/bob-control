@echo off
REM Start the Bob auto-dispatch worker as a STANDING process: it drains this
REM project's task board (data\tasks.db) and idle-polls, dispatching each task to
REM IBM Bob over IPC and writing back the result. With a worker always draining,
REM the plugin's dispatch skills (bob-review / plan / refactor / security) run
REM end-to-end hands-off: they create a task, then await_task hooks back with the
REM result the moment Bob settles it.
REM
REM Make it autostart at logon (so "standing" really means always up):
REM   No admin: drop a shortcut to this file in your Startup folder (Win+R -> shell:startup).
REM   Admin terminal only: schtasks /create /tn "BobWorker" /sc onlogon /tr "\"%~f0\"" /f
REM     (schtasks/Task Scheduler needs elevation; remove with  schtasks /delete /tn "BobWorker" /f)
REM
REM Requires IBM Bob running with IPC enabled (see launch-bob-ipc.cmd).
REM Extra worker flags pass through, e.g.:  launch-worker.cmd --no-notify --max-risk safe
REM
REM Defaults below: --answer-followups + --review-plans so the standing worker auto-answers mechanical
REM clarifications (file paths, flag names) and escalates plan/design questions to the board instead of
REM waiting them out.
cd /d "%~dp0"
node "dist\worker.js" --answer-followups --review-plans %*
