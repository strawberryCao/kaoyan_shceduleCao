#!/usr/bin/env bash
set -Eeuo pipefail

repo_branch='fix/learning-detail-title-latex'
clean_branch='fix/public-lan-parity-clean'
business_branch='review/public-lan-parity-business'
business_sha='7bf7971049aa946c485d1ecfb4e51356116fba8f'

# The business SHA has already passed 193/193 tests, production build and Worker dry-run.
git fetch origin "$repo_branch" "$business_branch"
git cat-file -e "$business_sha^{commit}"
git checkout -B "$clean_branch" "$business_sha"
git reset --soft "origin/$repo_branch"

# Restore repository CI and remove all one-time construction files.
git restore --source="origin/$repo_branch" --staged --worktree -- .github
rm -rf outputs/kaoyan-schedule-app/.github

git restore --source="origin/$repo_branch" --staged --worktree -- \
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

# Fail closed if any construction file survives.
if git diff --cached --name-only | grep -E '^\.github/(scripts|validation|workflows)/.*public-lan-parity|^outputs/kaoyan-schedule-app/\.github/'; then
  echo 'Construction files remain in the clean diff.' >&2
  exit 1
fi

# Fail closed if line-ending-only command files or the migration marker remain changed.
if git diff --cached --name-only | grep -E '^outputs/kaoyan-schedule-app/.*\.cmd$|scripts/\.apply-real-learning-records-v1$'; then
  echo 'Non-business command or migration marker changes remain.' >&2
  exit 1
fi

changed_count="$(git diff --cached --name-only | wc -l | tr -d ' ')"
if [[ "$changed_count" -lt 20 || "$changed_count" -gt 30 ]]; then
  echo "Unexpected clean business file count: $changed_count" >&2
  git diff --cached --name-status
  exit 1
fi

git config user.name 'Kaoyan Clean Delivery'
git config user.email 'kaoyan-clean-delivery@local.invalid'
git commit -m 'fix: enforce LAN parity for public capture and sync'
git push --force-with-lease origin "HEAD:$clean_branch"

echo "clean_branch=$clean_branch"
echo "clean_sha=$(git rev-parse HEAD)"
git diff --name-status "origin/$repo_branch" HEAD
