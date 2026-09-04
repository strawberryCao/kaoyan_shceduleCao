[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# Edge reaches Cloudflare through the local Clash Verge proxy, while Wrangler
# otherwise attempts a blocked direct connection. Keep OAuth's localhost
# callback direct and proxy only Wrangler's outbound Cloudflare requests. Use
# the localhost hostname so Windows can accept the browser's IPv6 ::1 callback;
# binding only 127.0.0.1 leaves the fixed localhost redirect disconnected.
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
$env:HTTP_PROXY = 'http://127.0.0.1:7897'
$env:NO_PROXY = 'localhost,127.0.0.1,::1'

$wrangler = Join-Path $PSScriptRoot '..\node_modules\.bin\wrangler.cmd'

Write-Host 'Cloudflare will keep the local OAuth callback open for 120 seconds.' -ForegroundColor Cyan
Write-Host 'Approve the newly opened page before it expires; do not refresh an older localhost error tab.' -ForegroundColor Cyan

& $wrangler login `
  --scopes account:read user:read workers_scripts:write `
  --callback-host localhost `
  --callback-port 8976 `
  --no-use-keyring

exit $LASTEXITCODE
