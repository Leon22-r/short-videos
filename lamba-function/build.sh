#!/usr/bin/env bash
# Rebuild function.zip from vendored deps and handler.
set -euo pipefail

cd "$(dirname "$0")"
rm -f function.zip
zip -r function.zip . \
  -x "build.sh" \
  -x "function.zip" \
  -x "*.dist-info/*" \
  -x "bin/*" \
  -x "__pycache__/*" \
  -x "*/__pycache__/*"
echo "Built: $(du -h function.zip | cut -f1)"
