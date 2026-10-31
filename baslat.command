#!/bin/bash
# Yerel Dedikodu — Mac/Linux tek tıkla başlat
cd "$(dirname "$0")"
echo "================================================"
echo "        YEREL DEDIKODU - Tek Tıkla Başlat"
echo "================================================"

if ! command -v node >/dev/null 2>&1; then
  echo "[HATA] Node.js kurulu değil."
  echo "https://nodejs.org adresinden LTS sürümünü kur, sonra tekrar çalıştır."
  read -r -p "Kapatmak için Enter..."
  exit 1
fi

[ -d node_modules ] || { echo "[1/3] Kurulum yapılıyor..."; npm install --no-audit --no-fund; }

if [ ! -x ./cloudflared ]; then
  echo "[2/3] Tünel aracı indiriliyor..."
  if [ "$(uname)" = "Darwin" ]; then
    curl -L -o cloudflared.tgz https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz
    tar -xzf cloudflared.tgz && rm -f cloudflared.tgz
  else
    curl -L -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  fi
  chmod +x cloudflared
fi

echo "[3/3] Sunucu başlatılıyor..."
node server.js &
SERVER_PID=$!
sleep 2

echo ""
echo "================================================"
echo " AŞAĞIDA ÇIKAN https://... LİNKİNİ PAYLAŞ"
echo " Bu pencereyi KAPATMA - kapatırsan site kapanır."
echo "================================================"
echo ""
trap "kill $SERVER_PID 2>/dev/null" EXIT
./cloudflared tunnel --url http://localhost:3000 --no-autoupdate --protocol http2
