@echo off
setlocal
cd /d "%~dp0.."

echo =========================================================
echo   Cleanup: remove internal docs from the repository
echo =========================================================
echo Project folder: %CD%
echo.

if not exist ".git" (
  echo ERROR: .git not found here.
  echo Run the script from the project folder: tools\cleanup-docs.cmd
  goto :end
)

echo Step 1. Move guide files out of the project (they stay on disk):
if not exist "..\forge-tasks-docs" md "..\forge-tasks-docs"

set moved=0
for %%F in (SETUP-GUIDE.html DEPLOYMENT.html SETUP-GUIDE.md DEPLOYMENT.md) do (
  if exist "%%F" (
    echo   moving %%F to ..\forge-tasks-docs
    move /Y "%%F" "..\forge-tasks-docs" >nul
    set moved=1
  ) else (
    echo   not in the root: %%F   [skipped]
  )
)

echo.
echo Step 2. Move the docs folder out (if present):
if exist "docs" (
  echo   moving docs\ to ..\forge-tasks-docs
  xcopy "docs" "..\forge-tasks-docs" /E /I /Y >nul
  rmdir /s /q "docs"
  set moved=1
) else (
  echo   docs\ not found   [skipped]
)

echo.
echo Step 3. What git sees now (deleted: = will be removed from the repository):
git status --short
echo.

if "%moved%"=="0" (
  echo Nothing had to be moved. If git still lists deletions above, commit them below.
)

set "answer="
set /p "answer=Commit and push to GitHub? (y/n): "
if /i not "%answer%"=="y" (
  echo.
  echo Skipped. The files are already outside the project folder.
  echo To finish manually later:
  echo    git add -A
  echo    git commit -m "Remove internal docs from public repository"
  echo    git push
  goto :end
)

git add -A
git commit -m "Remove internal docs from public repository"
if errorlevel 1 (
  echo.
  echo Commit was not created - probably nothing to commit or a git error. See above.
  goto :end
)

git push

echo.
echo Done. Files are in ..\forge-tasks-docs, the repository no longer has them.
echo Check: https://github.com/AbobaCDA/LLTasker   (branch: main)

:end
echo.
pause
endlocal
