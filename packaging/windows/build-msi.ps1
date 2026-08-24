<#
  Build (and optionally sign) REFUGIO.msi.

  Signing note, because it is the part that surprises people: since June 2023
  the CA/Browser Forum requires code-signing private keys to live on FIPS
  140-2 Level 2 hardware. A .pfx file on a build agent is no longer how this
  works for a publicly-trusted certificate. The practical options are a cloud
  signing service — Azure Trusted Signing, DigiCert KeyLocker, SSL.com eSigner
  — or a physical token, which cannot be used from a hosted CI runner at all.

  This script signs with signtool against whatever certificate/dlib the
  environment provides, and builds unsigned when given nothing.

  Usage:
    .\build-msi.ps1
    .\build-msi.ps1 -SignToolArgs '/fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /sha1 <thumbprint>'
    .\build-msi.ps1 -AzureTrustedSigning -Endpoint https://weu.codesigning.azure.net -Account acme -Profile refugio
#>

[CmdletBinding()]
param(
  [string]$NodeVersion = "22.16.0",
  [string]$SignToolArgs = "",
  [switch]$AzureTrustedSigning,
  [string]$Endpoint = "",
  [string]$Account = "",
  [string]$Profile = ""
)

$ErrorActionPreference = "Stop"
$Root  = (Resolve-Path "$PSScriptRoot\..\..").Path
$Build = Join-Path $Root "build\msi"
$Stage = Join-Path $Build "stage"
$Out   = Join-Path $Root "dist"

function Say  ($m) { Write-Host "`n> $m" -ForegroundColor White }
function Ok   ($m) { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host "  [x] $m" -ForegroundColor Red; exit 1 }

$Version = (Get-Content (Join-Path $Root "package.json") | ConvertFrom-Json).version
if (-not $Version) { $Version = "0.0.0" }

Remove-Item -Recurse -Force $Build -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Stage, $Out | Out-Null

# ── Payload ─────────────────────────────────────────────────
Say "Staging the payload"
$exclude = @(".git", "build", "dist", "node_modules", "menubar", "test")
Get-ChildItem $Root -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
  Copy-Item $_.FullName -Destination $Stage -Recurse -Force
}
Ok "source tree"

Say "Installing production dependencies"
Push-Location $Stage
try {
  & npm ci --omit=dev --ignore-scripts 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { & npm install --omit=dev --ignore-scripts 2>&1 | Out-Null }
  if ($LASTEXITCODE -ne 0) { Die "npm install failed — the MSI would ship without its dependencies" }
} finally { Pop-Location }
Ok "node_modules"

# ── Bundled Node ────────────────────────────────────────────
#
# Same reasoning as the .pkg: "install Node.js 18+ first" is not an instruction
# you can give to Intune. Bundling removes the single largest cause of an
# install that reports success and then does nothing.
Say "Bundling Node $NodeVersion"
$zip = Join-Path $Build "node.zip"
Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" -OutFile $zip
Expand-Archive $zip -DestinationPath $Build -Force
$runtime = Join-Path $Stage "runtime"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
Copy-Item (Join-Path $Build "node-v$NodeVersion-win-x64\*") $runtime -Recurse -Force
if (-not (Test-Path (Join-Path $runtime "node.exe"))) { Die "the bundled runtime has no node.exe" }

# A second copy under our own name. This exists so uninstall can terminate
# REFUGIO's supervisor by process name without touching any other Node process
# on the machine — on a developer's laptop, killing every node.exe to uninstall
# one app would be unforgivable.
Copy-Item (Join-Path $runtime "node.exe") (Join-Path $runtime "refugio-node.exe") -Force
Ok "runtime\node.exe + refugio-node.exe"

# ── Build ───────────────────────────────────────────────────
#
# No heat step. WiX v4 removed heat as a CLI verb and replaced it with the
# <Files Include="..."> element, which harvests at build time — see REFUGIO.wxs.
Say "Building the MSI"
& wix --version 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Die "WiX is not installed. Run: dotnet tool install --global wix"
}
& wix extension add -g WixToolset.Util.wixext 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Die "wix extension add failed — WixToolset.Util.wixext is not in the cache" }

$msi = Join-Path $Out "REFUGIO-$Version.msi"
& wix build (Join-Path $PSScriptRoot "REFUGIO.wxs") `
    -d ProductVersion="$Version" -d StageDir="$Stage" `
    -ext WixToolset.Util.wixext `
    -o $msi
if ($LASTEXITCODE -ne 0) { Die "wix build failed" }
Ok "REFUGIO-$Version.msi"

# ── Sign ────────────────────────────────────────────────────
if ($AzureTrustedSigning) {
  Say "Signing with Azure Trusted Signing"
  if (-not $Endpoint -or -not $Account -or -not $Profile) {
    Die "Azure Trusted Signing needs -Endpoint, -Account and -Profile"
  }
  $meta = Join-Path $Build "trusted-signing.json"
  @{ Endpoint = $Endpoint; CodeSigningAccountName = $Account; CertificateProfileName = $Profile } |
    ConvertTo-Json | Set-Content $meta
  # The dlib ships with the Trusted Signing client; the GitHub Action installs
  # it and exports this variable.
  $dlib = $env:AZURE_TRUSTED_SIGNING_DLIB
  if (-not $dlib) { Die "AZURE_TRUSTED_SIGNING_DLIB is not set — install the Trusted Signing client first" }
  & signtool sign /v /fd SHA256 /tr "http://timestamp.acs.microsoft.com" /td SHA256 `
      /dlib $dlib /dmdf $meta $msi
  if ($LASTEXITCODE -ne 0) { Die "signing failed" }
  Ok "signed"
}
elseif ($SignToolArgs) {
  Say "Signing"
  & signtool sign @($SignToolArgs -split ' ') $msi
  if ($LASTEXITCODE -ne 0) { Die "signing failed" }
  Ok "signed"
}
else {
  Warn "UNSIGNED — SmartScreen will warn on this, and many managed fleets will refuse it outright."
  Warn "Fine for testing. See packaging/README.md for what signing actually requires."
}

if ($SignToolArgs -or $AzureTrustedSigning) {
  & signtool verify /pa /v $msi
  if ($LASTEXITCODE -ne 0) { Die "the signed MSI does not verify" }
  Ok "signature verifies"
}

Say "Done"
Write-Host "  $msi"
Write-Host "  $([math]::Round((Get-Item $msi).Length / 1MB, 1)) MB"
Write-Host ""
Write-Host "  Install:  msiexec /i `"$msi`" /qn"
Write-Host "  Log:      msiexec /i `"$msi`" /qn /l*v install.log"
Write-Host ""
