# API de trading cTrader demo

API HTTP en Node.js para consumir cTrader desde un backend, n8n, scripts u otro cliente con HTTPS. Permite consultar cuenta, posiciones, órdenes, símbolos, cotizaciones e historial; validar una apertura; abrir posiciones de mercado con SL/TP; cerrar posiciones propias y conciliar ejecuciones inciertas. Solo acepta la cuenta **demo** configurada.

El contrato consumible está en [docs/openapi.json](docs/openapi.json), con los detalles de reintentos, unidades y respuestas en [docs/api-contract.md](docs/api-contract.md). La guía para el plan Business está en [docs/hostinger-business.md](docs/hostinger-business.md). Hay una colección de peticiones sin secretos en [postman/README.md](postman/README.md).

## Inicio local

Requiere Node.js 22.13 o posterior y npm. Las consultas pueden funcionar sin base de datos. La ejecución y su registro requieren una base MySQL dedicada.

```sh
npm ci
npm test
npm run check:syntax
npm run check:connection
npm start
```

El `.env` local se creó con permisos `0600` usando únicamente Client ID, Client Secret y el par OAuth con permiso de trading de los archivos proporcionados. No se necesitó copiar la contraseña de cTID. El login de cuenta configurado se comprobó con el broker. Se generaron dos claves API independientes y una clave de cifrado. Ningún secreto se imprime aquí ni forma parte de Git.

En otra instalación, copiar `.env.example` a `.env` y completar las variables privadas. `scripts/import-credentials.js ARCHIVO_OAUTH ARCHIVO_CUENTA` también importa el formato original sin mostrar valores ni reemplazar un `.env` existente; toma el primer par de tokens y requiere comprobar después su alcance contra el broker.

`TRADING_ENABLED=false` es el valor inicial. Con las variables `MYSQL_*` configuradas:

```sh
npm run db:migrate
npm run check:connection
```

Comprobar `/ready`, configurar la cuenta y límites apropiados y establecer `TRADING_ENABLED=true` para habilitar los endpoints de apertura y cierre. Cambiar este valor no envía órdenes: cada ejecución exige una petición autenticada explícita. No hay un bot ni decisiones automáticas.

## Consumo

Las variables de estos ejemplos se configuran en el cliente de confianza. La URL pública usa HTTPS.

```sh
curl "$BASE_URL/v1/demo/positions" \
  -H "Authorization: Bearer $API_KEY"

curl "$BASE_URL/v1/demo/orders/preview" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"EURUSD","side":"BUY","volume":"1000","stopLossPips":"10","takeProfitPips":"20"}'

curl "$BASE_URL/v1/demo/orders" \
  -H "Authorization: Bearer $TRADING_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: mi_instruccion_000001' \
  -d '{"symbol":"EURUSD","side":"BUY","volume":"1000","stopLossPips":"10","takeProfitPips":"20"}'

curl "$BASE_URL/v1/demo/positions/ID_POSICION/close" \
  -H "Authorization: Bearer $TRADING_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: mi_cierre_000000001' \
  -d '{}'
```

`volume` indica **unidades del instrumento**, no lotes; la API lo convierte al volumen en centésimas que exige cTrader. Los pips se convierten con los metadatos del símbolo. Las cadenas decimales evitan conversiones ambiguas.

Una respuesta HTTP 202 conserva el resultado como incierto. Consultar `/v1/demo/operations/{operationId}` y llamar a su ruta `/reconcile` para consultar evidencia del broker. Mantener la misma clave y cuerpo ante un timeout. Nunca reenviar la intención con otra clave para resolver la incertidumbre. `ORDER_ACCEPTED` y una respuesta parcial no cuentan como ejecución completada.

## Configuración y validaciones

