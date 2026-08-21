#!/usr/bin/env bash
set -euo pipefail

fail=0
max_bytes=$((10 * 1024 * 1024))

bad() {
  printf 'SANITATION ERROR: %s\n' "$1" >&2
  fail=1
}

while IFS= read -r -d '' path; do
  base=${path##*/}

  case "$path" in
    .env|*/.env|.env.*|*/.env.*)
      case "$path" in
        .env.example|*/.env.example|.env.*.example|*/.env.*.example) ;;
        *) bad "forbidden tracked environment file: $path" ;;
      esac
      ;;
    android/*|ios/*)
      bad "generated repo-root native project must not be tracked: $path"
      ;;
    *.pem|*.key|*.p8|*.p12|*.pfx|*.jks|*.keystore|*.mobileprovision|*.kdbx)
      bad "credential/key material must not be tracked: $path"
      ;;
    *.apk|*.aab|*.ipa|*.xcarchive|*.db|*.db-journal|*.db-shm|*.db-wal|*.sqlite|*.sqlite3|*.log|*.pyc)
      bad "generated/binary/runtime artifact must not be tracked: $path"
      ;;
    node_modules/*|*/node_modules/*|dist/*|*/dist/*|build/*|*/build/*|out/*|*/out/*|coverage/*|*/coverage/*|.expo/*|*/.expo/*|.gradle/*|*/.gradle/*|.cxx/*|*/.cxx/*|.cache/*|*/.cache/*|tmp/*|*/tmp/*|.tmp/*|*/.tmp/*|DerivedData/*|*/DerivedData/*|Pods/*|*/Pods/*|.idea/*|*/.idea/*|.vscode/*|*/.vscode/*)
      bad "transient/generated directory must not be tracked: $path"
      ;;
    .github/workflows/*bootstrap*.yml|.github/workflows/*bootstrap*.yaml|.github/workflows/*repair*.yml|.github/workflows/*repair*.yaml|.github/workflows/*temporary*.yml|.github/workflows/*temporary*.yaml)
      bad "temporary/repair workflow must not remain tracked: $path"
      ;;
  esac

  case "$base" in
    .DS_Store|Thumbs.db|local.properties|google-services.json|GoogleService-Info.plist|credentials.json|service-account.json|npm-debug.log*|yarn-debug.log*|yarn-error.log*|pnpm-debug.log*|*.swp|*.swo|*~)
      bad "forbidden tracked file: $path"
      ;;
  esac

  if [[ -f "$path" ]]; then
    bytes=$(wc -c < "$path")
    if (( bytes > max_bytes )); then
      bad "tracked file exceeds 10 MiB: $path ($bytes bytes)"
    fi
  fi
done < <(git ls-files -z)

secret_regex='-----BEGIN( [A-Z0-9]+)? PRIVATE KEY-----|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|sk-(proj-)?[A-Za-z0-9_-]{24,}|xox[baprs]-[A-Za-z0-9-]{10,}'

set +e
git grep -IEn -e "$secret_regex" -- . ':!scripts/repo-sanitize.sh'
secret_rc=$?
set -e
if (( secret_rc == 0 )); then
  bad 'possible high-confidence credential material detected'
elif (( secret_rc != 1 )); then
  bad "secret scan failed to execute (git grep exit $secret_rc)"
fi

if (( fail != 0 )); then
  exit 1
fi

printf 'PartnerScreen repository sanitation checks passed.\n'
