#!/usr/bin/env bash
# SessionStart hook: the owner works on several PCs, so say whether this checkout is behind
# origin/main and whether uncommitted work is lying around. Never fails the session.
cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" 2>/dev/null || exit 0
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0
if timeout 8 git fetch -q origin "$branch" 2>/dev/null; then
  behind=$(git rev-list --count "HEAD..origin/$branch" 2>/dev/null || echo 0)
  ahead=$(git rev-list --count "origin/$branch..HEAD" 2>/dev/null || echo 0)
  if [ "$behind" -gt 0 ]; then
    state="⚠ 이 PC는 origin/$branch보다 ${behind}커밋 뒤에 있습니다. 먼저 git pull 하세요."
  elif [ "$ahead" -gt 0 ]; then
    state="origin/$branch보다 ${ahead}커밋 앞서 있습니다. 작업 전에 git push를 잊지 마세요."
  else
    state="origin/$branch와 같은 상태입니다."
  fi
else
  state="origin을 확인하지 못했습니다(오프라인?). git pull 여부를 직접 확인하세요."
fi
dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
[ "$dirty" -gt 0 ] && state="$state 커밋되지 않은 변경 ${dirty}개가 있습니다."
rc="외출 중 폰에서 이 세션을 이어가려면 Remote Control을 켜 두세요 (claude --rc 로 시작하거나 claude remote-control 실행)."
escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
printf '{"systemMessage":"%s"}\n' "$(escape "$state $rc")"
