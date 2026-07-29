# REFUGIO Zero-Prereq Installer for Windows
# Usage: irm https://raw.githubusercontent.com/Phantazein-apps/refugio/main/install-refugio.ps1 | iex

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "============================================================" -ForegroundColor White
Write-Host " REFUGIO Installer" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor White
Write-Host ""

# ── Install Node.js if missing ────────────────────────────────

function Install-NodeIfMissing {
    try {
        $nodeVer = (node --version 2>$null)
        if ($nodeVer) {
            $major = [int]($nodeVer -replace 'v(\d+)\..*', '$1')
            if ($major -ge 18) {
                Write-Host "  ✓ Node.js ($nodeVer)" -ForegroundColor Green
                return
            }
            Write-Host "  ! Node.js $nodeVer is too old — upgrading..." -ForegroundColor Yellow
        }
    } catch {}

    Write-Host "  ! Node.js not found — installing..." -ForegroundColor Yellow

    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    } elseif (Get-Command choco -ErrorAction SilentlyContinue) {
        choco install nodejs-lts -y
    } else {
        Write-Host "  ✗ Could not find winget or choco — install Node.js 18+ from https://nodejs.org" -ForegroundColor Red
        exit 1
    }

    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

    try {
        $nodeVer = (node --version)
        Write-Host "  ✓ Node.js installed ($nodeVer)" -ForegroundColor Green
    } catch {
        Write-Host "  ✗ Node.js installation failed — install manually from https://nodejs.org" -ForegroundColor Red
        exit 1
    }
}

# ── Install Git if missing ────────────────────────────────────

function Install-GitIfMissing {
    try {
        $gitVer = (git --version 2>$null)
        if ($gitVer) {
            Write-Host "  ✓ $gitVer" -ForegroundColor Green
            return
        }
    } catch {}

    Write-Host "  ! Git not found — installing..." -ForegroundColor Yellow

    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install Git.Git --accept-package-agreements --accept-source-agreements
    } elseif (Get-Command choco -ErrorAction SilentlyContinue) {
        choco install git -y
    } else {
        Write-Host "  ✗ Could not find winget or choco — install Git from https://git-scm.com" -ForegroundColor Red
        exit 1
    }

    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

    try {
        git --version | Out-Null
        Write-Host "  ✓ Git installed" -ForegroundColor Green
    } catch {
        Write-Host "  ✗ Git installation failed — install manually from https://git-scm.com" -ForegroundColor Red
        exit 1
    }
}

# ── Main ──────────────────────────────────────────────────────

Install-GitIfMissing
Install-NodeIfMissing

Write-Host ""

# Download and run the Node installer
# Use a unique temp file name (no .js extension needed)
$tmpFile = Join-Path $env:TEMP "refugio-install-$(Get-Random).cjs"
try {
    # Same pin as the bash installer. This used to fetch from main unconditionally,
    # so a Windows install ignored REFUGIO_VERSION entirely and took whatever was
    # on the integration branch — the one thing pinning exists to prevent.
    if (-not $env:REFUGIO_VERSION) { $env:REFUGIO_VERSION = "v2.0.0-beta.2" }
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/Phantazein-apps/refugio/$($env:REFUGIO_VERSION)/install-node.cjs" -OutFile $tmpFile
    # Run node with stdin connected to the console (not the pipe)
    Start-Process -FilePath "node" -ArgumentList $tmpFile -NoNewWindow -Wait
} finally {
    Remove-Item $tmpFile -ErrorAction SilentlyContinue
}
