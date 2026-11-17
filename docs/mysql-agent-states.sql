-- Agrega el estado generico por agente, sin modificar operaciones ni tokens existentes.
-- Ejecutar en la misma base dedicada de la API.

CREATE TABLE IF NOT EXISTS trading_api_agent_states (
    namespace CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    agent_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    version BIGINT UNSIGNED NOT NULL,
    state_json LONGTEXT CHARACTER SET utf8mb4 NOT NULL,
    updated_ms BIGINT NOT NULL,
    PRIMARY KEY (namespace, agent_id)
  ) ENGINE=InnoDB;
