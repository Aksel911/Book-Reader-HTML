@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>&1

title Book-Reader-HTML deploy

cd /d "%~dp0"

echo.
echo ==============================================
echo   Book-Reader-HTML - deploy to GitHub Pages
echo ==============================================
echo.

if not exist "index.html" (
  echo ERROR: Run this bat from the book-reader folder.
  echo index.html not found.
  goto :fail
)

where git >nul 2>&1
if errorlevel 1 (
  echo ERROR: Git is not installed.
  echo Download: https://git-scm.com
  goto :fail
)

where gh >nul 2>&1
if errorlevel 1 (
  echo ERROR: GitHub CLI gh is not installed.
  echo Download: https://cli.github.com
  echo Then run: gh auth login
  goto :fail
)

gh auth status >nul 2>&1
if errorlevel 1 (
  echo GitHub login required...
  gh auth login
  if errorlevel 1 (
    echo ERROR: GitHub auth failed.
    goto :fail
  )
)

set "REPO=Book-Reader-HTML"

echo [1/5] Git init...
if not exist ".git" (
  git init
  if errorlevel 1 goto :fail
  git branch -M main
)

if not exist ".gitignore" (
  echo .DS_Store> .gitignore
  echo Thumbs.db>> .gitignore
  echo *.log>> .gitignore
  echo .idea/>> .gitignore
  echo .vscode/>> .gitignore
  echo node_modules/>> .gitignore
)

echo [2/5] Commit...
git add -A
git status --porcelain > "%TEMP%\br_status.txt" 2>nul
for %%A in ("%TEMP%\br_status.txt") do set "STSIZE=%%~zA"
if not "%STSIZE%"=="0" (
  git commit -m "Deploy Book-Reader-HTML"
  if errorlevel 1 (
    echo WARNING: commit failed or nothing to commit
  ) else (
    echo       Commit OK
  )
) else (
  echo       No new changes
)

echo [3/5] GitHub repository...
git remote get-url origin >nul 2>&1
if errorlevel 1 (
  gh repo view "%REPO%" >nul 2>&1
  if errorlevel 1 (
    echo       Creating public repo %REPO% ...
    gh repo create "%REPO%" --public --source=. --remote=origin --description "Book Reader for iPhone HTML"
    if errorlevel 1 (
      echo ERROR: could not create repository
      goto :fail
    )
  ) else (
    echo       Repo exists, linking remote...
    for /f "usebackq delims=" %%u in (`gh repo view %REPO% --json url -q .url 2^>nul`) do (
      git remote add origin "%%u.git" 2>nul
      if errorlevel 1 git remote set-url origin "%%u.git"
    )
  )
) else (
  echo       origin already set
)

echo [4/5] Push...
git branch -M main 2>nul
git push -u origin main
if errorlevel 1 (
  echo ERROR: git push failed
  goto :fail
)

echo [5/5] Enable GitHub Pages...
set "FULL="
for /f "usebackq delims=" %%f in (`gh repo view --json nameWithOwner -q .nameWithOwner 2^>nul`) do set "FULL=%%f"

if defined FULL (
  gh api repos/%FULL%/pages --method POST -f build_type=legacy -f source[branch]=main -f source[path]=/ >nul 2>&1
  gh api repos/%FULL%/pages --method PUT -f build_type=legacy -f source[branch]=main -f source[path]=/ >nul 2>&1

  for /f "tokens=1,2 delims=/" %%a in ("%FULL%") do (
    set "OWNER=%%a"
    set "RNAME=%%b"
  )
)

echo.
echo ==============================================
echo   DONE
echo.
if defined OWNER (
  echo   Site: https://%OWNER%.github.io/%RNAME%/
) else (
  echo   Site: https://YOUR_USERNAME.github.io/Book-Reader-HTML/
  echo   Enable Pages manually: Settings - Pages - main - root
)
echo.
echo   Wait 1-2 minutes, then open the link in Safari on iPhone.
echo ==============================================
echo.
pause
exit /b 0

:fail
echo.
echo Deploy failed. See messages above.
pause
exit /b 1
