"""Consolida os ensaios do Trabalho 2 em tabelas e figuras.

Le cada diretorio de resultados/<suite>/<ensaio>/ (metadata.json, samples.jtl,
events.csv, timeline.jsonl, remaining.csv) e gera:

  relatorio/tabelas/desempenho_por_rodada.csv  metricas de cada rodada sem falha
  relatorio/tabelas/desempenho_resumo.csv      media e desvio por configuracao e cenario
  relatorio/tabelas/falhas_por_rodada.csv      indisponibilidade, erros e marcos de cada falha
  relatorio/tabelas/falhas_resumo.csv          media, minimo e maximo por configuracao e falha
  relatorio/figuras/*.png                      graficos do relatorio (mesmo estilo do T1)

Uso: .venv/Scripts/python.exe analysis/analyze_results.py
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "resultados"
REPORT = ROOT / "relatorio"
TABLES = REPORT / "tabelas"
FIGURES = REPORT / "figuras"

READ_LABELS = {"READ - filtered list"}
CONFIG_ORDER = ["baseline", "async-primary", "sync-primary", "async-replicas"]
CONFIG_LABELS = {
    "baseline": "Sem replicação (T1)",
    "async-primary": "Replicação assíncrona",
    "sync-primary": "Replicação síncrona",
    "async-replicas": "Assíncrona + leitura nas réplicas",
}
# Mesmas cores do relatorio do T1 (vermelho e verde), mais o azul e o laranja do layout.
CONFIG_COLORS = {"baseline": "#a33a32", "async-primary": "#176b4d", "sync-primary": "#315d83",
                 "async-replicas": "#d27a28"}
DB_FAULTS = {"db-primary", "db-replica", "db-switchover"}


@dataclass
class Run:
    path: Path
    meta: dict
    samples: pd.DataFrame
    events: pd.DataFrame
    timeline: list[dict]
    remaining: pd.DataFrame

    @property
    def config(self) -> str:
        return self.meta["configName"]

    @property
    def fault(self) -> str:
        return self.meta["fault"]

    def event_time(self, name: str) -> float:
        rows = self.events.loc[self.events["event"] == name, "t_ms"]
        return float(rows.iloc[0]) if len(rows) else float("nan")


def load_run(path: Path) -> Run | None:
    meta_path = path / "metadata.json"
    if not meta_path.exists() or not (path / "samples.jtl").exists():
        return None
    meta = json.loads(meta_path.read_text(encoding="utf-8-sig"))
    if "finishedAt" not in meta:
        return None  # rodada interrompida
    columns = ["timeStamp", "elapsed", "label", "responseCode", "success", "served_by", "reading_id", "idem_key"]
    samples = pd.read_csv(path / "samples.jtl", usecols=lambda column: column in columns,
                          dtype={"responseCode": str, "served_by": str, "reading_id": str, "idem_key": str},
                          low_memory=False)
    if "idem_key" not in samples.columns:
        samples["idem_key"] = ""
    samples["success"] = samples["success"].astype(str).str.lower() == "true"
    samples["end"] = samples["timeStamp"] + samples["elapsed"]
    samples["kind"] = np.where(samples["label"].isin(READ_LABELS), "read", "write")
    timeline = []
    timeline_path = path / "timeline.jsonl"
    if timeline_path.exists():
        for line in timeline_path.read_text(encoding="utf-8").splitlines():
            try:
                timeline.append(json.loads(line))
            except json.JSONDecodeError:
                break  # ultima linha truncada quando o monitor e encerrado
    remaining = pd.DataFrame({"id": pd.Series(dtype=str), "request_id": pd.Series(dtype=str)})
    if (path / "remaining.csv").exists():
        frame = pd.read_csv(path / "remaining.csv", encoding="utf-8-sig", dtype=str).fillna("")
        if "id" in frame.columns:
            remaining = frame.reindex(columns=["id", "request_id"], fill_value="")
    return Run(path, meta, samples, pd.read_csv(path / "events.csv"), timeline, remaining)


def load_suite(suite: str) -> list[Run]:
    directory = RESULTS / suite
    if not directory.exists():
        return []
    runs = [load_run(path) for path in sorted(directory.iterdir()) if path.is_dir()]
    return [run for run in runs if run is not None]


# ---------------------------------------------------------------------------
# Metricas
# ---------------------------------------------------------------------------

def request_metrics(frame: pd.DataFrame, duration_s: float) -> dict[str, float]:
    ok = frame[frame["success"]]
    elapsed = ok["elapsed"].to_numpy(dtype=float)
    has = len(elapsed) > 0
    return {
        "samples": int(len(frame)),
        "errors": int(len(frame) - len(ok)),
        "throughput_rps": len(ok) / duration_s,
        "mean_ms": float(elapsed.mean()) if has else float("nan"),
        "p95_ms": float(np.percentile(elapsed, 95)) if has else float("nan"),
        "p99_ms": float(np.percentile(elapsed, 99)) if has else float("nan"),
    }


def performance_rows(run: Run) -> list[dict]:
    """Metricas em regime: descarta o ramp-up do inicio da carga."""
    samples = run.samples
    start = samples["timeStamp"].min() + run.meta["rampUpSeconds"] * 1000
    steady = samples[samples["timeStamp"] >= start]
    duration = (samples["end"].max() - start) / 1000.0
    base = {"run": run.path.name, "config": run.config, "scenario": run.meta["scenario"],
            "repetition": int(run.meta["repetition"])}
    return [{**base, "operation": operation, **request_metrics(subset, duration)}
            for operation, subset in [("overall", steady), ("read", steady[steady["kind"] == "read"]),
                                      ("write", steady[steady["kind"] == "write"])]]


def longest_gap_s(samples: pd.DataFrame, kind: str, fault_ms: float, until_ms: float) -> float:
    """Maior intervalo sem nenhuma resposta correta do tipo, a partir da falha."""
    ends = np.sort(samples.loc[(samples["kind"] == kind) & samples["success"], "end"].to_numpy(dtype=float))
    ends = ends[(ends >= fault_ms) & (ends <= until_ms)]
    return float(np.diff(np.concatenate([[fault_ms], ends, [until_ms]])).max() / 1000.0)


def per_second(samples: pd.DataFrame, origin_ms: float) -> pd.DataFrame:
    """Respostas por segundo (pelo instante de termino), relativas a origem."""
    second = np.floor((samples["end"].to_numpy(dtype=float) - origin_ms) / 1000.0).astype(int)
    kind, ok = samples["kind"].to_numpy(), samples["success"].to_numpy()
    frame = pd.DataFrame({"second": second, "read_ok": (kind == "read") & ok, "write_ok": (kind == "write") & ok,
                          "errors": ~ok})
    grouped = frame.groupby("second").sum()
    return grouped.reindex(range(int(grouped.index.min()), int(grouped.index.max()) + 1), fill_value=0)


def lost_writes(run: Run) -> dict[str, int]:
    """Escritas confirmadas ao cliente que nao sobreviveram ao failover.

    Cada ciclo do escritor (POST, PUT, DELETE) e identificado pela chave de
    idempotencia do POST. Criacao perdida: POST confirmado (201), PUT seguinte com
    404 e chave ausente do banco no fim. Exclusao perdida: DELETE confirmado (204)
    e chave ainda presente no banco no fim.
    """
    writes = run.samples[run.samples["kind"] == "write"]
    keys = writes["idem_key"].fillna("")
    remaining = set(run.remaining["request_id"]) - {""}
    created = set(keys[(writes["label"] == "WRITE - create") & writes["success"]]) - {"", "null"}
    update_404 = set(keys[(writes["label"] == "WRITE - update") & (writes["responseCode"] == "404")])
    deleted = set(keys[(writes["label"] == "WRITE - delete") & writes["success"]])
    return {"lost_creates": len((created & update_404) - remaining), "lost_deletes": len(deleted & remaining)}


def haproxy_up(sample: dict, proxy: str) -> list[str]:
    servers = ((sample.get("haproxy") or {}).get(proxy)) or {}
    return [name for name, state in servers.items() if name != "BACKEND" and state.get("status") == "UP"]


def patroni_members(sample: dict) -> list[dict]:
    return ((sample.get("patroni") or {}).get("members")) or []


def first_time(timeline: list[dict], after_ms: float, predicate) -> float:
    return next((float(s["t"]) for s in timeline if s["t"] >= after_ms and predicate(s)), float("nan"))


def haproxy_counter(sample: dict, field: str) -> int:
    value = ((((sample.get("haproxy") or {}).get("api_servers") or {}).get("BACKEND") or {}).get(field))
    return int(value) if isinstance(value, int) else 0


def fault_row(run: Run) -> dict:
    meta, samples, timeline = run.meta, run.samples, run.timeline
    fault_ms = run.event_time("fault_injected")
    recovery_ms = run.event_time("recovery_started")
    end_ms = float(samples["end"].max())
    service, old_leader = meta.get("faultService") or "", meta.get("leaderBefore") or ""
    after = samples[samples["timeStamp"] >= fault_ms]
    row: dict[str, object] = {
        "run": run.path.name, "config": run.config, "fault": run.fault,
        "repetition": int(meta["repetition"]), "target": service,
        "requests_after_fault": int(len(after)),
        "read_errors": int((~after.loc[after["kind"] == "read", "success"]).sum()),
        "write_errors": int((~after.loc[after["kind"] == "write", "success"]).sum()),
        "read_outage_s": longest_gap_s(samples, "read", fault_ms, end_ms),
        "write_outage_s": longest_gap_s(samples, "write", fault_ms, end_ms),
        **lost_writes(run),
    }

    def since(value: float, origin: float) -> float:
        return (value - origin) / 1000.0 if not np.isnan(value) else float("nan")

    if timeline and meta["topology"] == "replicated":
        if run.fault == "api":
            row["api_out_s"] = since(first_time(timeline, fault_ms, lambda s: s.get("haproxy") is not None
                                                and service not in haproxy_up(s, "api_servers")), fault_ms)
        if run.fault in ("db-primary", "db-switchover"):
            row["primary_out_s"] = since(first_time(timeline, fault_ms, lambda s: s.get("haproxy") is not None
                                                    and old_leader not in haproxy_up(s, "pg_primary")), fault_ms)
            row["new_leader_s"] = since(first_time(timeline, fault_ms, lambda s: any(
                m.get("role") == "leader" and m.get("state") == "running" and m.get("name") != old_leader
                for m in patroni_members(s))), fault_ms)
            row["new_primary_routed_s"] = since(first_time(timeline, fault_ms, lambda s: any(
                name != old_leader for name in haproxy_up(s, "pg_primary"))), fault_ms)
        if run.fault in DB_FAULTS and not np.isnan(recovery_ms):
            row["rejoined_after_restart_s"] = since(first_time(timeline, recovery_ms, lambda s: any(
                m.get("name") == service and m.get("state") == "streaming" for m in patroni_members(s))), recovery_ms)
        if run.fault == "db-replica" and meta.get("replication") == "sync":
            row["sync_moved_s"] = since(first_time(timeline, fault_ms, lambda s: any(
                m.get("role") == "sync_standby" and m.get("name") != service for m in patroni_members(s))), fault_ms)
        row["haproxy_retries"] = haproxy_counter(timeline[-1], "wretr") - haproxy_counter(timeline[0], "wretr")
        row["haproxy_redispatches"] = haproxy_counter(timeline[-1], "wredis") - haproxy_counter(timeline[0], "wredis")
    return row


# ---------------------------------------------------------------------------
# Figuras (estilo do relatorio do T1)
# ---------------------------------------------------------------------------

def grouped_bars(axis, frame: pd.DataFrame, value: str, error: str | None = None) -> None:
    configs = [c for c in CONFIG_ORDER if c in set(frame["config"])]
    x = np.arange(3)
    width = 0.8 / len(configs)
    for index, config in enumerate(configs):
        part = frame[frame["config"] == config].set_index("scenario").reindex(["A", "B", "C"])
        axis.bar(x + (index - (len(configs) - 1) / 2) * width, part[value], width=width * 0.94,
                 yerr=part[error] if error else None, capsize=4, color=CONFIG_COLORS[config],
                 label=CONFIG_LABELS[config])
    axis.set_xticks(x, ["A", "B", "C"])
    axis.set_xlabel("Cenário")


def throughput_chart(summary: pd.DataFrame) -> None:
    overall = summary[summary["operation"] == "overall"]
    fig, axis = plt.subplots(figsize=(11, 4.6))
    grouped_bars(axis, overall, "throughput_rps", "throughput_rps_sd")
    axis.set_ylabel("Vazão média (requisições/s)")
    axis.set_ylim(0, overall["throughput_rps"].max() * 1.3)
    axis.legend(loc="upper left", ncol=2, frameon=True)
    fig.suptitle("Vazão global por cenário e configuração (média de 3 repetições; barras = desvio-padrão)")
    fig.tight_layout()
    fig.savefig(FIGURES / "vazao_por_configuracao.png", dpi=180)
    plt.close(fig)


def median_run(runs: list[Run], key: str) -> Run:
    """Repeticao com o valor mediano de indisponibilidade (nem a melhor, nem a pior)."""
    ordered = sorted(runs, key=lambda run: fault_row(run)[key])
    return ordered[len(ordered) // 2]


def timeline_chart(fault_runs: list[Run]) -> None:
    panels = [("api", "baseline"), ("api", "async-primary"), ("db-primary", "baseline"),
              ("db-primary", "async-primary")]
    if not all(any(r.fault == f and r.config == c for r in fault_runs) for f, c in panels):
        return
    titles = {
        ("api", "baseline"): "Queda da API — sem replicação (T1)",
        ("api", "async-primary"): "Queda de 1 das 3 APIs — com replicação",
        ("db-primary", "baseline"): "Queda do banco — sem replicação (T1)",
        ("db-primary", "async-primary"): "Queda do primário — com replicação (assíncrona)",
    }
    fig, axes = plt.subplots(2, 2, figsize=(12, 7.2), sharex=True)
    for axis, (fault, config) in zip(axes.flat, panels, strict=True):
        run = median_run([r for r in fault_runs if r.fault == fault and r.config == config], "write_outage_s")
        fault_ms = run.event_time("fault_injected")
        series = per_second(run.samples, fault_ms).loc[-15:85]
        axis.plot(series.index, series["read_ok"], color="#176b4d", linewidth=1.6, label="Leituras corretas/s")
        axis.plot(series.index, series["write_ok"], color="#315d83", linewidth=1.6, label="Escritas corretas/s")
        axis.plot(series.index, series["errors"], color="#a33a32", linewidth=1.4, label="Erros/s")
        restart = (run.event_time("recovery_started") - fault_ms) / 1000.0
        top = 1100
        for position, text in [(0.0, "falha"), (restart, "religado")]:
            axis.axvline(position, color="#555555", linewidth=1)
            axis.text(position + 0.8, top * 0.93, text, fontsize=8, color="#333333")
        axis.set_ylim(0, top)
        axis.set_xlim(-15, 85)
        axis.set_title(titles[(fault, config)], fontsize=10)
        axis.set_ylabel("Respostas por segundo")
    for axis in axes[1]:
        axis.set_xlabel("Segundos desde a falha")
    axes[0][0].legend(loc="center", fontsize=8, frameon=True)
    fig.suptitle("Respostas por segundo antes e depois da falha (cenário A; repetição mediana)")
    fig.tight_layout()
    fig.savefig(FIGURES / "linha_do_tempo_falhas.png", dpi=180)
    plt.close(fig)


# ---------------------------------------------------------------------------
# Principal
# ---------------------------------------------------------------------------

def main() -> None:
    TABLES.mkdir(parents=True, exist_ok=True)
    FIGURES.mkdir(parents=True, exist_ok=True)
    plt.style.use("seaborn-v0_8-whitegrid")

    performance_runs = [r for r in load_suite("desempenho") if r.fault == "none"]
    if performance_runs:
        rows = pd.DataFrame([row for run in performance_runs for row in performance_rows(run)])
        rows.to_csv(TABLES / "desempenho_por_rodada.csv", index=False, float_format="%.3f")
        numeric = ["samples", "errors", "throughput_rps", "mean_ms", "p95_ms", "p99_ms"]
        group = ["config", "scenario", "operation"]
        means = rows.groupby(group, as_index=False)[numeric].mean()
        stds = rows.groupby(group, as_index=False)[numeric].std(ddof=1).rename(
            columns={column: f"{column}_sd" for column in numeric})
        counts = rows.groupby(group, as_index=False)["run"].count().rename(columns={"run": "repetitions"})
        summary = means.merge(stds, on=group).merge(counts, on=group)
        summary.to_csv(TABLES / "desempenho_resumo.csv", index=False, float_format="%.3f")
        throughput_chart(summary)
        overall = rows[rows["operation"] == "overall"]
        print(f"Desempenho: {len(performance_runs)} rodadas, {int(overall['samples'].sum())} requisicoes, "
              f"{int(overall['errors'].sum())} erros")

    fault_runs = [r for r in load_suite("falhas") if r.fault != "none"]
    if fault_runs:
        rows = pd.DataFrame([fault_row(run) for run in fault_runs])
        rows.to_csv(TABLES / "falhas_por_rodada.csv", index=False, float_format="%.3f")
        metrics = [c for c in rows.columns if c not in {"run", "config", "fault", "repetition", "target"}]
        grouped = rows.groupby(["config", "fault"])
        summary = grouped[metrics].agg(["mean", "min", "max"])
        summary.columns = [f"{metric}_{stat}" for metric, stat in summary.columns]
        summary = summary.reset_index()
        summary.insert(2, "repetitions", grouped.size().to_numpy())
        summary.to_csv(TABLES / "falhas_resumo.csv", index=False, float_format="%.3f")
        timeline_chart(fault_runs)
        print(f"Falhas: {len(fault_runs)} rodadas")


if __name__ == "__main__":
    main()
