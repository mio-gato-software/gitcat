# GitCat

MVP de escritorio para trabajar con ramas Git desde una vista centrada en historial, autoría y rebase. La aplicación usa Electron + React + Vite y mantiene el proceso de Git separado del renderer.

## Ejecutar

```bash
npm install
npm run dev
```

Para validar el proyecto:

```bash
npm run check

# Comprobaciones individuales
npm run lint
npm run typecheck
npm test
npm run test:ui # Incluye el build y usa un repositorio y perfil desechables
```

## Crear la aplicación instalable

El flujo de distribución está basado en la misma arquitectura actual: Vite compila el renderer, TypeScript compila `electron/` y electron-builder empaqueta ambos junto con el preload CommonJS.

```bash
# Carpeta ejecutable para probar localmente
npm run package:dir

# macOS: DMG y ZIP arm64/x64 según el host o flags de electron-builder
npm run dist:mac
# macOS: construir e instalar el app en /Applications/GitCat.app
npm run install:mac

# Alternativas por plataforma
npm run dist:win
npm run dist:linux
```

Los artefactos aparecen en `release/`. El build local no usa una identidad de desarrollo ni firma automáticamente; para distribución pública se puede añadir firma/notarización mediante las variables de electron-builder.

## Alcance del MVP

- Proyectos abiertos en pestañas independientes.
- Ramas locales, rama actual, ahead/behind y remotos.
- Resumen de dónde está el trabajo, bajo la barra del repositorio: cambios en este equipo, guardados locales, integración en la rama principal y lo publicado en el remoto (con cuándo se comprobó), más un único siguiente paso con su término de Git como ayuda. Guardar no se presenta como copia de seguridad ni una fusión local como publicada.
- Historial de commits con autor, correo, fecha y referencias.
- Acciones esenciales: switch, crear/borrar rama, fetch, pull fast-forward only, push, merge, commit y rebase.
- Rebase en curso: continuar o abortar.
- Solicitudes en lenguaje natural, en cualquier idioma, con un plan visible antes de ejecutar.
- OpenAI mediante Responses API, como asistente opcional. Abrir un proyecto y todas las acciones directas de Git (guardar con descripción propia, ramas, pull/push, conflictos) funcionan sin él. La conexión es guiada: explica qué hace falta y que cobra el proveedor, ofrece el modelo recomendado o un ID avanzado, verifica la clave y el modelo antes de guardarlos y, si falla, dice por qué (clave, modelo, facturación, caída o red, almacenamiento seguro) y permite reintentar. Sin proveedor no se interpreta nada: no hay modo de reglas locales.
- Ícono de aplicación en `build/icon.svg`; el build genera `build/icon.png` y electron-builder lo convierte al formato nativo del instalador.
- Filtro de alcance: el modelo decide si la solicitud trata sobre el repositorio y rechaza el resto.

## Decisiones de seguridad

**Toda evaluación de intención la hace el modelo.** No existe coincidencia de palabras clave, ni planificador local de reserva, ni extracción de datos por expresiones regulares sobre lo que escribe la persona: eso ataba la aplicación al español y fallaba con cualquier reformulación. El proceso principal solo valida.

El modelo nunca entrega un comando shell ejecutable. Solo puede devolver una operación de una lista permitida y argumentos validados; la aplicación compone el comando Git final y lo ejecuta con `spawn`, sin shell. Las operaciones con riesgo se presentan en una tarjeta de confirmación, y el riesgo y la confirmación los fija la aplicación, no el modelo.

Cuando la validación local o una comprobación del entorno rechaza una propuesta, el defecto vuelve al modelo como una incidencia estructurada (`{field, problem}`) para que corrija o explique el problema en el idioma de la persona. Los fallos del proveedor —respuesta vacía, truncada por tokens, esquema inválido— se reportan tal cual; nunca se convierten en un rechazo silencioso. Una pregunta del asistente se presenta como pregunta, no como error.

No hay límites artificiales sobre lo que se envía al modelo ni sobre lo que puede responder: ni longitud de solicitud, ni recorte de conversación, ni tope de tokens de salida, ni truncado del diff. Un archivo que no se pueda leer se reporta en el propio diff en lugar de desaparecer en silencio.

## Identidades

Una misma máquina puede tener varias cuentas de GitHub y varias claves SSH. GitCat no asume que la correcta sea la activa ni la predeterminada:

- **Cuenta `gh`**: se leen todas las cuentas autenticadas del host (`gh auth status --json hosts`), no solo la activa. Si el propietario indicado es una de ellas, se usa esa; el cambio con `gh auth switch` aparece en los efectos del plan, ocurre solo al ejecutar y se restaura después. Nunca se leen ni se manipulan tokens.
- **Clave SSH**: se marca cada candidato (`ssh -T`) y se comprueba **qué identidad responde**, no solo que la conexión autentique. Los alias de `~/.ssh/config` cuyo `HostName` resuelve al host se prueban también, y el que responde como el propietario es el que entra en la URL del remoto.
- **Preparación antes de guardar o publicar**: una lista breve dice si Git está disponible, con qué nombre y correo se firmarán los commits y de qué configuración salen (repositorio, global o sistema), y adónde iría un push. El acceso se comprueba solo leyendo (`git ls-remote --heads`, sin avisos interactivos, sin aceptar huellas SSH nuevas y con tiempo límite) y se clasifica en confirmado, rechazado, inexistente, sin credenciales o caducadas, sin conexión o huella sin confirmar. La autoría (una etiqueta en cada commit) y el acceso (lo que deja publicar) se muestran por separado; el nombre y el correo se revisan y se confirman antes de escribirse, para este repositorio o de forma global. Comprobar nunca cambia la configuración ni de cuenta.
- **Localización de binarios**: un lanzamiento gráfico no hereda el PATH del shell, así que se consulta al login shell y se añaden las rutas habituales de los gestores de paquetes antes de resolver `git`, `gh` y `ssh` a ruta absoluta.

## Qué recuerda la aplicación

La regla es una: **se recuerdan decisiones, se vuelve a medir el estado.**

Una decisión es de la persona y no caduca sola —«para `eliaquin` en `github.com` uso esta cuenta y este alias SSH»— y se guarda en `gitcat-memory.json` solo cuando una ejecución confirmada termina bien, nunca al proponer un plan. Las identidades se indexan por host y propietario, así que sirven en cualquier repositorio; por ruta se guarda además cómo se publicó ese repositorio en concreto (propietario, protocolo, remoto). Todo ello llega al planificador como `remembered`, para que el modelo no vuelva a preguntar lo que ya contestaste.

El estado del entorno no se guarda jamás: si `gh` está instalado, dónde vive un binario o si una clave sigue autenticando se comprueba cada vez, porque cambia en silencio y darlo por hecho es exactamente cómo se publica con la identidad equivocada.

Lo recordado **reordena la búsqueda, nunca sustituye la comprobación**: el alias recordado se marca primero, pero se verifica igual, y si responde otra identidad se descarta del recuerdo y la búsqueda continúa.

La API key se conserva en el proceso principal y se cifra con `safeStorage` de Electron; si el almacenamiento seguro no está disponible, no se guarda ninguna clave (nunca como texto plano) y Configuración lo explica. Para una aplicación distribuida convendría complementar esto con firma de builds, actualizaciones verificadas y un control más granular de permisos remotos.
