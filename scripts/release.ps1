# OpenCowork Quick Release Script (PowerShell)
# Usage: .\scripts\release.ps1 <version>
# Example: .\scripts\release.ps1 0.9.117

param(
    [Parameter(Mandatory=$true)]
    [string]$Version
)

$ErrorActionPreference = "Stop"

# Check version format
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Write-Host "[ERROR] Invalid version format: $Version" -ForegroundColor Red
    Write-Host "   Correct format: 0.9.117 (major.minor.patch)" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Note: Do not include 'v' prefix (script will add it automatically)" -ForegroundColor Yellow
    exit 1
}

Write-Host "[INFO] OpenCowork Quick Release Tool" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "[INFO] Target version: v$Version" -ForegroundColor Green
Write-Host ""

# Check required tools
Write-Host "[CHECK] Checking environment..." -ForegroundColor Yellow

# Check git
try {
    $null = Get-Command git -ErrorAction Stop
} catch {
    Write-Host "[ERROR] git not found, please install it first" -ForegroundColor Red
    exit 1
}

# Check npm
try {
    $null = Get-Command npm -ErrorAction Stop
} catch {
    Write-Host "[ERROR] npm not found, please install Node.js" -ForegroundColor Red
    exit 1
}

# Check gh CLI
$SkipGH = $false
try {
    $null = Get-Command gh -ErrorAction Stop
    
    # Check GitHub login status
    $ghStatus = gh auth status 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Not logged in to GitHub, please run: gh auth login" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "[WARN] gh CLI not found, will skip automatic Release creation" -ForegroundColor Yellow
    Write-Host "   Install: https://cli.github.com/" -ForegroundColor Gray
    $SkipGH = $true
}

# Check current branch
$Branch = git branch --show-current
Write-Host "[INFO] Current branch: $Branch" -ForegroundColor Green

# Check for uncommitted changes
$GitStatus = git status --porcelain
if ($GitStatus) {
    Write-Host "[WARN] You have uncommitted changes, please commit or stash first" -ForegroundColor Yellow
    Write-Host ""
    git status --short
    Write-Host ""
    $Continue = Read-Host "Continue anyway? (y/N)"
    if ($Continue -ne "y" -and $Continue -ne "Y") {
        Write-Host "[CANCEL] Release cancelled" -ForegroundColor Red
        exit 0
    }
}

Write-Host ""
Write-Host "[PRE-CHECK] Pre-release checks..." -ForegroundColor Yellow

# 1. Type check
Write-Host "  [1/3] Running type check..." -ForegroundColor Gray
$TypeCheckOutput = npm run typecheck 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Type check failed, please fix errors before release" -ForegroundColor Red
    Write-Host $TypeCheckOutput
    exit 1
}
Write-Host "  [PASS] Type check passed" -ForegroundColor Green

# 2. Update version
Write-Host "  [2/3] Updating version to $Version..." -ForegroundColor Gray
npm version $Version --no-git-tag-version
Write-Host "  [PASS] Version updated" -ForegroundColor Green

# 3. Commit version change
Write-Host "  [3/3] Committing version change..." -ForegroundColor Gray
git add package.json
git commit -m "chore(release): bump version to $Version"
git push origin $Branch
Write-Host "  [PASS] Pushed to remote" -ForegroundColor Green

Write-Host ""

# 4. Create GitHub Release
if (-not $SkipGH) {
    Write-Host "[RELEASE] Creating GitHub Release..." -ForegroundColor Yellow
    
    $Tag = "v$Version"
    
    gh release create $Tag `
        --title "Release $Tag" `
        --target $Branch `
        --generate-notes `
        --verify-tag
    
    Write-Host ""
    Write-Host "[SUCCESS] Release created: https://github.com/smawatch/OpenCowork/releases/tag/$Tag" -ForegroundColor Green
    Write-Host ""
    Write-Host "[INFO] CI/CD is building automatically..." -ForegroundColor Cyan
    Write-Host "   View progress: https://github.com/smawatch/OpenCowork/actions" -ForegroundColor Gray
    Write-Host ""
    Write-Host "[INFO] Estimated build time: 20-40 minutes" -ForegroundColor Gray
    Write-Host ""
    Write-Host "[INFO] Build will upload the following platforms:" -ForegroundColor Cyan
    Write-Host "   - Windows (x64/arm64)" -ForegroundColor Gray
    Write-Host "   - Linux (x64/arm64)" -ForegroundColor Gray
    Write-Host "   - macOS (arm64/x64)" -ForegroundColor Gray
} else {
    Write-Host "[ACTION] Please create GitHub Release manually:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "   1. Visit: https://github.com/smawatch/OpenCowork/releases/new" -ForegroundColor Gray
    Write-Host "   2. Tag version: v$Version" -ForegroundColor Gray
    Write-Host "   3. Release title: Release v$Version" -ForegroundColor Gray
    Write-Host "   4. Fill in release notes" -ForegroundColor Gray
    Write-Host "   5. Click 'Publish release'" -ForegroundColor Gray
    Write-Host ""
    Write-Host "   Or use GitHub CLI:" -ForegroundColor Gray
    Write-Host "   gh release create v$Version --title 'Release v$Version' --target $Branch --generate-notes" -ForegroundColor Gray
}

Write-Host ""
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "[DONE] Release process completed!" -ForegroundColor Green
Write-Host ""
Write-Host "[NEXT] Next steps:" -ForegroundColor Yellow
Write-Host "  1. Monitor CI/CD build progress" -ForegroundColor Gray
Write-Host "  2. Check if Release Assets are complete" -ForegroundColor Gray
Write-Host "  3. Download one installer for local testing" -ForegroundColor Gray
Write-Host "  4. Verify clients can detect the update" -ForegroundColor Gray
Write-Host ""
