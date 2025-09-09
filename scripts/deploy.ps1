param([Parameter(ValueFromRemainingArguments = $true)][string[]]$ArgsPassthru)
if (-not (Get-Command firebase -ErrorAction SilentlyContinue)) {
  Write-Error "Firebase CLI not found. Install with: npm i -g firebase-tools"
  exit 1
}
firebase deploy --only hosting:project-guardian-agent --project project-guardian-agent @ArgsPassthru