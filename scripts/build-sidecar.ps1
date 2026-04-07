# Build the .NET AOT sidecar for the current platform
# Usage: .\scripts\build-sidecar.ps1 [-Runtime win-x64|win-arm64|osx-x64|osx-arm64|linux-x64|linux-arm64] [-Configuration Release]

param(
    [string]$Runtime = "",
    [string]$Configuration = "Release"
)

$ProjectPath = Join-Path $PSScriptRoot "..\src\dotnet\OpenCowork.Agent\OpenCowork.Agent.csproj"
$OutputBase = Join-Path $PSScriptRoot "..\resources\sidecar"

# Auto-detect runtime if not specified
if (-not $Runtime) {
    if ($IsWindows -or $env:OS -eq "Windows_NT") {
        $Runtime = "win-x64"
    } elseif ($IsMacOS) {
        $arch = & uname -m
        $Runtime = if ($arch -eq "arm64") { "osx-arm64" } else { "osx-x64" }
    } else {
        $Runtime = "linux-x64"
    }
}

$OutputDir = Join-Path $OutputBase $Runtime

Write-Host "Building .NET AOT sidecar for $Runtime ($Configuration)..." -ForegroundColor Cyan

dotnet publish $ProjectPath `
    --configuration $Configuration `
    --runtime $Runtime `
    --output $OutputDir `
    /p:PublishAot=true `
    /p:TrimMode=full `
    /p:IlcOptimizationPreference=Speed `
    /p:StripSymbols=true

if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed!" -ForegroundColor Red
    exit 1
}

# Report binary size
$ext = if ($Runtime.StartsWith("win")) { ".exe" } else { "" }
$binary = Join-Path $OutputDir "OpenCowork.Agent$ext"

if (Test-Path $binary) {
    $size = (Get-Item $binary).Length
    $sizeMB = [math]::Round($size / 1MB, 2)

    Get-ChildItem $OutputBase -File | ForEach-Object {
        Remove-Item $_.FullName -Force
    }

    Write-Host "Built successfully: $binary ($sizeMB MB)" -ForegroundColor Green
    Write-Host "Staged sidecar assets at $OutputDir" -ForegroundColor Green
} else {
    Write-Host "Binary not found at $binary" -ForegroundColor Yellow
}
