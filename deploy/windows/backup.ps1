# SQLite-consistent online backup for one Empire instance, Windows-native.
# Uses the SQLite online backup API (VACUUM INTO) through node:sqlite — a clean
# self-contained snapshot while the service keeps running.
#   powershell -File backup.ps1 -Instance staging
#   powershell -File backup.ps1 -Instance staging -RestoreVerify <file>
param(
  [Parameter(Mandatory=$true)][ValidateSet('staging','production')] [string]$Instance,
  [string]$RestoreVerify
)
$ErrorActionPreference='Stop'
$Node='C:\Collectz\tools\node\node.exe'
$DbFile="C:\Empire\data\$Instance\empire.db"
$BackupDir="C:\Empire\backups\$Instance"
$ScriptDir=Split-Path -Parent $MyInvocation.MyCommand.Path

if($RestoreVerify){
  $NodeScript=@'
import { DatabaseSync } from 'node:sqlite';
import { openSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
const src = process.argv[1];
const tmp = 'C:/Empire/backups/.verify-' + Date.now();
mkdirSync(tmp, { recursive: true });
const json = readFileSync(src);
const dbFile = tmp + '/empire.db';
const { writeFileSync } = await import('node:fs');
writeFileSync(dbFile, json);
const db = new DatabaseSync(dbFile, { readOnly: true });
const integ = db.exec('PRAGMA integrity_check;').flat()[0];
const tables = db.exec("SELECT count(*) FROM sqlite_master WHERE type='table'").flat()[0];
db.close();
rmSync(tmp, { recursive: true, force: true });
if (integ !== 'ok') { console.error('verify FAILED: ' + integ); process.exit(1); }
console.log(`[backup] restore copy verified (integrity ok, ${tables} tables)`);
'@
  $TmpJs="C:\Empire\backups\.verify.mjs"
  $NodeScript | Set-Content -Path $TmpJs -Encoding UTF8
  & $Node $TmpJs $RestoreVerify
  exit $LASTEXITCODE
}

if(-not (Test-Path $DbFile)){ throw "missing $DbFile" }
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
# Backups may contain account/session data: SYSTEM + Administrators only, and
# inherited removal keeps the application identity (LOCAL SERVICE) out.
& icacls $BackupDir /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null

$Stamp=(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$Stage=Join-Path $BackupDir ".stage-$Stamp"
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
$NodeScript=@'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[1]);
db.exec(`VACUUM INTO '${process.argv[2].replace(/'/g, "''")}'`);
db.close();
console.log('snapshot ok');
'@
$TmpJs="$Stage\.backup.mjs"
$NodeScript | Set-Content -Path $TmpJs -Encoding UTF8
& $Node $TmpJs $DbFile "$Stage\empire.db" | Out-Null
Remove-Item $TmpJs
$Out=Join-Path $BackupDir "empire-$Instance-$Stamp.db"
Copy-Item "$Stage\empire.db" $Out
Remove-Item $Stage -Recurse -Force

# retention: keep the newest 14 daily snapshots
Get-ChildItem $BackupDir -Filter 'empire-*.db' | Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 14 | ForEach-Object { Remove-Item $_.FullName -Force }

# detectable end state: a small machine-readable status file + timestamped line
$Restored=$null
try {
  $tmpv=Join-Path $BackupDir ".verify-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Force -Path $tmpv | Out-Null
  $verify=@'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const ok = db.exec('PRAGMA integrity_check;').flat()[0] === 'ok';
process.exit(ok ? 0 : 2);
'@
  $tmpJs=Join-Path $tmpv '.check.mjs'
  $verify | Set-Content -Path $tmpJs -Encoding UTF8
  & $Node $tmpJs $Out
  $Restored=($LASTEXITCODE -eq 0)
  Remove-Item $tmpv -Recurse -Force
} catch { $Restored=$false }

$status=[ordered]@{
  instance = $Instance
  file = $Out
  stamp = (Get-Date).ToUniversalTime().ToString('o')
  retentionDays = 14
  integrityOk = [bool]$Restored
  result = $(if($Restored){ 'success' } else { 'FAILED' })
}
($status | ConvertTo-Json -Compress) | Set-Content -Path (Join-Path $BackupDir 'last-status.json') -Encoding ASCII
Write-Output "[backup] wrote $Out"
if($Restored){ Write-Output '[backup] integrity check: ok' } else { Write-Output '[backup] integrity check FAILED'; exit 1 }
