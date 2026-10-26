// Ejecutor de navegador con Playwright para la orquestación de n8n.
// Corre en su propio contenedor, dentro de la red de Docker de la migración: no publica puertos hacia el equipo.
//   POST /explorar         lee pantallas y las respuestas JSON que reciben (solo lectura)
//   POST /leer-registros   pide por GET los endpoints de listado con la sesión del usuario (solo lectura)
//   POST /ejecutar-receta  ejecuta los pasos de una receta en el destino (en simulación no escribe)
// Cuerpo: { navegador: 'chromium' | 'firefox' | 'webkit' | 'chromium_remoto', contexto: {...} } → { data }
import { createServer } from 'node:http';
import { chromium, firefox, webkit } from 'playwright';

const PUERTO = Number(process.env.PUERTO || 3100);
const BROWSERLESS_CDP = process.env.BROWSERLESS_CDP || 'ws://browserless:3000';
const MAX_SIMULTANEOS = Number(process.env.MAX_SIMULTANEOS || 4);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let enCurso = 0;

// ── Navegador ──────────────────────────────────────────────────────────────────────────────────
async function abrirNavegador(navegador) {
  switch (navegador) {
    case 'firefox': return firefox.launch();
    case 'webkit': return webkit.launch();
    // Chromium del contenedor browserless (el mismo motor que Chrome, Edge y Brave).
    case 'chromium_remoto': return chromium.connectOverCDP(BROWSERLESS_CDP);
    default: return chromium.launch();
  }
}

// Contexto con la sesión del usuario (cookies y localStorage) y, si corresponde, solo lectura en la red.
async function prepararContexto(navegador, { url, cookies = [], almacenamiento = {} }, soloLectura) {
  const contexto = await navegador.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-CO' });
  const base = new URL(url);
  if (cookies.length) await contexto.addCookies(cookies.map((c) => ({ path: '/', ...c, ...(c.domain ? {} : { url: base.origin }) })));
  if (Object.keys(almacenamiento).length) {
    await contexto.addInitScript((d) => { for (const [k, v] of Object.entries(d)) { try { localStorage.setItem(k, v); } catch { /* sin acceso */ } } }, almacenamiento);
  }
  const bloqueadas = [];
  if (soloLectura) {
    // Toda petición que no sea de lectura se cancela antes de salir: el modelo no puede saltarse esto.
    await contexto.route('**/*', (ruta) => {
      const metodo = ruta.request().method();
      if (['GET', 'HEAD', 'OPTIONS'].includes(metodo)) return ruta.continue();
      bloqueadas.push(`${metodo} ${ruta.request().url()}`);
      return ruta.abort();
    });
  }
  return { contexto, base, bloqueadas };
}

// Campos, botones, enlaces y tablas de la página o del modal abierto.
const leerPantalla = (pagina, soloModal) => pagina.evaluate((soloModal) => {
  const raiz = soloModal
    ? [...document.querySelectorAll('[role=dialog],[aria-modal=true],.modal,.fixed.inset-0')].pop() || document
    : document;
  const etiqueta = (el) => {
    if (el.labels?.length) return el.labels[0].innerText.trim();
    const padre = el.closest('label'); if (padre) return padre.innerText.trim();
    let p = el.previousElementSibling; while (p && !['LABEL', 'SPAN', 'P'].includes(p.tagName)) p = p.previousElementSibling;
    if (p) return p.innerText.trim();
    const cont = el.parentElement?.querySelector('label'); if (cont) return cont.innerText.trim();
    return el.getAttribute('aria-label') || el.placeholder || el.name || '';
  };
  const campos = [...raiz.querySelectorAll('input,select,textarea')].filter((e) => e.type !== 'hidden').slice(0, 60).map((e) => ({
    etiqueta: etiqueta(e).slice(0, 80), tipo: e.tagName === 'SELECT' ? 'select' : (e.type || e.tagName.toLowerCase()),
    nombre: e.name || '', id: e.id || '', placeholder: e.placeholder || '', requerido: Boolean(e.required),
    opciones: e.tagName === 'SELECT' ? [...e.options].slice(0, 30).map((o) => o.textContent.trim()) : [],
  }));
  const botones = [...raiz.querySelectorAll('button,[role=button]')].map((b) => (b.innerText || b.getAttribute('aria-label') || b.title || '').trim()).filter(Boolean).slice(0, 60);
  const enlaces = [...document.querySelectorAll('a[href]')].map((a) => ({ texto: (a.innerText || '').trim().slice(0, 60), href: a.href })).slice(0, 150);
  const titulos = [...raiz.querySelectorAll('h1,h2,h3')].map((h) => h.innerText.trim()).filter(Boolean).slice(0, 20);
  const tablas = [...raiz.querySelectorAll('table')].slice(0, 3).map((t) => ({ encabezados: [...t.querySelectorAll('th')].map((th) => th.innerText.trim()).slice(0, 20), filas: t.querySelectorAll('tbody tr').length }));
  return { titulo: document.title, ruta: location.href, titulos, campos, botones, enlaces, tablas };
}, soloModal);

