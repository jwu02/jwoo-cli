#!/bin/sh
#
# Builds the capture helper.
#
# The binary this produces is committed, so nobody needs this script to clone
# the repo and run it - requiring Xcode command line tools on install would make
# the repo impossible to clone and run (ADR-0002). Re-run it after changing
# eventtap.swift and commit the rebuilt binary alongside.
#
#   ./build.sh

set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

mkdir -p "$here/bin"

swiftc \
	-O \
	-o "$here/bin/eventtap" \
	"$here/eventtap.swift"

echo "built $here/bin/eventtap"
