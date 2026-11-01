# Instance-scoped process targeting and lifecycle for Empire on Windows.
# DEFAULT IS DRY-RUN: no Stop-P process unless -ConfirmStop is passed.
#
#   powershell resolve-empire-process.ps1 -Instance staging                    # dry run
#   powershell resolve-empire-process.ps1 -Instance staging -Restart           # task restart via scheduler
#   powershell resolve-empire-process.ps1 -Instance production -KillE app      # hard-kill app process (crash simulation)
#
# Identity rules (ALL must hold for a candidate; anything else is excluded):
#   1. process is node.exe
#   2. command line contains the EXACT instance env file: --env-file=C:/Empire/shared/<instance>.env
#   3. command line contains the tsx loader rooted at THIS instance's current release path
#      (C:\Empire\releases\<instance>\<current-sha>\...) - verified against active-release-<instance>.txt
#   4. command line contains NO reference to C:\Collectz or to the OTHER instance's env file
# A mismatch of any rule means the script ABORTS WITHOUT ACTION.
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
$OtherPort = if($Instance -eq 'staging'){ 8891 } else { 8892 }
$EnvFilePattern = "--env-file=C:/Empire/shared/$Instance.env"
$ReleaseSha = (Get-Content "$Root\shared\active-release-$Instance.txt" -Raw).Trim()
$ReleasePath = "$Root\releases\$Instance\$ReleaseSha"

Write-Output "target: instance=$Instance task=$Task port=$Port releaseSha=$ReleaseSha"

if($ReleaseSha -notmatch '^[a-f0-9]{40}$'){ throw 'invalid release pointer' }
if(-not (Test-Path $ReleasePath)){ throw "release path missing: $ReleasePath" }

function Is-EmpireInstance([System.Management.Automation.PSObject] $proc, [string] $inst){
  $cl = $proc.CommandLine
  if($null -eq $cl){ return $false }
  if($cl -notmatch [regex]::Escape('--env-file=C:/Empire/shared/' + $inst + '.env')){ return $false }
  # rooted in THIS instance's release path (child processes carry the release dir)
  if($cl -notlike "*$Root\releases\$inst\*"){ return $false }
  # never Collectz or the other instance
  if($cl -imatch 'Collectz'){ return $false }
  return $true
}

$candidates = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { Is-EmpireInstance $_ $Instance }
Write-Output "matched $($candidates.Count) process(es) for instance=$Instance"

$portOwner = Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq $Port } | Select-Object -First 1
if($portOwner){
  $owning = Get-CimInstance Win32_Process -Filter "ProcessId=$($portOwner.OwningProcess)"
  if(-not (Is-EmpireInstance $owning $Instance)){ throw "port $Port is owned by a process that does not belong to empire/$Instance - aborting" }
  Write-Output ("port listener: pid=$($owning.ProcessId) verified as empire/$Instance")
} else {
  Write-Output "port listener: none (instance likely stopped)"
}

# cross-check: the OTHER instance must not be selected
$other = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { Is-EmpireInstance $_ ($Instance -replace 'staging','production' -replace 'production','staging') }
Write-Output "other-instance processes: $($other.Count) (excluded from targeting)"

foreach($p in $candidates){
  Write-Output ("-- candidate pid=$($p.ProcessId) parent=$($p.ParentProcessId)")
  Write-Output ("   cmd: " + $p.CommandLine.Substring(0, [Math]::Min(180, $p.CommandLine.Length)))
}

$total = $candidates.Count
if($total -eq 0 -and -not $portOwner){ throw "no empire/$Instance process nor port listener found - nothing to act on" }

if($Restart){
  if(-not $ConfirmStop){
    Write-Output 'DRY RUN: would run Stop-ScheduledTask; Start-ScheduledTask (kills only this task instance, then the scheduler-owned loop restarts the app). Pass -ConfirmStop to execute.'
    exit 0
  }
  Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  Start-ScheduledTask -TaskName $Task
  for($i=0; $i -lt 15; $i++){ Start-Sleep 2; try { if(((Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/health" -TimeoutSec 3).Content) -match 'ok'){ "restart: healthy after ~$((2+$i*2))s"; exit 0 } } catch {} }
  throw "restart healthcheck FAILED after 30s"
}

if($KillE -and $candidates.Count -gt 0){
  if(-not $ConfirmStop){
    Write-Output 'DRY RUN: would hard-kill these pids (crash simulation); the supervised loop recovers them. Pass -ConfirmStop to execute.'
    exit 0
  }
  foreach($p in $candidates){ Stop-Process -Id $p.ProcessId -Force }
  Write-Output "hard-killed $($candidates.Count) process(es) (task recovers them)"
  exit 0
}

Write-Output 'dry run complete (no changes made). Use -Restart or -KillE with -ConfirmStop to act.'
