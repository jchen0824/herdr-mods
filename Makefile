.PHONY: check test e2e herdr-check hooks sync-revive install

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

# Bring upstream herdr-revive's newest release into revive/ (REF=<tag|branch|sha> for another).
sync-revive:
	node scripts/sync-revive.mjs $(if $(REF),--ref $(REF))

# Copy this repository's mods into ~/.config/herdr-app/mods (DRY=1: only say what would change;
# MOD=name[,name]: only those).
install:
	node scripts/install-mods.mjs $(if $(DRY),--dry) $(if $(MOD),--mod $(MOD))

hooks:
	git config core.hooksPath .githooks
