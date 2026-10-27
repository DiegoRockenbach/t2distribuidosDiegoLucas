[CmdletBinding()]
param(
  # desempenho = sem falhas, cenarios A/B/C; falhas = injecao de falhas no cenario A
  [ValidateSet('desempenho', 'falhas', 'all')][string]$Suite = 'all',
  [ValidateRange(1, 100)][int]$Repetitions = 3,
  [ValidateRange(10, 3600)][int]$PerformanceDuration = 60,
  [ValidateRange(30, 3600)][int]$FaultDuration = 150,
  [ValidateRange(1, 3600)][int]$FaultAt = 50,
  [ValidateRange(0, 3600)][int]$RecoverAfter = 60,
  [ValidateRange(1, 3600)][int]$RampUp = 10,
  [string]$JMeterPath = ''
)

# Executa a matriz experimental. As repeticoes sao intercaladas (rodada 1 de
# todas as configuracoes, depois a rodada 2...) para que variacoes lentas da
# maquina nao fiquem concentradas numa unica configuracao. Uma rodada que falhar
# e registrada em resultados/<suite>/falhas-de-execucao.log e a matriz continua.
$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'run-experiment.ps1'
$results = Join-Path (Split-Path -Parent $PSScriptRoot) 'resultados'

$performance = @(
  @{ Topology = 'replicated'; Replication = 'async'; ReadRouting = 'primary' },
  @{ Topology = 'replicated'; Replication = 'sync'; ReadRouting = 'primary' },
  @{ Topology = 'replicated'; Replication = 'async'; ReadRouting = 'replicas' },
  @{ Topology = 'baseline'; Replication = 'async'; ReadRouting = 'primary' }
)

$faults = @(
  @{ Topology = 'replicated'; Replication = 'async'; ReadRouting = 'primary'; Faults = @('api', 'db-primary', 'db-replica', 'db-switchover') },
  @{ Topology = 'replicated'; Replication = 'sync'; ReadRouting = 'primary'; Faults = @('db-primary', 'db-replica', 'db-switchover') },
  @{ Topology = 'replicated'; Replication = 'async'; ReadRouting = 'replicas'; Faults = @('db-replica') },
  @{ Topology = 'baseline'; Replication = 'async'; ReadRouting = 'primary'; Faults = @('api', 'db-primary') }
)

function Invoke-Run([string]$SuiteName, [hashtable]$Parameters) {
  $logFile = Join-Path $results "$SuiteName/falhas-de-execucao.log"
  try {
    & $runner @Parameters -Suite $SuiteName
  } catch {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logFile) | Out-Null
    $summary = ($Parameters.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ' '
    Add-Content -LiteralPath $logFile -Value "$(Get-Date -Format o) $summary :: $($_.Exception.Message)" -Encoding utf8
    Write-Warning "Rodada falhou ($summary): $($_.Exception.Message)"
  }
}

$common = @{ RampUp = $RampUp }
if ($JMeterPath) { $common.JMeterPath = $JMeterPath }
$started = Get-Date

for ($repetition = 1; $repetition -le $Repetitions; $repetition += 1) {
  if ($Suite -eq 'desempenho' -or $Suite -eq 'all') {
    foreach ($config in $performance) {
      foreach ($scenario in @('A', 'B', 'C')) {
        $parameters = $common.Clone()
        $parameters += @{
          Topology = $config.Topology; Replication = $config.Replication; ReadRouting = $config.ReadRouting
          Scenario = $scenario; Fault = 'none'; Repetition = $repetition; Duration = $PerformanceDuration
        }
        Invoke-Run 'desempenho' $parameters
      }
    }
  }
  if ($Suite -eq 'falhas' -or $Suite -eq 'all') {
    foreach ($config in $faults) {
      foreach ($fault in $config.Faults) {
        $parameters = $common.Clone()
        $parameters += @{
          Topology = $config.Topology; Replication = $config.Replication; ReadRouting = $config.ReadRouting
          Scenario = 'A'; Fault = $fault; Repetition = $repetition; Duration = $FaultDuration
          FaultAt = $FaultAt; RecoverAfter = $RecoverAfter
        }
        Invoke-Run 'falhas' $parameters
      }
    }
  }
}

Write-Host ("Matriz concluida em {0:n1} min." -f ((Get-Date) - $started).TotalMinutes)