// ── Acciones ───────────────────────────────────────────────────────────────────────────────────
async function explorar(navegador, ctx) {
  const { url, maxPaginas = 12, rutas = [], abrirFormularios = false } = ctx;
  const { contexto, base, bloqueadas } = await prepararContexto(navegador, ctx, true);
  const pagina = await contexto.newPage();
  const respuestas = [];
  pagina.on('response', async (r) => {
    try {
      if (r.request().method() !== 'GET' || !(r.headers()['content-type'] || '').includes('json')) return;
      respuestas.push({ pagina: pagina.url(), url: r.url(), estado: r.status(), muestra: (await r.text()).slice(0, 4000) });
    } catch { /* respuesta sin cuerpo */ }
  });
  const pendientes = [url, ...rutas.map((r) => new URL(r, base).href)];
  const vistas = new Set();
  const paginas = [];
  while (pendientes.length && paginas.length < maxPaginas) {
    const destino = pendientes.shift();
    if (vistas.has(destino)) continue;
    vistas.add(destino);
    try {
      await pagina.goto(destino, { waitUntil: 'networkidle', timeout: 45000 });
    } catch (e) {
      paginas.push({ ruta: destino, error: String(e.message).slice(0, 200) });
      continue;
    }
    await espera(1000);
    const info = await leerPantalla(pagina, false);
    const modales = [];
    if (abrirFormularios) {
      // Abre los botones de alta para ver sus formularios; las escrituras siguen bloqueadas por la red.
      const altas = info.botones.filter((t) => /^(\+\s*)?(nuev|crear|agregar|añadir|registrar|add|new)/i.test(t)).slice(0, 4);
      for (const texto of altas) {
        const boton = pagina.getByRole('button', { name: texto, exact: true }).first();
        if (!(await boton.isVisible().catch(() => false))) continue;
        await boton.click().catch(() => {});
        await espera(1200);
        const modal = await leerPantalla(pagina, true);
        modales.push({ boton: texto, titulos: modal.titulos, campos: modal.campos, botones: modal.botones });
        await pagina.keyboard.press('Escape');
        await pagina.goto(destino, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
      }
    }
    for (const e of info.enlaces) {
      const u = new URL(e.href, base);
      if (u.origin === base.origin && !/logout|salir|cerrar.?sesi|signout/i.test(u.href + e.texto) && !vistas.has(u.href)) pendientes.push(u.href);
    }
    paginas.push({ ...info, enlaces: info.enlaces.length, modales });
  }
  return { paginas, respuestas: respuestas.slice(0, 80), bloqueadas: bloqueadas.slice(0, 50) };
}

async function leerRegistros(navegador, ctx) {
  const { url, endpoints = [] } = ctx;
  const { contexto } = await prepararContexto(navegador, ctx, true);
  const pagina = await contexto.newPage();
  await pagina.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  const resultados = [];
  for (const ep of endpoints) {
    // La petición sale desde la página, con las cookies y cabeceras de la sesión del usuario.
    const r = await pagina.evaluate(async (u) => {
      try {
        const res = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
        return { estado: res.status, cuerpo: await res.text() };
      } catch (e) { return { estado: 0, cuerpo: String(e) }; }
    }, ep.url);
    let json = null;
    try { json = JSON.parse(r.cuerpo); } catch { /* no es JSON */ }
    resultados.push({ entidad: ep.entidad, url: ep.url, estado: r.estado, json, error: json ? '' : r.cuerpo.slice(0, 300) });
  }
  return { resultados };
}

async function ejecutarReceta(navegador, ctx) {
  const { pasos = [], valores = {}, simulacion = true } = ctx;
  const { contexto, base, bloqueadas } = await prepararContexto(navegador, ctx, simulacion);
  const pagina = await contexto.newPage();
  pagina.setDefaultTimeout(20000);
  const sustituir = (t) => String(t ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => (valores[k] ?? ''));

  // Localizadores de Playwright por orden de estabilidad: etiqueta, placeholder, rol con nombre, CSS, texto.
  const ubicar = (p) => {
    const candidatos = [];
    if (p.etiqueta) candidatos.push(pagina.getByLabel(p.etiqueta, { exact: false }), pagina.locator(`label:has-text("${p.etiqueta}") + *`), pagina.locator(`label:has-text("${p.etiqueta}") >> xpath=following::*[self::input or self::select or self::textarea][1]`));
    if (p.placeholder) candidatos.push(pagina.getByPlaceholder(p.placeholder, { exact: true }));
    if (p.texto) candidatos.push(pagina.getByRole('button', { name: p.texto, exact: true }), pagina.getByRole('tab', { name: p.texto, exact: true }), pagina.getByRole('link', { name: p.texto, exact: true }), pagina.getByText(p.texto, { exact: true }));
    if (p.selector) candidatos.push(pagina.locator(p.selector));
    return candidatos;
  };
  const primeroVisible = async (p) => {
    for (const c of ubicar(p)) {
      const el = c.first();
      if (await el.isVisible().catch(() => false)) return el;
    }
    return null;
  };

  const registro = [];
  const guardados = [];
  for (let i = 0; i < pasos.length; i++) {
    const p = pasos[i];
    try {
      if (p.accion === 'ir') {
        await pagina.goto(new URL(sustituir(p.ruta), base).href, { waitUntil: 'networkidle', timeout: 45000 });
      } else if (p.accion === 'esperar') {
        await espera(Number(p.ms) || 1000);
      } else {
        const el = await primeroVisible(p);
        if (!el) throw new Error(`No se encontró el elemento (${p.etiqueta || p.placeholder || p.texto || p.selector})`);
        if (p.accion === 'clic') {
          await el.click();
        } else if (p.accion === 'llenar') {
          await el.fill(sustituir(`{{${p.campo}}}`));
        } else if (p.accion === 'seleccionar') {
          const valor = sustituir(`{{${p.campo}}}`);
          await el.selectOption({ label: valor }).catch(() => el.selectOption(valor));
        } else if (p.accion === 'guardar') {
          if (simulacion) {
            registro.push({ paso: i, accion: p.accion, resultado: 'simulado (no se envió)' });
            continue;
          }
          // Solo cuenta como hecho si la API responde 2xx: no se confía en mensajes de pantalla.
          const patron = new RegExp(p.url_patron || '.');
          const [resp] = await Promise.all([
            pagina.waitForResponse((r) => r.request().method() === (p.metodo || 'POST') && patron.test(r.url()), { timeout: 30000 }),
            el.click(),
          ]);
          const cuerpo = await resp.text().catch(() => '');
          if (!resp.ok()) throw new Error(`${p.metodo || 'POST'} ${resp.url()} respondió ${resp.status()}: ${cuerpo.slice(0, 200)}`);
          guardados.push({ url: resp.url(), estado: resp.status(), cuerpo: cuerpo.slice(0, 2000) });
        }
      }
      registro.push({ paso: i, accion: p.accion, resultado: 'ok' });
      await espera(300);
    } catch (e) {
      // Para reparar: árbol de accesibilidad de la pantalla en el momento de la falla.
      const arbol = await pagina.locator('body').ariaSnapshot().catch(() => '');
      return { ok: false, paso_fallido: i, error: String(e.message).slice(0, 400), ruta: pagina.url(), registro, guardados, arbol: String(arbol).slice(0, 15000) };
    }
  }
  return { ok: true, registro, guardados, bloqueadas: bloqueadas.slice(0, 20) };
}

const ACCIONES = { explorar, 'leer-registros': leerRegistros, 'ejecutar-receta': ejecutarReceta };
const NAVEGADORES = ['chromium', 'firefox', 'webkit', 'chromium_remoto'];

// ── Servidor ───────────────────────────────────────────────────────────────────────────────────
const responder = (res, estado, cuerpo) => {
  res.writeHead(estado, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(cuerpo));
};

createServer(async (req, res) => {
  const accion = ACCIONES[new URL(req.url, 'http://ejecutor').pathname.slice(1)];
  if (req.method === 'GET' && req.url === '/salud') return responder(res, 200, { ok: true, enCurso, navegadores: NAVEGADORES });
  if (req.method !== 'POST' || !accion) return responder(res, 404, { error: 'Acción desconocida' });
  if (enCurso >= MAX_SIMULTANEOS) return responder(res, 429, { error: 'Ejecutor ocupado, reintenta en unos segundos' });
  let cuerpo = '';
  for await (const trozo of req) cuerpo += trozo;
  let entrada;
  try { entrada = JSON.parse(cuerpo || '{}'); } catch { return responder(res, 400, { error: 'JSON inválido' }); }
  const navegador = NAVEGADORES.includes(entrada.navegador) ? entrada.navegador : 'chromium';
  if (!entrada.contexto?.url) return responder(res, 400, { error: 'Falta contexto.url' });
  enCurso++;
  let instancia;
  try {
    instancia = await abrirNavegador(navegador);
    const data = await accion(instancia, entrada.contexto);
    responder(res, 200, { navegador, data });
  } catch (e) {
    responder(res, 500, { navegador, error: String(e.message).slice(0, 500) });
  } finally {
    enCurso--;
    await instancia?.close().catch(() => {});
  }
}).listen(PUERTO, () => console.log(`Ejecutor Playwright escuchando en el puerto ${PUERTO} (solo red de Docker)`));
