install:
    bun install

# Setup npm trusted publisher (one-time manual setup)
setup-npm-trust:
    npm trust github --repository dzackgarza/opencode-manager --file publish.yml

typecheck:
    bun run check

test:
    #!/usr/bin/env bash
    set -euo pipefail
    rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/opencode"
    exec bun test

check: typecheck test

# Manual publish from local (requires 2FA)
publish: check
    npm publish


# Bump patch version, commit, and tag
bump-patch:
    npm version patch --no-git-tag-version
    git add package.json
    git commit -m "chore: bump version to v$(node -p 'require("./package.json").version')"
    git tag "v$(node -p 'require("./package.json").version')"

# Bump minor version, commit, and tag
bump-minor:
    npm version minor --no-git-tag-version
    git add package.json
    git commit -m "chore: bump version to v$(node -p 'require("./package.json").version')"
    git tag "v$(node -p 'require("./package.json").version')"

# Push commits and tags to trigger CI release
release: check
    git push && git push --tags

