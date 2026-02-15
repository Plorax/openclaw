# post-update-deploy.ps1 — Re-deploys custom OpenClaw patches after an npm update
# Run from anywhere. Builds source and copies over the installed package.
# Usage: pwsh -ExecutionPolicy Bypass -File post-update-deploy.ps1

$ErrorActionPreference = "Stop"
$src = "C:\Users\jacqu\.openclaw\workspace\openclaw-src"
$dst = "C:\apps\nvm\v22.12.0\node_modules\openclaw"

# Check if source version matches installed (skip if already deployed)
$srcVer = (Get-Content "$src\package.json" | ConvertFrom-Json).version
$dstVer = (Get-Content "$dst\package.json" | ConvertFrom-Json).version
if ($srcVer -eq $dstVer) {
    # Versions match — check if our custom TTS is present
    $hasTts = Select-String -Path "$dst\dist\plugin-sdk\tts\tts.d.ts" -Pattern "kokoro" -Quiet
    if ($hasTts) {
        Write-Host "Already deployed (v$dstVer with custom patches). Skipping." -ForegroundColor Green
        exit 0
    }
}

Write-Host "Deploying custom patches (src: v$srcVer, installed: v$dstVer)..." -ForegroundColor Cyan

# Build
Write-Host "Building..." -ForegroundColor Cyan
cmd /c "cd /d $src && pnpm tsdown"
if ($LASTEXITCODE -ne 0) { Write-Host "Build failed!" -ForegroundColor Red; exit 1 }

# Deploy
Write-Host "Copying files..." -ForegroundColor Cyan
foreach ($d in @("dist","ui","skills","docs","assets")) {
    xcopy /E /Y /Q "$src\$d\*" "$dst\$d\" | Out-Null
}
robocopy "$src\extensions" "$dst\extensions" /E /NFL /NDL /NJH /NJS /XD node_modules | Out-Null
Copy-Item "$src\package.json" "$dst\package.json" -Force

Write-Host "Done! Custom patches deployed on v$dstVer." -ForegroundColor Green
Write-Host "Restart gateway: cmd /c 'openclaw gateway stop' then 'openclaw gateway start'" -ForegroundColor Yellow
