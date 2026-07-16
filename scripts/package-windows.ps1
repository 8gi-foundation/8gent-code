<#
.SYNOPSIS
  Build the Windows installer for 8gent Code and (optionally) sign it.

.DESCRIPTION
  Assumes dist\bin\8gent-windows-x64.exe already exists (produced by
  `bun run scripts/build-binaries.ts --only=bun-windows-x64`). Runs makensis
  to wrap it into 8gent-setup-<version>-x64.exe, then Authenticode-signs BOTH
  the raw exe and the installer IF signing material is present in the
  environment. Signing is skip-if-absent - never fabricated. See SIGNING.md.

  Signing paths (first match wins):
    1. Azure Trusted Signing - set EIGHT_AZURE_SIGN=1 plus the
       AZURE_* / trusted-signing vars and have signtool + the Azure dlib
       available. (Recommended: no local cert to guard.)
    2. Local PFX - set EIGHT_WIN_PFX to a .pfx path and EIGHT_WIN_PFX_PASSWORD
       to its password (an OV/EV Authenticode cert you procured).
  If neither is set, the installer is produced UNSIGNED and a notice is
  printed. Unsigned installers trigger SmartScreen warnings on other machines.

.PARAMETER Version
  Version string embedded in the installer (defaults to package.json version).
#>
param(
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root "dist\bin\8gent-windows-x64.exe"
$nsi = Join-Path $root "packaging\windows\installer.nsi"

if (-not (Test-Path $exe)) {
  throw "Missing $exe. Run: bun run scripts/build-binaries.ts --only=bun-windows-x64"
}

if ([string]::IsNullOrEmpty($Version)) {
  $pkg = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
  $Version = $pkg.version
}
Write-Host "Packaging 8gent Code $Version for Windows x64"

function Invoke-Sign([string]$file) {
  if ($env:EIGHT_AZURE_SIGN -eq "1") {
    Write-Host "Signing $file via Azure Trusted Signing"
    # Requires signtool + the Trusted Signing dlib configured via a metadata
    # json (EIGHT_AZURE_METADATA). Credentials come from the standard AZURE_*
    # env vars consumed by the Azure.CodeSigning dlib.
    & signtool sign /v /debug /fd SHA256 /tr "http://timestamp.acs.microsoft.com" /td SHA256 `
      /dlib "$env:EIGHT_AZURE_DLIB" /dmdf "$env:EIGHT_AZURE_METADATA" $file
    if ($LASTEXITCODE -ne 0) { throw "Azure signing failed for $file" }
  }
  elseif ($env:EIGHT_WIN_PFX) {
    Write-Host "Signing $file with local PFX"
    & signtool sign /v /fd SHA256 /f "$env:EIGHT_WIN_PFX" /p "$env:EIGHT_WIN_PFX_PASSWORD" `
      /tr "http://timestamp.digicert.com" /td SHA256 $file
    if ($LASTEXITCODE -ne 0) { throw "PFX signing failed for $file" }
  }
  else {
    Write-Host "  (unsigned - set EIGHT_AZURE_SIGN=1 or EIGHT_WIN_PFX to sign; see SIGNING.md)"
  }
}

# Sign the raw binary first so the exe inside the installer is trusted too.
Invoke-Sign $exe

# Build the installer.
$makensis = Get-Command makensis -ErrorAction SilentlyContinue
if (-not $makensis) {
  throw "makensis not found. Install NSIS 3 (choco install nsis) and re-run."
}
& makensis "/DEIGHT_VERSION=$Version" "/DEIGHT_EXE=$exe" $nsi
if ($LASTEXITCODE -ne 0) { throw "makensis failed" }

$installer = Join-Path $root "packaging\windows\8gent-setup-$Version-x64.exe"
if (-not (Test-Path $installer)) { throw "Installer not produced at $installer" }

# Sign the installer itself.
Invoke-Sign $installer

# Move artifacts to dist/installers for a uniform release upload step.
$outDir = Join-Path $root "dist\installers"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Move-Item -Force $installer (Join-Path $outDir "8gent-setup-$Version-x64.exe")
Write-Host "Installer: dist\installers\8gent-setup-$Version-x64.exe"
