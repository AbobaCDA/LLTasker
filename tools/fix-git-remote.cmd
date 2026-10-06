@echo off
chcp 65001 >nul
setlocal

rem Исправляет адрес origin для Forge Tasks: убирает лишние скобки, кавычки
rem и чужие логины, подставляя ваш GitHub-логин.
rem Запуск: двойной клик по файлу или из CMD:  tools\fix-git-remote.cmd

cd /d "%~dp0.."
echo === Исправление адреса репозитория (origin) ===
echo Папка проекта: %CD%
echo.

set /p login=Введите ваш GitHub логин (Username с github.com/settings/profile): 
if "%login%"=="" (
  echo Логин не введён — выходим.
  exit /b 1
)

rem Убираем случайные кавычки, скобки и пробелы из введённого логина
set "login=%login: =%"
set "login=%login:"=%"
set "login=%login:[=%"
set "login=%login:]=%"
set "login=%login:(=%"
set "login=%login:)=%"

set "url=https://github.com/%login%/ForgeTasks.git"

echo.
echo Новый адрес: %url%
git remote remove origin >nul 2>&1
git remote add origin "%url%"

echo.
echo Сохранённые адреса (должны быть без скобок и кавычек):
git remote -v

echo.
echo Проверка доступа. Пустой вывод без ошибок = репозиторий найден:
git ls-remote origin
if errorlevel 1 (
  echo.
  echo ОШИБКА: репозиторий не найден. Проверьте, что он создан и имя совпадает:
  echo   https://github.com/%login%/ForgeTasks
  echo Если страница отдаёт 404 — создайте репозиторий ForgeTasks, Public, без README.
  echo Если имя другое — запустите скрипт снова и укажите верный адрес вручную:
  echo   git remote set-url origin "https://github.com/%login%/ИМЯ_РЕПОЗИТОРИЯ.git"
  exit /b 1
)

echo.
echo Готово. Дальше:
echo   git push -u origin main
echo.
endlocal
