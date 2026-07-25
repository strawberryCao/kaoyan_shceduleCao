#!/usr/bin/env bash
set -Eeuo pipefail

LOG_FILE=/tmp/public-lan-clean.log
STATUS=failure
STAGE=initializing
FAILED_COMMAND=''
CLEAN_SHA=''
: > "$LOG_FILE"
exec 3>&1 4>&2
exec >> "$LOG_FILE" 2>&1

on_error() { FAILED_COMMAND="$BASH_COMMAND"; }
trap on_error ERR

finalize() {
  code=$?
  set +e
  trap - ERR EXIT
  [[ "$code" -eq 0 ]] && STATUS=success
  detail="$(tail -n 180 "$LOG_FILE" 2>/dev/null || true)"
  {
    echo '===== CLEAN DELIVERY SUMMARY ====='
    echo "status=$STATUS stage=$STAGE exitCode=$code"
    echo "failedCommand=$FAILED_COMMAND"
    echo "$detail"
    echo '===== END CLEAN DELIVERY SUMMARY ====='
  } >&3
  mkdir -p .github/validation
  export STATUS STAGE FAILED_COMMAND CLEAN_SHA DETAIL="$detail" EXIT_CODE="$code"
  python - <<'PY'
import json, os
from datetime import datetime, timezone
payload = {
    'schemaVersion': 1,
    'status': os.environ.get('STATUS', 'failure'),
    'stage': os.environ.get('STAGE', ''),
    'failedCommand': os.environ.get('FAILED_COMMAND', ''),
    'exitCode': int(os.environ.get('EXIT_CODE', '1')),
    'cleanSha': os.environ.get('CLEAN_SHA', ''),
    'runId': int(os.environ.get('GITHUB_RUN_ID', '0')),
    'detail': os.environ.get('DETAIL', '')[-24000:],
    'recordedAt': datetime.now(timezone.utc).isoformat(),
}
with open('.github/validation/public-lan-clean-status.json', 'w', encoding='utf-8') as file:
    json.dump(payload, file, ensure_ascii=False, indent=2)
    file.write('\n')
PY
  exit "$code"
}
trap finalize EXIT

repo_branch='fix/learning-detail-title-latex'
clean_branch='fix/public-lan-parity-clean'
business_branch='review/public-lan-parity-business'
business_sha='7bf7971049aa946c485d1ecfb4e51356116fba8f'

business_files=(
  outputs/kaoyan-schedule-app/cloudflare/agent-provider.test.mjs
  outputs/kaoyan-schedule-app/cloudflare/agent-runtime.js
  outputs/kaoyan-schedule-app/cloudflare/ai-config.js
  outputs/kaoyan-schedule-app/cloudflare/ai.js
  outputs/kaoyan-schedule-app/cloudflare/background-jobs.js
  outputs/kaoyan-schedule-app/cloudflare/media.js
  outputs/kaoyan-schedule-app/cloudflare/rename-job.js
  outputs/kaoyan-schedule-app/cloudflare/source-mirror.js
  outputs/kaoyan-schedule-app/scripts/__tests__/install-note-folder-sync-v10.test.cjs
  outputs/kaoyan-schedule-app/scripts/agent-workflow-contracts.cjs
  outputs/kaoyan-schedule-app/scripts/export-agent-runtime.cjs
  outputs/kaoyan-schedule-app/scripts/install-note-folder-sync.ps1
  outputs/kaoyan-schedule-app/scripts/learning-data-store.cjs
  outputs/kaoyan-schedule-app/scripts/note-capture-foreground.test.cjs
  outputs/kaoyan-schedule-app/scripts/note-file-access.cjs
  outputs/kaoyan-schedule-app/scripts/public-lan-parity.test.cjs
  outputs/kaoyan-schedule-app/scripts/start-local-services-hidden.ps1
  outputs/kaoyan-schedule-app/scripts/windows-note-folder-sync.ps1
  outputs/kaoyan-schedule-app/src/components/ImageViewer.tsx
  outputs/kaoyan-schedule-app/src/components/NoteDropApp.tsx
  outputs/kaoyan-schedule-app/src/image-viewer.css
  outputs/kaoyan-schedule-app/src/note-drop-mobile.css
  outputs/kaoyan-schedule-app/src/utils/learningData.ts
  outputs/kaoyan-schedule-app/src/utils/notes.ts
)

STAGE=fetch-reviewed-business
git fetch origin "$repo_branch" "$business_branch"
git cat-file -e "$business_sha^{commit}"

STAGE=prepare-clean-index
git checkout -B "$clean_branch" "$business_sha"
# Move the branch back to production while retaining the validated business tree in the working directory.
git reset --mixed "origin/$repo_branch"

STAGE=stage-business-whitelist
git add -- "${business_files[@]}"
changed_files="$(git diff --cached --name-only)"
printf '%s\n' "$changed_files"

expected_count="${#business_files[@]}"
actual_count="$(grep -c . <<< "$changed_files")"
if [[ "$actual_count" -ne "$expected_count" ]]; then
  echo "Expected $expected_count business files, staged $actual_count." >&2
  git diff --cached --name-status
  exit 1
fi

for expected in "${business_files[@]}"; do
  if ! grep -Fxq "$expected" <<< "$changed_files"; then
    echo "Missing approved business file: $expected" >&2
    exit 1
  fi
done

if grep -Ev '^outputs/kaoyan-schedule-app/' <<< "$changed_files" | grep -q .; then
  echo 'A non-application file entered the clean diff.' >&2
  exit 1
fi
if grep -Eq '\.cmd$|/\.github/|scripts/\.apply-real-learning-records-v1$' <<< "$changed_files"; then
  echo 'A construction, command, or migration-marker file entered the clean diff.' >&2
  exit 1
fi

STAGE=commit-clean-delivery
git config user.name 'Kaoyan Clean Delivery'
git config user.email 'kaoyan-clean-delivery@local.invalid'
git commit -m 'fix: enforce LAN parity for public capture and sync'
CLEAN_SHA="$(git rev-parse HEAD)"

STAGE=push-clean-delivery
git push origin "HEAD:$clean_branch"

STATUS=success
STAGE=completed
echo "clean_branch=$clean_branch"
echo "clean_sha=$CLEAN_SHA"
git diff --name-status "origin/$repo_branch" HEAD
