// Genera los flujos de n8n de la migración UI a UI genérica:
//   1 · Asistente de configuración (chat): el usuario cuenta su migración y el asistente le dice qué le falta.
//   2 · Exploración, plan y ejecución (formulario de varias páginas).
// Uso: node n8n/generar.mjs  →  escribe n8n/flujos/*.json listos para «n8n import:workflow».
import { writeFile, mkdir } from 'node:fs/promises';

const MODELO = 'claude-opus-5-5';
const VERSION_API = '2026-10-21';
// Ejecutor Playwright (contenedor «ejecutor» en la red de Docker de la migración).
const EJECUTOR = 'http://ejecutor:3100';
const ID_FLUJO_1 = 'MigrAsistente001';
const ID_FLUJO_2 = 'MigrEjecucion002';
const WEBHOOK_CHAT = '6f1c2a40-3b7e-4c1d-9a55-0e4b8d2f7a11';
const WEBHOOK_FORM = '9d4e7b21-5c3a-4f8e-b1a6-2c7f0e9d3b42';

// Cuerpo de una función como código de un nodo Code (todo lo que está entre la primera «{» y la última «}»).
const cuerpo = (fn) => { const t = fn.toString(); return t.slice(t.indexOf('{') + 1, t.lastIndexOf('}')).replace(/^\n/, ''); };

let x = 0;
const nodo = (nombre, tipo, version, parametros, extra = {}) => ({
  parameters: parametros, name: nombre, type: tipo, typeVersion: version, position: [x += 260, 300], id: crypto.randomUUID(), ...extra,
});
const codigo = (nombre, fn, extra) => nodo(nombre, 'n8n-nodes-base.code', 2, { jsCode: cuerpo(fn) }, extra);
const nota = (texto, pos, ancho = 420, alto = 260) => ({
  parameters: { content: texto, width: ancho, height: alto }, name: `Nota ${crypto.randomUUID().slice(0, 4)}`, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: pos, id: crypto.randomUUID(),
});

// Paso de IA independiente del proveedor: cadena LLM de n8n + subnodo de modelo + analizador de salida estructurada.
// El modelo predeterminado es Claude Opus 5.5, pero el subnodo se puede cambiar por cualquier modelo de chat de n8n
// (OpenAI, Gemini, Azure, Mistral, Ollama…). El analizador valida el JSON y, si no cumple, le pide al modelo corregirlo.
const pasoIA = ({ nombre, sistema, esquema, esfuerzo, maxTokens, sufijo }) => {
  const cadena = nodo(nombre, '@n8n/n8n-nodes-langchain.chainLlm', 1.7, {
    promptType: 'define',
    text: '={{ $json.prompt }}',
    hasOutputParser: true,
    messages: { messageValues: [{ type: 'SystemMessagePromptTemplate', message: sistema }] },
  });
  const [cx, cy] = cadena.position;
  const modelo = {
    parameters: {
      model: { __rl: true, mode: 'id', value: MODELO },
      options: { maxTokensToSample: maxTokens, thinkingMode: 'adaptive', effort: esfuerzo },
    },
    name: `Modelo · ${sufijo}`, type: '@n8n/n8n-nodes-langchain.lmChatAnthropic', typeVersion: 1.6, position: [cx - 80, cy + 220], id: crypto.randomUUID(),
  };
  const analizador = {
    parameters: { schemaType: 'manual', inputSchema: JSON.stringify(esquema, null, 2), autoFix: true },
    name: `Formato · ${sufijo}`, type: '@n8n/n8n-nodes-langchain.outputParserStructured', typeVersion: 1.3, position: [cx + 120, cy + 220], id: crypto.randomUUID(),
  };
  return { cadena, modelo, analizador };
};
const conectarIA = (c, { cadena, modelo, analizador }) => {
  c[modelo.name] = { ai_languageModel: [[{ node: cadena.name, type: 'ai_languageModel', index: 0 }, { node: analizador.name, type: 'ai_languageModel', index: 0 }]] };
  c[analizador.name] = { ai_outputParser: [[{ node: cadena.name, type: 'ai_outputParser', index: 0 }]] };
};

// Llamada a Claude por HTTP (ya no se usa en los flujos; queda como referencia de la API directa).
const claude = (nombre) => nodo(nombre, 'n8n-nodes-base.httpRequest', 4.2, {
  method: 'POST',
  url: 'https://api.anthropic.com/v1/messages',
  authentication: 'predefinedCredentialType',
  nodeCredentialType: 'anthropicApi',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'anthropic-version', value: VERSION_API },
    // Si el clasificador de seguridad rechaza la petición, la API la reintenta sola con el modelo de respaldo.
    { name: 'anthropic-beta', value: 'server-side-fallback-2026-07-01' },
  ] },
  sendBody: true,
  specifyBody: 'json',
  jsonBody: '={{ JSON.stringify($json.peticion) }}',
  options: { timeout: 600000 },
});

// Llamada al ejecutor Playwright: la acción y el navegador vienen en cada ítem.
const navegador = (nombre) => nodo(nombre, 'n8n-nodes-base.httpRequest', 4.2, {
  method: 'POST',
  url: `={{ '${EJECUTOR}/' + $json.accion }}`,
  sendBody: true,
  specifyBody: 'json',
  jsonBody: '={{ JSON.stringify({ navegador: $json.navegador, contexto: $json.contexto }) }}',
  options: { timeout: 900000 },
});

