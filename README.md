# Parrilleros del Roosevelt Center

Sitio web para reservar los 4 parrilleros del edificio (torres A y B, 22 pisos, 4 apartamentos por piso).
Los vecinos tienen su propia cuenta, sin necesidad de ninguna otra plataforma.

## Qué hace

**Vecinos**
- Se registran eligiendo su apartamento (o tocando su ventana en el dibujo del edificio), con nombre, email, celular y contraseña.
- No pueden reservar hasta que la administración aprueba la cuenta.
- Reservan día (hasta 45 días adelante), turno (mediodía 12–17 o noche 20–01) y parrillero.
- Pagan la seña de $ 500 con Mercado Pago. Mientras pagan, el lugar queda retenido 15 minutos.
- Cancelan desde "Mis reservas": con 24 horas o más de anticipación la seña se devuelve automáticamente a su medio de pago; con menos, el parrillero se libera pero la seña no se devuelve.
- Máximo 2 reservas activas por apartamento (configurable).
- En la agenda los demás vecinos ven el número de apartamento, no el nombre.

**Administración** (`/admin.html`)
- *Solicitudes*: aprobar o rechazar a quienes se registraron solos.
- *Vecinos*: dar de alta a un vecino directamente. El sistema genera un enlace para que cree su contraseña; se copia o se manda por WhatsApp con un botón. El mismo enlace sirve cuando alguien olvida la contraseña. También se puede dar de baja una cuenta.
- *Reservas*: ver todas, con nombre y celular; cancelar una reserva con o sin devolución; reintentar un reembolso que haya fallado.

## Publicarlo

Necesita un servidor con **Node.js 22.5 o más nuevo** y un **disco persistente** (ahí se guarda la base de datos, un único archivo SQLite).
Sirven Railway, Render, Fly.io o cualquier VPS. En los servicios "gratis" el disco suele borrarse en cada reinicio: hace falta el plan que incluye disco persistente (unos pocos dólares por mes).

Pasos generales (ejemplo con Render o Railway):
1. Subir esta carpeta a un repositorio de GitHub.
2. Crear un servicio web nuevo apuntando a ese repositorio.
   - Comando de instalación: `npm install`
   - Comando de inicio: `npm start`
3. Agregar un disco/volumen persistente montado en `/data` y poner `DB_FILE=/data/parrilleros.db`.
4. Cargar las variables de `.env.example` (BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, MP_ACCESS_TOKEN…).
5. Conectar un dominio propio si se quiere (por ejemplo `parrilleros.rooseveltcenter.uy`) y poner esa dirección en `BASE_URL`.
6. Entrar con el email y la contraseña de administración, y cambiar la contraseña con "Enlace de contraseña" en la pestaña Vecinos.

Para probarlo en una computadora: `npm install`, copiar `.env.example` como `.env`, dejar `MP_ACCESS_TOKEN` vacío y `BASE_URL=http://localhost:3000`, y ejecutar `npm start`.

## Mercado Pago

- Se usa Checkout Pro. Hace falta una cuenta de Mercado Pago Uruguay a nombre del edificio o de la administración.
- En Mercado Pago Developers → *Tus integraciones* → crear una aplicación → *Credenciales de producción* → copiar el **Access Token** a `MP_ACCESS_TOKEN`.
- No hay que configurar el webhook en el panel: cada pago le indica a Mercado Pago que avise a `BASE_URL/api/mp/webhook`. Por eso `BASE_URL` tiene que ser la dirección pública real, con https.
- El servidor nunca confía en lo que dice el aviso: consulta el pago directamente a Mercado Pago antes de confirmar la reserva.
- Los reembolsos de cancelaciones a tiempo se hacen solos por la API. Si alguno falla (por ejemplo, sin saldo disponible en la cuenta), queda marcado "reembolsos a revisar" en el panel para reintentarlo.
- Para probar antes de cobrar de verdad se pueden usar las credenciales y tarjetas de prueba de Mercado Pago.
- Mientras `MP_ACCESS_TOKEN` esté vacío, la app funciona en **modo demostración**: el pago es un botón "Simular pago aprobado" y no se cobra nada.

## Recuperación de contraseña

En la pantalla de ingreso está "¿Olvidaste tu contraseña?". El vecino pone su email y:

- **Sin servicio de mails configurado** (como viene): el pedido aparece en Administración → Solicitudes → *Pedidos de recuperación*. La administración aprieta *Generar enlace* y se lo manda por WhatsApp.
- **Con servicio de mails**: le llega un mail con un enlace que vale 1 hora. Si el envío falla, el pedido igual queda en el panel.

Para activar los mails, crear una cuenta gratis en Resend (resend.com) o Brevo (brevo.com), verificar el remitente y cargar estas variables:
- `RESEND_API_KEY` (o `BREVO_API_KEY`)
- `MAIL_FROM`, por ejemplo `Parrilleros Roosevelt <parrilleros@tudominio.uy>`

La administración también puede generar un enlace en cualquier momento desde la pestaña *Vecinos*.

## Cambiar reglas

Variables opcionales: `SENA`, `HORAS_CANCELACION`, `MINUTOS_RETENCION`, `MAX_RESERVAS_ACTIVAS_POR_APTO`, `DIAS_ADELANTE`.
Los horarios de los turnos están al principio de `server.js` (`TURNOS`).

## Respaldo

Toda la información está en el archivo de la base de datos (`DB_FILE`). Conviene copiarlo periódicamente.

## Archivos

- `server.js`: servidor, base de datos, cuentas, reservas y Mercado Pago.
- `index.html`: página de los vecinos (ingreso, registro y reservas).
- `admin.html`: panel de administración.
- `activar.html`: crear o cambiar la contraseña con el enlace de la administración.
- `pago-demo.html`: pago simulado (solo en modo demostración).
- `edificio.js`, `app.css`: dibujo del edificio y estilos.
