@echo off
setlocal EnableDelayedExpansion
title Khiana

REM ===========================================================================
REM  Khiana launcher (Windows)
REM
REM  Double-click, or:  khiana.bat [command]
REM
REM  Every long-running service opens in its OWN window. That is deliberate:
REM  if the server, client and spectator shared one console you could not read
REM  the agent log during a demo, and closing one would kill all three.
REM ===========================================================================

cd /d "%~dp0"

set "SERVER=%~dp0server"
set "CLIENT=%~dp0client"
set "SPECTATOR=%~dp0spectator"
set "CONTRACTS=%~dp0contracts"

if not "%~1"=="" (
  call :run %1
  exit /b !errorlevel!
)

:menu
cls
echo.
echo   KHIANA
echo   A 3D fog-of-war maze where your AI advisor may have been paid to lie.
echo   ---------------------------------------------------------------------
echo.
echo    1  Play            start everything and open both screens
echo    2  Test            run every test suite
echo    3  Headless        watch a full game as text, no browser
echo    4  Playback        replay the last recorded run (demo parachute)
echo    5  Record          play, and save the run for playback
echo.
echo    6  Setup           install all dependencies
echo    7  Wallets         show addresses and balances
echo    8  Deploy          deploy contracts to Monad testnet
echo    9  Verify chain    prove settlement + x402 on testnet
echo.
echo    0  Stop            kill anything still listening on our ports
echo    Q  Quit
echo.
set /p "choice=  > "

if /i "%choice%"=="1" call :run play
if /i "%choice%"=="2" call :run test
if /i "%choice%"=="3" call :run headless
if /i "%choice%"=="4" call :run playback
if /i "%choice%"=="5" call :run record
if /i "%choice%"=="6" call :run setup
if /i "%choice%"=="7" call :run wallets
if /i "%choice%"=="8" call :run deploy
if /i "%choice%"=="9" call :run verify
if /i "%choice%"=="0" call :run stop
if /i "%choice%"=="q" exit /b 0
echo.
pause
goto :menu

REM ---------------------------------------------------------------------------
:run
set "CMD=%~1"

call :checknode || exit /b 1

if /i "%CMD%"=="setup"    goto :do_setup
if /i "%CMD%"=="play"     goto :do_play
if /i "%CMD%"=="record"   goto :do_record
if /i "%CMD%"=="test"     goto :do_test
if /i "%CMD%"=="headless" goto :do_headless
if /i "%CMD%"=="playback" goto :do_playback
if /i "%CMD%"=="wallets"  goto :do_wallets
if /i "%CMD%"=="deploy"   goto :do_deploy
if /i "%CMD%"=="verify"   goto :do_verify
if /i "%CMD%"=="stop"     goto :do_stop

echo   Unknown command "%CMD%".
echo   Try: play ^| test ^| headless ^| playback ^| record ^| setup ^| wallets ^| deploy ^| verify ^| stop
exit /b 1

REM ---------------------------------------------------------------------------
:godir
REM Enter a directory or abort loudly. A silent pushd failure leaves the next
REM command running in whatever directory happened to be current, which
REM produces a baffling MODULE_NOT_FOUND instead of a useful error.
if "%~1"=="" (
  echo   [error] internal: no directory given
  exit /b 1
)
if not exist "%~1\" (
  echo   [error] missing folder: %~1
  echo           Re-run setup:  khiana.bat setup
  exit /b 1
)
pushd "%~1" || exit /b 1
exit /b 0

REM ---------------------------------------------------------------------------
:checknode
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js is not on PATH. Install Node 18 or newer: https://nodejs.org
  echo.
  exit /b 1
)
exit /b 0

REM ---------------------------------------------------------------------------
:ensuredeps
REM Only install when node_modules is genuinely absent. Running npm install on
REM every launch turns a two-second start into a two-minute one.
if not exist "%SERVER%\node_modules"    call :install "%SERVER%"    server
if not exist "%CLIENT%\node_modules"    call :install "%CLIENT%"    client
if not exist "%SPECTATOR%\node_modules" call :install "%SPECTATOR%" spectator
exit /b 0

:install
echo   installing %~2 dependencies...
if not exist "%~1\" ( echo   [error] missing folder: %~1 & exit /b 1 )
pushd "%~1"
call npm install --no-audit --no-fund
popd
exit /b 0

REM ---------------------------------------------------------------------------
:ensureenv
if exist "%~dp0.env" exit /b 0
echo   no .env found - creating one from .env.example
copy /y "%~dp0.env.example" "%~dp0.env" >nul
echo.
echo   Created .env. The game runs fully in MOCK_CHAIN mode without any keys.
echo   Add GROQ_API_KEY for real agents, AGENT_MNEMONIC for on-chain settlement.
echo.
exit /b 0

REM ---------------------------------------------------------------------------
:do_setup
call :ensureenv
call :install "%SERVER%" server
call :install "%CLIENT%" client
call :install "%SPECTATOR%" spectator
call :install "%CONTRACTS%" contracts
echo.
echo   Setup complete. Run:  khiana.bat play
echo.
if "%~1"=="" pause
exit /b 0

