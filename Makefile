.PHONY: check test hooks

check:
	node scripts/check-mods.mjs
	npm test

test:
	npm test

hooks:
	git config core.hooksPath .githooks
