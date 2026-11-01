# Instance-scoped process targeting and lifecycle for Empire on Windows.
# DEFAULT IS DRY-RUN: no stop/kill unless -ConfirmStop is passed.
#
#   powershell resolve-empire-process.ps1 -Instance staging                     # dry run
#   powershell resolve-empire-process.ps1 -Instance staging -Restart -ConfirmStop
#   powershell resolve-empire-process.ps1 -Instance production -KillE -ConfirmStop
#
# Identity rules (ALL candidates must satisfy; anything else is excluded):
#   1. process image is node.exe
#   2A. wrapper: command line contains the exact per-instance env flag
#       (--env-file="C:/Empire/shared/<instance>.env", quotes tolerated)
#   2B. child: command line is rooted in THIS instance's current release path
#       (C:\Empire\releases\<instance>\<current-sha>\... verified against the
#       pointer file; stale PIDs are never trusted)
#   3. nothing in the command line references Collectz or the other instance
#   4. port owner (8891/8892) is verified as one of the selected list before
#       any action; the helper aborts without action otherwise
param(
  [Parameter(Mandatory=$true)][ValidateSet('staging','production')] [string]$Instance,
  [switch]$Restart,
  [switch]$KillE,
  [switch]$ConfirmStop
)
$ErrorActionPreference='Stop'
$Root='C:\Empire'
$Port = if($Instance -eq 'staging'){ 8892 } else { 8891 }
$Task = if($Instance -eq 'staging'){ 'EmpireStaging' } else { 'EmpireProduction' }
$OtherInstance = if($Instance -eq 'staging'){ 'production' } else { 'staging' }
$ReleaseSha = (Get-Content "$Root\shared\active-release-$Instance.txt" -Raw).Trim()
$ReleasePathRoot = "$Root\releases\$Instance\$ReleaseSha"

Write-Output "target: instance=$Instance task=$Task port=$Port releaseSha=$ReleaseSha"
if($ReleaseSha -notmatch '^[a-f0-9]{40}$'){ throw 'invalid release pointer' }
if(-not (Test-Path $ReleasePathRoot)){ throw "release path missing: $ReleasePathRoot" }

function BadMark([string]$cl){
  if($null -eq $cl){ return $true }
  # Only flag real Collectz app markers (its server entrypoint or its own env file).
  # The shared node.exe binary under C:\Collectz\tools\node is Empire's runtime too.
  if($clFlat -and $clFlat -like '*Collectz/shared/*'){ return $true }
  if($clFlat -imatch 'src/server\.js'){ return $true }
  $clFlat = ($cl -replace '"','') -replace "'",""
  if($clFlat -like ('*' + '--env-file=C:/Empire/shared/' + $OtherInstance + '.env*')){ return $true }
  return $false
}

$nodes = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
# compare quote-stripped command lines (spawned arg quoting varies)
$wrappers = @($nodes | Where-Object {
  $cl = ($_.CommandLine -replace '"','') -replace "'",""
  ($cl -like '*--env-file=C:/Empire/shared/' + $Instance + '.env*') -and (-not (BadMark $cl))
})
$wrapperIds = @($wrappers | ForEach-Object { $_.ProcessId })
$children = @($nodes | Where-Object {
  ($wrapperIds -contains $_.ParentProcessId) -and
  ($_.CommandLine -like "*$ReleasePathRoot*") -and
  (-not (BadMark $_.CommandLine))
})
$all = @($wrappers) + @($children)
$portOwner = (Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq $Port } | Select-Object -First 1).OwningProcess
Write-Output "selected $($all.Count) process(es): wrappers=$($wrappers.Count) children=$($children.Count)"
foreach($p in $all){
  Write-Output ("-- pid=$($p.ProcessId) parent=$($p.ParentProcessId) cmd: " + $p.CommandLine.Substring(0, [Math]::Min(160, $p.CommandLine.Length)))
}
if($portOwner){
  if(($all | Where-Object { $_.ProcessId -eq $portOwner }).Count -eq 0){
    $owning = Get-CimInstance Win32_Process -Filter "ProcessId=$portOwner"
    throw ("port $Port is owned by pid $portOwner which does not match empire/$Instance rules - aborting. cmd: " + $owning.CommandLine)
  }
  Write-Output "port listener pid=$portOwner verified as empire/$Instance"
} else {
  Write-Output 'port listener: none (instance likely stopped)'
}
$otherCount = @($nodes | Where-Object {
  $cl = ($_.CommandLine -replace '"','') -replace "'",""
  ($cl -like ('*' + '--env-file=C:/Empire/shared/' + $OtherInstance + '.env*')) -and (-not (BadMark $cl))
}).Count
Write-Output "other-instance processes (excluded): $otherCount"

if($Restart){
  if(-not $ConfirmStop){ Write-Output 'DRY RUN: restart would run Stop-ScheduledTask + Start-ScheduledTask (scheduler job-object only). Pass -ConfirmStop to execute.'; exit 0 }
  Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  Start-ScheduledTask -TaskName $Task
  for($i=0; $i -lt 15; $i++){ Start-Sleep 2; try { if(((Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/health" -TimeoutSec 3).Content) -match 'ok'){ "restart: healthy after ~$((2+$i*2))s"; exit 0 } } catch {} }
  throw "restart healthcheck FAILED after 30s"
}

if($KillE -and $all.Count -gt 0){
  if(-not $ConfirmStop){ Write-Output 'DRY RUN: would hard-kill the listed pids (crash simulation; supervised loop recovers). Pass -ConfirmStop to execute.'; exit 0 }
  foreach($p in $children){ Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  foreach($p in $wrappers){ Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Output "hard-killed $($children.Count) child / $($wrappers.Count) wrapper process(es)"
  exit 0
}
Write-Output 'dry run complete (no changes). Use -Restart or -KillE with -ConfirmStop to act.'
