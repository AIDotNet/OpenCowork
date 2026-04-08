# Build the .NET AOT sidecar for the current platform
# Usage: .\scripts\build-sidecar.ps1 [-Runtime win-x64|win-arm64|osx-x64|osx-arm64|linux-x64|linux-arm64] [-Configuration Release]

param(
    [string]$Runtime = "",
    [string]$Configuration = "Release"
)

$ProjectPath = Join-Path $PSScriptRoot "..\src\dotnet\OpenCowork.Agent\OpenCowork.Agent.csproj"
$OutputBase = Join-Path $PSScriptRoot "..\resources\sidecar"

# Force UTF-8 for native tool output to avoid mojibake in Windows terminals and log viewers.
if ($IsWindows -or $env:OS -eq "Windows_NT") {
    try {
        chcp 65001 | Out-Null
    } catch {
        # Ignore if the host disallows code page changes.
    }
}

[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$env:DOTNET_CLI_UI_LANGUAGE = "en"

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
$binaryName = "OpenCowork.Agent$ext"
$binary = Join-Path $OutputDir $binaryName
$flatBinary = Join-Path $OutputBase $binaryName

if (Test-Path $binary) {
    $size = (Get-Item $binary).Length
    $sizeMB = [math]::Round($size / 1MB, 2)

    Get-ChildItem $OutputBase -File | ForEach-Object {
        Remove-Item $_.FullName -Force
    }

    Copy-Item $binary $flatBinary -Force

    Write-Host "Built successfully: $binary ($sizeMB MB)" -ForegroundColor Green
    Write-Host "Staged runtime-scoped sidecar assets at $OutputDir" -ForegroundColor Green
    Write-Host "Staged compatibility sidecar binary at $flatBinary" -ForegroundColor Green
} else {
    Write-Host "Binary not found at $binary" -ForegroundColor Yellow
}
