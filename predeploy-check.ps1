Write-Host "Running predeploy JS sanity check..." -ForegroundColor Cyan

$bad = Get-ChildItem -Path .\public -Filter *.js |
  Where-Object {
    try {
      (Get-Content $_.FullName -TotalCount 1) -match '<!DOCTYPE html>'
    } catch {
      Write-Warning "Could not read $($_.FullName): $_"
      $false
    }
  }

if ($bad -and $bad.Count -gt 0) {
  Write-Host ""
  Write-Error ("ERROR: The following .js files start with <!DOCTYPE html>:`n - " + ($bad.Name -join "`n - "))
  exit 1
} else {
  Write-Host "All .js files appear to be JS (no stray HTML DOCTYPEs found)." -ForegroundColor Green
}
