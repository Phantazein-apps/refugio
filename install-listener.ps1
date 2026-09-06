# REFUGIO Listener Zero-Prereq Installer for Windows
# Usage: irm https://raw.githubusercontent.com/Phantazein-apps/refugio/main/install-listener.ps1 | iex
#
# See install-listener (the bash twin) for what this product is and why this is
# a wrapper rather than a second copy of install-refugio.ps1.

$ErrorActionPreference = "Stop"

$env:REFUGIO_EDITION = "listener"
if (-not $env:REFUGIO_VERSION) { $env:REFUGIO_VERSION = "v2.0.0-beta.2" }

$bootstrap = Invoke-RestMethod -Uri "https://raw.githubusercontent.com/Phantazein-apps/refugio/$($env:REFUGIO_VERSION)/install-refugio.ps1"
Invoke-Expression $bootstrap
