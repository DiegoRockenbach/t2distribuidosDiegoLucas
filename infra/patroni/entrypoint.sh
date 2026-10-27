#!/bin/sh
# Inicia o Patroni deste no. O nome e os enderecos anunciados variam por no e
# chegam por variaveis de ambiente; o restante esta em /etc/patroni/patroni.yml.
set -eu

: "${PATRONI_NAME:?defina PATRONI_NAME (ex.: pg1)}"
export PATRONI_RESTAPI_CONNECT_ADDRESS="${PATRONI_RESTAPI_CONNECT_ADDRESS:-${PATRONI_NAME}:8008}"
export PATRONI_POSTGRESQL_CONNECT_ADDRESS="${PATRONI_POSTGRESQL_CONNECT_ADDRESS:-${PATRONI_NAME}:5432}"

mkdir -p /var/lib/postgresql/data
exec patroni /etc/patroni/patroni.yml
