# No de banco do cluster: PostgreSQL 16 gerenciado pelo Patroni.
# O Patroni inicializa o PostgreSQL, configura a replicacao por streaming,
# disputa a lideranca no etcd e promove uma replica quando o primario falha.
FROM postgres:16.14-bookworm

ARG PATRONI_VERSION=4.1.5

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv curl ca-certificates \
 && python3 -m venv /opt/patroni \
 && /opt/patroni/bin/pip install --no-cache-dir \
      "patroni[etcd3]==${PATRONI_VERSION}" "psycopg[binary]>=3.1,<4" \
 && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/patroni/bin:${PATH}"

COPY patroni.yml /etc/patroni/patroni.yml
COPY entrypoint.sh /usr/local/bin/patroni-entrypoint.sh
COPY post_bootstrap.sh /etc/patroni/post_bootstrap.sh

# Remove CR caso o repositorio tenha sido clonado no Windows com autocrlf.
RUN sed -i 's/\r$//' /usr/local/bin/patroni-entrypoint.sh /etc/patroni/post_bootstrap.sh /etc/patroni/patroni.yml \
 && chmod 755 /usr/local/bin/patroni-entrypoint.sh /etc/patroni/post_bootstrap.sh \
 && mkdir -p /var/lib/postgresql/data \
 && chown -R postgres:postgres /var/lib/postgresql /etc/patroni

USER postgres
EXPOSE 5432 8008
ENTRYPOINT ["/usr/local/bin/patroni-entrypoint.sh"]