const conectar = (conexiones, de, a, salida = 0) => {
  conexiones[de] ??= { main: [] };
  while (conexiones[de].main.length <= salida) conexiones[de].main.push([]);
  conexiones[de].main[salida].push({ node: a, type: 'main', index: 0 });
};

// ════════════════════════ Flujo 1 · Asistente de configuración ════════════════════════
const APLICATIVO = {
  type: 'object', additionalProperties: false,
  required: ['nombre', 'url', 'acceso', 'autenticacion', 'ambiente', 'rutas_relevantes'],
  properties: {
    nombre: { type: 'string' },
    url: { type: 'string' },
    acceso: { type: 'string', enum: ['ui', 'api', 'ui_y_api', 'desconocido'] },
    autenticacion: { type: 'string' },
    ambiente: { type: 'string', description: 'producción, pruebas, etc.' },
    rutas_relevantes: { type: 'array', items: { type: 'string' } },
  },
};

const ESQUEMA_ASISTENTE = {
  type: 'object',
  additionalProperties: false,
  required: ['respuesta', 'fase', 'checklist', 'configuracion'],
  properties: {
    respuesta: { type: 'string', description: 'Mensaje para el usuario, en español, con las preguntas de este turno' },
    fase: { type: 'string', enum: ['recopilando', 'listo_para_explorar'] },
    checklist: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['requisito', 'categoria', 'estado', 'detalle'],
        properties: {
          requisito: { type: 'string' },
          categoria: { type: 'string', enum: ['acceso', 'ambiente', 'datos', 'reglas', 'seguridad', 'operacion'] },
          estado: { type: 'string', enum: ['pendiente', 'completo', 'no_aplica'] },
          detalle: { type: 'string' },
        },
      },
    },
    configuracion: {
      type: 'object', additionalProperties: false,
      required: ['origen', 'destino', 'navegador', 'entidades', 'clave_identidad', 'reglas', 'volumen_estimado', 'piloto', 'aprobadores'],
      properties: {
        origen: APLICATIVO,
        destino: APLICATIVO,
        navegador: { type: 'string', enum: ['chromium', 'firefox', 'webkit', 'chromium_remoto', 'sin_definir'] },
        entidades: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['nombre', 'filtros', 'incluir', 'excluir'],
            properties: { nombre: { type: 'string' }, filtros: { type: 'string' }, incluir: { type: 'array', items: { type: 'string' } }, excluir: { type: 'array', items: { type: 'string' } } },
          },
        },
        clave_identidad: { type: 'string' },
        reglas: { type: 'array', items: { type: 'string' } },
        volumen_estimado: { type: 'string' },
        piloto: { type: 'array', items: { type: 'string' } },
        aprobadores: { type: 'array', items: { type: 'string' } },
      },
    },
  }
};

const SISTEMA_ASISTENTE = `Eres el asistente de configuración de una plataforma que migra datos entre aplicativos web, interfaz a interfaz (UI a UI): lee las pantallas del origen y llena los formularios del destino como lo haría una persona.

Tu trabajo: a partir de lo que el usuario cuente, decir con precisión qué falta para configurar el entorno de la migración, y pedirlo. Te adaptas a cada caso: no hagas preguntas cuya respuesta ya diste o que no aplican.

Cómo trabajas:
- Haz como máximo 3 preguntas por turno, empezando por lo que bloquea.
- Explica en una línea por qué necesitas cada cosa.
- Mantén el checklist completo en cada respuesta (todo lo pendiente, completo o no aplica).
- Escribe en español, claro y sin jerga técnica innecesaria.

Lo que una migración UI a UI necesita (adapta, no recites):
1. Acceso: URL de origen y destino; cómo se ingresa (usuario y clave, SSO, OTP o MFA, captcha). Si hay OTP o MFA, propone un usuario técnico de migración o que el usuario exporte su sesión (cookies) al iniciar. NUNCA pidas contraseñas ni códigos por este chat: se registran en las credenciales de n8n o se pegan en el formulario de ejecución.
2. Ambiente: si el destino tiene ambiente de pruebas para el piloto; confirmar que el origen se usará solo en lectura.
3. Datos: qué entidades (proyectos, clientes, tickets…), qué secciones de cada una, filtros y exclusiones, volumen aproximado.
4. Identidad: cómo reconocer si un registro ya existe en el destino. Recomienda guardar el código del origen; advierte que el nombre puede repetirse.
5. Catálogos: usuarios, áreas, estados y listas del destino que deben existir antes (responsables, categorías). Pregunta qué hacer si no existen: crearlos, usar uno por defecto o dejar aviso.
6. Reglas: transformaciones (fechas, estados equivalentes), datos incompletos (por ejemplo, fechas vacías), duplicados.
7. Operación: piloto (2 o 3 registros concretos), quién aprueba, ventana de ejecución.
8. Navegador: pregunta con cuál se va a trabajar y explica la diferencia en una línea cada uno: Chromium (recomendado; el mismo motor de Chrome, Edge y Brave), Firefox, WebKit (el motor de Safari, útil si el aplicativo solo se usa en Mac o iPhone) o Chromium remoto (el del servicio browserless, útil para repartir la carga). Si el usuario no tiene preferencia, propone Chromium.
9. Si el destino es un sistema propio con API, menciona que cargar por la API sería más rápido y estable, sin insistir.

Pasa a fase «listo_para_explorar» solo cuando estén completos acceso, ambiente, navegador, entidades, identidad y piloto. En ese momento resume la configuración y di que el siguiente paso es el formulario «Iniciar migración».`;

