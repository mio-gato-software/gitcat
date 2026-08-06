# Branchline

MVP de escritorio para trabajar con ramas Git desde una vista centrada en historial, autoría y rebase. La aplicación usa Electron + React + Vite y mantiene el proceso de Git separado del renderer.

## Ejecutar

```bash
npm install
npm run dev
```

Para validar el proyecto:

```bash
npm run typecheck
npm run build
npm test
```

## Crear la aplicación instalable

El flujo de distribución está basado en la misma arquitectura actual: Vite compila el renderer, TypeScript compila `electron/` y electron-builder empaqueta ambos junto con el preload CommonJS.

```bash
# Carpeta ejecutable para probar localmente
npm run package:dir

# macOS: DMG y ZIP arm64/x64 según el host o flags de electron-builder
npm run dist:mac

# Alternativas por plataforma
npm run dist:win
npm run dist:linux
```

Los artefactos aparecen en `release/`. El build local no usa una identidad de desarrollo ni firma automáticamente; para distribución pública se puede añadir firma/notarización mediante las variables de electron-builder.

## Alcance del MVP

- Proyectos abiertos en pestañas independientes.
- Ramas locales, rama actual, ahead/behind y remotos.
- Historial de commits con autor, correo, fecha y referencias.
- Acciones esenciales: switch, crear/borrar rama, fetch, pull fast-forward only, push, merge, commit y rebase.
- Rebase en curso: continuar o abortar.
- Solicitudes en lenguaje natural, en cualquier idioma, con un plan visible antes de ejecutar.
- OpenAI mediante Responses API. El proveedor es obligatorio: al guardarlo se verifica contra la API, y sin él la aplicación no interpreta nada.
- Ícono de aplicación en `build/icon.svg`; el build genera `build/icon.png` y electron-builder lo convierte al formato nativo del instalador.
- Filtro de alcance: el modelo decide si la solicitud trata sobre el repositorio y rechaza el resto.

## Decisiones de seguridad

**Toda evaluación de intención la hace el modelo.** No existe coincidencia de palabras clave, ni planificador local de reserva, ni extracción de datos por expresiones regulares sobre lo que escribe la persona: eso ataba la aplicación al español y fallaba con cualquier reformulación. El proceso principal solo valida.

El modelo nunca entrega un comando shell ejecutable. Solo puede devolver una operación de una lista permitida y argumentos validados; la aplicación compone el comando Git final y lo ejecuta con `spawn`, sin shell. Las operaciones con riesgo se presentan en una tarjeta de confirmación, y el riesgo y la confirmación los fija la aplicación, no el modelo.

Cuando la validación local o una comprobación del entorno rechaza una propuesta, el defecto vuelve al modelo como una incidencia estructurada (`{field, problem}`) para que corrija o explique el problema en el idioma de la persona. Los fallos del proveedor —respuesta vacía, truncada por tokens, esquema inválido— se reportan tal cual; nunca se convierten en un rechazo silencioso.

La API key se conserva en el proceso principal y, cuando el sistema lo permite, se cifra con `safeStorage` de Electron. Para una aplicación distribuida convendría complementar esto con firma de builds, actualizaciones verificadas y un control más granular de permisos remotos.
