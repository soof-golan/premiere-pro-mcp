param(
  [switch]$Diagnose,
  [ValidateSet("Premiere", "AfterEffects")]
  [string]$ConnectorHost = "Premiere"
)

$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $PSScriptRoot
$isAfterEffects = $ConnectorHost -eq "AfterEffects"
$pluginSource = Join-Path $projectDir $(if ($isAfterEffects) { "after-effects-cep-plugin" } else { "cep-plugin" })
$signedPackage = if ($isAfterEffects) { $null } else { Join-Path $projectDir "artifacts\MCPBridgeCEP.zxp" }
$packageMetadata = Get-Content -LiteralPath (Join-Path $projectDir "package.json") -Raw | ConvertFrom-Json
$expectedVersion = [string]$packageMetadata.version
$cepRoot = Join-Path $env:APPDATA "Adobe\CEP\extensions"
$pluginDestination = Join-Path $cepRoot $(if ($isAfterEffects) { "MCPAfterEffectsBridgeCEP" } else { "MCPBridgeCEP" })
$resolvedCepRoot = [System.IO.Path]::GetFullPath($cepRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$resolvedDestination = [System.IO.Path]::GetFullPath($pluginDestination)

if (-not $resolvedDestination.StartsWith($resolvedCepRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to install outside the CEP extensions directory: $resolvedDestination"
}

Write-Host "=== $(if ($isAfterEffects) { 'After Effects' } else { 'Premiere' }) MCP Connector ==="
Write-Host "Source:      $pluginSource"
Write-Host "Destination: $pluginDestination"
if ($Diagnose) {
  Write-Host "Mode:        Check only (no files or settings will be changed)"
}

if (-not (Test-Path -LiteralPath (Join-Path $pluginSource "CSXS\manifest.xml"))) {
  throw "CEP plugin manifest not found at $pluginSource"
}

$signedPackageMatchesRelease = $false
if ($signedPackage -and (Test-Path -LiteralPath $signedPackage)) {
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($signedPackage)
    try {
      $manifestEntry = $archive.Entries | Where-Object { $_.FullName -eq "CSXS/manifest.xml" } | Select-Object -First 1
      if (-not $manifestEntry) {
        throw "Signed package does not contain CSXS/manifest.xml"
      }
      $reader = [System.IO.StreamReader]::new($manifestEntry.Open())
      try {
        $signedManifest = $reader.ReadToEnd()
      }
      finally {
        $reader.Dispose()
      }
    }
    finally {
      $archive.Dispose()
    }

    $signedPackageMatchesRelease = $signedManifest -match ('ExtensionBundleVersion="' + [regex]::Escape($expectedVersion) + '"')
    if (-not $signedPackageMatchesRelease) {
      Write-Warning "Ignoring artifacts\MCPBridgeCEP.zxp because its embedded connector version does not match package version $expectedVersion."
    }
  }
  catch {
    Write-Warning "Ignoring artifacts\MCPBridgeCEP.zxp because its embedded manifest could not be verified: $($_.Exception.Message)"
  }
}

$stateFile = Join-Path $cepRoot ".premiere-pro-mcp-player-debug-mode.state.json"

if (-not $Diagnose) {
  New-Item -ItemType Directory -Force -Path $cepRoot | Out-Null

  if (Test-Path -LiteralPath $pluginDestination) {
    Remove-Item -LiteralPath $resolvedDestination -Recurse -Force
  }
  if ($signedPackageMatchesRelease) {
    $temporaryZip = Join-Path ([System.IO.Path]::GetTempPath()) ("MCPBridgeCEP-" + [guid]::NewGuid().ToString("N") + ".zip")
    try {
      Copy-Item -LiteralPath $signedPackage -Destination $temporaryZip
      Expand-Archive -LiteralPath $temporaryZip -DestinationPath $pluginDestination
      Write-Host "Installed signed CEP package: $signedPackage"
      Write-Host "Signed package in use; PlayerDebugMode was not changed."
    }
    finally {
      if (Test-Path -LiteralPath $temporaryZip) {
        Remove-Item -LiteralPath $temporaryZip -Force
      }
    }
  }
  else {
    Copy-Item -LiteralPath $pluginSource -Destination $pluginDestination -Recurse
    Write-Warning "No signed CEP package is present; installed the unsigned development bundle, which requires PlayerDebugMode."
    Write-Warning "PlayerDebugMode disables CEP extension signature verification for ALL CEP extensions for this Windows user, not just this one."

    # Adobe requires PlayerDebugMode to be a String value. A DWORD that happens
    # to contain 1 is ignored by CEP and the unsigned extension is not discovered.
    $priorState = [ordered]@{}
    if (Test-Path -LiteralPath $stateFile) {
      Write-Host "Reusing the PlayerDebugMode baseline already recorded at $stateFile"
    }
    else {
      Write-Host "Recording current PlayerDebugMode values before changing anything..."
      foreach ($version in 9..14) {
        $key = "HKCU:\SOFTWARE\Adobe\CSXS.$version"
        $existing = Get-ItemProperty -Path $key -Name "PlayerDebugMode" -ErrorAction SilentlyContinue
        if ($null -eq $existing) {
          $priorState["CSXS.$version"] = [ordered]@{ existed = $false; value = $null; kind = $null }
        }
        else {
          $existingKind = (Get-Item -Path $key).GetValueKind("PlayerDebugMode")
          $priorState["CSXS.$version"] = [ordered]@{ existed = $true; value = [string]$existing.PlayerDebugMode; kind = $existingKind.ToString() }
        }
      }
      ($priorState | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $stateFile -Encoding UTF8
    }

    $changed = $false
    foreach ($version in 9..14) {
      $key = "HKCU:\SOFTWARE\Adobe\CSXS.$version"
      $current = Get-ItemProperty -Path $key -Name "PlayerDebugMode" -ErrorAction SilentlyContinue
      if ($null -eq $current -or [string]$current.PlayerDebugMode -ne "1") {
        New-Item -Path $key -Force | Out-Null
        New-ItemProperty -Path $key -Name "PlayerDebugMode" -PropertyType String -Value "1" -Force | Out-Null
        $changed = $true
      }
    }
    if ($changed) {
      Write-Host "CEP debug mode enabled for CSXS 9-14 where needed."
    }
    else {
      Write-Host "CEP debug mode was already enabled for CSXS 9-14; nothing changed."
    }
    Write-Host "Run uninstall-cep.ps1 to restore the PlayerDebugMode values recorded above."
  }
}

$problems = @()
if (-not (Test-Path -LiteralPath (Join-Path $pluginDestination "CSXS\manifest.xml"))) {
  $problems += "Plugin manifest is missing from $pluginDestination"
}

if (-not $signedPackageMatchesRelease) {
  foreach ($version in 9..14) {
    $key = "HKCU:\SOFTWARE\Adobe\CSXS.$version"
    $value = Get-ItemProperty -Path $key -Name "PlayerDebugMode" -ErrorAction SilentlyContinue
    if ($null -eq $value -or [string]$value.PlayerDebugMode -ne "1") {
      $problems += "CSXS.$version PlayerDebugMode is missing or not set to 1"
      continue
    }

    $kind = (Get-Item -Path $key).GetValueKind("PlayerDebugMode")
    if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String) {
      $problems += "CSXS.$version PlayerDebugMode is $kind; Adobe requires REG_SZ"
    }
  }
}

$signatureFailures = Get-ChildItem -Path $env:TEMP -Filter "CEP*-PPRO.log" -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 5 |
  Select-String -Pattern "Signature verification failed for extension com\.mcp\.premiere\.bridge" -ErrorAction SilentlyContinue
if (!$isAfterEffects -and $signatureFailures) {
  $latestFailure = $signatureFailures | Select-Object -First 1
  $problems += "Premiere logged a signature failure in $($latestFailure.Path). Reinstall from a release containing artifacts\MCPBridgeCEP.zxp, fully quit Premiere, and relaunch it."
}

if ($problems.Count -gt 0) {
  Write-Error ("The $(if ($isAfterEffects) { 'After Effects' } else { 'Premiere' }) Connector needs attention:`n" + ($problems -join [Environment]::NewLine))
  Write-Host ""
  Write-Host "Next steps:"
  Write-Host "  1. Fully quit $(if ($isAfterEffects) { 'After Effects' } else { 'Premiere Pro' })."
  Write-Host "  2. Run the Connector installer again."
  Write-Host "  3. Reopen $(if ($isAfterEffects) { 'After Effects, then choose Window > Extensions > MCP for Adobe After Effects.' } else { 'Premiere Pro, then choose Window > Extensions > MCP for Adobe Premiere Pro.' })"
  exit 1
}

Write-Host ""
if ($Diagnose) {
  Write-Host "Connector installation looks ready."
  Write-Host "This check cannot confirm that $(if ($isAfterEffects) { 'After Effects' } else { 'Premiere Pro' }) is currently open or connected."
  Write-Host "Next: Open $(if ($isAfterEffects) { 'After Effects and run Verify After Effects connection.' } else { 'Premiere Pro and run Verify Premiere connection.' })"
}
else {
  Write-Host "Connector installed. Fully restart $(if ($isAfterEffects) { 'After Effects, then open Window > Extensions > MCP for Adobe After Effects.' } else { 'Premiere Pro, then open Window > Extensions > MCP for Adobe Premiere Pro.' })"
  Write-Host "After that, ask your AI assistant to run '$(if ($isAfterEffects) { 'Verify After Effects connection' } else { 'Verify Premiere connection' })' before editing."
}
