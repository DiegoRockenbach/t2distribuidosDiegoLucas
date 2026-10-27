[CmdletBinding()]
param(
  [string]$JMeterVersion = '5.6.3',
  [switch]$SkipPython
)

# Prepara as ferramentas locais (ignoradas pelo git):
#   .tools/apache-jmeter-<versao>   gerador de carga
#   .venv                           Python com pandas/matplotlib para a analise
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$toolsDir = Join-Path $projectRoot '.tools'
$jmeterHome = Join-Path $toolsDir "apache-jmeter-$JMeterVersion"
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $jmeterHome 'bin/jmeter.bat'))) {
  $zipName = "apache-jmeter-$JMeterVersion.zip"
  $zipPath = Join-Path $toolsDir $zipName
  $baseUrl = "https://archive.apache.org/dist/jmeter/binaries/$zipName"
  Write-Host "Baixando $baseUrl"
  Invoke-WebRequest -UseBasicParsing -Uri $baseUrl -OutFile $zipPath
  $expected = ((Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl.sha512").Content -split '\s+')[0].Trim().ToLowerInvariant()
  $actual = (Get-FileHash -Algorithm SHA512 -LiteralPath $zipPath).Hash.ToLowerInvariant()
  if ($expected -ne $actual) { throw "SHA-512 do JMeter nao confere (esperado $expected, obtido $actual)." }
  Expand-Archive -LiteralPath $zipPath -DestinationPath $toolsDir -Force
  Remove-Item -LiteralPath $zipPath
}
Write-Host "JMeter: $(Join-Path $jmeterHome 'bin/jmeter.bat')"

if (-not $SkipPython) {
  $venv = Join-Path $projectRoot '.venv'
  if (-not (Test-Path -LiteralPath (Join-Path $venv 'Scripts/python.exe'))) {
    python -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao criar o ambiente Python (.venv).' }
  }
  & (Join-Path $venv 'Scripts/python.exe') -m pip install --disable-pip-version-check -q -r (Join-Path $projectRoot 'analysis/requirements.txt')
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar as dependencias da analise.' }
  Write-Host "Python da analise: $(Join-Path $venv 'Scripts/python.exe')"
}
