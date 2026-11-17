# Mercados e instrumentos

## Habilitación

```dotenv
ALLOWED_SYMBOLS=*
```

El asterisco admite todos los instrumentos que el bróker tenga habilitados en el catálogo de la cuenta demo configurada. Incluye las criptomonedas disponibles, como ADAUSD y BTCUSD, y los demás mercados ofrecidos por ese mismo bróker. No conecta con exchanges ni admite cuentas reales. No es necesario modificar el código cuando el bróker agrega otro símbolo compatible con el protocolo.

Una lista explícita, como `ALLOWED_SYMBOLS=EURUSD,ADAUSD`, sigue restringiendo la selección. No mezclar `*` con una lista. Los nombres deben coincidir exactamente con el catálogo, incluidos mayúsculas, espacios internos y sufijos. No enviar `"symbol":"*"` a una orden.

## Aplicar en Hostinger

1. Publicar esta versión del código en la rama desplegada.
2. En las variables del servicio Node.js cambiar el valor existente de `ALLOWED_SYMBOLS` a `*`, sin comillas. El código conserva deliberadamente una lista restrictiva si aún está configurada.
3. Reconstruir y reiniciar la aplicación. Conservar las claves, MySQL y `TRADING_ENABLED=true` que ya funcionan en el servidor. No importar un `.env` local completo que tenga trading deshabilitado.
4. Consultar `/ready` y `/v1/demo/capabilities` con una clave válida. Este último debe devolver `allBrokerSymbols: true` y `allowedSymbols: ["*"]`. Después consultar catálogo, restricciones y preview del instrumento previsto.

El cambio local y las pruebas no acreditan que Hostinger haya publicado esta versión.

## Volumen y protecciones

El consumidor decide el volumen de cada instrucción. No se agrega un presupuesto, objetivo ni máximo fijo en USD. `volume` se expresa en unidades del instrumento, con hasta dos decimales, y cTrader recibe centésimas de unidad. Permanecen el mínimo, máximo y paso del bróker, el máximo configurado en `MAX_VOLUME_UNITS` (1000 unidades por defecto), el límite de posiciones, las órdenes pendientes y la reserva de margen. Un límite de unidades no equivale a un importe común en dólares para todos los instrumentos.

SL y TP son obligatorios. Su conversión usa `pipPosition` y `digits` del instrumento; no reutilizar distancias de EURUSD sin consultar los metadatos. El bróker también debe permitir esas protecciones, volumen y dirección. Las validaciones pueden rechazar símbolos habilitados por horario, falta de precio fresco, margen insuficiente, precisión no representable o restricciones del bróker.

## Filtros de mercado

Los pips tienen escalas diferentes entre instrumentos. Aplicar 3 pips de EURUSD a BTCUSD bloquearía cotizaciones normales de BTC. Por eso:

- Los pares convencionales de divisas reconocidos por su nombre, como EURUSD y GBPUSD, conservan `MAX_SPREAD_PIPS=3` y `MAX_STOP_LOSS_PIPS=100`. Se reconocen dos códigos de divisa admitidos en mayúsculas, con sufijo opcional separado por punto, guion o guion bajo. La lista de códigos está en `src/symbol-limits.js`.
- Los demás nombres, incluidas criptomonedas, índices, acciones y metales, usan `MAX_SPREAD_BPS=300` por defecto: un filtro de spread del 3% del ask. No heredan el máximo de SL en pips de forex. Las protecciones siguen requiriendo distancias positivas, precisión, precios positivos y mínimos del bróker.
- `spreadBps = (ask - bid) / ask * 10000`. Un punto básico es 0,01%. Este filtro mide el spread, no el importe de la posición.

Se pueden ajustar filtros por nombre exacto sin habilitar símbolos adicionales:

```dotenv
SYMBOL_LIMITS_JSON={"ADAUSD":{"maxSpreadBps":200},"XAUUSD":{"maxSpreadPips":20,"maxStopLossPips":1000}}
```

Es un ejemplo de configuración, no una recomendación para esos mercados. Los únicos campos permitidos son `maxSpreadBps`, `maxSpreadPips` y `maxStopLossPips`: números positivos finitos, como máximo 1000000. Un campo presente reemplaza ese filtro; los otros filtros aplicables siguen activos. Si están presentes filtros de spread en pips y puntos básicos, deben cumplirse ambos. JSON vacío usa los valores predeterminados. No admite `maxNotionalUsd` ni modifica `MAX_VOLUME_UNITS`.

## Consulta y preview

```sh
curl "$BASE_URL/v1/demo/capabilities" \
  -H "Authorization: Bearer $API_KEY"

curl "$BASE_URL/v1/demo/symbols" \
  -H "Authorization: Bearer $API_KEY"

curl "$BASE_URL/v1/demo/orders/preview" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"ADAUSD","side":"BUY","volume":"64","stopLossPips":"10","takeProfitPips":"20"}'
```

El último cuerpo es solo un ejemplo de formato. No expresa USD 64 ni asegura una exposición de USD 10: el precio cambia. El preview consulta datos actuales y no abre una posición. Devuelve las unidades, mínimo/paso, precisión, spread en pips y puntos básicos, filtros efectivos y margen. `/capabilities` solo informa configuración; no comprueba la conexión ni garantiza un llenado.

Para ejecutar una instrucción autorizada, usar el mismo formato de cuerpo en `POST /v1/demo/orders`, con `TRADING_API_KEY` y una clave de idempotencia. La apertura repite todas las validaciones. Consultar [el contrato](api-contract.md) para autenticación, estados inciertos y cierre. Ningún cambio de configuración envía órdenes por sí solo.
