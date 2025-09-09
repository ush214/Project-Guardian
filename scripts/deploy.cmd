@echo off
setlocal
where firebase >NUL 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo Firebase CLI not found. Install with: npm i -g firebase-tools
  exit /b 1
)
firebase deploy --only hosting:project-guardian-agent --project project-guardian-agent %*
endlocal