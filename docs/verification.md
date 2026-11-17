# Verificación técnica — 17 de noviembre de 2026

## Alcance comprobado

- Node.js local: 25.9.0. Compatibilidad comprobada ejecutando la suite completa también con **Node.js 22.23.5**.
- **24 pruebas aprobadas**, sin omitidas, con MySQL 9.7.1 local aislado y broker WebSocket simulado. El comando ordinario `npm test` omite las dos pruebas MySQL si no hay instancia de prueba configurada; no se describe esa omisión como una prueba de persistencia.
- Se verificaron autenticación, demo exclusiva, validación decimal, permisos de escritura, volumen/horario/spread/margen, protecciones en el mensaje de apertura, cierre de posiciones propias, idempotencia después de recrear el servicio, respuesta parcial, desconexión posterior al envío, rechazo definitivo, conciliación y pérdida de confirmación de la base después de enviar.
- MySQL real: creación de tablas idempotente, exclusión entre conexiones mediante GET_LOCK, claves sensibles a mayúsculas, conservación de operaciones al reconectar, cifrado autenticado de tokens y circuito HTTP → WebSocket simulado → MySQL → nueva instancia → conciliación sin segundo envío.
- OpenAPI: `postman spec lint docs/openapi.json --issueType=syntax`, sin incidencias. Colección generada: `postman collection lint 'postman/collections/Agent Trading Demo API'`, 16 peticiones, cero errores y cero advertencias. Esto comprueba estructura; la colección no se ejecutó contra la cuenta real de demo.
- Dependencias instaladas: `npm install` / actualización del lockfile informaron cero vulnerabilidades conocidas. No equivale a una auditoría exhaustiva.
- `.env`: modo `0600`, ignorado por Git. Búsqueda de los secretos configurados en los archivos del proyecto, excluidos el propio `.env`, Git y dependencias: cero coincidencias.

## Comprobación con cTrader

Se usó TLS y el endpoint oficial fijo `wss://demo.ctraderapi.com:5036`. Solo se enviaron mensajes de autenticación y consulta.

- Client ID y Client Secret aceptados por el broker. El proxy omite `payload` en la respuesta vacía de autenticación de aplicación; se corrigió el transporte y se añadió cobertura mediante el broker simulado.
- Los dos pares de tokens del archivo se comprobaron mediante listado de cuentas: el primero tiene `SCOPE_TRADE` (1), el segundo `SCOPE_VIEW` (0). El `.env` usa el primero y su refresh token correspondiente.
- Login configurado verificado como demo por coincidencia exacta; sin elegir la primera cuenta por defecto. Cuenta HEDGED con acceso completo y divisa USD.
- Consulta de conciliación inicial: cero posiciones y cero órdenes pendientes.
- Preview de EURUSD BUY, 1000 unidades, SL 10 pips y TP 20 pips: aprobado con cotización fresca y margen suficiente en el momento de la consulta. El preview no envía una orden.
- HTTP local con credenciales reales: `/health` 200, consulta sin Bearer 401, `/ready` 200 con broker verificado y permiso de trading. La respuesta identifica `persistence: not_configured` y `tradingEnabled: false`.
- No se renovaron los tokens reales; no se abrió ni cerró ninguna operación de cTrader durante este trabajo.

## Pendiente de despliegue y operación

No se accedió a hPanel ni se publicó la aplicación. Faltan los valores MySQL de la base dedicada de Hostinger en las variables privadas, ejecutar la migración allí y comprobar la salida WebSocket desde el alojamiento. El entorno local conserva `TRADING_ENABLED=false`.

La apertura, el cierre y la renovación OAuth se probaron con el protocolo simulado; todavía requieren una comprobación controlada en la demo del broker antes de declarar validada la ejecución real. No se usó la cuenta de cTrader para producir operaciones de prueba sin una instrucción de ejecución concreta.

Las ejecuciones parciales, los resultados sin historial suficiente o con protecciones sin verificar permanecen inciertos y bloquean nuevas aperturas. La API permite el cierre explícito de una posición propia, pero no inventa una resolución ni marca como fallido un envío que pudo ejecutarse. Esas situaciones pueden requerir conciliación operativa manual; no hay un botón de borrado o reenvío para eludir el registro.

Postman Orbit no devolvió una fuente utilizable, y el CLI local no dispone de `postman status`; se consultaron directamente documentación y definiciones oficiales de Spotware. El lint de gobernanza requiere iniciar sesión en Postman y no se ejecutó; sí se ejecutó el lint local de sintaxis. Los mocks HTTP de Postman no representan los eventos de ejecución WebSocket de cTrader: se verificó el transporte real del servicio con un servidor WebSocket local, en lugar de afirmar una simulación HTTP del broker.

## Reproducir pruebas con persistencia

Usar exclusivamente una instancia MySQL **aislada de pruebas**, escuchando en localhost, usuario root sin contraseña y base `agent_trading_test`. No usar una base operativa ni cambiar sus cuentas para ajustarse al fixture.

```sh
TEST_MYSQL_PORT=PUERTO_DE_LA_INSTANCIA_AISLADA npm test
```

Los tests MySQL crean y conservan registros ficticios en esa base de pruebas. La instancia temporal utilizada durante esta implementación se detuvo al terminar; no se alteró el servicio MySQL habitual del equipo. El `.env` de producción no se utiliza en la suite.

## Fuentes oficiales

- https://help.ctrader.com/open-api/messages/
- https://help.ctrader.com/open-api/model-messages/
- https://help.ctrader.com/open-api/account-authentication/
- https://help.ctrader.com/open-api/proxies-endpoints/
- https://github.com/spotware/openapi-proto-messages
- https://www.hostinger.com/support/hostinger-node-js-limits-for-web-and-cloud-plans/
