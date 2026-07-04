#!/usr/bin/env sh
set -eu

: "${PORT:=4173}"
: "${PRODUCT_ID:=gold-trend-desk}"
: "${LICENSE_REQUIRED:=false}"

export PORT
export PRODUCT_ID
export LICENSE_REQUIRED

cd "$(dirname "$0")"
exec node server.js
