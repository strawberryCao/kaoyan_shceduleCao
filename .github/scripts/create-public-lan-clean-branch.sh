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
  detail="$(tail -n 160 "$LOG_FILE" 2>/dev/null || true)"
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
    'detail': os.environ.get('DETAIL', '')[-20000:],
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

STAGE=fetch-reviewed-business
git fetch origin "$repo_branch" "$business_branch"
git cat-file -e "$business_sha^{commit}"

STAGE=prepare-clean-index
git checkout -B "$clean_branch" "$business_sha"
git reset --soft "origin/$repo_branch"

# Restore repository CI and remove all one-time construction files.
git checkout "origin/$repo_branch" -- .github
rm -rf outputs/kaoyan-schedule-app/.github

git checkout "origin/$repo_branch" -- \
  outputs/kaoyan-schedule-app/scripts/.apply-real-learning-records-v1 \
  outputs/kaoyan-schedule-app/取消开机自启.cmd \
  outputs/kaoyan-schedule-app/安装依赖.cmd \
  outputs/kaoyan-schedule-app/导入敦煌壁纸图片.cmd \
  outputs/kaoyan-schedule-app/收集环境信息.cmd \
  outputs/kaoyan-schedule-app/整理笔记元数据.cmd \
  outputs/kaoyan-schedule-app/测试千问连接.cmd \
  outputs/kaoyan-schedule-app/生成敦煌动态壁纸视频.cmd \
  outputs/kaoyan-schedule-app/设置开机自启.cmd \
  outputs/kaoyan-schedule-app/配置千问命名.cmd

git add -A

STAGE=audit-clean-diff
changed_files="$(git diff --cached --name-only)"
printf '%s\n' "$changed_files"

if grep -Eq '^\.github/(scripts|validation|workflows)/.*public-lan|^outputs/kaoyan-schedule-app/\.github/' <<< "$changed_files"; then
  echo 'Construction files remain in the clean diff.' >&2
  exit 1
fi
if grep -Eq '^outputs/kaoyan-schedule-app/.*\.cmd$|scripts/\.apply-real-learning-records-v1$' <<< "$changed_files"; then
  echo 'Non-business command or migration marker changes remain.' >&2
  exit 1
fi

changed_count="$(grep -c . <<< "$changed_files")"
if [[ "$changed_count" -lt 20 || "$changed_count" -gt 30 ]]; then
  echo "Unexpected clean business file count: $changed_count" >&2
  git diff --cached --name-status
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
