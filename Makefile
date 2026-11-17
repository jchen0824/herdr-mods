.PHONY: check test e2e herdr-check hooks

check:
	node scripts/check-mods.mjs
	npm test

test:
	npm test

# Needs a disposable cluster (kind in CI): creates and deletes the herdr-kube-e2e namespace.
# KUBE_E2E_CONTEXT picks the kube context (default kind-kind).
e2e:
	npm run e2e

# Herdr's own check of every mod (needs herdr-app; CI installs it).
herdr-check:
	for m in */mods/*/; do herdr-app check "$$m" || exit 1; done

hooks:
	git config core.hooksPath .githooks
