# Empire app runner (mirrors C:\Collectz\tools\run-app.ps1 conventions).
# Usage: powershell -File C:\Empire\tools\run-staging.ps1   (run-production.ps1 equivalent)
param([Parameter(Mandatory=$true)][ValidateSet('staging','production')] [string]$Instance)
$ErrorActionPreference='Stop'
$root='C:\Empire'
$releaseFile=Join-Path $root "shared\active-release-$Instance.txt"
$release=(Get-Content $releaseFile -Raw).Trim()
if($release -notmatch '^[a-f0-9]{40}$'){throw 'Invalid release identifier'}
$app=Join-Path (Join-Path $root "releases\$Instance") $release
if(-not (Test-Path $app)){throw "Release $release does not exist on disk"}
$port = if($Instance -eq 'staging'){ 8892 } else { 8891 }
Set-Location $app
$ErrorActionPreference='Continue'  # benign node:sqlite startup warnings on Windows console
Write-Output "empire:$Instance starting release $release on 127.0.0.1:$port"

# Supervised loop (equivalent of systemd Restart=always): relaunch ~5s after any
# crash; Stop-ScheduledTask terminates the loop and children as a job object.
while($true){
  & 'C:\Collectz\tools\node\node.exe' --env-file="C:/Empire/shared/$Instance.env" node_modules\tsx\dist\cli.mjs server\src\index.ts >> "$root\shared\logs\$Instance.log" 2>&1
  $code=$LASTEXITCODE
  "$(Get-Date -Format o) empire:$Instance node exit code=$code; restart in 5s" |
    Add-Content -Path "$root\shared\logs\$Instance.supervisor.log"
  Write-Output "empire:$Instance process exited code=$code at $(Get-Date -Format o); restart in 5s"
  Start-Sleep -Seconds 5
  # re-read the release pointer so a deploy can replace the running version without stopping the task
  $next=(Get-Content $releaseFile -Raw).Trim()
  if($next -ne $release){ $release=$next; $app=Join-Path (Join-Path $root "releases\$Instance") $release; Set-Location $app; Write-Output "empire:$Instance switched to release $next" }
}