function prepararConversacion() {
  const datos = $getWorkflowStaticData('global');
  datos.sesiones ??= {};
  const { sessionId, chatInput } = $input.first().json;
  const sesion = datos.sesiones[sessionId] ?? { historial: [], configuracion: null, checklist: [], creada: new Date().toISOString() };
  sesion.historial.push({ rol: 'usuario', texto: String(chatInput ?? '') });
  datos.sesiones[sessionId] = sesion;
  const conversacion = sesion.historial.slice(-30).map((m) => `${m.rol === 'usuario' ? 'USUARIO' : 'ASISTENTE'}: ${m.texto}`).join('\n\n');
  const estado = sesion.configuracion ? JSON.stringify({ configuracion: sesion.configuracion, checklist: sesion.checklist }) : 'Todavía no hay configuración guardada.';
  const prompt = `Conversación hasta ahora:\n${conversacion}\n\nEstado guardado (actualízalo con lo nuevo):\n${estado}\n\nResponde al último mensaje del usuario.`;
  return [{ json: { sessionId, prompt } }];
}

function guardarYResponder() {
  const datos = $input.first().json.output;
  const { sessionId } = $('Preparar conversación').first().json;
  if (!datos?.respuesta) return [{ json: { output: 'No pude interpretar la respuesta del modelo. Intenta de nuevo.', sessionId } }];
  const almacen = $getWorkflowStaticData('global');
  const sesion = almacen.sesiones[sessionId];
  sesion.historial.push({ rol: 'asistente', texto: datos.respuesta });
  sesion.configuracion = datos.configuracion;
  sesion.checklist = datos.checklist;
  sesion.fase = datos.fase;
  const pendientes = datos.checklist.filter((c) => c.estado === 'pendiente');
  let salida = datos.respuesta;
  if (pendientes.length) salida += `\n\n**Pendiente (${pendientes.length}):**\n${pendientes.map((p) => `- ${p.requisito}`).join('\n')}`;
  if (datos.fase === 'listo_para_explorar') {
    const formulario = 'http://localhost:5678/form/__WEBHOOK_FORM__';
    salida += `\n\n✅ **La configuración está completa.** Copia este bloque y pégalo en el formulario «Iniciar migración» (${formulario}):\n\n\`\`\`json\n${JSON.stringify(datos.configuracion, null, 2)}\n\`\`\``;
  }
  return [{ json: { output: salida, sessionId, fase: datos.fase } }];
}

function flujoAsistente() {
  x = 0;
  const chat = nodo('Chat de migración', '@n8n/n8n-nodes-langchain.chatTrigger', 1.1, {
    public: true,
    mode: 'hostedChat',
    initialMessages: 'Hola. Soy el asistente de migraciones entre aplicativos.\nCuéntame qué quieres migrar: de qué aplicativo a cuál, qué datos y las reglas que tengas. Te diré qué necesito para configurar el entorno.',
    options: { title: 'Asistente de migración', subtitle: 'UI a UI, con piloto y aprobación', inputPlaceholder: 'Describe tu migración…', responseMode: 'lastNode' },
  }, { webhookId: WEBHOOK_CHAT });
  const preparar = codigo('Preparar conversación', prepararConversacion);
  const ia = pasoIA({ nombre: 'IA · configurador', sistema: SISTEMA_ASISTENTE, esquema: ESQUEMA_ASISTENTE, esfuerzo: 'medium', maxTokens: 16000, sufijo: 'configurador' });
  const llamar = ia.cadena;
  const responder = codigo('Guardar y responder', guardarYResponder);
  responder.parameters.jsCode = responder.parameters.jsCode.replace('__WEBHOOK_FORM__', WEBHOOK_FORM);
  const conexiones = {};
  conectar(conexiones, chat.name, preparar.name);
  conectar(conexiones, preparar.name, llamar.name);
  conectar(conexiones, llamar.name, responder.name);
  conectarIA(conexiones, ia);
  return {
    id: ID_FLUJO_1,
    name: 'Migración UI a UI · 1 · Asistente de configuración',
    nodes: [
      nota('## 1 · Asistente de configuración\nEl usuario cuenta su migración y el asistente le dice **qué falta** para configurar el entorno (accesos, ambiente de pruebas, OTP, entidades, identidad, catálogos, piloto).\n\nGuarda el avance por sesión de chat. Cuando todo está completo entrega la configuración en JSON para el flujo 2.\n\n**Modelo:** por defecto Claude Opus 5.5 (nodo *Modelo · configurador*). Puedes reemplazarlo por cualquier modelo de chat de n8n: OpenAI, Gemini, Azure, Mistral, Ollama…\n**Antes de usarlo:** asigna la credencial del proveedor en el nodo del modelo.', [0, 0], 600, 280),
      chat, preparar, llamar, ia.modelo, ia.analizador, responder,
    ],
    connections: conexiones,
    settings: { executionOrder: 'v1' },
    active: false,
  };
}

