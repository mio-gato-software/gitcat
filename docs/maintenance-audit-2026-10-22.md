# Auditoría de mantenimiento de GitCat — 22 de octubre de 2026

## Resultado y alcance

La aplicación tiene una base de pruebas útil y varias protecciones bien planteadas, pero la revisión encontró dos defectos de prioridad alta en la ejecución y comunicación de operaciones Git. Ambos se reprodujeron en repositorios temporales. La auditoría inicial no los modificó. Tras la autorización posterior del propietario, F1 y F2 se corrigieron con pruebas de regresión; los demás hallazgos permanecen como recomendaciones.

Base revisada: `41c1b51`, inicialmente en `main`, sin cambios locales. Trabajo preparado en `feature/dependency-maintenance`. Se revisaron el flujo renderer → preload → IPC → servicio Git, confirmaciones, recuperación, persistencia, configuración de herramientas, pruebas y empaquetado. No es una certificación de seguridad ni una revisión exhaustiva de cada línea.

Cambios aplicados:

- Actualización de 16 de las 20 dependencias directas; las otras cuatro ya estaban en su última versión estable. Renovación de dependencias transitivas dentro de los rangos de sus paquetes propietarios.
- Ajuste de tipos para TypeScript 6: inclusión explícita de tipos Node y biblioteca ES2022, que declara `Array.at`, ya usado por la aplicación. El objetivo de emisión del renderer sigue siendo ES2020.
- Actualización del contrato de pruebas que esperaba explícitamente Electron 43.3 para reflejar Electron 45.0.
- Corrección posterior autorizada de F1 y F2 en el servicio Git, su contrato con el renderer y las instrucciones del planificador.

## Hallazgos priorizados

### F1 — P1 — Corregido: comandos considerados de lectura pueden sobrescribir trabajo sin confirmación

**Corrección:** los comandos Git libres requieren confirmación y riesgo alto, incluidas las consultas. Solo las operaciones estructuradas `status` y `fetch` conservan ejecución automática. Las regresiones cubren ambas formas de `--output`, ejecución externa y opciones globales, preservando los bytes de un archivo seguido con cambios locales.

**Ubicación original:** `electron/git-service.ts:2570–2578`, `electron/git-service.ts:3272–3286`; ejecución automática en `src/App.tsx:1062–1071`.

`isUnattended` decide exclusivamente por el primer argumento: `log`, `diff`, `show`, etc. Sus opciones no se comprueban para demostrar que sean de solo lectura. Git permite `git log -1 --output=<archivo>` y abre ese destino para escritura. La validación de `git_command` solo comprueba argumentos vacíos y ciertas eliminaciones de ramas.

**Reproducción:** se creó un repositorio temporal con un archivo seguido y una edición sin guardar. Se simuló una respuesta del proveedor que proponía `['log', '-1', '--output=<ruta del archivo>']`. `planAction` devolvió `allowed: true` y `requiresConfirmation: false`; `executePlan` terminó sin error y el archivo dejó de contener la edición original. El renderer ejecuta automáticamente planes con esa clasificación. No se llamó a un proveedor real ni se tocó un repositorio personal.

**Consecuencia:** una respuesta incorrecta o manipulada del asistente puede destruir una edición local sin pasar por la confirmación prevista. La ausencia de una shell no evita las escrituras que permite Git.

**Recomendación:** permitir la ejecución automática únicamente para combinaciones de subcomando y argumentos cuya lectura pueda demostrarse; tratar opciones de salida a archivo, programas externos y combinaciones desconocidas de forma conservadora. Añadir regresiones con archivos centinela y ambas formas de opciones (`--output=x` y `--output x`), comprobando bytes y confirmación.

