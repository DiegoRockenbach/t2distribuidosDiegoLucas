#!/bin/sh
# Executado pelo Patroni uma unica vez, no no que cria o cluster.
# $1 e a URL de conexao do superusuario; a senha vem do PGPASSFILE do Patroni.
# Cria o usuario e o banco da aplicacao; as replicas recebem tudo pela replicacao.
set -eu

: "${APP_DB_NAME:?}"
: "${APP_DB_USER:?}"
: "${APP_DB_PASSWORD:?}"

psql -v ON_ERROR_STOP=1 \
  -v app_db="$APP_DB_NAME" -v app_user="$APP_DB_USER" -v app_password="$APP_DB_PASSWORD" \
  "$1" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'app_db', :'app_user') \gexec
SQL
