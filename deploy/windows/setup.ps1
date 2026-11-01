# One-time setup for the Empire tree + scheduled task (one instance).
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Instance staging
# Creates C:\Empire layout, generates the SESSION_SECRET on the server (never
# printed), writes the env file with 0600-equivalent ACLs, registers the task.
param(
  [Parameter(Mandatory=$true)][ValidateSet('staging','production')] [string]$Instance
)
$ErrorActionPreference='Stop'
$Node='C:\Collectz\tools\node\node.exe'
$Root='C:\Empire'
$Port = if($Instance -eq 'staging'){ 8892 } else { 8891 }
$Host2 = if($Instance -eq 'staging'){ 'https://staging.playempire.uk' } else { 'https://playempire.uk' }
$Task  = if($Instance -eq 'staging'){ 'EmpireStaging' } else { 'EmpireProduction' }

# 1. Tree (unprivileged LocalService runs the app, mirroring the Collectz service)
foreach($d in "$Root\repo","$Root\releases","$Root\shared\logs","$Root\data\$Instance","$Root\backups\$Instance","$Root\tools","$Root\secrets"){
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}
icacls $Root /T /C /grant:r 'Administrators:(OI)(CI)F' /grant:r 'SYSTEM:(OI)(CI)F' /grant:r 'NT AUTHORITY\LOCAL SERVICE:(OI)(CI)RX' | Out-Null
foreach($w in "$Root\shared\logs","$Root\data\$Instance"){
  icacls $w /inheritance:r /T /C /grant 'Administrators:(OI)(CI)F' /grant 'NT AUTHORITY\LOCAL SERVICE:(OI)(CI)M' /grant 'SYSTEM:(OI)(CI)F' | Out-Null
}
# backups may contain account/session data: no app-identity write access
if(Test-Path "$Root\backups\$Instance"){
  icacls "$Root\backups\$Instance" /T /C /inheritance:r /grant:r 'Administrators:(OI)(CI)F' /grant:r 'SYSTEM:(OI)(CI)F' | Out-Null
}

# 2. Local clone (read-only remote) on the deployment branch
if(-not (Test-Path "$Root\repo\.git")){
  & git clone https://github.com/AyvaQuaver/empire.git "$Root\repo"
  if($LASTEXITCODE -ne 0){ throw 'git clone failed' }
}
& git -C "$Root\repo" fetch origin codex/deploy-playempire
if($LASTEXITCODE -ne 0){ throw 'git fetch failed' }
& git -C "$Root\repo" checkout --detach origin/codex/deploy-playempire
if($LASTEXITCODE -ne 0){ throw 'git checkout failed' }

# 3. Env file with generated-on-server secret (redirected; never displayed)
$EnvFile="$Root\shared\$Instance.env"
$SecretFlag="$Root\secrets\.secret-set-$Instance"
if(-not (Test-Path $EnvFile)){
  $secret = & $Node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  $secret = ($secret -join '').Trim()
  if($secret.Length -lt 40){ throw 'secret generation failed' }
  @"
EMPIRE_ENV=$Instance
PORT=$Port
APP_BASE_URL=$Host2
CORS_ORIGINS=$Host2
EMPIRE_DB_FILE=C:/Empire/data/$Instance/empire.db
SESSION_SECRET=$secret
AUTH_ACCOUNTS_ENABLED=false
# SMTP_HOST=      (accounts stay disabled until real SMTP exists and is tested)
# SMTP_PORT=587
# SMTP_USER=
# SMTP_PASSWORD=
# EMAIL_FROM=Empire <no-reply@playempire.uk>
"@ | Set-Content -Path $EnvFile -Encoding ASCII
  icacls $EnvFile /inheritance:r /grant 'Administrators:F' /grant 'NT AUTHORITY\LOCAL SERVICE:RX' /grant 'SYSTEM:F' | Out-Null
  New-Item -ItemType File -Force -Path $SecretFlag | Out-Null
  Write-Output "setup: $EnvFile written (secret generated on this server; not displayed)"
} else {
  Write-Output "setup: $EnvFile already exists - left unchanged"
}

# 4. Runner + scheduled task (boot autostart + restart on failure = crash recovery)
#    The registered wrapper embeds the instance so the shared run-app module
#    always receives -Instance explicitly (task actions never pass it inline).
$RunnerSource="$Root\repo\deploy\windows\run-app.ps1"
$wrapper = "& `"$RunnerSource`" -Instance $Instance"
Set-Content -Path "$Root\tools\run-$Instance.ps1" -Value $wrapper -Encoding ASCII
$Runner="C:\Empire\tools\run-$Instance.ps1"

$action  = New-ScheduledTaskAction  -Execute 'powershell.exe' `
           -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`"" `
           -WorkingDirectory 'C:\Empire'
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
            -RestartCount 16 -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId 'LOCAL SERVICE' -LogonType ServiceAccount -RunLevel Limited
Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Output "setup: task $Task registered as LOCAL SERVICE (boot autostart; crash recovery by task restart, 16 retries/1min)"

# 5. Re-apply the writable-directory grants LAST: the broad /T root grant above
#    leaves my own sub-folder writes intact, but a later setup for the other
#    instance would re-walk the tree; a common helper keeps this idempotent.
if(Test-Path "$Root\repo\deploy\windows\grant-acls.ps1"){
  & powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\repo\deploy\windows\grant-acls.ps1"
}
