# Colección para consumir la API

La colección se generó desde `docs/openapi.json`, fuente del contrato, y se ajustaron las variables y la protección de peticiones de ejecución. No contiene secretos ni respuestas inventadas del broker.

La petición `Active market selection and order filters` refleja la nueva operación `/v1/demo/capabilities` del OpenAPI y usa `bearerToken`. Permite comprobar `allBrokerSymbols` tras desplegar; no comprueba conexión al bróker ni envía órdenes. Los nombres de instrumento admiten ahora sufijos y espacios internos exactos del catálogo.

Configurar `baseUrl` y `bearerToken` en un entorno privado del cliente. Para abrir/cerrar, configurar además `tradingToken`, `idempotencyKey` y `enableTrading` como cadena `true`. Las peticiones de ejecución y conciliación se omiten por defecto mediante `pm.execution.skipRequest()`; revisar la instrucción concreta antes de habilitarlas. El preview no opera y usa la clave de lectura.

No ejecutar toda la colección sobre una cuenta operativa: está pensada para seleccionar y completar la petición deseada. Los IDs de ruta son ejemplos y deben sustituirse por los del broker o registro. Las peticiones de historial usan por defecto las últimas 24 horas; para otro intervalo agregar `from` y `to` en milisegundos conforme al contrato.

```sh
postman collection lint 'postman/collections/Agent Trading Demo API'
```

La relación de generación está en `.postman/workflows.yaml`. Al regenerar, revisar los cambios y conservar las variables privadas vacías y el bloqueo explícito de ejecución. Los ejemplos genéricos autogenerados se eliminaron porque no representan ejecuciones verificadas.
