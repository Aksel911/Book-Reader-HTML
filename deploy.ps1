# Book-Reader-HTML deploy to GitHub Pages (PowerShell)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path "index.html")) {
  Write-Host "ERROR: Run from book-reader folder" -ForegroundColor Red
  exit 1
}

Write-Host "Book-Reader-HTML deploy..." -ForegroundColor Green

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host "Install Git: https://git-scm.com" -ForegroundColor Red
  exit 1
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Write-Host "Install GitHub CLI: https://cli.github.com" -ForegroundColor Red
  exit 1
}

gh auth status 2>$null
if ($LASTEXITCODE -ne 0) { gh auth login }

$repo = if ($args.Count -gt 0) { $args[0] } else { "Book-Reader-HTML" }

if (-not (Test-Path ".git")) {
  git init
  git branch -M main
}

@"
.DS_Store
Thumbs.db
*.log
.idea/
.vscode/
node_modules/
"@ | Set-Content -Encoding ascii .gitignore

git add -A
$status = git status --porcelain
if ($status) {
  git commit -m "Deploy Book-Reader-HTML"
}

$hasRemote = $false
try { git remote get-url origin 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $hasRemote = $true } } catch {}

if (-not $hasRemote) {
  gh repo view $repo 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    gh repo create $repo --public --source=. --remote=origin --description "Book Reader for iPhone HTML"
  } else {
    $url = gh repo view $repo --json url -q .url
    git remote add origin "$url.git" 2>$null
    if ($LASTEXITCODE -ne 0) { git remote set-url origin "$url.git" }
  }
}

git branch -M main
git push -u origin main

$full = gh repo view --json nameWithOwner -q .nameWithOwner
gh api "repos/$full/pages" --method POST -f "build_type=legacy" -f "source[branch]=main" -f "source[path]=/" 2>$null | Out-Null
gh api "repos/$full/pages" --method PUT -f "build_type=legacy" -f "source[branch]=main" -f "source[path]=/" 2>$null | Out-Null

$owner, $name = $full.Split('/')
Write-Host ""
Write-Host "DONE" -ForegroundColor Green
Write-Host "Site: https://$owner.github.io/$name/"
Write-Host "Wait 1-2 minutes, open in Safari on iPhone."
