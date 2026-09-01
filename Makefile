# ============================================================================
# session-sitter — one entry point for every task
# ============================================================================
#
# Run `make` with no target for the list. The three you will actually use:
#
#   make            list every target
#   make check      compile + lint + test — what CI runs, run it before you push
#   make install    build the VSIX and install it into your IDE
#
# Every target is safe to run repeatedly. `make` handles the npm install for you:
# targets that need dependencies depend on node_modules, which is rebuilt only
# when package-lock.json is newer than it.
# ============================================================================

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

NPM     ?= npm
NPX     ?= npx
# The packaging tool is pinned so a local VSIX and a CI VSIX are built the same way.
VSCE    ?= $(NPX) --yes @vscode/vsce@3.9.2
# Which IDE `make install` targets: code (VS Code), bobide (IBM Bob IDE), cursor, …
CODE    ?= code

VERSION := $(shell node -p "require('./package.json').version")
VSIX    := session-sitter-$(VERSION).vsix

# Generated, and gitignored — so a fresh clone has no copy of it. The source imports it, which
# means typecheck, lint AND the tests all need it to exist first. Making it a real prerequisite
# is what keeps `make test` working on a clean checkout.
BUILD_INFO := src/buildInfo.ts

.DEFAULT_GOAL := help

# ---------------------------------------------------------------------------
# Help — the default target. Every `## comment` after a target name is listed.
# ---------------------------------------------------------------------------

.PHONY: help
help:
	@echo "session-sitter $(VERSION)"
	@echo
	@echo "Usage: make <target>"
	@echo
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "Variables:  CODE=$(CODE)   (use CODE=bobide for IBM Bob IDE)"

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------

# A real file target, so this runs only when the lockfile actually changed.
node_modules: package-lock.json
	$(NPM) ci
	@touch node_modules

.PHONY: deps
deps: node_modules ## Install npm dependencies (only when the lockfile changed)

# Regenerated whenever the version or the generator changes.
$(BUILD_INFO): package.json scripts/gen-build-info.js
	node scripts/gen-build-info.js

.PHONY: build-info
build-info: $(BUILD_INFO) ## Generate src/buildInfo.ts (version + build timestamp)

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

.PHONY: compile
compile: node_modules ## Compile TypeScript to out/ (also regenerates buildInfo)
	$(NPM) run compile

.PHONY: watch
watch: node_modules ## Recompile on every change
	$(NPM) run watch

.PHONY: typecheck
typecheck: node_modules $(BUILD_INFO) ## Type-check without emitting anything
	$(NPX) tsc -p ./ --noEmit

# ---------------------------------------------------------------------------
# Quality
# ---------------------------------------------------------------------------

.PHONY: lint
lint: node_modules $(BUILD_INFO) ## Run ESLint over src/
	$(NPX) eslint src

.PHONY: test
test: node_modules $(BUILD_INFO) ## Run the test suite (vitest)
	$(NPX) vitest run

.PHONY: test-watch
test-watch: node_modules $(BUILD_INFO) ## Run the tests and re-run on every change
	$(NPX) vitest

.PHONY: test-file
test-file: node_modules $(BUILD_INFO) ## Run one test file: make test-file FILE=src/test/x.test.ts
	@test -n "$(FILE)" || { echo "usage: make test-file FILE=src/test/<name>.test.ts"; exit 2; }
	$(NPX) vitest run $(FILE)

.PHONY: coverage
coverage: node_modules $(BUILD_INFO) ## Run the tests with a coverage report
	$(NPX) vitest run --coverage

.PHONY: guards
guards: compile ## Run every CI guard: no Python, settings match, one project name
	bash ci/check-no-python.sh
	node ci/check-settings.mjs
	bash ci/check-naming.sh
	node ci/check-links.mjs

.PHONY: check
check: typecheck lint test ## compile + lint + test — the same gate CI applies
	@echo
	@echo "✓ check passed — safe to push"

# ---------------------------------------------------------------------------
# Package and install
# ---------------------------------------------------------------------------

.PHONY: package
package: compile ## Build the installable .vsix
	$(VSCE) package --no-dependencies
	@echo
	@echo "✓ built $(VSIX)"

.PHONY: install
install: package ## Build the .vsix and install it (CODE=bobide for IBM Bob IDE)
	$(CODE) --install-extension $(VSIX) --force
	@echo
	@echo "✓ installed into '$(CODE)' — reload the window to pick it up"

.PHONY: uninstall
uninstall: ## Remove the installed extension
	$(CODE) --uninstall-extension eranra.session-sitter

.PHONY: ls-package
ls-package: compile ## List exactly what would ship inside the .vsix
	# Same --no-dependencies as `package`, or this lists the dependency tree instead of
	# the real VSIX contents (and fails outright when node_modules is not a full install).
	$(VSCE) ls --no-dependencies

# ---------------------------------------------------------------------------
# The bundled CLIs — the same code the extension runs, driven by hand
# ---------------------------------------------------------------------------

.PHONY: supervise
supervise: compile ## Run the supervisor CLI: make supervise ARGS="poll --loop 5"
	node out/supervisor/cli.js $(ARGS)

.PHONY: corpus
corpus: compile ## Run the corpus CLI: make corpus ARGS="list --repo /path"
	node out/corpus/cli.js $(ARGS)

# ---------------------------------------------------------------------------
# Housekeeping
# ---------------------------------------------------------------------------

.PHONY: clean
clean: ## Remove build output and packaged .vsix files
	rm -rf out
	rm -f *.vsix
	rm -f src/buildInfo.ts

.PHONY: clean-all
clean-all: clean ## Also remove node_modules
	rm -rf node_modules

.PHONY: version
version: ## Print the current version
	@echo $(VERSION)
