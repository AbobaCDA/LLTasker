@echo off
setlocal
cd /d "%~dp0.."

echo =========================================================
echo   Fix package.json (tool versions, publish address)
echo =========================================================
echo Project folder: %CD%
echo.

if not exist package.json (
  echo ERROR: package.json not found in this folder.
  echo Make sure the archive was unpacked without a nested forge-tasks folder.
  goto :end
)

echo Before:
node -p "JSON.stringify({builder:require('./package.json').devDependencies['electron-builder'], electron:require('./package.json').devDependencies.electron, publish:require('./package.json').build.publish && require('./package.json').build.publish[0]}, null, 2)"
echo.

npm pkg set devDependencies.electron-builder=26.15.3
npm pkg set devDependencies.electron=44.5.1
npm pkg set dependencies.electron-updater=6.8.9
npm pkg set "build.publish[0].provider=github"
npm pkg set "build.publish[0].owner=AbobaCDA"
npm pkg set "build.publish[0].repo=LLTasker"
npm pkg set "build.publish[0].releaseType=release"
npm pkg set "scripts.dist:win=electron-builder --win nsis --x64 --publish never"

echo.
echo After:
node -p "JSON.stringify({builder:require('./package.json').devDependencies['electron-builder'], electron:require('./package.json').devDependencies.electron, publish:require('./package.json').build.publish && require('./package.json').build.publish[0]}, null, 2)"
echo.
echo Scripts:
node -p "JSON.stringify(require('./package.json').scripts, null, 2)"

echo.
echo Reinstalling dependencies (may take a couple of minutes)...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo npm install failed. Try a clean install:
  echo   rmdir /s /q node_modules
  echo   del package-lock.json
  echo   npm install
  goto :end
)

echo.
echo Installed builder version:
call npm ls electron-builder

echo.
echo If you see 26.15.3 above - all set. Next:
echo   git add -A
echo   git commit -m "Fix publish settings"
echo   git push

:end
echo.
pause
endlocal
