# Históricos y estado recuperable de agentes

La API sirve a varios agentes sin incorporar una estrategia, un presupuesto ni reglas de riesgo propios de uno de ellos. Cada consumidor decide sus análisis y conserva sus datos con un ID. Las órdenes mantienen sus validaciones, registro MySQL e idempotencia existentes. Solo cuenta demo.

## Históricos OHLC

```sh
curl "$BASE_URL/v1/demo/symbols/$SYMBOL_ID/candles?period=M15&limit=200" \
  -H "Authorization: Bearer $API_KEY"
```

Obtener `SYMBOL_ID` del catálogo de la cuenta. La ruta usa `ProtoOAGetTrendbarsReq` de cTrader y admite `M1`, `M2`, `M3`, `M4`, `M5`, `M10`, `M15`, `M30`, `H1`, `H4`, `H12`, `D1`, `W1` y `MN1`.

| Parámetro | Significado |
|---|---|
| `period` | Marco temporal; por defecto `M1` |
| `limit` | Máximo solicitado, 1–1000; por defecto 200. Puede haber menos barras disponibles |
| `from` | Límite inclusivo de apertura, Unix en milisegundos, no negativo |
| `to` | Límite inclusivo de apertura, Unix en milisegundos; por defecto ahora, sin fechas futuras |

Ventana máxima por petición: 3660 días. Sin `from`, se busca al menos una semana o dos veces la duración nominal de las barras solicitadas, con ese máximo. Para este cálculo de búsqueda `MN1` usa 31 días; las fechas devueltas son las del bróker, sin reconstruir meses como intervalos fijos. Las ventanas no garantizan completar `limit` ni disponibilidad histórica anterior a la que ofrezca el bróker. cTrader limita `to` a 2147483646000.

La respuesta contiene `candles` ordenadas de antigua a reciente. Cada barra tiene `openTime` en milisegundos, precios `open`, `high`, `low`, `close` como cadenas con cinco decimales y `tickVolume` como cadena entera. **El volumen cuenta ticks; no representa unidades negociadas ni dólares.** Las cadenas evitan pérdida de precisión de enteros grandes. No se rellenan huecos ni se inventan velas. La barra actual puede estar todavía en formación; el consumidor decide qué barras necesita para su análisis.

`brokerHasMore` conserva el indicador del bróker o `null` si no llegó. `mayHaveMore` también es verdadero cuando se alcanza el número solicitado, para no afirmar que el historial terminó por un límite de respuesta. Si hay un `nextTo`, repetir con ese valor como `to`, manteniendo `from`, `period` y símbolo; deduplicar por `openTime` entre consultas. Los precios históricos pueden actualizarse en una vela todavía en formación. La paginación no crea una instantánea transaccional del bróker.

La consulta requiere la clave de lectura o ejecución, utiliza la sesión de lectura optimizada y no envía órdenes. Está disponible con `TRADING_ENABLED=false`. La lista `ALLOWED_SYMBOLS` controla las aperturas; consultar históricos no habilita un símbolo para operar.

## Estado por agente

`agentId` admite 1–64 caracteres ASCII: letras, números, `_` y `-`, comenzando con letra o número; distingue mayúsculas. Cada registro pertenece a la cuenta/aplicación configuradas y al ID elegido. No hace falta registrar previamente el agente.

```sh
AGENT_ID=analista-ada

curl "$BASE_URL/v1/demo/agents/$AGENT_ID/state" \
  -H "Authorization: Bearer $API_KEY"

curl -X PUT "$BASE_URL/v1/demo/agents/$AGENT_ID/state" \
  -H "Authorization: Bearer $TRADING_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"expectedVersion":0,"state":{"strategy":"definida-por-el-consumidor","risk":{},"checkpoint":{}}}'
```

GET devuelve 404 `AGENT_STATE_NOT_FOUND` antes de la primera escritura. PUT crea el registro con `expectedVersion=0` y devuelve `{agentId, version:1, state, updatedAt}`. Para actualizar, enviar la versión actual; se incrementa en uno. Una versión atrasada devuelve 409 `AGENT_STATE_VERSION_CONFLICT`: volver a leer y reconciliar los datos. Esto impide perder cambios de otro proceso que use el mismo ID. Tras un timeout, leer el estado antes de decidir si debe escribirse otra versión.

