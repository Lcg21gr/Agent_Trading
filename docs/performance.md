# Rendimiento de las consultas

## Cambios

- Una sesión autenticada por proceso para lecturas y previews, con heartbeat cada 8 segundos, cierre tras 60 segundos sin uso y autenticación nueva al superar 5 minutos. Se comprueba el par de tokens almacenado en cada uso. Un cambio de tokens, expiración próxima, revocación o fallo de transporte invalida la sesión.
- Los datos de posiciones, cuenta, saldo, margen e historial se piden al bróker cuando la ruta los necesita, sin reutilizar respuestas anteriores. La consulta de cuenta obtiene trader, activos y PnL en paralelo, correlacionando respuestas por mensaje.
- Solo se conserva una suscripción de cotizaciones. Se acepta el último bid/ask recibido si ambos timestamps siguen dentro del máximo de 10 segundos. Si falta frescura, se solicita una nueva instantánea; cambiar de símbolo elimina la suscripción anterior y descarta eventos tardíos del anterior.
- El bloqueo MySQL conserva su duración mínima de un segundo sin retrasar artificialmente la respuesta HTTP. La liberación usa su conexión original y el apagado espera las liberaciones pendientes. Los registros y comprobaciones siguen completándose antes de devolver el resultado.
- Aperturas, cierres y conciliaciones que acceden al bróker cierran la sesión de lectura y usan autenticación nueva. La sesión reutilizable rechaza mensajes de trading. No se agrega ningún reintento de órdenes ni de callbacks.

`CTRADER_REUSE_READ_SESSION=true` es el valor predeterminado. `false` vuelve al modo de conexión nueva para las lecturas; no cambia la consulta paralela de cuenta ni el envío temprano del resultado HTTP. No requiere cambios de esquema ni nuevas credenciales.

## Mediciones del 17 de noviembre de 2026

Antes de implementar se midió `https://talentouniversal.online` con Postman: tres consultas por ruta, doce peticiones en total, todas HTTP 200. Los tiempos fueron 1103–1278 ms para posiciones, 1534–1539 ms para cuenta/PnL y 1103–1245 ms para `/ready`. `/health` respondió en 103–435 ms. Son muestras, no una garantía de latencia o disponibilidad.

Comparación del código anterior (`a3f166e`) con el optimizado en **el mismo entorno local**, usando HTTP en loopback, MySQL aislado y cTrader demo real. Se reutilizaron las peticiones guardadas de Postman de posiciones y cuenta, tres muestras por ruta y versión, separadas por 1200 ms. No se mandó ninguna orden ni renovación OAuth; el cliente de medición bloqueó esos mensajes.

| Consulta | Promedio anterior | Promedio optimizado | Reducción observada |
|---|---:|---:|---:|
| Posiciones | 1231 ms | 235 ms | 81% |
| Cuenta/PnL | 2567 ms | 936 ms | 64% |

Primera consulta de posiciones, incluyendo conexión y autenticación: 1500 ms con la versión anterior y 1272 ms con la nueva. En las siete consultas de cada versión (una inicial y seis medidas), las autenticaciones bajaron de siete a una. Los tiempos que Postman muestra en segundos están redondeados a su resolución de presentación.

Esto demuestra la mejora medida desde el entorno local contra el bróker, **no su despliegue ni su latencia en Hostinger**. Debe publicarse el código y repetir la medición en el alojamiento. La red, reinicios del proceso, tokens, bróker, margen de espera de cotizaciones y carga pueden modificar los tiempos. Tras una escritura, cierre por inactividad, vencimiento de sesión o fallo habrá otra consulta con coste de autenticación.

## Consumidores y monitoreo

Se mantienen autenticación Bearer, límite de ritmo, exclusión de cuenta, idempotencia y estados inciertos. Una respuesta por debajo de un segundo no permite disparar otra solicitud inmediatamente. Esperar la respuesta, espaciar las consultas y atender 429 con `Retry-After`; no ejecutar la colección completa en paralelo.

La API no programa un análisis ni un ciclo cada 10 segundos. El consumidor debe contar tiempo de sus solicitudes, procesamiento y herramientas. Esta optimización reduce el tiempo del servicio; no convierte un agente conversacional en un proceso con frecuencia garantizada. No se implementó una estrategia autónoma ni modificación automática de posiciones.

## Validación

Las pruebas cubren datos actuales con sesión reutilizada, respuestas paralelas fuera de orden, cambio/caducidad de tokens, revocación, desconexión, tiempo máximo, inactividad, rechazo de comandos de trading en la sesión de lectura, autenticación nueva de escrituras, cotizaciones caducadas e idempotencia. MySQL real aislado verifica que el bloqueo continúa vigente después de devolver una respuesta rápida y que el apagado espera su liberación. La suite también conserva las pruebas previas de ejecución incierta y recuperación.

Referencias oficiales para conexión y suscripciones: [conexión cTrader](https://help.ctrader.com/open-api/connection/) y [mensajes cTrader](https://help.ctrader.com/open-api/messages/).
