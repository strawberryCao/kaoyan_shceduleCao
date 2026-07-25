#!/usr/bin/env bash
set -Eeuo pipefail

LOG_FILE=/tmp/public-lan-parity-v2.log
STATUS=failure
STAGE=initializing
FAILED_COMMAND=''
BUSINESS_SHA=''
: > "$LOG_FILE"
exec 3>&1 4>&2
exec >> "$LOG_FILE" 2>&1

on_error() {
  FAILED_COMMAND="$BASH_COMMAND"
}
trap on_error ERR

finalize() {
  code=$?
  set +e
  trap - ERR EXIT
  [[ "$code" -eq 0 ]] && STATUS=success
  detail="$(tail -n 120 "$LOG_FILE" 2>/dev/null || true)"
  business_sha="${BUSINESS_SHA:-$(git rev-parse HEAD 2>/dev/null)}"

  {
    echo '===== PUBLIC LAN PARITY V2 SUMMARY ====='
    echo "status=$STATUS stage=$STAGE exitCode=$code"
    echo "failedCommand=$FAILED_COMMAND"
    echo "$detail"
    echo '===== END SUMMARY ====='
  } >&3

  git reset --hard HEAD >> "$LOG_FILE" 2>&1 || true
  git config user.name 'Kaoyan Parity Validator'
  git config user.email 'kaoyan-parity@local.invalid'
  mkdir -p .github/validation
  export STATUS STAGE FAILED_COMMAND BUSINESS_SHA="$business_sha" DETAIL="$detail" EXIT_CODE="$code"
  python - <<'PY'
import json, os
from datetime import datetime, timezone
payload = {
    'schemaVersion': 2,
    'status': os.environ.get('STATUS', 'failure'),
    'stage': os.environ.get('STAGE', ''),
    'failedCommand': os.environ.get('FAILED_COMMAND', ''),
    'exitCode': int(os.environ.get('EXIT_CODE', '1')),
    'runId': int(os.environ.get('GITHUB_RUN_ID', '0')),
    'runAttempt': int(os.environ.get('GITHUB_RUN_ATTEMPT', '0')),
    'sourceSha': os.environ.get('GITHUB_SHA', ''),
    'businessSha': os.environ.get('BUSINESS_SHA', ''),
    'detail': os.environ.get('DETAIL', '')[-16000:],
    'recordedAt': datetime.now(timezone.utc).isoformat(),
}
with open('.github/validation/public-lan-parity-v2-status.json', 'w', encoding='utf-8') as file:
    json.dump(payload, file, ensure_ascii=False, indent=2)
    file.write('\n')
PY
  git add .github/validation/public-lan-parity-v2-status.json
  git commit -m 'ci: record public LAN parity V2 validation' >> "$LOG_FILE" 2>&1 || true
  git push origin HEAD:fix/public-lan-parity-control-plane >&3 2>&4 || true
  exit "$code"
}
trap finalize EXIT

STAGE=repair-transformer
python -m py_compile \
  .github/scripts/repair-public-lan-transformer-v3.py \
  .github/scripts/repair-public-lan-transformer-v4.py \
  .github/scripts/repair-public-lan-transformer-v5.py
python .github/scripts/repair-public-lan-transformer-v5.py
node --check .github/scripts/apply-public-lan-parity.cjs

STAGE=apply-source
node .github/scripts/apply-public-lan-parity.cjs

STAGE=javascript-syntax
for file in \
  outputs/kaoyan-schedule-app/scripts/agent-workflow-contracts.cjs \
  outputs/kaoyan-schedule-app/scripts/export-agent-runtime.cjs \
  outputs/kaoyan-schedule-app/scripts/note-file-access.cjs \
  outputs/kaoyan-schedule-app/cloudflare/agent-runtime.js \
  outputs/kaoyan-schedule-app/cloudflare/ai-config.js \
  outputs/kaoyan-schedule-app/cloudflare/ai.js \
  outputs/kaoyan-schedule-app/cloudflare/rename-job.js \
  outputs/kaoyan-schedule-app/cloudflare/background-jobs.js \
  outputs/kaoyan-schedule-app/cloudflare/media.js \
  outputs/kaoyan-schedule-app/cloudflare/source-mirror.js; do
  node --check "$file"
done

STAGE=powershell-syntax
pwsh -NoProfile -Command - <<'PWSH'
$failed = $false
foreach ($file in @(
  'outputs/kaoyan-schedule-app/scripts/windows-note-folder-sync.ps1',
  'outputs/kaoyan-schedule-app/scripts/install-note-folder-sync.ps1',
  'outputs/kaoyan-schedule-app/scripts/start-local-services-hidden.ps1'
)) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count -gt 0) {
    $failed = $true
    Write-Error ("{0}: {1}" -f $file, (($errors | ForEach-Object Message) -join '; '))
  }
}
if ($failed) { exit 1 }
PWSH

cd outputs/kaoyan-schedule-app
STAGE=npm-ci
npm ci

STAGE=targeted-tests
node --test scripts/public-lan-parity.test.cjs cloudflare/agent-provider.test.mjs

STAGE=all-tests
mapfile -d '' test_files < <(find cloudflare scripts -type f \( -name '*.test.cjs' -o -name '*.test.mjs' \) -print0 | sort -z)
(( ${#test_files[@]} > 0 ))
node --test "${test_files[@]}"

STAGE=production-build
npm run build

STAGE=worker-dry-run
npx wrangler deploy --dry-run

cd ../..
STAGE=commit-business
git config user.name 'Kaoyan Parity Validator'
git config user.email 'kaoyan-parity@local.invalid'
git add outputs/kaoyan-schedule-app
if ! git diff --cached --quiet; then
  git commit -m 'fix: align public capture with LAN control plane'
  git push origin HEAD:fix/public-lan-parity-control-plane
fi
BUSINESS_SHA="$(git rev-parse HEAD)"
STATUS=success
STAGE=completed
