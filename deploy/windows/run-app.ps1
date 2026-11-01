# Empire app runner (mirrors C:\Collectz\tools\run-app.ps1 conventions).
# Usage: powershell -File C:\Empire\tools\run-staging.ps1   (run-production.ps1 equivalent)
param([Parameter(Mandatory=$true)][ValidateSet('staging','production')] [string]$Instance)
$ErrorActionPreference='Stop'
$root='C:\Empire'
$releaseFile=Join-Path $root "shared\active-release-$Instance.txt"
$release=(Get-Content $releaseFile -Raw).Trim()
if($release -notmatch '^[a-f0-9]{40}$'){throw 'Invalid release identifier'}
$app=Join-Path "$root\releases" $release
if(-not (Test-Path $app)){throw "Release $release does not exist on disk"}
Set-Location $app
$ErrorActionPreference='Continue'  # benign node:sqlite startup warnings on Windows console
$port = if($Instance -eq 'staging'){ 8892 } else { 8891 }
Write-Output "empire:$Instance starting release $release on 127.0.0.1:$port"
& 'C:\Collectz\tools\node\node.exe' --env-file="C:/Empire/shared/$Instance.env" node_modules\tsx\dist\cli.mjs server\src\index.ts >> "$root\shared\logs\$Instance.log" 2>&1
exit $LASTEXITCODE
