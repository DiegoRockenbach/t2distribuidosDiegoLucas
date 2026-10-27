"""Registra o estado do cluster durante um ensaio, uma linha JSON por amostra.

Cada amostra traz o instante (ms desde a epoca, mesmo relogio do JMeter), os
membros do Patroni (papel, estado, timeline, atraso) e o estado de cada servidor
no HAProxy. A analise usa esse historico para medir, por exemplo, quanto tempo
o cluster ficou sem primario. So usa a biblioteca padrao.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import time
import urllib.error
import urllib.request

MEMBER_FIELDS = ("name", "role", "state", "timeline", "lag", "receive_lag", "replay_lag")
HAPROXY_FIELDS = ("status", "scur", "wretr", "wredis", "econ", "eresp")


def fetch(url: str, timeout: float) -> str | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.read().decode("utf-8")
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
        return None


class PatroniProbe:
    """Consulta /cluster no primeiro no que responder, comecando pelo ultimo que funcionou."""

    def __init__(self, urls: list[str], timeout: float) -> None:
        self.urls = urls
        self.timeout = timeout

    def sample(self) -> dict | None:
        for index, url in enumerate(self.urls):
            body = fetch(url.rstrip("/") + "/cluster", self.timeout)
            if body is None:
                continue
            try:
                data = json.loads(body)
            except ValueError:
                continue
            if index > 0:
                self.urls.insert(0, self.urls.pop(index))
            members = [{field: member.get(field) for field in MEMBER_FIELDS} for member in data.get("members", [])]
            return {"source": url, "members": members}
        return None


def haproxy_sample(url: str, timeout: float) -> dict | None:
    body = fetch(url, timeout)
    if body is None:
        return None
    reader = csv.DictReader(io.StringIO(body.lstrip("# ")))
    servers: dict[str, dict[str, dict]] = {}
    for row in reader:
        proxy, server = row.get("pxname"), row.get("svname")
        if not proxy or not server or proxy == "stats" or server == "FRONTEND":
            continue
        values = {}
        for field in HAPROXY_FIELDS:
            raw = row.get(field) or ""
            values[field] = int(raw) if raw.isdigit() else raw
        servers.setdefault(proxy, {})[server] = values
    return servers


def api_sample(url: str, timeout: float) -> int | None:
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    parser.add_argument("--duration", type=float, required=True, help="segundos de amostragem")
    parser.add_argument("--interval", type=float, default=0.5)
    parser.add_argument("--timeout", type=float, default=0.4)
    parser.add_argument("--patroni", default="", help="URLs da API REST do Patroni, separadas por virgula")
    parser.add_argument("--haproxy", default="", help="URL do CSV de estatisticas do HAProxy")
    parser.add_argument("--api", default="", help="URL de /health/live (topologia sem HAProxy)")
    args = parser.parse_args()

    patroni = PatroniProbe([url for url in args.patroni.split(",") if url], args.timeout) if args.patroni else None
    deadline = time.time() + args.duration
    with open(args.out, "w", encoding="utf-8") as output:
        while time.time() < deadline:
            started = time.time()
            sample: dict = {"t": int(started * 1000)}
            if patroni is not None:
                sample["patroni"] = patroni.sample()
            if args.haproxy:
                sample["haproxy"] = haproxy_sample(args.haproxy, args.timeout)
            if args.api:
                sample["api"] = api_sample(args.api, args.timeout)
            output.write(json.dumps(sample, separators=(",", ":")) + "\n")
            output.flush()
            time.sleep(max(0.0, args.interval - (time.time() - started)))


if __name__ == "__main__":
    main()
