# Observatório de Qualidade do Ar — Trabalho 2: tolerância a falhas com replicação

Evolução do [Trabalho 1](https://github.com/lucasaued/t1distribuidosLucasDiego) (CRUD de medições de
qualidade do ar com Fastify, PostgreSQL e JMeter). O T2 replica as duas camadas que eram pontos únicos
de falha — o servidor web e o banco de dados — e mede o que acontece quando cada uma delas cai.

Relatório: [relatorio/Relatorio_T2_Sistemas_Distribuidos_Lucas_Aued_Diego_Rockenbach.pdf](relatorio/Relatorio_T2_Sistemas_Distribuidos_Lucas_Aued_Diego_Rockenbach.pdf)
(fonte em [relatorio/RELATORIO_FINAL.html](relatorio/RELATORIO_FINAL.html)).

## Arquitetura

```text
                      clientes (navegador, JMeter)
                                  |
                          HAProxy :3000  (verifica as APIs a cada 1 s)
                  ┌───────────────┼───────────────┐
                api1            api2            api3        API Fastify sem estado
                  └───────────────┼───────────────┘
                 escritas -> HAProxy :5000      leituras -> HAProxy :5001
                                  |                         |
                ┌──────── primário (Patroni) ── WAL ──> réplicas (Patroni) ────────┐
                pg1                      pg2                      pg3     PostgreSQL 16
                └──────────── etcd1, etcd2, etcd3 (eleição do líder, Raft) ────────┘
```

| Camada | Réplicas | Como sobrevive a uma queda |
| --- | ---: | --- |
| API (servidor web) | 3 | Sem estado. O HAProxy retira a réplica morta e reenvia a requisição interrompida a outra. |
| PostgreSQL | 3 (1 primário + 2 réplicas) | Replicação por streaming de WAL. O Patroni promove uma réplica quando a chave de líder do primário expira no etcd. |
| etcd | 3 | Consenso Raft; tolera a perda de 1 membro. |

Mudanças na API em relação ao T1: classificação de falhas do banco com novas tentativas
([api/src/resilience.ts](api/src/resilience.ts)), leituras que passam às réplicas quando o primário cai,
cabeçalho `Idempotency-Key` no POST ([migration 002](api/migrations/002_add_request_id.sql)),
desligamento gracioso, `/health/live` para o balanceador e a correção de um defeito do T1 que derrubava
a API quando o banco caía ([api/src/database.ts](api/src/database.ts)).

## Início rápido

```powershell
Copy-Item .env.example .env
docker compose up -d --build --wait
docker compose run --rm tools                     # migrations
docker compose run --rm tools npm run db:seed:prod -- --count 50000 --seed 20260930 --truncate
docker compose run --rm tools npm run db:index:prod -- create
```

| Endereço | O que é |
| --- | --- |
| <http://localhost:8080> | Interface web |
| <http://localhost:3000> | API, via HAProxy |
| <http://localhost:8404> | Estatísticas do HAProxy (estado de cada API e de cada nó do banco) |
| <http://localhost:8008/cluster> | Estado do cluster Patroni (também em 8009 e 8010) |

```powershell
docker compose exec pg1 patronictl -c /etc/patroni/patroni.yml list   # quem é o primário
docker kill t2-air-quality-api2-1                                      # derruba uma API
docker kill t2-air-quality-pg1-1                                       # derruba um nó do banco
docker start t2-air-quality-pg1-1                                      # volta como réplica
```

A topologia do T1 (uma API e um PostgreSQL) está em `docker-compose.baseline.yml`. As duas topologias
publicam a porta 3000; rode uma de cada vez.

## Experimentos

```powershell
.\scripts\setup-tools.ps1                  # baixa o JMeter 5.6.3 e cria o ambiente Python (uma vez)

# Um ensaio: topologia, modo de replicação, roteamento das leituras, cenário e falha
.\scripts\run-experiment.ps1 -Scenario A -Fault db-primary -Duration 150 -FaultAt 50 -RecoverAfter 60
.\scripts\run-experiment.ps1 -Topology baseline -Scenario B
.\scripts\run-experiment.ps1 -Replication sync -Scenario A -Fault db-replica

# Matriz usada no relatório (~2,5 h) e a consolidação em tabelas e figuras
.\scripts\run-matrix.ps1 -Repetitions 3
.\.venv\Scripts\python.exe analysis\analyze_results.py
.\.venv\Scripts\python.exe analysis\build_report.py   # imprime relatorio/RELATORIO_FINAL.html em PDF
```

Falhas disponíveis: `none`, `api`, `db-primary`, `db-replica` (`docker kill`, religado `RecoverAfter`
segundos depois) e `db-switchover` (troca planejada de primário pelo Patroni). Cada ensaio grava em
`resultados/` as amostras do JMeter, os eventos da falha, o estado do Patroni e do HAProxy a cada 0,5 s e
os logs dos contêineres.

## Testes da API

```powershell
Set-Location api
npm.cmd install
npm.cmd test
```
