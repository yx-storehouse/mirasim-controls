@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0bootstrap.ps1" -Action diagnose %*
set "mirasim_exit=%errorlevel%"
exit /b %mirasim_exit%
