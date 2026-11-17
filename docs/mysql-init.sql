-- Primera inicializacion: ejecutar en la base dedicada configurada.
-- Conserva las tablas y los registros existentes; no ejecutar para sustituir historial perdido.

CREATE TABLE IF NOT EXISTS trading_api_operations (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    namespace CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    idempotency_key VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    fingerprint CHAR(64) CHARACTER SET ascii NOT NULL,
    kind VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL,
    body_json LONGTEXT NOT NULL,
    result_json LONGTEXT NULL,
    created_ms BIGINT NOT NULL,
    updated_ms BIGINT NOT NULL,
    UNIQUE KEY operation_key (namespace, idempotency_key),
    KEY operation_status (namespace, status),
    KEY operation_time (namespace, created_ms)
  ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS trading_api_tokens (
    namespace CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    encrypted_tokens TEXT NOT NULL,
    updated_ms BIGINT NOT NULL
  ) ENGINE=InnoDB;