// ════════════════════════ Flujo 2 · Exploración, plan y ejecución ════════════════════════
const ESQUEMA_PLAN = {
  type: 'object', additionalProperties: false,
  required: ['resumen', 'entidades', 'mapeo', 'recetas', 'catalogos_faltantes', 'riesgos', 'preguntas_abiertas'],
  properties: {
    resumen: { type: 'string' },
    entidades: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['nombre', 'orden', 'padre', 'campo_padre_origen', 'endpoint_listado', 'ruta_lista', 'campo_id', 'campo_nombre', 'filtros', 'endpoint_destino', 'ruta_lista_destino', 'campo_clave_destino'],
        properties: {
          nombre: { type: 'string' },
          orden: { type: 'integer' },
          padre: { type: 'string', description: 'Entidad padre, o vacío' },
          campo_padre_origen: { type: 'string', description: 'Campo del registro que apunta al id del padre en el origen, o vacío' },
          endpoint_listado: { type: 'string', description: 'URL completa del GET que lista los registros en el origen; puede usar {{id_padre_origen}}' },
          ruta_lista: { type: 'string', description: 'Ruta dentro del JSON hasta el arreglo (ej.: data.items), vacío si es la raíz' },
          campo_id: { type: 'string' },
          campo_nombre: { type: 'string' },
          filtros: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['campo', 'operador', 'valor'],
              properties: { campo: { type: 'string' }, operador: { type: 'string', enum: ['igual', 'distinto', 'contiene', 'no_contiene'] }, valor: { type: 'string' } },
            },
          },
          endpoint_destino: { type: 'string', description: 'GET del destino que lista los registros ya existentes, o vacío' },
          ruta_lista_destino: { type: 'string' },
          campo_clave_destino: { type: 'string', description: 'Campo del destino que se compara con la clave de identidad' },
        },
      },
    },
    mapeo: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['entidad', 'campo_destino', 'origen', 'transformacion', 'valor_fijo', 'tabla'],
        properties: {
          entidad: { type: 'string' },
          campo_destino: { type: 'string', description: 'Nombre corto que usan las recetas en {{campo}}' },
          origen: { type: 'string', description: 'Ruta en el registro de origen (ej.: fecha_inicio, cliente.nombre)' },
          transformacion: { type: 'string', enum: ['ninguna', 'fecha_iso', 'mayusculas', 'minusculas', 'numero', 'fijo', 'tabla'] },
          valor_fijo: { type: 'string' },
          tabla: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['de', 'a'], properties: { de: { type: 'string' }, a: { type: 'string' } } },
          },
        },
      },
    },
    recetas: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['entidad', 'pasos'],
        properties: {
          entidad: { type: 'string' },
          pasos: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['accion', 'ruta', 'selector', 'texto', 'etiqueta', 'placeholder', 'campo', 'metodo', 'url_patron', 'ms'],
              properties: {
                accion: { type: 'string', enum: ['ir', 'clic', 'llenar', 'seleccionar', 'guardar', 'esperar'] },
                ruta: { type: 'string' }, selector: { type: 'string' }, texto: { type: 'string' }, etiqueta: { type: 'string' },
                placeholder: { type: 'string' }, campo: { type: 'string' }, metodo: { type: 'string' }, url_patron: { type: 'string' },
                ms: { type: 'integer' },
              },
            },
          },
        },
      },
    },
    catalogos_faltantes: { type: 'array', items: { type: 'string' } },
    riesgos: { type: 'array', items: { type: 'string' } },
    preguntas_abiertas: { type: 'array', items: { type: 'string' } },
  },
};

const SISTEMA_PLAN = `Eres el planificador de una migración UI a UI. Recibes la configuración acordada con el usuario y lo que un navegador vio al explorar el origen (en solo lectura) y el destino (sin escribir): páginas, campos de formularios, botones y las respuestas JSON que reciben las pantallas.

Produce el plan de migración:
- entidades: en orden de carga (padres primero). Para leer el origen usa los endpoints GET que aparecen en las respuestas capturadas, no el HTML. Indica la ruta al arreglo dentro del JSON y los campos id y nombre. Para detectar duplicados en el destino usa la clave de identidad de la configuración.
- mapeo: campo a campo. Los valores de catálogo (estados, categorías) se traducen con transformación «tabla».
- recetas: los pasos exactos para crear UN registro en el destino con los campos y botones observados. Prefiere selectores por etiqueta o placeholder (estables) antes que CSS. Cada «guardar» debe indicar el método HTTP y un patrón de URL de la API que confirma el guardado. Los valores se referencian con el nombre de «campo_destino»; para el id del padre en el destino usa el campo «_id_padre_destino».
- Usa solo lo observado; si algo no se vio, decláralo en preguntas_abiertas en vez de inventarlo.
- catalogos_faltantes, riesgos y preguntas_abiertas: concretos y accionables.
Responde en español.`;

const SISTEMA_REPARACION = 'Reparas un paso de una receta de navegador que falló en una migración UI a UI. Con el árbol de accesibilidad de la pantalla, propone el mismo paso con un selector, texto, etiqueta o placeholder que sí exista. No cambies la intención del paso ni inventes campos. Si no se puede reparar, reparable=false. Responde en español.';

const ESQUEMA_REPARACION = {
  type: 'object', additionalProperties: false, required: ['diagnostico', 'reparable', 'paso'],
  properties: {
    diagnostico: { type: 'string' },
    reparable: { type: 'boolean' },
    paso: ESQUEMA_PLAN.properties.recetas.items.properties.pasos.items,
  },
};

