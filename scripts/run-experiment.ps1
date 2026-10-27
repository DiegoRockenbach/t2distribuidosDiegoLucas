[CmdletBinding()]
param(
  # baseline = topologia do T1 (1 API, 1 PostgreSQL); replicated = topologia do T2
  [ValidateSet('baseline', 'replicated')][string]$Topology = 'replicated',
  [ValidateSet('async', 'sync')][string]$Replication = 'async',
  [ValidateSet('primary', 'replicas')][string]$ReadRouting = 'primary',
  [Parameter(Mandatory)][ValidateSet('A', 'B', 'C')][string]$Scenario,
  # api = mata uma replica da API (api2; na baseline, a unica API)
  # db-primary = mata o primario atual do PostgreSQL
  # db-replica = mata uma replica (a sincrona, no modo sync)
  # db-switchover = troca planejada de primario pelo Patroni (manutencao), sem matar nada
  [ValidateSet('none', 'api', 'db-primary', 'db-replica', 'db-switchover')][string]$Fault = 'none',
  [ValidateRange(1, 1000)][int]$Repetition = 1,
  [ValidateRange(1, 3600)][int]$RampUp = 10,
  [ValidateRange(10, 86400)][int]$Duration = 60,
  # Segundos apos o inicio da carga em que a falha e injetada.
  [ValidateRange(1, 86400)][int]$FaultAt = 50,
  # Segundos apos a falha em que o container derrubado e religado (0 = so no fim).
  [ValidateRange(0, 86400)][int]$RecoverAfter = 60,
  [ValidateRange(1000, 10000000)][int]$DatasetSize = 50000,
  [ValidateRange(1, 2147483647)][int]$Seed = 20260930,
  [string]$JMeterPath = '',
  [string]$Suite = 'adhoc'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/cluster.ps1')

if ($Topology -eq 'baseline') {
  if ($Fault -eq 'db-replica' -or $Fault -eq 'db-switchover') { throw 'A topologia baseline nao tem replicas de banco.' }
  if ($Replication -ne 'async' -or $ReadRouting -ne 'primary') {
    Write-Warning 'Replication e ReadRouting sao ignorados na topologia baseline.'
  }
  $configName = 'baseline'
} else {
  $configName = "$Replication-$ReadRouting"
}
if ($Fault -ne 'none' -and $FaultAt -ge $Duration) { throw 'FaultAt precisa ser menor que Duration.' }

$projectRoot = $script:ProjectRoot
if (-not $JMeterPath) {
  $bundled = Join-Path $projectRoot '.tools/apache-jmeter-5.6.3/bin/jmeter.bat'
  $JMeterPath = if (Test-Path -LiteralPath $bundled) { $bundled } else { 'jmeter' }
}
$python = Join-Path $projectRoot '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $python)) { $python = 'python' }

$distribution = @{ A = @{ Readers = 50; Writers = 50 }; B = @{ Readers = 75; Writers = 25 }; C = @{ Readers = 25; Writers = 75 } }
$clients = $distribution[$Scenario]
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runName = "$timestamp-$configName-fault-$Fault-scenario-$Scenario-rep-$Repetition"
$runDirectory = Join-Path $projectRoot "resultados/$Suite/$runName"
if (Test-Path -LiteralPath $runDirectory) { throw "Diretorio de resultado ja existe: $runDirectory" }
New-Item -ItemType Directory -Path $runDirectory | Out-Null
$eventsFile = Join-Path $runDirectory 'events.csv'
Set-Content -LiteralPath $eventsFile -Value 't_ms,event,target' -Encoding ascii
function Add-RunEvent([long]$Time, [string]$Name, [string]$Target = '') {
  Add-Content -LiteralPath $eventsFile -Value "$Time,$Name,$Target" -Encoding ascii
}

Write-Host "== $runName"
$otherTopology = if ($Topology -eq 'baseline') { 'replicated' } else { 'baseline' }
$killedContainer = $null
$monitor = $null
$jmeter = $null

try {
  # 1. Somente a topologia avaliada fica no ar (as duas publicam a porta 3000).
  Invoke-Compose -Topology $otherTopology -Arguments @('stop') -AllowFailure | Out-Null
  if ($Topology -eq 'replicated') {
    $env:READ_ROUTING = $ReadRouting
    Invoke-Compose -Topology $Topology -Arguments @('up', '-d', '--wait', '--wait-timeout', '240') | Out-Null
    Wait-Condition -What 'cluster com primario' -TimeoutSec 180 -Check {
      if ($null -eq (Get-PatroniLeader)) { return 'sem lider' } else { return $null }
    }
    Set-ReplicationMode $Replication
    Wait-Condition -What 'cluster replicado completo' -TimeoutSec 240 -Consecutive 3 -Check { Test-ReplicatedReady $Replication }
  } else {
    Invoke-Compose -Topology $Topology -Arguments @('up', '-d', '--wait', '--wait-timeout', '180', 'postgres', 'api') | Out-Null
    Wait-Condition -What 'API e banco' -TimeoutSec 120 -Check { Test-BaselineReady }
  }

  # 2. Mesmo ponto de partida em toda rodada: 50 mil registros + indice composto.
  Reset-Dataset -Topology $Topology -DatasetSize $DatasetSize -Seed $Seed
  if ($Topology -eq 'replicated') {
    Wait-Condition -What 'replicas sincronizadas com o primario' -TimeoutSec 120 -Check { Test-ReplicasCaughtUp }
    Wait-Condition -What 'cluster replicado completo' -TimeoutSec 120 -Consecutive 3 -Check { Test-ReplicatedReady $Replication }
  } else {
    Wait-Condition -What 'API e banco' -TimeoutSec 60 -Check { Test-BaselineReady }
  }

  $leaderBefore = if ($Topology -eq 'replicated') { Get-PatroniLeader } else { 'postgres' }
  $clusterBefore = if ($Topology -eq 'replicated') { Get-PatroniCluster } else { $null }

  # 3. Alvo da falha, resolvido antes da carga para nao atrasar a injecao.
  $faultService = $null
  if ($Fault -eq 'api') {
    $faultService = if ($Topology -eq 'baseline') { 'api' } else { 'api2' }
  } elseif ($Fault -eq 'db-primary' -or $Fault -eq 'db-switchover') {
    $faultService = $leaderBefore
  } elseif ($Fault -eq 'db-replica') {
    $replicas = @($clusterBefore.members | Where-Object { $_.role -ne 'leader' } | Sort-Object name)
    $sync = @($replicas | Where-Object { $_.role -eq 'sync_standby' })
    $faultService = if ($sync.Count -gt 0) { $sync[0].name } else { $replicas[0].name }
  }
  $faultContainer = if ($faultService -and $Fault -ne 'db-switchover') { Get-ContainerId $Topology $faultService } else { $null }

  $metadata = [ordered]@{
    runName = $runName
    suite = $Suite
    configName = $configName
    topology = $Topology
    replication = if ($Topology -eq 'replicated') { $Replication } else { 'none' }
    readRouting = if ($Topology -eq 'replicated') { $ReadRouting } else { 'primary' }
    scenario = $Scenario
    readers = $clients.Readers
    writers = $clients.Writers
    fault = $Fault
    faultService = $faultService
    faultAtSeconds = $FaultAt
    recoverAfterSeconds = $RecoverAfter
    rampUpSeconds = $RampUp
    durationSeconds = $Duration
    datasetSize = $DatasetSize
    seed = $Seed
    repetition = $Repetition
    leaderBefore = $leaderBefore
    startedAt = (Get-Date).ToString('o')
  }
  $metadata | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $runDirectory 'metadata.json') -Encoding utf8

  # 4. Monitor do cluster em paralelo com a carga.
  $timeline = Join-Path $runDirectory 'timeline.jsonl'
  $monitorArgs = @((Join-Path $PSScriptRoot 'monitor_cluster.py'), '--out', $timeline, '--duration', "$($Duration + 30)")
  if ($Topology -eq 'replicated') {
    $monitorArgs += @('--patroni', ($script:PatroniUrls -join ','), '--haproxy', $script:HaproxyCsvUrl)
  } else {
    $monitorArgs += @('--api', 'http://localhost:3000/health/live')
  }
  $monitor = Start-Process -FilePath $python -ArgumentList (@('-I') + $monitorArgs) -NoNewWindow -PassThru `
    -RedirectStandardError (Join-Path $runDirectory 'monitor-stderr.txt')

  # 5. Carga do JMeter em segundo plano.
  $jtl = Join-Path $runDirectory 'samples.jtl'
  $jmeterArgs = @(
    '-n', '-t', (Join-Path $projectRoot 'jmeter/air-quality-load-test.jmx'),
    '-Japi_host=localhost', '-Japi_port=3000', "-Jscenario=$Scenario",
    "-Jreaders=$($clients.Readers)", "-Jwriters=$($clients.Writers)",
    "-Jramp_up=$RampUp", "-Jduration=$Duration",
    '-Jjmeter.save.saveservice.output_format=csv',
    '-Jjmeter.save.saveservice.print_field_names=true',
    '-Jjmeter.save.saveservice.url=false',
    '-Jsample_variables=served_by,reading_id,idem_key',
    '-l', $jtl, '-j', (Join-Path $runDirectory 'jmeter.log')
  )
  $quoted = ($jmeterArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
  $loadStart = Get-EpochMs
  Add-RunEvent $loadStart 'load_start'
  $jmeter = Start-Process -FilePath $JMeterPath -ArgumentList $quoted -NoNewWindow -PassThru `
    -RedirectStandardOutput (Join-Path $runDirectory 'jmeter-stdout.txt') `
    -RedirectStandardError (Join-Path $runDirectory 'jmeter-stderr.txt')
  $null = $jmeter.Handle

  # 6. Injecao da falha: docker kill envia SIGKILL (queda abrupta, sem desligamento gracioso).
  if ($Fault -eq 'db-switchover') {
    Wait-UntilEpochMs ($loadStart + $FaultAt * 1000)
    $faultMs = Get-EpochMs
    $body = @{ leader = $leaderBefore } | ConvertTo-Json -Compress
    $answer = Invoke-RestMethod -Method Post -Uri "$($script:PatroniUrls[0])/switchover" -Body $body `
      -ContentType 'application/json' -TimeoutSec 60
    Add-RunEvent $faultMs 'fault_injected' $faultService
    Add-RunEvent (Get-EpochMs) 'switchover_returned' $faultService
    Write-Host "   switchover solicitado: $answer"
  } elseif ($faultContainer) {
    Wait-UntilEpochMs ($loadStart + $FaultAt * 1000)
    $faultMs = Get-EpochMs
    Invoke-Native -FilePath 'docker' -ArgumentList @('kill', $faultContainer) | Out-Null
    $killedContainer = $faultContainer
    Add-RunEvent $faultMs 'fault_injected' $faultService
    Add-RunEvent (Get-EpochMs) 'fault_kill_returned' $faultService
    Write-Host "   falha injetada em $faultService"
    if ($RecoverAfter -gt 0) {
      Wait-UntilEpochMs ($faultMs + $RecoverAfter * 1000)
      $recoverMs = Get-EpochMs
      Invoke-Native -FilePath 'docker' -ArgumentList @('start', $faultContainer) | Out-Null
      $killedContainer = $null
      Add-RunEvent $recoverMs 'recovery_started' $faultService
      Write-Host "   $faultService religado"
    }
  }

  $jmeter.WaitForExit()
  $jmeterExit = $jmeter.ExitCode
  Add-RunEvent (Get-EpochMs) 'load_end'
  if ($killedContainer) {
    Invoke-Native -FilePath 'docker' -ArgumentList @('start', $killedContainer) | Out-Null
    Add-RunEvent (Get-EpochMs) 'recovery_started' $faultService
    $killedContainer = $null
  }

  # 7. Espera o sistema voltar a redundancia completa e registra quando isso ocorreu.
  if ($Topology -eq 'replicated') {
    Wait-Condition -What 'cluster replicado completo apos o ensaio' -TimeoutSec 240 -Check { Test-ReplicatedReady $Replication }
  } else {
    Wait-Condition -What 'API e banco apos o ensaio' -TimeoutSec 120 -Check { Test-BaselineReady }
  }
  Add-RunEvent (Get-EpochMs) 'fully_restored'
  if ($null -ne $monitor -and -not $monitor.HasExited) { Stop-Process -Id $monitor.Id -Force }

  # 8. Evidencias: registros de carga remanescentes (escritas perdidas), estado final e logs.
  $remaining = Invoke-Compose -Topology $Topology -Arguments @('run', '--rm', '-T', 'tools', 'node', 'dist/scripts/export-load-records.js') -StdoutOnly
  Set-Content -LiteralPath (Join-Path $runDirectory 'remaining.csv') -Value $remaining -Encoding utf8
  if ($Topology -eq 'replicated') {
    Get-PatroniCluster | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $runDirectory 'cluster-after.json') -Encoding utf8
  }
  $since = [DateTimeOffset]::FromUnixTimeMilliseconds($loadStart - 5000).ToString('yyyy-MM-ddTHH:mm:ssZ')
  $logServices = if ($Topology -eq 'replicated') { @('haproxy', 'pg1', 'pg2', 'pg3', 'api1', 'api2', 'api3') } else { @('postgres', 'api') }
  $logs = Invoke-Compose -Topology $Topology -Arguments (@('logs', '--no-color', '--timestamps', '--since', $since) + $logServices) -AllowFailure
  Set-Content -LiteralPath (Join-Path $runDirectory 'containers.log') -Value $logs -Encoding utf8

  $metadata.leaderAfter = if ($Topology -eq 'replicated') { Get-PatroniLeader } else { 'postgres' }
  $metadata.loadStartMs = $loadStart
  $metadata.jmeterExitCode = $jmeterExit
  $metadata.finishedAt = (Get-Date).ToString('o')
  $metadata | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $runDirectory 'metadata.json') -Encoding utf8
  if ($jmeterExit -ne 0) { throw "JMeter encerrou com codigo $jmeterExit." }
  Write-Host "   concluido: $runDirectory"
} finally {
  if ($null -ne $jmeter -and -not $jmeter.HasExited) { Stop-Process -Id $jmeter.Id -Force -ErrorAction SilentlyContinue }
  if ($null -ne $monitor -and -not $monitor.HasExited) { Stop-Process -Id $monitor.Id -Force -ErrorAction SilentlyContinue }
  if ($killedContainer) { Invoke-Native -FilePath 'docker' -ArgumentList @('start', $killedContainer) -AllowFailure | Out-Null }
}
