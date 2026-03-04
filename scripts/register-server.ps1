param(
  [Parameter(Mandatory = $true)][string]$Id,
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$Description = "",
  [string]$TargetUrl = "",
  [string]$HealthPath = "/health",
  [string]$AuthType = "",
  [string]$AuthInstructions = "",
  [string]$DocsUrl = "",
  [string]$SignupUrl = "",
  [string]$Command = "",
  [string[]]$CommandArgs = @(),
  [string[]]$RequiredHeaders = @("Authorization"),
  [string[]]$ForwardHeaders = @("authorization"),
  [hashtable]$CommandEnv = @{},
  [hashtable]$CommandEnvSecrets = @{},
  [switch]$AutoStart,
  [string]$BaseUrl = "http://127.0.0.1:8080",
  [string]$ApiKey = ""
)

$headers = @{ "Content-Type" = "application/json" }
if ($ApiKey) {
  $headers["X-API-Key"] = $ApiKey
}

$body = @{
  id = $Id
  name = $Name
  description = $Description
  targetUrl = $TargetUrl
  healthPath = $HealthPath
  authType = $AuthType
  authInstructions = $AuthInstructions
  docsUrl = $DocsUrl
  signupUrl = $SignupUrl
  command = $Command
  commandArgs = $CommandArgs
  commandEnv = $CommandEnv
  commandEnvSecrets = $CommandEnvSecrets
  requiredHeaders = $RequiredHeaders
  forwardHeaders = $ForwardHeaders
  autoStart = [bool]$AutoStart
} | ConvertTo-Json -Depth 10

Invoke-RestMethod -Method POST -Uri "$BaseUrl/admin/servers" -Headers $headers -Body $body