function leerFormulario() {
  const f = $input.first().json;
  const leerJson = (texto, nombre, porDefecto) => {
    if (!String(texto ?? '').trim()) return porDefecto;
    try { return JSON.parse(texto); } catch { throw new Error(`El campo «${nombre}» no es un JSON válido.`); }
  };
  const configuracion = leerJson(f['Configuración (JSON del asistente)'], 'Configuración', null);
  if (!configuracion?.origen?.url || !configuracion?.destino?.url) throw new Error('La configuración debe traer origen.url y destino.url.');
  const sesionOrigen = leerJson(f['Sesión del origen (opcional)'], 'Sesión del origen', {});
  const sesionDestino = leerJson(f['Sesión del destino (opcional)'], 'Sesión del destino', {});
  const simulacion = f['Modo'] !== 'Real (escribe en el destino)';
  const piloto = Math.max(0, Number(f['Registros piloto (0 = todos)']) || 0);
  const opciones = { 'Chromium (Chrome, Edge, Brave)': 'chromium', Firefox: 'firefox', 'WebKit (Safari)': 'webkit', 'Chromium remoto (browserless)': 'chromium_remoto' };
  const elegido = opciones[f['Navegador']] ?? configuracion.navegador;
  const navegador = ['chromium', 'firefox', 'webkit', 'chromium_remoto'].includes(elegido) ? elegido : 'chromium';
  const accion = 'explorar';
  const comun = (s) => ({ cookies: s.cookies ?? [], almacenamiento: s.almacenamiento ?? {} });
  return [
    { json: { lado: 'origen', configuracion, sesionOrigen, sesionDestino, simulacion, piloto, navegador, accion,
      contexto: { url: configuracion.origen.url, rutas: configuracion.origen.rutas_relevantes ?? [], maxPaginas: 12, abrirFormularios: false, ...comun(sesionOrigen) } } },
    { json: { lado: 'destino', configuracion, sesionOrigen, sesionDestino, simulacion, piloto, navegador, accion,
      contexto: { url: configuracion.destino.url, rutas: configuracion.destino.rutas_relevantes ?? [], maxPaginas: 10, abrirFormularios: true, ...comun(sesionDestino) } } },
  ];
}

function prepararPlan() {
  const exploraciones = $input.all().map((i) => i.json.data ?? i.json);
  const entradas = $('Leer formulario').all().map((i) => i.json);
  const recortar = (v, n) => JSON.stringify(v).slice(0, n);
  const detalle = entradas.map((e, k) => `### ${e.lado.toUpperCase()} (${e.contexto.url})\nPáginas: ${recortar(exploraciones[k]?.paginas ?? [], 60000)}\nRespuestas JSON: ${recortar(exploraciones[k]?.respuestas ?? [], 60000)}`).join('\n\n');
  const prompt = `Configuración acordada:\n${JSON.stringify(entradas[0].configuracion, null, 2)}\n\nExploración:\n${detalle}`;
  return [{ json: { prompt } }];
}

