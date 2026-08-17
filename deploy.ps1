# Умный Читатель — деплой на GitHub Pages (PowerShell / Windows)
# Требуется: git, GitHub CLI (gh) — https://cli.github.com

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path "index.html")) {
  Write-Error "Запусти скрипт из папки book-reader"
}

Write-Host "📚 Деплой Умный Читатель..." -ForegroundColor Green

if (-not (Test-Path ".git")) {
  git init
  git branch -M main
}

if (-not (Test-Path ".gitignore")) {
  @"
.DS_Store
Thumbs.db
*.log
.idea/
.vscode/
node_modules/
"@ | Set-Content .gitignore
}

git add -A
$hasChanges = git status --porcelain
if ($hasChanges) {
  git commit -m "Deploy Умный Читатель $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
}

$repo = if ($args[0]) { $args[0] } else { "Book-Reader-HTML" }

$remoteExists = $false
try { git remote get-url origin | Out-Null; $remoteExists = $true } catch {}

if (-not $remoteExists) {
  if (Get-Command gh -ErrorAction SilentlyContinue) {
    gh auth status 2>$null
    if ($LASTEXITCODE -ne 0) { gh auth login }
    gh repo create $repo --public --source=. --remote=origin --description "Умный Читатель"
  } else {
    Write-Host "Установи GitHub CLI: https://cli.github.com" -ForegroundColor Yellow
    Write-Host "Или добавь remote вручную и сделай git push"
    exit 1
  }
}

git push -u origin main

# Enable Pages
$full = gh repo view --json nameWithOwner -q .nameWithOwner
try {
  gh api "repos/$full/pages" --method POST -f "build_type=legacy" -f "source[branch]=main" -f "source[path]=/" 2>$null
} catch {
  try {
    gh api "repos/$full/pages" --method PUT -f "build_type=legacy" -f "source[branch]=main" -f "source[path]=/" 2>$null
  } catch {}
}

$owner = $full.Split('/')[0]
$name = $full.Split('/')[1]
Write-Host ""
Write-Host "✓ Готово!" -ForegroundColor Green
Write-Host "Сайт: https://$owner.github.io/$name/"
Write-Host "Подожди 1-2 минуты и открой в Safari на iPhone."
