# Contrato de la API cTrader demo

La API recibe instrucciones explícitas del consumidor; no decide estrategias ni opera por temporizador. Solo admite la cuenta demo configurada. Las credenciales OAuth nunca se entregan al consumidor.

Autenticación: `Authorization: Bearer <API_KEY>` para consultas y `Authorization: Bearer <TRADING_API_KEY>` para ejecución. La clave de ejecución también puede consultar. Las escrituras requieren `Content-Type: application/json`. Abrir y cerrar requieren `Idempotency-Key` (16–100 caracteres ASCII: letras, números, `_`, `-`). Repetir la clave y el mismo cuerpo recupera el registro original; otro cuerpo devuelve 409. Las claves se conservan en MySQL y no vencen automáticamente.

| Método | Ruta | Comportamiento |
|---|---|---|
| GET | `/health` | Estado HTTP público; no prueba conexión al broker |
| GET | `/ready` | Comprueba MySQL, autenticación y cuenta demo, sin enviar órdenes |
| GET | `/v1/demo/capabilities` | Configuración activa de mercados y filtros; requiere clave, no consulta al bróker |
| GET | `/v1/demo/account` | Cuenta, saldo, divisa y PnL flotante |
| GET | `/v1/demo/positions` | Posiciones abiertas y órdenes pendientes |
| GET | `/v1/demo/orders` | Órdenes pendientes |
| GET | `/v1/demo/symbols` | Catálogo del broker |
| GET | `/v1/demo/symbols/{id}` | Restricciones de volumen, precisión y horario |
| GET | `/v1/demo/symbols/{id}/quote` | Bid/ask con timestamp fresco del broker |
| GET | `/v1/demo/deals` | Ejecuciones históricas, comisiones y cierres |
| GET | `/v1/demo/order-history` | Historial de órdenes del broker |
| GET | `/v1/demo/operations?limit=50` | Registro persistente de instrucciones de esta API |
| GET | `/v1/demo/operations/{id}` | Estado de una instrucción |
| POST | `/v1/demo/orders/preview` | Valida volumen, protecciones, exposición, spread y margen sin operar |
| POST | `/v1/demo/orders` | Abre MARKET con SL y TP relativos en el mismo mensaje |
| POST | `/v1/demo/positions/{id}/close` | Cierra completamente una posición creada por esta API; cuerpo `{}` |
| POST | `/v1/demo/operations/{id}/reconcile` | Consulta el broker para resolver un resultado incierto; nunca reenvía la orden |

Apertura y preview comparten exactamente este cuerpo (no se aceptan campos adicionales):

```json
{"symbol":"EURUSD","side":"BUY","volume":"1000","stopLossPips":"10","takeProfitPips":"20"}
```

`volume` son unidades del instrumento, como cadena decimal de hasta dos decimales, no lotes ni dólares. Los pips se convierten usando `pipPosition` del broker. BUY/SELL en mayúsculas. `symbol` es el nombre exacto del catálogo, respetando mayúsculas, sufijos y espacios internos; hasta 100 caracteres, sin caracteres de control ni espacios en los extremos. `*` es exclusivamente una opción de configuración y no es un símbolo válido en una orden.

`ALLOWED_SYMBOLS=*` permite seleccionar cualquier instrumento habilitado en el catálogo de esa cuenta. Una lista explícita sigue restringiendo los instrumentos. El preview y la apertura vuelven a verificar disponibilidad, modo de trading, mínimos, paso de volumen, precisión, horario, margen y protecciones; permitir un símbolo no garantiza que pueda operarse en cualquier momento. Las operaciones se identifican mediante UUID y `clientOrderId`; la etiqueta `ORDER_LABEL` identifica las posiciones gestionadas por esta instalación.

El preview agrega `volumeUnits`, `minVolumeUnits`, `stepVolumeUnits`, `pipPosition`, `priceDigits`, `spreadBps` y `limits`. Conserva `volume` en centésimas del protocolo. Los filtros efectivos se detallan en [mercados](markets.md); no se define un máximo fijo de exposición en USD. El consumidor elige el volumen y lo somete a preview. La ruta `/capabilities` informa `allowedSymbols`, `allBrokerSymbols`, `marketDefaults`, `forexDefaults`, `symbolLimitOverrides` y `limitsBySymbol`. Con `*`, `limitsBySymbol` enumera únicamente los ajustes explícitos; los demás usan los valores predeterminados según su nombre. No acredita disponibilidad o conexión al bróker; usar `/ready` y `/symbols` para ello.

Historial: `from` y `to` son timestamps Unix en milisegundos (cadenas enteras), ventana máxima 7 días, por defecto últimas 24 horas. `limit` (1–1000, por defecto 100) solo para deals. Se devuelve `hasMore` del broker; la API no afirma que un bloque truncado sea el historial completo. Para retroceder, el consumidor consulta intervalos anteriores, conservando y deduplicando por dealId/orderId los límites inclusivos.

Respuestas de envío: `{operationId, status, result?, error?}`. `completed` exige llenado y comprobación posterior. `rejected` significa validación fallida antes del envío o rechazo definitivo del broker. `uncertain`/`sent`/`reserved` no autorizan un nuevo intento: consultar el registro y conciliar. Un timeout después de enviar devuelve 202 y bloquea nuevas aperturas de la cuenta. El cierre de posiciones propias sigue disponible para reducir exposición. La aceptación de una orden no se anuncia como ejecución.

Errores: 400 parámetros/JSON inválidos; 401 sin autenticación; 403 clave sin permiso o trading deshabilitado; 404 recurso/ruta inexistente; 409 idempotencia incompatible o ejecución pendiente; 413 cuerpo >8 KiB; 415 tipo incorrecto; 422 regla de operación incumplida; 429 ocupado/límite; 502 error del broker; 503 persistencia no disponible. Nunca se devuelven textos remotos ni secretos. Los errores conocidos incluyen `requestId` para correlación.

Las aperturas requieren cuenta HEDGED, acceso de trading OAuth y del broker, sin órdenes pendientes, límite total de posiciones de cuenta y margen libre con reserva. SL/TP no garantizan un precio de cierre ni una pérdida máxima. La validación y preview son instantáneos: otros clientes pueden modificar la cuenta entre verificaciones. Se deben usar cuenta y etiqueta exclusivas para esta API. No se amplía automáticamente a cuentas reales.

Las rutas, claves y cuerpos no cambian con la optimización de conexiones. Las consultas al bróker pueden reutilizar una sesión autenticada; cada consulta vuelve a solicitar sus datos. Una cotización activa puede usar el último evento recibido solo si ambas caras cumplen la antigüedad máxima de 10 segundos. `/ready` envía una consulta efectiva incluso con sesión reutilizada. Después de una desconexión, la solicitud actual falla y una solicitud posterior vuelve a autenticar; no hay repetición automática de la acción.

Se conserva la separación mínima de un segundo entre solicitudes y la exclusión de cuenta. El resultado HTTP puede devolverse antes de completar la duración mínima del bloqueo MySQL, que se libera en segundo plano. No implica que el servidor ya admita otra solicitud: respetar 429 y `Retry-After`. Esta liberación no aplaza escrituras del registro ni la verificación del llenado. La aplicación espera las liberaciones pendientes al apagarse. Ver [performance.md](performance.md).
