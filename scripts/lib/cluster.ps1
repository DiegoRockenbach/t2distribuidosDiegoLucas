# Funcoes comuns aos scripts de experimento. Compativel com Windows PowerShell 5.1.
Set-StrictMode -Version 3

$script:ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script:PatroniUrls = @('http://localhost:8008', 'http://localhost:8009', 'http://localhost:8010')
$script:HaproxyCsvUrl = 'http://localhost:8404/;csv'

function Get-EpochMs { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Wait-UntilEpochMs([long]$Target) {
  while ((Get-EpochMs) -lt $Target) { Start-Sleep -Milliseconds 100 }
}

# Executa um programa externo sem que o stderr dele vire excecao no PowerShell 5.1.
function Invoke-Native {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [switch]$AllowFailure,
    [switch]$StdoutOnly
  )
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($StdoutOnly) {
      $output = & $FilePath @ArgumentList 2>$null
    } else {
      $output = & $FilePath @ArgumentList 2>&1 | ForEach-Object { "$_" }
    }
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($code -ne 0 -and -not $AllowFailure) {
    throw ("Comando falhou ({0}): {1} {2}`n{3}" -f $code, $FilePath, ($ArgumentList -join ' '), (@($output) -join "`n"))
  }
  return @($output)
}

function Get-ComposeFile([string]$Topology) {
  if ($Topology -eq 'baseline') { return Join-Path $script:ProjectRoot 'docker-compose.baseline.yml' }
  return Join-Path $script:ProjectRoot 'docker-compose.yml'
}

function Invoke-Compose {
  param(
    [Parameter(Mandatory)][string]$Topology,
    [Parameter(Mandatory)][string[]]$Arguments,
    [switch]$AllowFailure,
    [switch]$StdoutOnly
  )
  $all = @('compose', '-f', (Get-ComposeFile $Topology)) + $Arguments
  return Invoke-Native -FilePath 'docker' -ArgumentList $all -AllowFailure:$AllowFailure -StdoutOnly:$StdoutOnly
}

function Get-ContainerId([string]$Topology, [string]$Service) {
  $id = @(Invoke-Compose -Topology $Topology -Arguments @('ps', '-a', '-q', $Service) -StdoutOnly) | Where-Object { $_ } | Select-Object -First 1
  if (-not $id) { throw "Container do servico $Service nao encontrado." }
  return "$id".Trim()
}