REM ---------------------------------------------------------------------------
:do_play
call :ensureenv
call :ensuredeps
call :do_stop quiet

echo.
echo   starting server, client and spectator...
start "Khiana server" /D "%SERVER%" cmd /k "npm start"
start "Khiana client" /D "%CLIENT%" cmd /k "npm run dev"
start "Khiana spectator" /D "%SPECTATOR%" cmd /k "npm run dev"

REM Vite needs a moment to bind before a browser hitting it gets anything but
REM a connection refused.
timeout /t 6 /nobreak >nul
start "" http://localhost:5173
start "" http://localhost:5174

echo.
echo   landing    http://localhost:5173          ^<- lobbies, how to play
echo   game       http://localhost:5173/play.html
echo   spectator  http://localhost:5174
echo   server     http://localhost:8787
echo.
echo   Open a table on the landing page, or start the main one:
echo     curl -X POST http://localhost:8787/game/start
echo.
if "%~1"=="" pause
exit /b 0

REM ---------------------------------------------------------------------------
:do_record
call :ensureenv
call :ensuredeps
call :do_stop quiet
echo.
echo   starting with RECORD=true - this run is saved for playback
start "Khiana server (recording)" /D "%SERVER%" cmd /k "set RECORD=true&& npm start"
start "Khiana client" /D "%CLIENT%" cmd /k "npm run dev"
start "Khiana spectator" /D "%SPECTATOR%" cmd /k "npm run dev"
timeout /t 6 /nobreak >nul
start "" http://localhost:5173
start "" http://localhost:5174
echo.
echo   Recording is written to server\recordings\ when the game ENDS.
echo   Replay it later with:  khiana.bat playback
echo.
if "%~1"=="" pause
exit /b 0

REM ---------------------------------------------------------------------------
:do_test
call :ensuredeps
if not exist "%CONTRACTS%\node_modules" call :install "%CONTRACTS%" contracts
echo.
set "FAILED=0"

echo   === game core ===
call :godir "%SERVER%" || exit /b 1
call node game.test.mjs
if errorlevel 1 set "FAILED=1"
popd
echo.
echo   === integration ===
call :godir "%SERVER%" || exit /b 1
call node integration.test.mjs
if errorlevel 1 set "FAILED=1"
popd
echo.
echo   === contracts ===
call :godir "%CONTRACTS%" || exit /b 1
call npx hardhat test
if errorlevel 1 set "FAILED=1"
popd
echo.
if "%FAILED%"=="1" (echo   SOME SUITES FAILED) else (echo   all suites passed)
if "%~1"=="" pause
exit /b %FAILED%

REM ---------------------------------------------------------------------------
:do_headless
call :ensureenv
call :ensuredeps
call :godir "%SERVER%" || exit /b 1
call npm run headless
popd
if "%~1"=="" pause
exit /b 0

REM ---------------------------------------------------------------------------
:do_playback
call :ensuredeps
call :do_stop quiet
if not exist "%SERVER%\recordings" (
  echo.
  echo   No recordings yet. Make one with:  khiana.bat record
  echo.
  if "%~1"=="" pause
  exit /b 1
)
start "Khiana playback" /D "%SERVER%" cmd /k "npm run playback"
start "Khiana spectator" /D "%SPECTATOR%" cmd /k "npm run dev"
timeout /t 6 /nobreak >nul
start "" http://localhost:5174
echo.
echo   Replaying the newest recording. The spectator cannot tell it from live.
echo.
if "%~1"=="" pause
exit /b 0

REM ---------------------------------------------------------------------------
:do_wallets
call :ensureenv
call :ensuredeps
call :godir "%SERVER%" || exit /b 1
call npm run wallets
popd
if "%~1"=="" pause
exit /b 0

:do_deploy
call :ensureenv
if not exist "%CONTRACTS%\node_modules" call :install "%CONTRACTS%" contracts
call :godir "%CONTRACTS%" || exit /b 1
call npm run deploy
popd
echo.
echo   Paste the addresses above into .env, then:  khiana.bat verify
echo.
if "%~1"=="" pause
exit /b 0

:do_verify
call :ensureenv
call :ensuredeps
pushd "%SERVER%"
echo   === settlement ===
call npm run phase1
echo.
echo   === x402 ===
call npm run x402
popd
if "%~1"=="" pause
exit /b 0

REM ---------------------------------------------------------------------------
:do_stop
REM Free our three ports. Without this a second launch silently attaches to a
REM stale server and you debug a process you are not editing.
for %%P in (8787 5173 5174) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr /r /c:":%%P .*LISTENING"') do (
    taskkill /f /pid %%A >nul 2>&1
  )
)
if not "%~1"=="quiet" (
  echo   stopped anything listening on 8787, 5173, 5174
  if "%~1"=="" pause
)
exit /b 0
