[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
$env:HTTP_PROXY = 'http://127.0.0.1:7897'
$env:NO_PROXY = 'localhost,127.0.0.1,::1'

$projectRoot = Split-Path -Parent $PSScriptRoot
$wrangler = Join-Path $projectRoot 'node_modules\.bin\wrangler.cmd'

Push-Location $projectRoot
try {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  & $wrangler deploy --env=''
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
