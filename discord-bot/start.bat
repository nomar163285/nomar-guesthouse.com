@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Discord Bot wo kidou shiteimasu... kono window wo tojinaide kudasai.
where node >nul 2>nul
if errorlevel 1 (
  echo node ga mitsukarimasen. PC wo saikidou shitekara mou ichido tameshite kudasai.
  pause
  exit /b 1
)
node bot.js
pause
