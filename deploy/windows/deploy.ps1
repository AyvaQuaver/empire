# Empire deploy for Windows (one instance) — mirrors the Collectz release model.
#   powershell -File deploy.ps1 -Instance staging
#   powershell -File deploy.ps1 -Instance production -Ref origin/codex/empire-mvp
# Runs the full check suite, archives the pinned ref into releases\<sha>, swaps
# active-release-<instance>.txt, restarts the Task Scheduler job, healthchecks.
# Never prints or touches secret values.
param(
  [Parameter(Mandatory=$true)][ValidateSet('staging','production')] [string]$Instance,
  [string]$Ref
)
$ErrorActionPreference='Stop'
$Repo='C:\Empire\repo'
$Root='C:\Empire'
$Port = if($Instance -eq 'staging'){ 8892 } else { 8891 }
$Task = if($Instance -eq 'staging'){ 'EmpireStaging' } else { 'EmpireProduction' }
if(-not $Ref){
  git -C $Repo fetch origin codex/deploy-playempire 2>$null | Out-Null
  $Ref = 'origin/codex/deploy-playempire'
}
Write-Output "empire:deploy instance=$Instance ref=$Ref"

& git -C $Repo fetch origin ($Ref -replace '^origin/','')
if($LASTEXITCODE -ne 0){ throw 'git fetch failed' }

$Sha=(git -C $Repo rev-parse $Ref).Trim()
if($Sha -notmatch '^[a-f0-9]{40}$'){ throw "invalid ref: $Ref" }
Write-Output "empire:deploy sha=$Sha"

# Build fresh release directory (existing releases stay for rollback)
$ReleaseDir=Join-Path "$Root\releases" $Sha
if(-not (Test-Path $ReleaseDir)){
  & git -C $Repo archive --format=zip --output="$env:TEMP\empire-$Sha.zip" $Sha
  if($LASTEXITCODE -ne 0){ throw 'git archive failed' }
  New-Item -ItemType Directory -Force -Path $ReleaseDir | Out-Null
  Expand-Archive -Path "$env:TEMP\empire-$Sha.zip" -DestinationPath $ReleaseDir -Force
  Remove-Item "$env:TEMP\empire-$Sha.zip" -Force
}

Push-Location $ReleaseDir
try {
  Write-Output '-- install --'
  & npm ci --no-fund --no-audit
  if($LASTEXITCODE -ne 0){ throw 'npm ci failed' }

  Write-Output '-- checks: vitest --'
  & npx vitest run
  if($LASTEXITCODE -ne 0){ throw 'tests failed' }

  Write-Output '-- checks: tsc (server+web), eslint --'
  & npx tsc --noEmit -p tsconfig.json
  if($LASTEXITCODE -ne 0){ throw 'tsc server failed' }
  & npx tsc --noEmit -p web/tsconfig.json
  if($LASTEXITCODE -ne 0){ throw 'tsc web failed' }
  & npx eslint server/src server/test web/src scripts
  if($LASTEXITCODE -ne 0){ throw 'eslint failed' }

  Write-Output '-- build --'
  & npm run build
  if($LASTEXITCODE -ne 0){ throw 'build failed' }
} finally { Pop-Location }

# Swap release pointer, restart
Set-Content -Path "$Root\shared\active-release-$Instance.txt" -Value $Sha -NoNewline
Write-Output "empire:deploy restart task $Task"
Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $Task
Start-Sleep -Seconds 2
$status=(Get-ScheduledTask -TaskName $Task).State
Write-Output "empire:deploy task state=$status"

# Healthcheck (local port; never exposes env)
for($i=1; $i -le 30; $i++){
  Start-Sleep -Seconds 1
  try {
    $r=Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3
    $ok=($r.Content | ConvertFrom-Json).ok
  } catch { $ok=$false }
  if($ok){
    Write-Output "empire:deploy healthy after ${i}s on 127.0.0.1:$Port"
    Write-Output "empire:deploy deployed sha=$Sha instance=$Instance"
    exit 0
  }
}
throw "healthcheck FAILED after 30s - inspect C:\Empire\shared\logs\$Instance.log and the task state"
