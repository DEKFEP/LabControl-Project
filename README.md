# Insuco LabControl

Sistema web para el control y la supervisión de los laboratorios de computación del Liceo
INSUCO. Permite consultar y administrar la disponibilidad, el inventario de equipos, el mapa
del establecimiento, las reservas de uso, los reportes y las cuentas de los profesores, con
autenticación por roles y base de datos real en el backend.

**Sitio publicado:** <https://insuco-labcontrol.pages.dev>

Proyecto de la asignatura *Diseño y Aplicaciones Web*. Lo que cambió en cada versión está en las
[releases](https://github.com/DereckYQL/LabControl-Project/releases); este README describe el
sistema, no su historial.

---

## Autores del proyecto

| Encargado | Área | Cargo |
|---|---|---|
| **Dereck Quiñonez** | Desarrollo web, técnico e informático | CTO — Chief Technology Officer |
| **Felipe Torres** | Branding, comunicación y relaciones institucionales | CMO — Chief Marketing Officer |

---

## 1. Contenido del sistema

| Módulo | Qué permite |
|---|---|
| **Inicio de sesión** | Acceso con usuario y contraseña, renovación automática de sesión y registro de cuentas nuevas (el administrador les otorga el nivel de acceso). |
| **Panel** | Resumen del estado de los laboratorios, actividad reciente y distribución de equipos. |
| **Laboratorios** | Ficha de cada laboratorio: estado, hardware, servicios disponibles y agenda de la semana. |
| **Disponibilidad** | Cambio de estado (disponible, ocupado, mantención) y reserva de horarios, con detección de solapamientos. |
| **Mapa** | Plano del establecimiento con los laboratorios marcados según su estado en vivo. |
| **Equipos** | Inventario por laboratorio con número de serie, sistema operativo y estado. El control remoto está simulado. |
| **Reportes** | Reportes de uso, disponibilidad, fallas e inventario, con adjuntos, edición, eliminación y exportación a CSV. |
| **Usuarios** | Alta, edición, desactivación/reactivación y eliminación de profesores, área, especialidad, niveles de acceso (los otorga el administrador) y solicitudes de cambio de especialidad. |
| **Configuración** | Perfil personal, apariencia del sitio, notificaciones, seguridad (2FA), auditoría, respaldos y configuración avanzada (solo administrador). |

La web es una **PWA**: se puede instalar en el teléfono y guarda una copia de los archivos
estáticos para trabajar sin conexión.

---

## 2. Roles y permisos

| Capacidad | Otra área | Programación | Administrador |
|---|:--:|:--:|:--:|
| Ver estado y disponibilidad de los laboratorios | Sí | Sí | Sí |
| Cambiar el estado de un laboratorio | Sí | Sí | Sí |
| Agendar y cancelar reservas propias | Sí | Sí | Sí |
| Editar los datos técnicos de un laboratorio | No | Sí | Sí |
| Ver datos técnicos del equipo (hardware, IP/MAC) | No | Sí | Sí |
| Control remoto de equipos | No | Sí | Sí |
| Consultar los reportes y exportarlos a CSV | Sí | Sí | Sí |
| Crear, editar y eliminar reportes propios | Sí | Sí | Sí |
| Editar o eliminar reportes de otros | No | No | Sí |
| Crear cuentas y editar las de otros | No | No | Sí |
| Desactivar, reactivar o eliminar cuentas de otros | No | No | Sí |
| Auditoría y respaldos | No | No | Sí |
| Activar la verificación en dos pasos de la propia cuenta | No | Sí | Sí |
| Otorgar o cambiar el nivel de acceso de una cuenta | No | No | Sí |

Editar el perfil propio está disponible para todos; cambiar el rol, el área, el estado de la
cuenta, el nivel de acceso o la contraseña de otra persona es solo del administrador. Una cuenta
se puede **desactivar** (deja de poder iniciar sesión, pero se conserva) o **eliminar** (baja
definitiva); al eliminar, sus reservas se borran y los reportes que la referencian quedan sin
autor. No se puede desactivar ni eliminar la propia cuenta, ni eliminar al último administrador.

La información técnica se **redacta en el servidor**: una cuenta no técnica nunca la recibe,
aunque la interfaz la pida.

---

## 3. Arquitectura

El frontend es estático (HTML, CSS y JavaScript con módulos ES, sin compilación) y el backend
es una API REST sobre Express con SQLite.

### En producción

```
navegador
   │  HTTPS, mismo origen
   ▼
Cloudflare Pages ──── archivos estáticos (website/public)
   │
   └── /api/* ──► Pages Function (functions/api/[[path]].js) ──► API en Railway
                                                            │
                                                            └── SQLite en volumen
```

El frontend llama siempre a `api/...` por ruta relativa, así que no necesita saber dónde vive
el backend: una **Pages Function** reenvía `/api/*` al servicio real. El navegador nunca
habla directo con el backend, no hay que abrir CORS y la política de seguridad de la interfaz
no cambia.

El backend no puede vivir en el mismo hosting que la web porque usa `node:sqlite`, escribe
la base en disco y crea respaldos: necesita un proceso Node con sistema de archivos.

**Concurrencia: una sola instancia escritora.** LabControl usa `node:sqlite` de forma
síncrona sobre un archivo local: todas las consultas comparten el mismo proceso y el mismo
volumen. Está pensado para un centro pequeño con **un único proceso de API** (un réplica en
Railway, sin escalado horizontal). Dos procesos escribiendo el mismo volumen pueden
perder escrituras o dejar la base inconsistente; para escalar haría falta mover la base a un
motor con bloqueo y conexiones reales. Antes de aplicar migraciones se guarda `labcontrol.db.bak`,
y cada restauración pasa un `PRAGMA integrity_check` completo antes de sustituir la base.

### En local (un solo proceso)

El mismo Express que expone la API también entrega el sitio estático, de modo que todo
funciona en una sola URL, sin proxy:

```
Express (website/backend/server.js)
   ├── /api/*      API REST + SQLite
   └── /*          sitio de website/public
```

Si el hosting no copia `public/` junto a `backend/`, se indica la ruta con `LC_PUBLIC_DIR`.

---

## 4. Estructura del proyecto

```
.
├── .github/workflows/
│   ├── ci.yml                          Calidad y pruebas (backend, lint, tipos, interfaz)
│   └── deploy-cloudflare.yml           Publicación de la web + aviso de despliegue a la API
├── functions/api/[[path]].js           Pages Function que reenvía /api/* al backend
├── website/
│   ├── public/                         Sitio publicado (web estática)
│   │   ├── login.html                  Inicio de sesión y registro
│   │   ├── index.html                  Panel
│   │   ├── laboratorios.html           Laboratorios y su ficha
│   │   ├── disponibilidad.html         Estado y agenda de reservas
│   │   ├── equipos.html                Inventario de equipos
│   │   ├── reportes.html               Reportes
│   │   ├── usuarios.html               Usuarios
│   │   ├── configuracion.html          Configuración
│   │   ├── _headers                    Cabeceras de seguridad del hosting estático
│   │   ├── _redirects                  URLs antiguas con .html → rutas limpias (308)
│   │   ├── 404.html                    Página de error
│   │   ├── robots.txt                  Instrucciones para buscadores
│   │   ├── service-worker.js           Caché y funcionamiento sin conexión
│   │   ├── manifest.webmanifest        Datos de la PWA
│   │   ├── css/
│   │   │   └── style.css               Estilos compartidos
│   │   ├── js/
│   │   │   ├── app.js                  Navegación por rol y funciones de render
│   │   │   ├── data.js                 Cliente de la API
│   │   │   ├── datos-demo.js           Datos de ejemplo sin conexión
│   │   │   ├── theme.js                Selector de tema (claro/oscuro)
│   │   │   ├── <página>.js             Lógica de cada página
│   │   │   └── vendor/lucide.min.js    Iconos
│   │   └── img/                        Imágenes y fotos de laboratorios
│   ├── backend/                        API y base de datos
│   │   ├── server.js                   API REST (Express)
│   │   ├── db.js                       Esquema, migraciones, semilla y respaldo
│   │   ├── totp.mjs                    Códigos TOTP de la verificación en dos pasos
│   │   ├── tests/                      Pruebas de backend (Jest + Supertest)
│   │   └── scripts/                    Utilidades de línea de comandos
│   └── config/                         Calidad, pruebas de interfaz y utilidades
└── PENDIENTES.txt                      Pendientes y limitaciones conocidas
```

Los nombres `.html` del árbol son archivos en disco, **no URLs públicas**. El sitio
se navega con rutas limpias (`/login`, `/equipos`, `/configuración`…); Cloudflare
Pages sirve cada archivo en su ruta sin extensión y `_redirects` redirige 308
cualquier enlace antiguo con `.html` a la ruta limpia. El servidor local hace lo
mismo con `extensions: ["html"]`.

---

## 5. Requisitos

- **Node.js 22.13 o superior** (el backend usa `node:sqlite` sin flag experimental
  a partir de esa versión; con Node 22.5–22.12 el arranque falla). Se recomienda
  Node 24, la versión fijada en `.nvmrc` y usada en CI.
- Un navegador moderno. Para el celular, acceso a la red local o un código QR.

---

## 6. Puesta en marcha local

```bash
cd website/backend
npm install
npm start
```

El sitio queda en <http://localhost:3000>. La base de datos se crea sola la primera vez, con
el esquema y los datos de ejemplo.

También sirve `npm run dev` para recargar el servidor al guardar cambios. Para abrir el sitio
desde el celular, con el servidor ya iniciado, ejecuta `node website/config/celular.js`: muestra
un código QR con la dirección de la red local.

Para levantar solo la interfaz estática, sin backend, alcanza con servir `website/public`
con cualquier servidor de archivos; en ese caso el sitio funciona con los datos de ejemplo
y no se pueden guardar cambios.

---

## 7. Seguridad

- **Contraseñas** con hash bcrypt, mínimo de 10 caracteres con mayúscula y número en
  todos los caminos, rechazo de contraseñas comunes y nunca devueltas por la API.
- **Sesiones** con JWT: token de acceso de 2 horas y token de refresco de 30 días con
  rotación; reutilizar un token ya usado se rechaza, y cerrar sesión o cambiar la contraseña
  revoca todos los tokens.
- **Verificación en dos pasos (TOTP)** disponible para las cuentas con acceso técnico o de
  administración (se activa desde Configuración → Seguridad), con clave QR y ventana de 5 minutos.
- **Límites de peticiones** en el inicio de sesión, el registro, la recuperación y las rutas
  de escritura. El límite de sesión combina IP y usuario, así que dos profesores no se
  bloquean entre sí.
- **Validación de entrada** con `express-validator` en todas las rutas de escritura, y
  consultas preparadas en SQLite.
- **Cabeceras de seguridad** con `helmet`: CSP sin `unsafe-inline`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy` y `Cache-Control: no-store` en la API. El sitio
  publicado replica la misma política en `website/public/_headers`; si se cambia en un lado,
  hay que cambiarla en el otro.
- **Escape de HTML** en todas las vistas y fechas validadas con formato estricto.
- **Adjuntos** de reportes con lista blanca de tipos, máximo 5 MB por archivo y 10 por
  reporte.
- **Auditoría** de los eventos relevantes con fecha, usuario, acción, detalle y dirección de
  origen, consultable desde *Configuración → Auditoría*.

---

## 8. Calidad y pruebas

Los comandos se ejecutan desde `website/config`:

```bash
npm test          # pruebas de backend (Jest + Supertest)
npm run test:e2e  # pruebas de interfaz (Playwright)
npm run lint      # ESLint
npm run typecheck # TypeScript en modo comprobación
npm run check     # sintaxis de todos los .js
```

GitHub Actions corre lo mismo en cada `push` a `master`: el flujo de calidad tiene un trabajo
para el backend (pruebas, lint y tipos) y otro para las pruebas de interfaz.

---

## 9. Publicación

Hay **un solo despliegue**, disparado por `workflow_run` cuando el flujo de CI termina en
verde para `master` desde `.github/workflows/deploy-cloudflare.yml` (también se puede lanzar
a mano con `workflow_dispatch`). Así un push con tests rojos nunca se publica:

1. Publica `website/public` en Cloudflare Pages.
2. Sube el backend a Railway con la CLI (`railway up website/backend`), que crea un despliegue
   nuevo desde el commit actual y espera a que la construcción termine.
3. Comprueba que las ocho páginas respondan `200` en su ruta limpia (sin `.html`), que
   `robots.txt` y el `404` existan y que
   la API publicada sea compatible con el backend actual.

Si alguna comprobación falla, el flujo queda en rojo.

### La API y las versiones

La API vive en Railway porque usa `node:sqlite` y necesita disco. El servicio se creó subiendo el
código con la CLI (no tiene repositorio ni directorio raíz configurados), y su despliegue
automático está apagado, así que la API pública no construye nada por sí sola. Por eso el
workflow la actualiza con `railway up`: sube `website/backend` como raíz, adjunta el commit y
espera a que la construcción termine. Así la API queda siempre con el código del push.

El paso 3 es el que decide. No compara la versión de la web con la de la API, sino con **la
versión que declara el último commit que tocó `website/backend`**: si el backend no cambió desde
la última versión, la API puede quedarse atrás sin romper nada y el flujo pasa; si el backend sí
cambió y la API no lo recogió, el flujo falla.

Por eso `GET /api/salud` devuelve la versión **de la API**, no la de la web, y esa cadena solo
sube cuando cambia el comportamiento del backend. Subirla en cada versión obligaría a
redesplegar la API sin ningún cambio real detrás.

Configuración del repositorio, una sola vez:

```
gh secret set CLOUDFLARE_API_TOKEN          # token con permiso Account > Cloudflare Pages: Edit
gh secret set RAILWAY_API_TOKEN             # token de railway.app/account/tokens
gh secret set LC_SALUD_TOKEN                # mismo valor que la variable LC_SALUD_TOKEN de la API
gh variable set RAILWAY_PROJECT_ID          # identificadores del servicio, desde la URL del panel
gh variable set RAILWAY_SERVICE_ID
gh variable set RAILWAY_ENVIRONMENT_ID
```

El backend se configura en el hosting con `LC_DB_DIR` apuntando al volumen, `JWT_SECRET`,
`LC_TRUST_PROXY` y `LC_PUBLIC_URL`. Para que el rate limiting y la auditoría usen la IP real
del navegador (y no la del proxy), define el mismo `LC_PROXY_SECRET` en la API y en el proyecto
de Pages: la Pages Function firma la IP que sí conoce (`cf-connecting-ip`) y el backend solo la
acepta si el secreto coincide; sin él se sigue usando `req.ip`/`x-forwarded-for`. El proyecto de
Pages también define `API_ORIGIN` hacia la API. El chequeo de vida es `GET /api/salud`: responde
`{ ok: true }` a cualquiera y solo revela `servicio` y `version` si se envía el mismo `LC_SALUD_TOKEN`
(anti-fingerprinting), que por eso se define en la API y como secreto del despliegue.

**Cabeceras de seguridad**: al publicarse como archivos estáticos, `helmet` deja de afectar
al frontend, por eso `website/public/_headers` replica la misma política. Es el único punto
que hay que mantener sincronizado con el backend.

### Respaldos y durabilidad

La descarga de Configuración → Respaldos entrega una instantánea consistente (`VACUUM INTO`
+ `integrity_check`), pero vive en el mismo volumen que la base. La durabilidad se cubre en
dos capas:

1. **Línea base (recomendada):** backups automáticos del volumen de Railway. Se activan en
   el panel del servicio (Settings → Backups) en modalidad diaria, semanal y mensual. No
   requieren variables ni credenciales; Railway los factura como almacenamiento incremental,
   un importe marginal para una base de pocos MB.
   **Requiere un plan de pago que los incluya:** el plan Free de Railway no ofrece backups
   del volumen (`maxBackupsCount = 0`). Mientras el servicio esté en Free, la copia
   disponible es la descarga manual de Configuración → Respaldos (y la copia externa en R2
   si se activa).
2. **Opcional:** copia fuera de Railway en **Cloudflare R2**, programada por el propio
   backend. Está implementada pero **no activada**; se deja documentada como pendiente.
   Sin esta capa la aplicación funciona igual: no es un requisito para el uso diario.

La copia externa en R2, cuando se active, usará esta configuración:

| Dato | Valor previsto |
|---|---|
| Bucket | `labcontrol-backups` (privado, sin acceso público) |
| Prefijo | `labcontrol/` |
| Frecuencia | diaria, **02:15** (`America/Santiago`) |
| Retención local | 30 días, conservando siempre las últimas 7 copias |
| Retención en R2 | regla de ciclo de vida de 90 días |
| Verificación | `PRAGMA integrity_check` antes de subir y hash SHA-256 en los metadatos |

Para activar la capa opcional, configura estas variables en el servicio del backend (nunca en
el repositorio):

```text
LC_BACKUP_AUTO=1
LC_BACKUP_HORA=02:15
LC_BACKUP_TZ=America/Santiago
LC_BACKUP_S3_URI=s3://labcontrol-backups/labcontrol/
LC_BACKUP_S3_ENDPOINT=https://<CUENTA>.r2.cloudflarestorage.com
LC_BACKUP_S3_REGION=auto
AWS_ACCESS_KEY_ID=<token de R2 con Object Read & Write>
AWS_SECRET_ACCESS_KEY=<secreto del token>
```

Con `LC_BACKUP_AUTO=1`, el servidor revisa cada 5 minutos y ejecuta un único respaldo al día.
Si el proceso estaba caído a las 02:15, recupera la copia en la primera revisión después del
arranque; la marca `.ultimo-respaldo` evita repetirla el mismo día. Si la subida falla, deja
`.ultimo-intento` y no reintenta hasta el día siguiente; `npm run respaldo` fuerza un intento
manual. El script usa el SDK de AWS incluido en `package.json`, así que **no hace falta
instalar `awscli`** en la imagen.

Puesta en marcha de R2 (opcional, una sola vez):

1. En Cloudflare → R2, crea el bucket privado `labcontrol-backups`.
2. En R2 → Manage R2 API Tokens, crea un token con **Object Read & Write** limitado a ese
   bucket y guarda el Access Key ID y el Secret Access Key.
3. Añade una regla de ciclo de vida que elimine los objetos después de 90 días.
4. Carga las variables del bloque anterior en Railway y redespliega el backend.
5. Fuerza una copia con `npm run respaldo` o espera a las 02:15; revisa que el objeto aparezca
   en `labcontrol-backups/labcontrol/`.

Para probar o forzar una copia:

```bash
cd website/backend
npm run respaldo
```

El script (`website/backend/scripts/respaldo-externo.mjs`) crea la instantánea en
`LC_BACKUP_DIR` (por defecto `$LC_DB_DIR/backups`), verifica su integridad, la copia a
`LC_BACKUP_COPIAR_A` si está definido y/o la sube a R2. La retención local se controla con
`LC_BACKUP_RETENCION_DIAS` y `LC_BACKUP_CONSERVAR`.

Si prefieres un servidor propio en lugar de Railway, el mismo script sirve desde cron:

```cron
15 2 * * * cd /ruta/LabControl/website/backend && LC_BACKUP_AUTO=0 npm run respaldo >> /var/log/labcontrol-respaldo.log 2>&1
```

**Restauración desde un backup del volumen**: en Railway, servicio → Settings → Backups →
elegir el punto → Restore, revisar el volumen restaurado y confirmar Deploy. Antes de restaurar,
descarga el estado actual con `railway volume files download` (o Configuración → Respaldos) y
valida la copia elegida con `PRAGMA integrity_check`. Después del redespliegue, vuelve a
ejecutar `PRAGMA integrity_check` y comprueba usuarios, agenda y equipos.

**Restauración desde R2 o una copia manual**: descarga la copia, valida `PRAGMA integrity_check`,
detén el backend y reemplaza `labcontrol.db` en el volumen. Haz este ensayo al menos una vez al
trimestre en un entorno de staging, no en producción.

Los backups del volumen cubren el contenido del volumen y permiten recuperarse de un borrado
accidental de datos o de un despliegue defectuoso, pero no del borrado del volumen, del
proyecto o de la cuenta de Railway; para eso sirve la copia externa en R2. Restaurar un punto
descarta los backups más nuevos creados después de ese punto.

---

## 10. Pendientes

Lo que falta por hacer y las limitaciones conocidas del despliegue actual están en
[PENDIENTES.txt](PENDIENTES.txt).