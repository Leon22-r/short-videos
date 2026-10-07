#!/usr/bin/env bash
# Build function.zip for AWS Lambda from requirements.txt and handler.py.
#
# The dependencies are NOT tracked in git: this script installs them into this
# directory on every build, which is what makes the artifact reproducible from a
# clean checkout. Everything it installs is gitignored.
set -euo pipefail

cd "$(dirname "$0")"

rm -f function.zip
# Pinned to the Lambda runtime, not to this machine. One dependency ships a
# compiled binary (charset_normalizer), so an install resolved for the build
# host's Python or architecture produces a zip that builds fine and then fails
# at import inside AWS. --only-binary makes pip refuse rather than fall back to
# a source build for the wrong target. No --upgrade: two builds of the same
# commit should resolve the same versions.
python3 -m pip install --quiet --target . \
  --platform manylinux2014_x86_64 \
  --python-version 3.12 \
  --only-binary=:all: \
  -r requirements.txt

zip -qr function.zip . \
  -x "build.sh" \
  -x "function.zip" \
  -x "requirements.txt" \
  -x "README.md" \
  -x "local-server.py" \
  -x "test_handler.py" \
  -x "*.dist-info/*" \
  -x "bin/*" \
  -x "__pycache__/*" \
  -x "*/__pycache__/*" \
  -x ".pytest_cache/*"

# A pip install that silently resolved nothing still produces a valid archive,
# so check the two things the Lambda cannot run without.
python3 - <<'CHECK'
import zipfile
names = zipfile.ZipFile("function.zip").namelist()
assert "handler.py" in names, "handler.py missing from function.zip"
assert any(n.startswith("youtube_transcript_api/") for n in names), \
    "youtube_transcript_api missing from function.zip"
print(f"function.zip: {len(names)} entries")
CHECK

echo "Built: $(du -h function.zip | cut -f1)"
