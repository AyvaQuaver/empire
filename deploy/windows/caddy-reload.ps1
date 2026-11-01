# Caddyfile integration for Empire: validate, idempotently append site blocks,
# then reload without dropping other apps' connections.
#   powershell -File caddy-reload.ps1
# Requires DNS for playempire.uk / staging.playempire.uk to point here FIRST
# (certificate issuance for unresolvable hostnames fails at run time).
$ErrorActionPreference='Stop'
$Caddy='C:\Collectz\tools\caddy\caddy.exe'
$Caddyfile='C:\Collectz\shared\Caddyfile'
$Backup=Join-Path 'C:\Empire\backups' ("Caddyfile."+(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')+'.bak')

if(-not (Test-Path $Caddyfile)){ throw "missing $Caddyfile" }

$content=Get-Content $Caddyfile -Raw

# Idempotency: existing Empire blocks skip reload changes
$already = ($content -match 'playempire\.uk \{') 
if(-not $already){
  Copy-Item $Caddyfile $Backup
  $blocks=@(
    '',
    '# --- Empire (playempire.uk) - added by deploy kit; keep Collectz untouched ---',
    'playempire.uk {',
    '    reverse_proxy 127.0.0.1:8891',
    '}',
    'www.playempire.uk {',
    '    redir https://playempire.uk{uri} 308',
    '}',
    'staging.playempire.uk {',
    '    reverse_proxy 127.0.0.1:8892'
    '}'
  )
  # The global options block must stay first: for Caddy, site blocks after global
  # options inside one file are fine as long as nothing follows the '}' of globals
  # except sites; plain append works here.
  Add-Content -Path $Caddyfile -Value ($blocks -join "`r`n")
  Write-Output "caddy:appended Empire site blocks (backup: $Backup)"
}

# Validate before reload
& $Caddy validate --config $Caddyfile --adapter caddyfile
if($LASTEXITCODE -ne 0){ throw "Caddyfile validation FAILED - restoring backup if any"; }

& $Caddy reload --config $Caddyfile --adapter caddyfile
if($LASTEXITCODE -ne 0){ throw 'caddy reload FAILED - previous configuration continues running' }
Write-Output 'caddy:reloaded (Collectz sites untouched)'
