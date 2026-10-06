@echo off
chcp 65001 >nul
setlocal

rem Чистка публичного репозитория: убирает вложенную копию проекта, служебный файл $null
rem и переносит внутреннюю документацию из репозитория в соседнюю папку на диске.
rem Запуск: двойной клик по файлу или из CMD:  tools\cleanup-repo.cmd

cd /d "%~dp0.."
echo === Чистка репозитория ===
echo Папка проекта: %CD%
echo.

echo Сейчас в корне:
dir /b
echo.

rem --- 1. Вложенная копия проекта (распакованный архив внутри репозитория) ---
if exist "forge-tasks\" (
  echo [1/3] Убираю вложенную копию проекта: forge-tasks\
  git rm -r -f --quiet --ignore-unmatch forge-tasks
  if exist "forge-tasks\" rmdir /s /q "forge-tasks"
) else (
  echo [1/3] Вложенной папки forge-tasks нет — пропускаю
)

rem --- 2. Служебный файл $null (создаётся, если в CMD выполнить 2^>$null из PowerShell) ---
if exist "$null" (
  echo [2/3] Убираю служебный файл "$null"
  git rm -f --quiet --ignore-unmatch "$null"
  if exist "$null" del /q "$null"
) else (
  echo [2/3] Файла "$null" нет — пропускаю
)

rem --- 3. Внутренняя документация: остаётся на диске, уходит из публичного репозитория ---
if exist "docs\" (
  if not exist "..\forge-tasks-docs" mkdir "..\forge-tasks-docs"
  echo [3/3] Переношу docs\ в ..\forge-tasks-docs ^(файлы останутся у вас^)
  xcopy "docs" "..\forge-tasks-docs" /E /I /Y >nul
  git rm -r --cached --quiet docs
  rmdir /s /q "docs"
) else (
  echo [3/3] Папки docs\ нет — пропускаю
)

echo.
echo Что изменилось:
git status --short
echo.

set /p answer=Закоммитить и отправить на GitHub? (y/n):
if /i not "%answer%"=="y" goto :end

git add -A
git commit -m "Чищу репозиторий: убираю дубль проекта, служебный файл и внутреннюю документацию"
if errorlevel 1 (
  echo.
  echo Коммит не создан — возможно, изменений уже нет. Проверьте вывод git status выше.
  goto :end
)
git push

echo.
echo Готово. Документация осталась в ..\forge-tasks-docs, в репозитории её больше нет.
echo Напоминание: в истории прошлых коммитов документ сохранится. Секретов в нём нет,
echo поэтому это безопасно; если нужно вычистить и историю — см. инструкцию в гайде.

:end
endlocal
