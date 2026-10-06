@echo off
chcp 65001 >nul
setlocal

rem Приводит package.json в порядок: версии инструментов и адрес публикации.
rem Запуск: двойной клик по файлу или из CMD:  tools\fix-package-json.cmd

cd /d "%~dp0.."
echo === Правка package.json ===
echo Папка проекта: %CD%
echo.

if not exist package.json (
  echo ОШИБКА: в этой папке нет package.json.
  echo Убедитесь, что запускаете скрипт из папки проекта и что архив распакован правильно
  echo ^(без вложенной папки forge-tasks внутри forge-tasks^).
  exit /b 1
)

echo Было:
node -p "JSON.stringify({builder:require('./package.json').devDependencies['electron-builder'], electron:require('./package.json').devDependencies.electron, publish:require('./package.json').build.publish && require('./package.json').build.publish[0]}, null, 2)"
echo.

npm pkg set devDependencies.electron-builder=26.15.3
npm pkg set devDependencies.electron=44.5.1
npm pkg set dependencies.electron-updater=6.8.9
npm pkg set "build.publish[0].provider=github"
npm pkg set "build.publish[0].owner=AbobaCDA"
npm pkg set "build.publish[0].repo=LLTasker"
npm pkg set "build.publish[0].releaseType=release"
npm pkg set scripts.dist:win=electron-builder --win nsis --x64

echo.
echo Стало:
node -p "JSON.stringify({builder:require('./package.json').devDependencies['electron-builder'], electron:require('./package.json').devDependencies.electron, publish:require('./package.json').build.publish && require('./package.json').build.publish[0]}, null, 2)"

echo.
echo Переустанавливаю зависимости под новые версии ^(может занять пару минут^)...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo npm install завершился с ошибкой. Попробуйте чистую установку:
  echo   rmdir /s /q node_modules ^&^& del package-lock.json ^&^& npm install
  exit /b 1
)

echo.
echo Проверка установленной версии сборщика:
call npm ls electron-builder

echo.
echo Если выше видно 26.15.3 — всё готово. Дальше:
echo   git add -A
echo   git commit -m "LLTasker в публикации, возвращаю electron-builder 26.15.3"
echo   git push
echo   git push origin :refs/tags/v0.1.0
echo   git tag -d v0.1.0
echo   git tag v0.1.0
echo   git push origin v0.1.0
echo.
endlocal