# Chama $Check a cada segundo ate ele devolver $null (pronto) em $Consecutive
# verificacoes seguidas, ou o tempo acabar. $Check devolve o que ainda falta.
function Wait-Condition {
  param(
    [Parameter(Mandatory)][scriptblock]$Check,
    [int]$TimeoutSec = 180,
    [string]$What = 'condicao',
    [int]$Consecutive = 1
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $last = 'sem verificacao'
  $streak = 0
  while ((Get-Date) -lt $deadline) {
    $last = & $Check
    if ($null -eq $last) {
      $streak += 1
      if ($streak -ge $Consecutive) { return }
    } else {
      $streak = 0
    }
    Start-Sleep -Seconds 1
  }
  throw "Tempo esgotado aguardando $What (ultimo estado: $last)"
}

function Get-PatroniCluster {
  foreach ($url in $script:PatroniUrls) {
    try { return Invoke-RestMethod -Uri "$url/cluster" -TimeoutSec 2 } catch { continue }
  }
  return $null
}

# Le uma propriedade opcional (o lider, por exemplo, nao tem "lag").
function Get-OptionalProperty($Object, [string]$Name) {
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Get-MemberSummary($Cluster) {
  if ($null -eq $Cluster) { return 'patroni sem resposta' }
  return (@($Cluster.members) | ForEach-Object {
      "$($_.name)=$($_.role)/$($_.state)/lag:$(Get-OptionalProperty $_ 'lag')"
    }) -join ', '
}

function Get-PatroniLeader {
  $cluster = Get-PatroniCluster
  if ($null -eq $cluster) { return $null }
  $leaders = @($cluster.members | Where-Object { $_.role -eq 'leader' -and $_.state -eq 'running' })
  if ($leaders.Count -eq 1) { return $leaders[0].name }
  return $null
}

function Get-HaproxyServers {
  try {
    $csv = (Invoke-WebRequest -UseBasicParsing -Uri $script:HaproxyCsvUrl -TimeoutSec 2).Content
  } catch {
    return @()
  }
  return @($csv.TrimStart('#', ' ') | ConvertFrom-Csv | Where-Object {
      $_.svname -ne 'FRONTEND' -and $_.svname -ne 'BACKEND' -and $_.pxname -ne 'stats'
    })
}

function Get-UpCount($Servers, [string]$Proxy) {
  return @($Servers | Where-Object { $_.pxname -eq $Proxy -and $_.status -eq 'UP' }).Count
}

# $null quando o cluster replicado esta completo: 1 lider, 2 replicas em
# streaming (uma sincrona, no modo sync), 3 APIs e as rotas do HAProxy no ar.
function Test-ReplicatedReady([string]$Replication) {
  $cluster = Get-PatroniCluster
  if ($null -eq $cluster) { return 'patroni sem resposta' }
  $members = @($cluster.members)
  $leaders = @($members | Where-Object { $_.role -eq 'leader' -and $_.state -eq 'running' })
  $streaming = @($members | Where-Object { $_.role -ne 'leader' -and $_.state -eq 'streaming' })
  if ($members.Count -ne 3 -or $leaders.Count -ne 1 -or $streaming.Count -ne 2) { return Get-MemberSummary $cluster }
  $sync = @($members | Where-Object { $_.role -eq 'sync_standby' })
  if ($Replication -eq 'sync' -and $sync.Count -ne 1) { return "aguardando replica sincrona: $(Get-MemberSummary $cluster)" }
  if ($Replication -eq 'async' -and $sync.Count -ne 0) { return "ainda ha replica sincrona: $(Get-MemberSummary $cluster)" }
  $servers = Get-HaproxyServers
  if ((Get-UpCount $servers 'api_servers') -ne 3) { return 'HAProxy: nem todas as APIs estao UP' }
  if ((Get-UpCount $servers 'pg_primary') -ne 1) { return 'HAProxy: sem primario UP' }
  if ((Get-UpCount $servers 'pg_replicas') -ne 2) { return 'HAProxy: replicas de leitura incompletas' }
  return $null
}

function Test-ReplicasCaughtUp {
  $cluster = Get-PatroniCluster
  if ($null -eq $cluster) { return 'patroni sem resposta' }
  $lagging = @($cluster.members | Where-Object {
      $_.role -ne 'leader' -and ($_.state -ne 'streaming' -or "$(Get-OptionalProperty $_ 'lag')" -ne '0')
    })
  if ($lagging.Count -gt 0) { return Get-MemberSummary $cluster }
  return $null
}

function Test-BaselineReady {
  try {
    $health = Invoke-RestMethod -Uri 'http://localhost:3000/health' -TimeoutSec 3
    if ($health.status -eq 'ok') { return $null }
    return "status $($health.status)"
  } catch {
    return 'API ou banco indisponiveis'
  }
}

# Liga/desliga o synchronous_mode na configuracao dinamica (etcd) do Patroni.
function Set-ReplicationMode([string]$Replication) {
  $desired = $Replication -eq 'sync'
  foreach ($url in $script:PatroniUrls) {
    try {
      $config = Invoke-RestMethod -Uri "$url/config" -TimeoutSec 3
    } catch {
      continue
    }
    $property = $config.PSObject.Properties['synchronous_mode']
    $current = ($null -ne $property) -and [bool]$property.Value
    if ($current -ne $desired) {
      $body = @{ synchronous_mode = $desired } | ConvertTo-Json -Compress
      Invoke-RestMethod -Method Patch -Uri "$url/config" -Body $body -ContentType 'application/json' -TimeoutSec 5 | Out-Null
    }
    return
  }
  throw 'Nao foi possivel alterar o modo de replicacao: nenhum no do Patroni respondeu.'
}

# Recria o dataset do zero: migrations, carga deterministica e indice composto.
# A carga roda numa unica transacao (TRUNCATE + INSERTs), entao repetir e seguro.
function Reset-Dataset([string]$Topology, [int]$DatasetSize, [int]$Seed, [int]$Attempts = 3) {
  $script = "npm run db:migrate:prod && npm run db:seed:prod -- --count $DatasetSize --seed $Seed --truncate && npm run db:index:prod -- create && npm run db:index:prod -- status"
  for ($attempt = 1; ; $attempt += 1) {
    try {
      $output = Invoke-Compose -Topology $Topology -Arguments @('run', '--rm', '-T', 'tools', 'sh', '-c', $script)
      break
    } catch {
      if ($attempt -ge $Attempts) { throw }
      Write-Warning "Preparacao do dataset falhou (tentativa $attempt de $Attempts); repetindo em 5 s."
      Start-Sleep -Seconds 5
    }
  }
  $status = @($output | Where-Object { $_ -match '"present"' }) | Select-Object -Last 1
  if (-not ($status -match '"present":true')) { throw "Indice ausente apos a preparacao do dataset: $($output -join ' | ')" }
  $seeded = @($output | Where-Object { $_ -match '"finalCount"' }) | Select-Object -Last 1
  if (-not ($seeded -match ('"finalCount":' + $DatasetSize))) { throw "Carga do dataset inconsistente: $seeded" }
}