function mostrarPlan() {
  const plan = $input.first().json.output;
  if (!plan?.entidades) throw new Error('El modelo no devolvió un plan válido.');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const lista = (titulo, items) => (items?.length ? `<h3>${titulo}</h3><ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '');
  const filas = (plan.mapeo ?? []).map((m) => `<tr><td>${esc(m.entidad)}</td><td>${esc(m.origen)}</td><td>→</td><td>${esc(m.campo_destino)}</td><td>${esc(m.transformacion)}</td></tr>`).join('');
  const html = `<p>${esc(plan.resumen)}</p>
<h3>Entidades (en orden)</h3><ol>${(plan.entidades ?? []).sort((a, b) => a.orden - b.orden).map((e) => `<li><b>${esc(e.nombre)}</b>${e.padre ? ` (hija de ${esc(e.padre)})` : ''} · ${esc(e.endpoint_listado)}</li>`).join('')}</ol>
<h3>Mapeo</h3><table border="1" cellpadding="4" style="border-collapse:collapse;font-size:12px"><tr><th>Entidad</th><th>Origen</th><th></th><th>Destino</th><th>Transformación</th></tr>${filas}</table>
<h3>Recetas</h3><ul>${(plan.recetas ?? []).map((rc) => `<li>${esc(rc.entidad)}: ${rc.pasos.length} pasos</li>`).join('')}</ul>
${lista('Catálogos que faltan en el destino', plan.catalogos_faltantes)}${lista('Riesgos', plan.riesgos)}${lista('Preguntas abiertas', plan.preguntas_abiertas)}`;
  return [{ json: { plan, html } }];
}

function leerRegistrosOrigen() {
  const { plan } = $('Mostrar plan').first().json;
  const base = $('Leer formulario').first().json;
  const raices = plan.entidades.filter((e) => !e.padre);
  return [{ json: {
    accion: 'leer-registros',
    navegador: base.navegador,
    contexto: { url: base.configuracion.origen.url, ...(base.sesionOrigen ?? {}), endpoints: raices.map((e) => ({ entidad: e.nombre, url: e.endpoint_listado })) },
  } }];
}

function prepararTrabajos() {
  const { plan } = $('Mostrar plan').first().json;
  const base = $('Leer formulario').first().json;
  const resultados = $input.first().json.data?.resultados ?? [];
  const leer = (obj, ruta) => (ruta ? String(ruta).split('.').reduce((o, k) => o?.[k], obj) : obj);
  const cumple = (reg, f) => {
    const v = String(leer(reg, f.campo) ?? '').toLowerCase(); const w = String(f.valor ?? '').toLowerCase();
    return { igual: v === w, distinto: v !== w, contiene: v.includes(w), no_contiene: !v.includes(w) }[f.operador] ?? true;
  };
  const trabajos = [];
  for (const ent of plan.entidades.filter((e) => !e.padre)) {
    const r = resultados.find((x) => x.entidad === ent.nombre);
    let registros = leer(r?.json, ent.ruta_lista) ?? [];
    if (!Array.isArray(registros)) registros = [];
    registros = registros.filter((reg) => (ent.filtros ?? []).every((f) => cumple(reg, f)));
    if (base.piloto > 0) registros = registros.slice(0, base.piloto);
    for (const reg of registros) trabajos.push({ json: { entidad: ent.nombre, idOrigen: String(leer(reg, ent.campo_id) ?? ''), nombre: String(leer(reg, ent.campo_nombre) ?? ''), registro: reg, intento: 0 } });
  }
  // Estado de esta ejecución: ids creados y resultados por registro.
  const estado = $getWorkflowStaticData('global');
  estado.ejecuciones ??= {};
  estado.ejecuciones[$execution.id] = { idsDestino: {}, resultados: [] };
  if (!trabajos.length) return [{ json: { vacio: true, motivo: resultados.map((x) => `${x.entidad}: ${x.estado} ${x.error}`).join(' | ') } }];
  return trabajos;
}

function transformarRegistro() {
  const t = $input.first().json;
  const { plan } = $('Mostrar plan').first().json;
  const base = $('Leer formulario').first().json;
  const estado = $getWorkflowStaticData('global').ejecuciones[$execution.id];
  // Sin registros: se manda una receta vacía para llegar al resumen con el motivo.
  if (t.vacio) {
    return [{ json: { ...t, ok: false, accion: 'ejecutar-receta', navegador: base.navegador, contexto: { url: base.configuracion.destino.url, pasos: [], valores: {}, simulacion: true } } }];
  }
  const leer = (obj, ruta) => (ruta ? String(ruta).split('.').reduce((o, k) => o?.[k], obj) : obj);
  const valores = {};
  for (const m of plan.mapeo.filter((x) => x.entidad === t.entidad)) {
    let v = m.transformacion === 'fijo' ? m.valor_fijo : leer(t.registro, m.origen);
    if (v == null) v = '';
    if (m.transformacion === 'fecha_iso' && v) v = String(v).slice(0, 10);
    if (m.transformacion === 'mayusculas') v = String(v).toUpperCase();
    if (m.transformacion === 'minusculas') v = String(v).toLowerCase();
    if (m.transformacion === 'numero') v = String(Number(v) || 0);
    if (m.transformacion === 'tabla') v = (m.tabla.find((f) => f.de.toLowerCase() === String(v).toLowerCase())?.a) ?? v;
    valores[m.campo_destino] = String(v);
  }
  const ent = plan.entidades.find((e) => e.nombre === t.entidad);
  if (ent?.padre) valores._id_padre_destino = estado.idsDestino[`${ent.padre}:${leer(t.registro, ent.campo_padre_origen)}`] ?? '';
  const receta = t.recetaReparada ?? plan.recetas.find((r) => r.entidad === t.entidad)?.pasos ?? [];
  return [{ json: { ...t, valores, receta, accion: 'ejecutar-receta', navegador: base.navegador,
    contexto: { url: base.configuracion.destino.url, ...(base.sesionDestino ?? {}), pasos: receta, valores, simulacion: base.simulacion } } }];
}

function evaluarResultado() {
  const t = $('Transformar registro').first().json;
  const r = $input.first().json.data ?? {};
  // Sin registros no hay nada que reparar: pasa directo al registro con el motivo.
  return [{ json: { ...t, resultado: r, ok: Boolean(r.ok), intento: t.vacio ? 1 : t.intento } }];
}

function pedirReparacion() {
  const t = $input.first().json;
  const paso = t.receta[t.resultado.paso_fallido];
  const prompt = `Paso que falló: ${JSON.stringify(paso)}\nError: ${t.resultado.error}\nPantalla: ${t.resultado.ruta}\nÁrbol de accesibilidad: ${t.resultado.arbol}`;
  return [{ json: { ...t, prompt } }];
}

function aplicarReparacion() {
  const t = $('Pedir reparación').first().json;
  const rep = $input.first().json.output ?? null;
  if (!rep?.reparable) return [{ json: { ...t, ok: false, diagnostico: rep?.diagnostico ?? 'Sin reparación posible', intento: t.intento + 1 } }];
  const recetaReparada = t.receta.map((p, i) => (i === t.resultado.paso_fallido ? rep.paso : p));
  return [{ json: { ...t, recetaReparada, diagnostico: rep.diagnostico, intento: t.intento + 1, reintentar: true } }];
}

function registrar() {
  const t = $input.first().json;
  const estado = $getWorkflowStaticData('global').ejecuciones[$execution.id];
  if (t.vacio) {
    estado.resultados.push({ entidad: '—', idOrigen: '', nombre: '', ok: false, idDestino: '', reparado: false, detalle: `No se encontraron registros en el origen. ${t.motivo ?? ''}` });
    return [{ json: { listo: true } }];
  }
  // El id creado se toma de la primera respuesta de guardado que traiga un campo id.
  let idDestino = '';
  for (const g of t.resultado?.guardados ?? []) {
    try { const j = JSON.parse(g.cuerpo); idDestino = String(j.id ?? j.data?.id ?? ''); if (idDestino) break; } catch { /* sin JSON */ }
  }
  if (t.ok && idDestino) estado.idsDestino[`${t.entidad}:${t.idOrigen}`] = idDestino;
  estado.resultados.push({ entidad: t.entidad, idOrigen: t.idOrigen, nombre: t.nombre, ok: t.ok, idDestino, reparado: Boolean(t.recetaReparada), detalle: t.ok ? '' : (t.resultado?.error ?? t.diagnostico ?? '') });
  return [{ json: { listo: true } }];
}

function resumen() {
  const base = $('Leer formulario').first().json;
  const estado = $getWorkflowStaticData('global').ejecuciones?.[$execution.id] ?? { resultados: [] };
  const rs = estado.resultados;
  const ok = rs.filter((r) => r.ok).length;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const filas = rs.map((r) => `<tr><td>${esc(r.entidad)}</td><td>${esc(r.idOrigen)}</td><td>${esc(r.nombre)}</td><td>${r.ok ? '✔' : '✘'}${r.reparado ? ' (reparado)' : ''}</td><td>${esc(r.idDestino)}</td><td>${esc(r.detalle)}</td></tr>`).join('');
  const html = `<h2>${base.simulacion ? 'Simulación terminada (no se escribió nada)' : 'Migración terminada'}</h2>
<p><b>${ok}</b> de <b>${rs.length}</b> registros correctos.</p>
<table border="1" cellpadding="4" style="border-collapse:collapse;font-size:12px"><tr><th>Entidad</th><th>Id origen</th><th>Nombre</th><th>Resultado</th><th>Id destino</th><th>Detalle</th></tr>${filas}</table>`;
  delete $getWorkflowStaticData('global').ejecuciones?.[$execution.id];
  return [{ json: { html, total: rs.length, correctos: ok } }];
}

function flujoEjecucion() {
  x = 0;
  const campos = (lista) => ({ values: lista });
  const inicio = nodo('Iniciar migración', 'n8n-nodes-base.formTrigger', 2.3, {
    formTitle: 'Iniciar migración UI a UI',
    formDescription: 'Pega la configuración que te entregó el asistente. El origen se lee siempre en solo lectura. En modo simulación tampoco se escribe en el destino.',
    formFields: campos([
      { fieldLabel: 'Configuración (JSON del asistente)', fieldType: 'textarea', requiredField: true },
      { fieldLabel: 'Sesión del origen (opcional)', fieldType: 'textarea', placeholder: '{"cookies":[{"name":"...","value":"..."}],"almacenamiento":{"clave":"valor"}}' },
      { fieldLabel: 'Sesión del destino (opcional)', fieldType: 'textarea', placeholder: '{"cookies":[{"name":"...","value":"..."}]}' },
      { fieldLabel: 'Navegador', fieldType: 'dropdown', requiredField: true, fieldOptions: { values: [{ option: 'Según la configuración' }, { option: 'Chromium (Chrome, Edge, Brave)' }, { option: 'Firefox' }, { option: 'WebKit (Safari)' }, { option: 'Chromium remoto (browserless)' }] } },
      { fieldLabel: 'Modo', fieldType: 'dropdown', requiredField: true, fieldOptions: { values: [{ option: 'Simulación (no escribe)' }, { option: 'Real (escribe en el destino)' }] } },
      { fieldLabel: 'Registros piloto (0 = todos)', fieldType: 'number', placeholder: '2' },
    ]),
  }, { webhookId: WEBHOOK_FORM });
  const leer = codigo('Leer formulario', leerFormulario);
  const explorarNav = navegador('Playwright · explorar (solo lectura)');
  const prepPlan = codigo('Preparar plan', prepararPlan);
  const iaPlan = pasoIA({ nombre: 'IA · plan de migración', sistema: SISTEMA_PLAN, esquema: ESQUEMA_PLAN, esfuerzo: 'high', maxTokens: 32000, sufijo: 'planificador' });
  const planClaude = iaPlan.cadena;
  const mostrar = codigo('Mostrar plan', mostrarPlan);
  const aprobar = nodo('Aprobar plan', 'n8n-nodes-base.form', 2.3, {
    operation: 'page',
    formFields: campos([
      { fieldType: 'html', html: '={{ $json.html }}' },
      { fieldLabel: 'Decisión', fieldType: 'dropdown', requiredField: true, fieldOptions: { values: [{ option: 'Aprobar y ejecutar' }, { option: 'Cancelar' }] } },
      { fieldLabel: 'Observaciones', fieldType: 'textarea' },
    ]),
    options: { formTitle: 'Plan propuesto', buttonLabel: 'Enviar' },
  }, { webhookId: crypto.randomUUID() });
  const siAprobado = nodo('¿Aprobado?', 'n8n-nodes-base.if', 2, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [{ id: crypto.randomUUID(), leftValue: '={{ $json["Decisión"] }}', rightValue: 'Aprobar y ejecutar', operator: { type: 'string', operation: 'equals' } }],
      combinator: 'and',
    },
    options: {},
  });
  const leerOrigen = codigo('Preparar lectura de registros', leerRegistrosOrigen);
  const leerNav = navegador('Playwright · leer registros (solo lectura)');
  const trabajos = codigo('Preparar trabajos', prepararTrabajos);
  const bucle = nodo('Por cada registro', 'n8n-nodes-base.splitInBatches', 3, { batchSize: 1, options: {} });
  const transformar = codigo('Transformar registro', transformarRegistro);
  const ejecutar = navegador('Playwright · ejecutar receta');
  const evaluar = codigo('Evaluar resultado', evaluarResultado);
  const siOk = nodo('¿Guardado?', 'n8n-nodes-base.if', 2, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [{ id: crypto.randomUUID(), leftValue: '={{ $json.ok || $json.intento >= 1 }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and',
    },
    options: {},
  });
  const pedir = codigo('Pedir reparación', pedirReparacion);
  const iaReparar = pasoIA({ nombre: 'IA · reparar paso', sistema: SISTEMA_REPARACION, esquema: ESQUEMA_REPARACION, esfuerzo: 'medium', maxTokens: 8000, sufijo: 'reparador' });
  const repararClaude = iaReparar.cadena;
  const aplicar = codigo('Aplicar reparación', aplicarReparacion);
  const siReintentar = nodo('¿Reintentar?', 'n8n-nodes-base.if', 2, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [{ id: crypto.randomUUID(), leftValue: '={{ Boolean($json.reintentar) }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and',
    },
    options: {},
  });
  const reg = codigo('Registrar resultado', registrar);
  const fin = codigo('Resumen', resumen);
  const final = nodo('Resultado', 'n8n-nodes-base.form', 2.3, { operation: 'completion', respondWith: 'showText', responseText: '={{ $json.html }}' }, { webhookId: crypto.randomUUID() });
  const cancelado = nodo('Cancelado', 'n8n-nodes-base.form', 2.3, { operation: 'completion', respondWith: 'text', completionTitle: 'Migración cancelada', completionMessage: 'No se escribió nada. Puedes ajustar la configuración y volver a empezar.' }, { webhookId: crypto.randomUUID() });

  const c = {};
  conectar(c, inicio.name, leer.name);
  conectar(c, leer.name, explorarNav.name);
  conectar(c, explorarNav.name, prepPlan.name);
  conectar(c, prepPlan.name, planClaude.name);
  conectar(c, planClaude.name, mostrar.name);
  conectar(c, mostrar.name, aprobar.name);
  conectar(c, aprobar.name, siAprobado.name);
  conectar(c, siAprobado.name, leerOrigen.name, 0);
  conectar(c, siAprobado.name, cancelado.name, 1);
  conectar(c, leerOrigen.name, leerNav.name);
  conectar(c, leerNav.name, trabajos.name);
  conectar(c, trabajos.name, bucle.name);
  conectar(c, bucle.name, fin.name, 0); // salida «done»
  conectar(c, bucle.name, transformar.name, 1); // salida «loop»
  conectar(c, transformar.name, ejecutar.name);
  conectar(c, ejecutar.name, evaluar.name);
  conectar(c, evaluar.name, siOk.name);
  conectar(c, siOk.name, reg.name, 0);
  conectar(c, siOk.name, pedir.name, 1);
  conectar(c, pedir.name, repararClaude.name);
  conectar(c, repararClaude.name, aplicar.name);
  conectar(c, aplicar.name, siReintentar.name);
  conectar(c, siReintentar.name, transformar.name, 0);
  conectar(c, siReintentar.name, reg.name, 1);
  conectar(c, reg.name, bucle.name);
  conectar(c, fin.name, final.name);
  conectarIA(c, iaPlan);
  conectarIA(c, iaReparar);

  return {
    id: ID_FLUJO_2,
    name: 'Migración UI a UI · 2 · Exploración, plan y ejecución',
    nodes: [
      nota('## 2 · Exploración, plan y ejecución\n1. **Explorar:** el ejecutor Playwright (Chromium, Firefox o WebKit, según elijas) recorre origen y destino. Toda escritura queda bloqueada a nivel de red.\n2. **Planear:** Claude propone entidades, mapeo y recetas solo con lo observado.\n3. **Aprobar:** ves el plan y decides.\n4. **Ejecutar:** cada registro corre su receta; un guardado cuenta solo si la API responde 2xx. Si un paso falla, Claude lo repara una vez.\n\n**Modelos:** *Modelo · planificador* y *Modelo · reparador* usan Claude Opus 5.5 por defecto; cada uno se puede cambiar por cualquier modelo de chat de n8n. El plan es la tarea más exigente.\n**Antes de usarlo:** asigna la credencial del proveedor en cada nodo de modelo.', [0, 0], 680, 340),
      inicio, leer, explorarNav, prepPlan, planClaude, iaPlan.modelo, iaPlan.analizador, mostrar, aprobar, siAprobado, cancelado, leerOrigen, leerNav, trabajos, bucle, transformar, ejecutar, evaluar, siOk, pedir, repararClaude, iaReparar.modelo, iaReparar.analizador, aplicar, siReintentar, reg, fin, final,
    ],
    connections: c,
    settings: { executionOrder: 'v1' },
    active: false,
  };
}

await mkdir(new URL('./flujos/', import.meta.url), { recursive: true });
for (const flujo of [flujoAsistente(), flujoEjecucion()]) {
  const archivo = new URL(`./flujos/${flujo.id}.json`, import.meta.url);
  await writeFile(archivo, JSON.stringify(flujo, null, 2));
  console.log(`✓ ${flujo.name} → n8n/flujos/${flujo.id}.json (${flujo.nodes.length} nodos)`);
}
