# Fix Node.js AutoRun Registry Error
# This script removes invalid AutoRun entries that cause node.exe errors

Write-Host "Fixing Node.js AutoRun Registry Error..." -ForegroundColor Cyan
Write-Host ""

$AutoRunPaths = @(
    "HKCU:\Software\Microsoft\Command Processor",
    "HKLM:\Software\Microsoft\Command Processor"
)

$Found = $false

foreach ($Path in $AutoRunPaths) {
    if (Test-Path $Path) {
        $AutoRunValue = Get-ItemProperty -Path $Path -Name "AutoRun" -ErrorAction SilentlyContinue
        if ($AutoRunValue) {
            Write-Host "Found AutoRun in: $Path" -ForegroundColor Yellow
            Write-Host "  Current value: $($AutoRunValue.AutoRun)" -ForegroundColor Gray
            Write-Host ""
            
            $Remove = Read-Host "Remove this AutoRun entry? (y/N)"
            if ($Remove -eq "y" -or $Remove -eq "Y") {
                Remove-ItemProperty -Path $Path -Name "AutoRun" -Force
                Write-Host "  Removed successfully" -ForegroundColor Green
                $Found = $true
            }
        }
    }
}

if (-not $Found) {
    Write-Host "No AutoRun entries found in standard locations." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Trying alternative method..." -ForegroundColor Cyan
    Write-Host ""
    
    # Check for node.exe specific AutoRun
    $NodeAutoRunPath = "HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\node.exe"
    if (Test-Path $NodeAutoRunPath) {
        Write-Host "Found node.exe execution options: $NodeAutoRunPath" -ForegroundColor Yellow
        Get-ItemProperty -Path $NodeAutoRunPath | Format-List
        
        $Remove = Read-Host "Remove node.exe execution options? (y/N)"
        if ($Remove -eq "y" -or $Remove -eq "Y") {
            Remove-Item -Path $NodeAutoRunPath -Recurse -Force
            Write-Host "Removed successfully" -ForegroundColor Green
        }
    } else {
        Write-Host "No problematic entries found." -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "Please restart PowerShell and try the release script again." -ForegroundColor Cyan
Write-Host ""
