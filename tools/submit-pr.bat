@echo off
chcp 65001 >nul
cd /d "%~dp0.."

rem 定时任务调用入口：跑 submit-pr.js 并把输出追加到 tools\submit-pr.log
rem 用独立的 node（不依赖 DSH 进程是否在跑）
set NODE_EXE=C:\nodejs\node-v24.21.0-win-x64\node.exe

if not exist "%NODE_EXE%" (
  echo [%DATE% %TIME%] 找不到 node: %NODE_EXE% >> "tools\submit-pr.log"
  exit /b 1
)

echo. >> "tools\submit-pr.log"
echo ===== scheduled run at %DATE% %TIME% ===== >> "tools\submit-pr.log"
"%NODE_EXE%" "tools\submit-pr.js" >> "tools\submit-pr.log" 2>&1
echo exit=%ERRORLEVEL% >> "tools\submit-pr.log"
exit /b %ERRORLEVEL%
