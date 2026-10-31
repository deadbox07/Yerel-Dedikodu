@echo off
chcp 65001 >nul
title Yerel Dedikodu
cd /d "%~dp0"
echo ================================================
echo         YEREL DEDIKODU - Tek Tikla Baslat
echo ================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [HATA] Node.js kurulu degil.
  echo.
  echo 1^) https://nodejs.org adresine git
  echo 2^) "LTS" surumunu indir ve kur
  echo 3^) Bu dosyayi tekrar cift tikla
  echo.
  pause
  exit /b
)

if not exist node_modules (
  echo [1/3] Gerekli dosyalar kuruluyor... (1 dakika)
  call npm install --no-audit --no-fund
)

if not exist cloudflared.exe (
  echo [2/3] Internet tuneli araci indiriliyor... (30 saniye)
  powershell -Command "Invoke-WebRequest -Uri https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe -OutFile cloudflared.exe"
)

echo [3/3] Sunucu baslatiliyor...
start "Yerel Dedikodu - Sunucu" /min cmd /c "node server.js"
timeout /t 3 >nul

echo.
echo ================================================
echo  ASAGIDA CIKAN https://... LINKINI ARKADASLARINA GONDER
echo  Bu pencereyi KAPATMA - kaparsan site kapanir.
echo ================================================
echo.
cloudflared.exe tunnel --url http://localhost:3000 --no-autoupdate --protocol http2
pause