| Variable | Función |
|---|---|
| `API_KEY` | Clave Bearer de consulta y preview, mínimo 32 caracteres aleatorios |
| `TRADING_API_KEY` | Clave distinta para abrir, cerrar y conciliar; también puede consultar |
| `CTRADER_CLIENT_ID`, `CTRADER_CLIENT_SECRET` | Aplicación Open API |
| `CTRADER_ACCESS_TOKEN`, `CTRADER_REFRESH_TOKEN` | Par OAuth de esa aplicación; las órdenes requieren `SCOPE_TRADE` |
| `CTRADER_ACCOUNT_LOGIN` | Login visible; el ID interno y la condición demo se verifican en cTrader |
| `TOKEN_ENCRYPTION_KEY` | 32 bytes en Base64, para cifrado autenticado AES-256-GCM de tokens en MySQL |
| `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` | Base dedicada para el registro y los tokens rotados |
| `MYSQL_SSL_CA` | CA PEM opcional para conexiones remotas con TLS verificado |
| `TRADING_ENABLED` | Habilita apertura y cierre; inicialmente `false` |
| `ALLOWED_SYMBOLS` | Lista explícita separada por comas; inicial `EURUSD` |
| `ORDER_LABEL` | Etiqueta propia y estable de esta instalación |
| `MAX_VOLUME_UNITS` | Máximo por apertura; inicial 1000 unidades |
| `MAX_OPEN_POSITIONS` | Máximo total de posiciones de la cuenta; inicial 1 |
| `MAX_SPREAD_PIPS` | Spread máximo al enviar; inicial 3 pips |
| `MAX_STOP_LOSS_PIPS` | Distancia máxima de SL; inicial 100 pips |
| `MARGIN_RESERVE_PERCENT` | Porcentaje del margen libre que debe conservarse; inicial 50 |
| `CORS_ORIGINS` | Orígenes HTTPS de confianza, separados por comas; vacío para uso entre servidores |
| `PORT`, `HOST` | Puerto asignado por el alojamiento e interfaz de escucha |

La apertura comprueba entorno y cuenta, permiso OAuth, acceso del broker, cuenta HEDGED, símbolo habilitado, horario y festivos publicados por el broker, mínimos/máximos/paso de volumen, exposición, ausencia de órdenes pendientes, spread, precio fresco, distancia/precisión de SL/TP y margen con reserva. SL y TP relativos se envían en el mismo mensaje que la orden. Después del llenado se verifica posición, volumen y protecciones antes de marcar `completed`.

El cierre completo consulta el volumen actual del broker, exige la etiqueta de esta API y verifica que la posición ya no esté abierta. La conciliación nunca envía una orden. Un estado incierto bloquea nuevas aperturas; cerrar posiciones propias continúa disponible cuando trading está habilitado. Un cierre incierto de la misma posición bloquea otro cierre hasta conciliarlo.

Usar una cuenta y una etiqueta exclusivas para esta API. La API serializa sus solicitudes mediante un bloqueo MySQL y limita su ritmo; otros bots o clientes que usen la cuenta pueden cambiarla entre verificaciones. No existe una transacción conjunta entre MySQL y cTrader: el registro previo al envío evita reenvíos automáticos, pero no promete ejecución exactamente una vez ni resolución automática de toda incertidumbre. No borrar registros ni reiniciar las claves de idempotencia.

SL/TP son instrucciones al broker; gaps, slippage y costes pueden cambiar la pérdida. Esta API no calcula una estrategia, un riesgo monetario por operación ni un presupuesto diario. No ofrece órdenes pendientes nuevas, cierres parciales ni modificación de SL/TP en esta versión.

## OAuth y continuidad

Los tokens iniciales vienen de `.env`. Si cTrader informa que el token caducó o está inválido, o el token almacenado está próximo a caducar, se intenta renovar la autenticación una sola vez bajo el bloqueo de cuenta. El nuevo par se cifra y guarda en MySQL antes de utilizarlo. Tras el primer refresco, la base tiene prioridad frente al par inicial del entorno.

`npm run token:refresh` permite una renovación explícita con MySQL configurado. No se ha ejecutado con los tokens reales durante esta implementación. Un refresco rota credenciales: otra aplicación que reutilice el mismo par también deberá recibir el par actualizado. Para operar servicios independientes, autorizar aplicaciones o pares independientes. Si la renovación ocurre en el broker pero falla su guardado, se requiere recuperar el acceso OAuth; no hay reintento de órdenes para compensarlo. Conservar la clave de cifrado y los respaldos de la base fuera del repositorio. Si se revoca el acceso, se necesita autorización OAuth nueva con alcance `trading`.

No incluir claves API en JavaScript público: un frontend usa su propio backend autenticado. No registrar cabeceras Authorization, cuerpos de OAuth ni `.env`. No se admiten parámetros para cambiar cuenta, entorno o endpoint; el destino es el oficial demo con TLS verificado.

## Evidencia

Ver [docs/verification.md](docs/verification.md) para separar pruebas locales con WebSocket simulado y MySQL real de consultas realizadas a cTrader. Las verificaciones de consulta y preview no acreditan un llenado ni un cierre real. No se abrió ni cerró ninguna operación real de la demo y no se ha desplegado en Hostinger.
