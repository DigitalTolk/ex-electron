SHELL := /bin/bash

.PHONY: help install regen-icons dev typecheck lint test bundle build clean dist dist-mac dist-linux dist-win

help:
	@echo "Targets:"
	@echo "  install        install npm dependencies"
	@echo "  regen-icons    regenerate icon artifacts in prebuilt/ from assets/"
	@echo "                 (run after editing assets/ex.icon, then commit prebuilt/)"
	@echo "  bundle         bundle TypeScript sources into dist/"
	@echo "  typecheck      run tsc --noEmit"
	@echo "  lint           run eslint"
	@echo "  test           run vitest"
	@echo "  build          typecheck + lint + bundle"
	@echo "  dev            launch the app from source"
	@echo "  dist-mac       package macOS arm64 (.dmg + .zip)"
	@echo "  dist-linux     package Linux amd64 + arm64 (.AppImage + .deb)"
	@echo "  dist-win       package Windows amd64 + arm64 (.exe + .zip)"
	@echo "  dist           package all targets"
	@echo "  clean          remove dist/, release/"

install:
	npm install

# Manual: regenerate icons in prebuilt/ after editing assets/. The committed
# prebuilt/ is the source of truth for installers; CI never runs this. macOS
# host with Xcode 26 (Icon Composer + actool + iconutil) required.
regen-icons:
	npm run regen-icons

bundle:
	npm run bundle

typecheck:
	npm run typecheck

lint:
	npm run lint

test:
	npm test

build:
	npm run build

dev:
	npm run start

# Local Mac builds default to ad-hoc signing + no notarization. This sidesteps
# the keychain prompt that hangs codesign on first use and avoids needing the
# Developer ID cert on your machine. CI sets CSC_LINK/APPLE_ID and runs
# `npm run dist:mac` directly, which uses the real signing flow.
dist-mac:
	CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac -- --config.mac.notarize=false

dist-linux:
	npm run dist:linux

dist-win:
	npm run dist:win

dist:
	npm run dist:all

clean:
	rm -rf dist release