Referencia de comportamiento: [documentación oficial de git log](https://git-scm.com/docs/git-log), opción `--output`.

### F2 — P1 — Corregido: un fallo del historial puede convertir un commit completado en una acción «no ejecutada»

**Corrección:** el resultado de cada paso se conserva fuera del registro de actividad. Un fallo de persistencia detiene la secuencia y devuelve los pasos completados, fallidos y omitidos; la recuperación excluye los completados. Si falla la inspección posterior, el snapshot de respaldo se marca obsoleto y no reemplaza la vista actual. Las regresiones inyectan errores antes de ejecutar, después de un commit y entre pasos.

**Ubicación original:** `electron/git-service.ts:3558–3565`, `electron/git-service.ts:3813–3823`, `electron/main.ts:713–717`.

La ejecución de Git y la escritura del historial comparten el mismo `try`. Si Git termina correctamente y `ActivityHistory.step` falla, el código marca el paso como fallido e intenta escribir otra vez en el mismo historial. Una segunda excepción escapa sin devolver los resultados ya obtenidos. El manejador IPC interpreta cualquier excepción como si ningún paso se hubiera ejecutado y registra todos como `skipped`.

**Reproducción:** en un repositorio temporal se preparó un commit válido y se inyectó un fallo persistente en `ActivityHistory.step`, simulando un error de persistencia posterior a la operación. El HEAD cambió y el commit existía, pero `executePlan` rechazó la llamada. El historial quedó en `state: failed` con el paso del commit todavía `pending`. La asignación a `skipped` en IPC se verificó por lectura del código; no se simuló ese manejador en la reproducción.

**Consecuencia:** la recuperación pierde la distinción entre «Git falló» y «Git terminó, pero no pudo registrarse». Puede informar que no se ejecutó una operación y preparar un reintento a partir de información incompleta.

**Recomendación:** separar los errores de ejecución de los de observación y persistencia, conservar los resultados confirmados antes de registrar el historial y devolver explícitamente los pasos completados o de estado incierto. Probar fallos de disco después de un commit y entre pasos de un plan.

### F3 — P2: el comando habitual de lint incluye worktrees anidados y falla

**Ubicación:** `eslint.config.mjs:7–15`, `package.json:27`.

`npm run lint` recorre `.` y no excluye worktrees anidados. En este checkout existe `.kilo/worktrees/potent-scarecrow`, también registrado por Git. Antes de actualizar dependencias, el comando produjo 126 errores de resolución de `tsconfigRootDir`, incluyendo archivos del checkout principal y del worktree. Es un problema previo y dependiente de la disposición local; no demuestra que falle una ejecución limpia en CI.

**Comprobación:** `npm exec -- eslint . --ignore-pattern '.kilo/**' --max-warnings 0` sí pasó con las dependencias nuevas. El comando estándar sigue sin ofrecer una validación local limpia con ese worktree presente.

**Recomendación:** delimitar el alcance de lint al proyecto principal o excluir los directorios de worktrees, y declarar una raíz explícita para el parser cuando corresponda. Mantener los worktrees y su trabajo intactos.

### F4 — P2: algunos contratos de seguridad comprueban texto en lugar del comportamiento

**Ubicación:** `test/project-contract.test.mjs:63–85` y pruebas similares en el mismo archivo.

Hay 54 archivos de pruebas. Dos utilizan `test/helpers/source.mjs` para leer fuentes y contienen conjuntamente 490 aserciones `match`/`doesNotMatch`. No todas esas aserciones son incorrectas: algunas verifican configuración o contenido. Sin embargo, el contrato que afirma que los comandos libres no saltan protecciones solo busca expresiones como `readOnlyGitSubcommands` y llamadas a `spawn`; pasa aunque F1 esté presente.

**Consecuencia:** las pruebas pueden fallar por un refactor inocuo y, a la vez, aceptar una regresión funcional. Las 421 pruebas correctas no equivalen a cobertura completa de los guardrails. No se midió cobertura de líneas o ramas.

**Recomendación:** conservar contratos textuales donde el texto sea el producto, y sustituir progresivamente los que prometen seguridad o efectos Git por escenarios observables: archivos que permanecen iguales, historial correcto, confirmaciones y recuperación. Empezar por F1 y F2; aprovechar las pruebas de integración existentes.

### F5 — P3: dos archivos concentran demasiadas responsabilidades

**Ubicación:** `src/App.tsx:425` y `electron/git-service.ts:1`.

`App.tsx` tiene 4.452 líneas y reúne pestañas, estado de repositorios, conversaciones, revisiones, conflictos, gráficos, ajustes y muchos estados de diálogos. `git-service.ts` tiene 3.981 líneas y mezcla ejecución de procesos, snapshots, integración con el proveedor, credenciales, planificación, conflictos, publicación y persistencia. La compilación genera un chunk JavaScript de 654,96 kB (196,80 kB gzip) y avisa de que supera 500 kB. Eso no prueba por sí mismo lentitud de arranque; no se hizo un benchmark.

**Recomendación:** extraer gradualmente unidades por responsabilidad manteniendo las APIs actuales y los escenarios de integración. Empezar por el ejecutor de comandos y sus políticas, luego persistencia/recuperación y flujos del renderer. Medir el arranque y la interacción antes de decidir si hace falta carga diferida. Evitar una reescritura general.

## Aspectos sólidos observados

- TypeScript estricto y separación entre renderer, preload y proceso principal.
- Ventana con `contextIsolation: true`, `nodeIntegration: false` y `sandbox: true`; restricción de navegación y comprobación del origen IPC.
- Planes emitidos y conservados en el proceso principal, enlazados al estado del repositorio y comprobados antes de ejecutar.
- Pruebas de integración con Git real, repositorios temporales y configuración aislada; pruebas de interfaz con perfiles desechables.
- Tratamiento explícito de cambios seleccionados, conflictos, worktrees y recuperación. La base permite mejoras incrementales sin rediseñar toda la aplicación.

## Dependencias

Versiones resueltas consultadas en npm durante esta revisión. «Antes» procede del lockfile original, no del mínimo declarado en `package.json`.

| Dependencia | Antes | Después |
| --- | --- | --- |
| lucide-react | 0.468.0 | 1.61.0 |
| react | 19.2.8 | 19.3.1 |
| react-dom | 19.2.8 | 19.3.1 |
| @eslint/js | 10.0.1 | 10.0.1 |
| @resvg/resvg-js | 2.6.2 | 2.6.2 |
| @types/node | 22.20.1 | 26.6.5 |
| @types/react | 19.2.18 | 19.3.0 |
| @types/react-dom | 19.2.4 | 19.3.0 |
| @vitejs/plugin-react | 4.7.0 | 6.1.2 |
| concurrently | 9.2.4 | 10.0.6 |
| cross-env | 10.1.0 | 10.1.0 |
| electron | 43.3.0 | 45.0.0 |
| electron-builder | 26.15.3 | 26.15.3 |
| eslint | 10.10.0 | 10.13.0 |
| globals | 17.12.0 | 17.13.0 |
| js-yaml | 4.3.2 | 5.5.0 |
| typescript | 5.9.3 | 6.0.3 |
| typescript-eslint | 8.69.0 | 8.72.0 |
| vite | 6.4.3 | 8.3.5 |
| wait-on | 8.0.5 | 9.5.1 |

**Excepción explícita:** TypeScript tiene una versión estable más nueva, 7.0.2. El último `typescript-eslint`, 8.72.0, declara `typescript: >=4.8.4 <6.1.0`; por eso se instaló 6.0.3, la última compatible. `npm outdated --json` únicamente señala TypeScript. No se forzó una combinación fuera del contrato de dependencias ni se usaron versiones preliminares. `npm ls --depth=0` no detectó dependencias inválidas.

Los requisitos de Node del nuevo conjunto siguen admitiendo Node 22.13+ y 24+, como indica README. Las comprobaciones locales se ejecutaron con Node 26.3.0 y npm 11.16.0; no se ejecutó aquí la matriz completa de Node o plataformas.

Se consultaron las [notas de migración de Vite](https://vite.dev/guide/migration), los [cambios incompatibles de Electron](https://www.electronjs.org/docs/latest/breaking-changes) y las [notas de TypeScript 6](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html). La compatibilidad final se comprobó mediante tipos, pruebas y ejecución de la interfaz.

## Auditoría de dependencias vulnerables

| Alcance | Antes | Después |
| --- | --- | --- |
| Total de paquetes señalados por npm audit | 20 | 8 |
| Críticos | 2 | 0 |
| Altos | 9 | 0 |
| Moderados | 9 | 8 |
| Dependencias de producción después de la actualización | — | 0 avisos |

Los ocho avisos restantes proceden de una cadena de herramientas de empaquetado: `electron-builder → app-builder-lib → @electron/get@3 → global-agent → roarr → sprintf-js`. Incluyen paquetes dependientes afectados, no ocho vulnerabilidades independientes. El aviso raíz es [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), denegación de servicio con especificadores de precisión sin límite.

La última versión estable de electron-builder mantiene esa cadena. La solución automática propuesta por npm implica retroceder electron-builder a 26.5.0; no se aplicó `npm audit fix --force`. Queda pendiente una solución compatible del empaquetador o una sustitución evaluada por separado. `npm audit --omit=dev` da cero avisos, pero no certifica la seguridad del runtime Electron ni cubre F1/F2.

## Validación

| Comprobación | Resultado |
| --- | --- |
| Base anterior: typecheck | Correcto |
| Base anterior: pruebas | 421 correctas, 1 omitida (Windows), 0 fallos |
| Base anterior: lint estándar | Falla por worktree anidado; ver F3 |
| Actualización: typecheck | Correcto |
| Actualización: pruebas | 421 correctas, 1 omitida (Windows), 0 fallos |
| Actualización: lint excluyendo `.kilo/**` | Correcto, sin advertencias |
| Actualización: build | Correcto; aviso de tamaño del chunk |
| Interfaz: `node scripts/check-ui.cjs` sobre el build nuevo | Correcto |
| Bienvenida: `node scripts/check-welcome.cjs` | Correcto: inglés/español × cinco tamaños/zoom |
| Reproducciones F1/F2 | Confirmadas en repositorios desechables |
| Correcciones F1/F2: typecheck | Correcto |
| Correcciones F1/F2: pruebas | 435 correctas, 1 omitida (Windows), 0 fallos; 14 regresiones nuevas |
| Correcciones F1/F2: lint excluyendo `.kilo/**` | Correcto, sin advertencias |
| Correcciones F1/F2: build e interfaz | Correctos sobre la versión final |

La primera ejecución de las dos pruebas visuales coincidió con la descarga diferida de Electron 45 y dejó una extracción incompleta. Se eliminó únicamente esa distribución generada dentro de `node_modules/electron`, se reinstaló secuencialmente con su instalador y se verificó `electron --version` = `v45.0.0`. Ambas pruebas se repitieron con éxito. La prueba de bienvenida emite además una advertencia de deprecación de los argumentos de `console-message`; conviene actualizar ese listener en un mantenimiento posterior.

## Instalación personal

`npm run install:mac` completó la instalación en `/Applications/GitCat.app`. Se comprobó Electron 45.0.0 en el framework instalado y que el HTML, JavaScript, CSS, main y preload del paquete coinciden byte a byte con el build validado.

El primer arranque quedó esperando el Llavero de macOS. El usuario atendió el diálogo. Se observó después una ventana en `about:blank`; se comparó con una carga del paquete y del main en perfiles temporales, ambas correctas, y se reabrió la instalación para capturar diagnósticos. Finalmente se verificó un arranque normal, sin argumentos de diagnóstico, con los seis proyectos restaurados y la configuración del asistente presente. No se determinó la causa exacta de la ventana inicial; el último arranque normal no reprodujo el problema. No se borró ni regeneró el perfil.

Las sumas SHA-256 de `gitcat-settings.json`, `gitcat-workspace.json` y `gitcat-memory.json` permanecieron iguales a las de antes de instalar. Se crearon copias temporales de recuperación y se retiraron tras verificar la preservación.

El runtime avisa también de que los métodos síncronos de `safeStorage` utilizados por GitCat están deprecados y se retirarán en Electron 46. La migración a las variantes asíncronas queda pendiente para una tarea funcional posterior; consultar las notas oficiales de Electron enlazadas arriba.

Windows: compilación, validación e instalación omitidas por instrucción expresa del usuario durante esta tarea, al no disponer de un equipo Windows. No se publicó ningún release ni se hizo push.

Tras corregir F1/F2 se repitió `npm run install:mac` y se abrió la app instalada: restauró los seis proyectos y la configuración del asistente. Se compararon los módulos instalados del servicio, planificador y resumen de resultados con el build validado. Las tres sumas del perfil permanecieron iguales; Windows siguió omitido.

## Orden recomendado para el siguiente mantenimiento

F1 y F2 ya están corregidos y cubiertos por regresiones. Pendiente:

1. Restablecer el comando estándar de lint (F3).
2. Sustituir los contratos textuales de seguridad por escenarios ejecutables (F4).
3. Dividir responsabilidades gradualmente y medir antes de optimizar (F5).
4. Retomar TypeScript 7 cuando el linter lo soporte y resolver la cadena vulnerable de empaquetado cuando exista una actualización compatible.
