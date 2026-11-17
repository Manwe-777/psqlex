#!/bin/sh
# Makes psqlex-<version>.tar.gz: the launcher, the bundled server and the built
# UI. Unpack it anywhere with Node.js 20.11+ installed and run bin/psqlex.
set -eu
VERSION="$(node -p 'require("./package.json").version')"
STAGE="$(mktemp -d)/psqlex"
mkdir -p "$STAGE/bin" "$STAGE/dist"
cp bin/psqlex "$STAGE/bin/"
cp -R dist/web dist/psqlex.mjs "$STAGE/dist/"
cp README.md psqlex.config.example.json "$STAGE/"
node -e 'const p = require("./package.json"); console.log(JSON.stringify({ name: p.name, version: p.version, type: "module", bin: p.bin, engines: p.engines }, null, 2))' >"$STAGE/package.json"
mkdir -p release
# Leave out macOS extended attributes, which GNU tar warns about on Linux.
COPYFILE_DISABLE=1 tar --no-xattrs -czf "release/psqlex-$VERSION.tar.gz" -C "$(dirname "$STAGE")" psqlex
rm -rf "$(dirname "$STAGE")"
echo "release/psqlex-$VERSION.tar.gz"
