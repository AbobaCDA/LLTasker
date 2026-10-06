@echo off
setlocal
cd /d "%~dp0.."

echo =========================================================
echo   Cleanup of the public repository (full variant)
echo =========================================================
echo Project folder: %CD%
echo.

echo Current root contents:
dir /b
echo.

echo [1/3] Nested copy of the project (forge-tasks\ inside the repo):
if exist "forge-tasks\" (
  git rm -r -f --quiet --ignore-unmatch forge-tasks
  if exist "forge-tasks\" rmdir /s /q "forge-tasks"
  echo   removed
) else (
  echo   not found   [skipped]
)

echo [2/3] Service file "$null":
if exist "$null" (
  git rm -f --quiet --ignore-unmatch "$null"
  if exist "$null" del /q "$null"
  echo   removed
) else (
  echo   not found   [skipped]
)

echo [3/3] Internal documentation: moved out, stays on disk in ..\forge-tasks-docs
if exist "docs\" (
  if not exist "..\forge-tasks-docs" mkdir "..\forge-tasks-docs"
  xcopy "docs" "..\forge-tasks-docs" /E /I /Y >nul
  rmdir /s /q "docs"
  echo   moved
) else (
  echo   docs\ not found   [skipped]
)

echo.
echo Changes:
git status --short
echo.

set "answer="
set /p "answer=Commit and push to GitHub? (y/n): "
if /i not "%answer%"=="y" (
  echo.
  echo Skipped. Run "git add -A" and commit manually when ready.
  goto :end
)

git add -A
git commit -m "Clean up the public repository"
if errorlevel 1 (
  echo.
  echo Commit was not created - probably nothing to commit. See git status above.
  goto :end
)
git push

echo.
echo Done. Documentation is in ..\forge-tasks-docs, the repository no longer has it.
echo Note: old commits keep the old files in history. There are no secrets there, so it is safe.

:end
echo.
pause
endlocal
