param(
  [switch]$Quiet,
  [ValidateSet("Premiere", "AfterEffects")]
  [string]$ConnectorHost = "Premiere"
)

$ErrorActionPreference = "Stop"

$cepRoot = Join-Path $env:APPDATA "Adobe\CEP\extensions"
$isAfterEffects = $ConnectorHost -eq "AfterEffects"
$pluginDestination = Join-Path $cepRoot $(if ($isAfterEffects) { "MCPAfterEffectsBridgeCEP" } else { "MCPBridgeCEP" })
$resolvedCepRoot = [System.IO.Path]::GetFullPath($cepRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$resolvedDestination = [System.IO.Path]::GetFullPath($pluginDestination)

if (-not $resolvedDestination.StartsWith($resolvedCepRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to uninstall outside the CEP extensions directory: $resolvedDestination"
}

$hostProcess = Get-Process -Name $(if ($isAfterEffects) { "AfterFX" } else { "Adobe Premiere Pro" }) -ErrorAction SilentlyContinue
if ($hostProcess) {
  throw "$(if ($isAfterEffects) { 'After Effects' } else { 'Premiere Pro' }) is running. Fully quit it before removing the Connector."
}

if (Test-Path -LiteralPath $resolvedDestination) {
  Remove-Item -LiteralPath $resolvedDestination -Recurse -Force
  if (-not $Quiet) {
    Write-Host "Removed the $(if ($isAfterEffects) { 'After Effects' } else { 'Premiere' }) MCP Connector from $pluginDestination"
  }
}
elseif (-not $Quiet) {
  Write-Host "The $(if ($isAfterEffects) { 'After Effects' } else { 'Premiere' }) MCP Connector is not installed for this Windows user."
}

$stateFile = Join-Path $cepRoot ".premiere-pro-mcp-player-debug-mode.state.json"
$siblingPremiere = Join-Path $cepRoot "MCPBridgeCEP"
$siblingAfterEffects = Join-Path $cepRoot "MCPAfterEffectsBridgeCEP"

if ((Test-Path -LiteralPath $siblingPremiere) -or (Test-Path -LiteralPath $siblingAfterEffects)) {
  if (-not $Quiet) {
    Write-Host "Another MCP CEP connector is still installed for this Windows user; leaving PlayerDebugMode unchanged."
  }
}
elseif (-not (Test-Path -LiteralPath $stateFile)) {
  if (-not $Quiet) {
    Write-Host ""
    Write-Host "No PlayerDebugMode baseline was recorded for this Windows user (installed by an older version, or already restored), so it was left unchanged."
    Write-Host "To turn PlayerDebugMode off manually for CSXS 9-14 (only if no other unsigned CEP extension needs it):"
    Write-Host "  9..14 | ForEach-Object { Remove-ItemProperty -Path `"HKCU:\SOFTWARE\Adobe\CSXS.`$_`" -Name PlayerDebugMode -ErrorAction SilentlyContinue }"
  }
}
else {
  if (-not $Quiet) {
    Write-Host ""
    Write-Host "Restoring PlayerDebugMode to the values recorded before installation..."
  }
  $priorState = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
  foreach ($property in $priorState.PSObject.Properties) {
    $version = $property.Name -replace "^CSXS\.", ""
    $entry = $property.Value
    $key = "HKCU:\SOFTWARE\Adobe\CSXS.$version"
    if ($entry.existed) {
      New-Item -Path $key -Force | Out-Null
      $kind = if ($entry.kind) { [Microsoft.Win32.RegistryValueKind]$entry.kind } else { [Microsoft.Win32.RegistryValueKind]::String }
      New-ItemProperty -Path $key -Name "PlayerDebugMode" -PropertyType $kind -Value $entry.value -Force | Out-Null
    }
    else {
      Remove-ItemProperty -Path $key -Name "PlayerDebugMode" -ErrorAction SilentlyContinue
    }
  }
  Remove-Item -LiteralPath $stateFile -Force
  if (-not $Quiet) {
    Write-Host "PlayerDebugMode restored for CSXS 9-14."
  }
}

if (-not $Quiet) {
  Write-Host "This removes only the selected connector. Remove the MCP server from your AI client's configuration separately if you no longer use it."
}
