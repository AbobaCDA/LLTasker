@echo off
setlocal
cd /d "%~dp0.."

echo =========================================================
echo   Fix the origin address of the repository
echo =========================================================
echo Project folder: %CD%
echo.

set "login=AbobaCDA"
set /p "login=GitHub login [Enter = AbobaCDA]: "
if "%login%"=="" set "login=AbobaCDA"

rem Strip accidental quotes, brackets and spaces
set "login=%login: =%"
set "login=%login:"=%"
set "login=%login:[=%"
set "login=%login:]=%"
set "login=%login:(=%"
set "login=%login:)=%"

set "url=https://github.com/%login%/LLTasker.git"
echo.
echo New address: %url%

git remote remove origin >nul 2>&1
git remote add origin "%url%"

echo.
echo Saved addresses (must have no brackets or quotes):
git remote -v

echo.
echo Access check. No errors below = repository found:
git ls-remote origin
if errorlevel 1 (
  echo.
  echo ERROR: repository not found. Check that it exists:
  echo   https://github.com/%login%/LLTasker
  echo If the page shows 404 - create the repository LLTasker, Public, without README.
  echo If the name is different - set the address manually:
  echo   git remote set-url origin "https://github.com/%login%/REPO_NAME.git"
  goto :end
)

echo.
echo Done. Next step:
echo   git push -u origin main

:end
echo.
pause
endlocal
