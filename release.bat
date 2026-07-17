@echo off
setlocal enabledelayedexpansion

set SERVER_DIR=C:\Users\Superak0s\Documents\Coding\OwnLift\OwnLift-Server
set DOCKER_IMAGE=superak0s/ownlift-server

echo === OwnLift Server Release Script ===

docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Docker is not running.
    pause & exit /b 1
)

:: ─── [0/3] Version Management ───────────────────────────────────────────────
echo.
echo [0/3] Version management...

for /f "delims=" %%i in ('node -e "console.log(require('%SERVER_DIR:\=\\%/package.json').version)"') do set CURRENT_VERSION=%%i

for /f "delims=" %%i in ('node -e "const v='%CURRENT_VERSION%'.split('.'); v[2]=parseInt(v[2])+1; console.log(v.join('.'))"') do set AUTO_VERSION=%%i

echo Current version: %CURRENT_VERSION%
echo.
echo [1] Auto-increment to %AUTO_VERSION%
echo [2] Enter custom version
echo [3] Keep current version
echo.

set /p VERSION_CHOICE="Choose (1-3, default=1): "
if "%VERSION_CHOICE%"=="" set VERSION_CHOICE=1

if "%VERSION_CHOICE%"=="2" (
    set /p NEW_VERSION="Enter custom version (e.g. 2.0.0): "
    if "!NEW_VERSION!"=="" (
        echo ERROR: No version entered.
        pause & exit /b 1
    )
) else if "%VERSION_CHOICE%"=="3" (
    set NEW_VERSION=%CURRENT_VERSION%
) else (
    set NEW_VERSION=%AUTO_VERSION%
)

echo Updating version to: %NEW_VERSION%

node -e "const fs=require('fs'); const p=require('%SERVER_DIR:\=\\%/package.json'); p.version='%NEW_VERSION%'; fs.writeFileSync('%SERVER_DIR:\=\\%/package.json', JSON.stringify(p, null, 2)+'\n')"

echo Version updated successfully!

:: ─── [1/3] Git Push ─────────────────────────────────────────────────────────
echo.
echo [1/3] Pushing source code to GitHub...

cd /d "%SERVER_DIR%"
git add .

set /p COMMIT_MSG="Enter commit message (or press Enter for default): "
if "%COMMIT_MSG%"=="" set COMMIT_MSG=Release update v%NEW_VERSION%

git diff --cached --quiet
if %errorlevel%==0 (
    echo No changes to commit.
) else (
    git commit -m "%COMMIT_MSG%"
    git push origin main
)

:: ─── [2/3] Build Docker image ───────────────────────────────────────────────
echo.
echo [2/3] Building Docker image...
cd /d "%SERVER_DIR%"

for /f "delims=" %%i in ('node -p "require('./package.json').version"') do set VERSION=%%i

echo Building v%VERSION%...

docker build -t "%DOCKER_IMAGE%:latest" -t "%DOCKER_IMAGE%:%VERSION%" .

if %errorlevel% neq 0 (
    echo ERROR: Docker build failed.
    pause & exit /b 1
)

:: ─── [3/3] Push to Docker Hub ───────────────────────────────────────────────
echo.
echo [3/3] Pushing image to Docker Hub...

docker push "%DOCKER_IMAGE%:latest"
if %errorlevel% neq 0 (
    echo ERROR: Failed to push :latest.
    pause & exit /b 1
)

docker push "%DOCKER_IMAGE%:%VERSION%"
if %errorlevel% neq 0 (
    echo ERROR: Failed to push :%VERSION%.
    pause & exit /b 1
)

echo.
echo === Done! Pushed as :latest and :%VERSION% ===
pause