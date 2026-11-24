@echo off
REM School Unity — one-step local start (Windows)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org, then run this again.
  pause & exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo School Unity needs Node.js 22.13 or newer. Update from https://nodejs.org
  pause & exit /b 1
)
if not exist node_modules (
  echo Installing dependencies ^(first run only^)...
  call npm install --no-audit --no-fund
)
call npm run --silent seed
if "%PORT%"=="" set PORT=3000
echo.
echo   School Unity is starting at http://localhost:%PORT%
echo   Sign in: admin@greenfield.edu / admin12345   (close this window to stop)
echo.
start "" http://localhost:%PORT%
call npm start
pause
