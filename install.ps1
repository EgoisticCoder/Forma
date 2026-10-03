$ErrorActionPreference = "Stop"
$repo = "EgoisticCoder/Forma"
$version = if ($env:FORMA_VERSION) { $env:FORMA_VERSION } else { "latest" }
$asset = "forma-cli-bundle.zip"
if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "FORMA needs Node.js 20+ and npm. Install Node from https://nodejs.org/ and rerun."
}
$nodeMajor = [int]((node -p 'process.versions.node.split(".")[0]'))
if ($nodeMajor -lt 20) { throw "FORMA needs Node.js 20 or newer." }
$base = "https://github.com/$repo/releases"
if ($version -eq "latest") { $url = "$base/latest/download/$asset"; $sumUrl = "$base/latest/download/SHA256SUMS" }
else { $url = "$base/download/$version/$asset"; $sumUrl = "$base/download/$version/SHA256SUMS" }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Invoke-WebRequest -Uri $url -OutFile (Join-Path $tmp $asset)
  Invoke-WebRequest -Uri $sumUrl -OutFile (Join-Path $tmp "SHA256SUMS")
  $expected = (Select-String -Path (Join-Path $tmp "SHA256SUMS") -Pattern "^([a-fA-F0-9]{64})\s+$asset$").Matches.Groups[1].Value
  $actual = (Get-FileHash (Join-Path $tmp $asset) -Algorithm SHA256).Hash
  if (-not $expected -or $expected.ToLower() -ne $actual.ToLower()) { throw "Release checksum is missing or does not match; package was not installed." }
  Expand-Archive (Join-Path $tmp $asset) -DestinationPath $tmp
  $packages = Get-ChildItem (Join-Path $tmp "forma-cli-bundle") -Filter *.tgz | ForEach-Object { $_.FullName }
  if ($packages.Count -lt 2) { throw "Release archive did not contain both Forma packages." }
  & npm.cmd install --global $packages opencode-ai
  if ($LASTEXITCODE -ne 0) { throw "npm installation failed with exit code $LASTEXITCODE." }
  $openCodeRoot = Join-Path ((npm root --global).Trim()) "opencode-ai"
  $postInstall = Join-Path $openCodeRoot "postinstall.mjs"
  if (Test-Path $postInstall) { node $postInstall; if ($LASTEXITCODE -ne 0) { throw "OpenCode platform setup failed." } }
  if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) { throw "OpenCode's CLI did not install. See https://opencode.ai/docs for a manual install." }
  Write-Host "FORMA installed. Run 'forma' to connect your models."
} finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
