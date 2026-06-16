# LANAgent Windows Setup Guide
# Run: powershell -ExecutionPolicy Bypass -File scripts/setup/install.ps1

Write-Host ""
Write-Host "  LANAgent Windows Setup" -ForegroundColor Cyan
Write-Host "  ======================" -ForegroundColor Cyan
Write-Host ""

# Check for Docker
$hasDocker = $null -ne (Get-Command docker -ErrorAction SilentlyContinue)
$hasWSL = $null -ne (Get-Command wsl -ErrorAction SilentlyContinue)

if ($hasDocker) {
    Write-Host "  [OK] Docker found" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Recommended: Use Docker for the easiest setup." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Steps:" -ForegroundColor White
    Write-Host "    1. Copy .env.example to .env" -ForegroundColor Gray
    Write-Host "    2. Edit .env with your API keys" -ForegroundColor Gray
    Write-Host "    3. Run: docker compose up -d" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Or run the interactive setup in Docker:" -ForegroundColor White
    Write-Host "    docker run -it --rm -v ${PWD}:/app -w /app node:20-slim bash scripts/setup/install.sh --docker" -ForegroundColor Cyan
    Write-Host ""
}
elseif ($hasWSL) {
    Write-Host "  [OK] WSL found" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Recommended: Run LANAgent inside WSL2." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Steps:" -ForegroundColor White
    Write-Host "    1. wsl" -ForegroundColor Cyan
    Write-Host "    2. cd /mnt/c/path/to/LANAgent" -ForegroundColor Cyan
    Write-Host "    3. ./scripts/setup/install.sh" -ForegroundColor Cyan
    Write-Host ""
}
else {
    Write-Host "  Neither Docker nor WSL2 found." -ForegroundColor Red
    Write-Host ""
    Write-Host "  LANAgent requires a Linux environment. Options:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Option 1 (Easiest): Install Docker Desktop" -ForegroundColor White
    Write-Host "    https://www.docker.com/products/docker-desktop/" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  Option 2: Install WSL2" -ForegroundColor White
    Write-Host "    wsl --install" -ForegroundColor Cyan
    Write-Host "    (Restart, then run this script again)" -ForegroundColor Gray
    Write-Host ""
}

Write-Host "  Documentation: README.md" -ForegroundColor DarkGray
Write-Host ""
