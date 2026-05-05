SHELL := /bin/bash

.PHONY: help install icons dev typecheck lint test bundle build clean dist dist-mac dist-linux dist-win

help:
	@echo "Targets:"
	@echo "  install      install npm dependencies"
	@echo "  icons        regenerate icon assets in build/ from assets/"
	@echo "  bundle       bundle TypeScript sources into dist/"
	@echo "  typecheck    run tsc --noEmit"
	@echo "  lint         run eslint"
	@echo "  test         run vitest"
	@echo "  build        typecheck + lint + bundle + icons"
	@echo "  dev          launch the app from source"
	@echo "  dist-mac     package macOS arm64 (.dmg + .zip)"
	@echo "  dist-linux   package Linux amd64 + arm64 (.AppImage + .deb)"
	@echo "  dist-win     package Windows amd64 + arm64 (.exe + .zip)"
	@echo "  dist         package all targets"
	@echo "  clean        remove dist/, release/, generated icons"

install:
	npm install

icons:
	npm run icons

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

dist-mac:
	npm run dist:mac

dist-linux:
	npm run dist:linux

dist-win:
	npm run dist:win

dist:
	npm run dist:all

clean:
	rm -rf dist release build
