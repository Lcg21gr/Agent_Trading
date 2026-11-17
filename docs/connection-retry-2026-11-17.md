# Reintento de conexión demo

Registro histórico anterior a la ampliación de la API del mismo día. Para el estado posterior, con conexión comprobada y endpoints de ejecución implementados, consultar [verification.md](verification.md). Se conserva la evidencia inicial sin presentarla como el estado vigente.

- Entorno: Mac conectado, proyecto Agent_Trading.
- WebSocket nativo a endpoint oficial `wss://demo.ctraderapi.com:5036`: agotó plazo de 10 s y emitió error de conexión.
- Prueba estándar TCP/TLS con verificación de certificado: no llegó a TLS; falló resolución con `gaierror`.
- No se enviaron credenciales a cTrader ni se intentó ninguna orden.
- API HTTP local: `GET /health` devolvió 200 y `brokerConnection: not_checked`.
- Ruta privada sin credenciales: `GET /v1/demo/account` devolvió 401 UNAUTHORIZED.
- Las 6 pruebas automatizadas pasaron. Estas pruebas usan simulación del broker y no demuestran conexión real.
- No se añadieron endpoints de órdenes: no hay acceso comprobado ni capacidad comprobada de cierre. Se conserva API de consultas demo-only.
- Pendiente: conectividad autorizada al endpoint y validación de token/cuenta antes de implementar y ejecutar una prueba de compra/venta.
