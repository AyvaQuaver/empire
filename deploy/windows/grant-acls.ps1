# Grant the app identity writable (inheritable) ACEs on all per-instance write
# directories. Run after any setup/redeploy tree operation that may have reset
# ACLs (e.g. a broad root-level icacls re-grant).
#   powershell -ExecutionPolicy Bypass -File grant-acls.ps1
$ErrorActionPreference='Stop'
Write-Output '== data: staging + production =='
foreach($d in 'C:\Empire\data\staging','C:\Empire\data\production'){
  if(Test-Path $d){
    icacls $d /T /C /grant:r 'Administrators:(OI)(CI)F' /grant:r 'SYSTEM:(OI)(CI)F' /grant:r 'NT AUTHORITY\LOCAL SERVICE:(OI)(CI)M' | Out-Null
    Write-Output "granted Modify: $d"
  }
}
Write-Output '== logs + extra dirs =='
foreach($d in 'C:\Empire\shared\logs'){
  if(Test-Path $d){
    icacls $d /T /C /grant:r 'Administrators:(OI)(CI)F' /grant:r 'SYSTEM:(OI)(CI)F' /grant:r 'NT AUTHORITY\LOCAL SERVICE:(OI)(CI)M' | Out-Null
    Write-Output "granted Modify: $d"
  }
}
Write-Output '== backups: restrict (may contain account/session data) =='
foreach($d in 'C:\Empire\backups\staging','C:\Empire\backups\production'){
  if(Test-Path $d){
    icacls $d /T /C /inheritance:r /grant:r 'Administrators:(OI)(CI)F' /grant:r 'SYSTEM:(OI)(CI)F' | Out-Null
    Write-Output "restricted: $d"
  }
}
Write-Output '== env files readable (never writable by the app) =='
foreach($f in 'C:\Empire\shared\staging.env','C:\Empire\shared\production.env'){
  if(Test-Path $f){
    icacls $f /grant:r 'NT AUTHORITY\LOCAL SERVICE:RX' | Out-Null
    Write-Output "granted Read: $f"
  }
}
Write-Output 'acls refreshed'