`state` puede contener cualquier objeto JSON con los datos que necesite el consumidor: presupuesto elegido, riesgo estimado, estrategia, identificadores de operaciones o checkpoint. El cuerpo completo mantiene el máximo de 8 KiB. La API almacena esos datos; no interpreta ni aplica reglas financieras a sus campos. Se conserva la última versión, no un historial inmutable de todas las revisiones. No guardar credenciales dentro del estado.

Para importes decimales e identificadores que exijan precisión exacta, usar cadenas. Los números del estado siguen la representación numérica habitual de JSON/JavaScript.

PUT necesita `TRADING_API_KEY` porque modifica datos, pero funciona aunque trading esté deshabilitado y no conecta con cTrader. Los IDs separan registros lógicamente: **compartir una clave comparte sus permisos sobre todos los agentes de esta cuenta**. No son un sistema de aislamiento entre usuarios.

## Atribuir y recuperar operaciones

Las aperturas y cierres pueden llevar `X-Agent-Id`. El cuerpo de apertura sigue teniendo exactamente sus cinco campos. La respuesta y el registro de operaciones incluyen `agentId` si se suministró. La identidad idempotente incorpora esa atribución; la misma clave no puede utilizarse desde otro ID para una intención distinta. Las claves de idempotencia siguen siendo únicas para toda la cuenta/aplicación; conviene prefijarlas con el ID del agente.

Flujo recuperable para un consumidor:

1. Leer su estado y recuperar cualquier intención pendiente.
2. Guardar con control de versión la instrucción prevista y su clave de idempotencia estable, junto con sus propios datos de riesgo.
3. Enviar la orden autorizada usando esa clave y `X-Agent-Id`. Esperar y respetar el límite de solicitudes entre pasos.
4. Guardar `operationId` y resultado en su estado. Si se pierde la respuesta, reutilizar la misma clave y cuerpo conforme al contrato de operaciones; nunca inventar otra clave para resolver una incertidumbre.
5. Consultar y conciliar `operationId` cuando corresponda antes de decidir una nueva entrada.

El guardado del estado y el envío de la orden son peticiones separadas: no existe una transacción común entre ellos y el bróker. La intención persistida permite recuperar el contexto y la idempotencia evita repetir la orden ya registrada. El consumidor resuelve sus decisiones pendientes al retomar el trabajo.

`X-Agent-Id` es atribución aportada por el cliente; no añade permisos distintos ni impide que quien tenga la clave de ejecución cierre una posición de la misma API. Todos los agentes comparten la cuenta, etiqueta, máximos de volumen/posiciones, margen, bloqueos de incertidumbre y ritmo existentes. La suma de presupuestos y las políticas de coordinación las decide el consumidor; no se creó un límite fijo en USD ni se activó una estrategia automática.

## Publicar en Hostinger

1. En la base MySQL dedicada de la API, ejecutar [mysql-agent-states.sql](mysql-agent-states.sql), por `npm run db:migrate` o desde phpMyAdmin. El archivo solo crea `trading_api_agent_states` si falta; conserva las operaciones y tokens existentes. [mysql-init.sql](mysql-init.sql) también incluye las tres tablas para una instalación inicial.
2. Publicar el código nuevo y reconstruir/reiniciar Node.js. Conservar variables, claves, cuenta, etiqueta e historial actuales; no se requieren claves nuevas.
3. Comprobar `/ready`: ahora verifica también la tabla de estados. Si falta, devuelve 503 `DB_SCHEMA_NOT_INITIALIZED`.
4. Probar históricos, crear un checkpoint propio y recuperarlo tras reiniciar. No ejecutar la colección completa contra una cuenta operativa.

El código y las pruebas locales no acreditan que estos servicios ya estén publicados en Hostinger.

Fuentes oficiales: [mensajes históricos de cTrader](https://help.ctrader.com/open-api/messages/), [protocolo de mensajes](https://github.com/spotware/openapi-proto-messages/blob/main/OpenApiMessages.proto) y [modelo de velas](https://github.com/spotware/openapi-proto-messages/blob/main/OpenApiModelMessages.proto).
