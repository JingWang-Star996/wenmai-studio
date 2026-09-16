@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在只读扫描文章目录并刷新生成索引……
if exist "%ProgramFiles%\nodejs\npm.cmd" (
  call "%ProgramFiles%\nodejs\npm.cmd" run data:refresh
) else (
  call npm.cmd run data:refresh
)
echo 刷新结束。若文脉正在运行，回到浏览器刷新页面。
pause
