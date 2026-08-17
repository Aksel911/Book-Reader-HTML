#!/usr/bin/env bash
# ============================================================
#  Умный Читатель — автоматический деплой на GitHub Pages
# ============================================================
#  Использование:
#    ./deploy.sh                  # деплой в репозиторий по умолчанию
#    ./deploy.sh my-repo-name     # указать имя репозитория
#    ./deploy.sh user/repo        # указать owner/repo
#
#  Требования: git, и (желательно) GitHub CLI (gh)
# ============================================================

set -euo pipefail

# Цвета
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}→${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}!${NC} $*"; }
err()   { echo -e "${RED}✗${NC} $*" >&2; }

# --- Проверки ---
cd "$(dirname "$0")"

if [[ ! -f index.html ]]; then
  err "Запусти скрипт из папки book-reader (рядом с index.html)"
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  err "Git не установлен. Установи: https://git-scm.com"
  exit 1
fi

HAS_GH=false
if command -v gh >/dev/null 2>&1; then
  HAS_GH=true
fi

# --- Имя репозитория ---
REPO_ARG="${1:-Book-Reader-HTML}"
if [[ "$REPO_ARG" == */* ]]; then
  OWNER="${REPO_ARG%%/*}"
  REPO="${REPO_ARG##*/}"
else
  REPO="$REPO_ARG"
  OWNER=""
fi

COMMIT_MSG="${DEPLOY_MSG:-Deploy Умный Читатель $(date '+%Y-%m-%d %H:%M')}"

echo ""
echo -e "${GREEN}📚 Умный Читатель — деплой на GitHub Pages${NC}"
echo "=============================================="

# --- Git init ---
if [[ ! -d .git ]]; then
  info "Инициализация git-репозитория..."
  git init
  git branch -M main
  ok "git init"
fi

# --- .gitignore ---
if [[ ! -f .gitignore ]]; then
  cat > .gitignore << 'GI'
.DS_Store
Thumbs.db
*.log
.idea/
.vscode/
node_modules/
GI
  ok "Создан .gitignore"
fi

# --- Commit ---
info "Добавление файлов..."
git add -A

if git diff --cached --quiet 2>/dev/null; then
  warn "Нет новых изменений для коммита"
else
  git commit -m "$COMMIT_MSG" || true
  ok "Коммит: $COMMIT_MSG"
fi

# --- Remote / GitHub ---
REMOTE_URL=""
if git remote get-url origin >/dev/null 2>&1; then
  REMOTE_URL=$(git remote get-url origin)
  ok "Remote origin: $REMOTE_URL"
else
  if $HAS_GH; then
    info "Создание репозитория на GitHub через gh..."
    # Проверка авторизации
    if ! gh auth status >/dev/null 2>&1; then
      warn "Нужен вход в GitHub CLI:"
      gh auth login
    fi

    if [[ -n "$OWNER" ]]; then
      FULL="$OWNER/$REPO"
    else
      FULL="$REPO"
    fi

    # Создать репозиторий, если ещё нет
    if gh repo view "$FULL" >/dev/null 2>&1; then
      ok "Репозиторий $FULL уже существует"
      gh repo set-default "$FULL" 2>/dev/null || true
      git remote add origin "$(gh repo view "$FULL" --json url -q .url).git" 2>/dev/null || \
        git remote set-url origin "$(gh repo view "$FULL" --json url -q .url).git"
    else
      gh repo create "$FULL" --public --source=. --remote=origin --description "Умный Читатель — book reader for iPhone"
      ok "Репозиторий создан: $FULL"
    fi
    REMOTE_URL=$(git remote get-url origin)
  else
    err "Нет remote origin и не установлен GitHub CLI (gh)."
    echo ""
    echo "Варианты:"
    echo "  1) Установи GitHub CLI: https://cli.github.com"
    echo "     затем снова: ./deploy.sh"
    echo ""
    echo "  2) Создай репозиторий вручную на github.com и выполни:"
    echo "     git remote add origin https://github.com/ТВОЙ-ЛОГИН/${REPO}.git"
    echo "     git push -u origin main"
    echo "     Затем Settings → Pages → Branch: main / root"
    exit 1
  fi
fi

# --- Push ---
info "Пуш в origin main..."
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo main)
if [[ "$CURRENT_BRANCH" != "main" && "$CURRENT_BRANCH" != "master" ]]; then
  git branch -M main
fi

git push -u origin main

ok "Код загружен на GitHub"

# --- Включить GitHub Pages ---
PAGES_URL=""
if $HAS_GH; then
  info "Включение GitHub Pages..."
  # Получить owner/repo из remote
  if [[ -z "${FULL:-}" ]]; then
    # parse from remote
    REMOTE_URL=$(git remote get-url origin)
    # support https and git@
    if [[ "$REMOTE_URL" =~ github.com[:/]([^/]+)/([^/.]+) ]]; then
      FULL="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
    fi
  fi

  if [[ -n "${FULL:-}" ]]; then
    # gh api to set pages
    if gh api "repos/$FULL/pages" --method POST \
      -f "build_type=legacy" \
      -f "source[branch]=main" \
      -f "source[path]=/" >/dev/null 2>&1; then
      ok "GitHub Pages включён"
    else
      # Возможно уже включено — обновить
      gh api "repos/$FULL/pages" --method PUT \
        -f "build_type=legacy" \
        -f "source[branch]=main" \
        -f "source[path]=/" >/dev/null 2>&1 || \
      warn "Pages уже настроены или нет прав — проверь Settings → Pages вручную"
    fi

    # URL
    OWNER_NAME="${FULL%%/*}"
    REPO_NAME="${FULL##*/}"
    PAGES_URL="https://${OWNER_NAME}.github.io/${REPO_NAME}/"
  fi
fi

echo ""
echo "=============================================="
ok "Деплой завершён!"
echo ""
if [[ -n "$PAGES_URL" ]]; then
  echo -e "  ${GREEN}Сайт:${NC}  $PAGES_URL"
  echo ""
  echo "  Подожди 1–2 минуты, пока GitHub соберёт сайт,"
  echo "  затем открой ссылку в Safari на iPhone."
else
  echo "  Включи Pages вручную:"
  echo "  GitHub → репозиторий → Settings → Pages"
  echo "  Source: Deploy from a branch → main → / (root) → Save"
  echo ""
  echo "  Адрес будет:"
  echo "  https://ТВОЙ-ЛОГИН.github.io/${REPO}/"
fi
echo ""
echo "  На iPhone: Поделиться → На экран «Домой»"
echo "=============================================="
echo ""
