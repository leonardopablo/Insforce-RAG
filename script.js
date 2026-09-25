const $ = (selector) => document.querySelector(selector);
const sidebar = $('#sidebar');
const scrim = $('#scrim');
const input = $('#messageInput');
const send = $('#sendButton');
const messages = $('#messages');
const welcome = $('#welcome');
const conversation = $('.conversation');
const dialog = $('#documentDialog');
const STORAGE_KEY = 'insforce.rag.chats.v1';
const INGESTION_DB = 'insforce-rag-ingestion-v1';
let chats = [];
let activeId = null;
let busy = false;
let activeRequest = null;
let ingestionRequest = null;
let selectedJob = null;
let appConfig = { maxTxtBytes: 10 * 1024 * 1024, blockCharacters: 100_000 };

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const currentChat = () => chats.find((chat) => chat.id === activeId);
function announce(text) { $('#notice').textContent = text; }
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ activeId, chats: chats.slice(0, 30).map((chat) => ({
      ...chat, messages: chat.messages.filter((message) => message.status !== 'loading').slice(-100),
    })) }));
  } catch { announce('No se pudo guardar el historial en este navegador. El chat sigue disponible.'); }
}
function restore() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (Array.isArray(stored?.chats)) {
      chats = stored.chats.filter((chat) => typeof chat.id === 'string' && typeof chat.title === 'string' &&
        Array.isArray(chat.messages) && chat.messages.every((m) => ['user', 'assistant'].includes(m.role) && typeof m.text === 'string')).slice(0, 30);
      activeId = chats.some((chat) => chat.id === stored.activeId) ? stored.activeId : null;
    }
  } catch { chats = []; }
}
function closeSidebar() {
  sidebar.classList.remove('is-open');
  scrim.classList.remove('is-visible');
  $('#menuButton').setAttribute('aria-expanded', 'false');
}
function resizeInput() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  send.disabled = busy || !input.value.trim();
}
function setBusy(value, asking = false) {
  busy = value;
  $('#stopButton').hidden = !(value && asking);
  $('#newChat').disabled = value;
  $('#attachButton').disabled = value;
  document.querySelectorAll('[data-open-document]').forEach((button) => { button.disabled = value; });
  $('#deleteChat').disabled = value || !currentChat();
  $('#exportChat').disabled = value || !currentChat()?.messages.length;
  document.querySelectorAll('.chat-link').forEach((button) => { button.disabled = value; });
  $('#composer').setAttribute('aria-busy', String(value));
  resizeInput();
}
function scrollDown() { conversation.scrollTo({ top: conversation.scrollHeight, behavior: 'smooth' }); }
function renderHistory() {
  const group = el('section', 'chat-group');
  group.append(el('h2', '', 'Tus conversaciones'));
  if (!chats.length) group.append(el('p', 'history-empty', 'Tus consultas aparecerán aquí.'));
  for (const chat of chats) {
    const button = el('button', `chat-link${chat.id === activeId ? ' is-active' : ''}`);
    button.type = 'button';
    button.title = chat.title;
    button.disabled = busy;
    if (chat.id === activeId) button.setAttribute('aria-current', 'true');
    button.append(el('span', '', chat.title));
    button.addEventListener('click', () => {
      if (busy) return;
      activeId = chat.id;
      save(); render(); closeSidebar();
    });
    group.append(button);
  }
  $('#chatHistory').replaceChildren(group);
}
function normalizeTrace(value) {
  if (!value || (value.version !== undefined && value.version !== 1) || !Array.isArray(value.steps) || !Array.isArray(value.retrieval)) return null;
  const allowedSteps = new Set(['routing', 'embedding', 'retrieval', 'generation', 'grounding']);
  const steps = value.steps.slice(0, 5).filter((step) => step && allowedSteps.has(step.key)).map((step) => ({
    key: step.key,
    status: step.status === 'done' ? 'done' : 'skipped',
    durationMs: Number.isFinite(Number(step.durationMs)) ? Math.max(0, Number(step.durationMs)) : null,
    dimensions: step.key === 'embedding' && Number(step.dimensions) === 1536 ? 1536 : null,
  }));
  const retrieval = value.retrieval.slice(0, 5).filter((item) => item && Number.isFinite(Number(item.score))).map((item, index) => ({
    rank: index + 1,
    source: typeof item.source === 'string' ? item.source.slice(0, 500) : 'Documento',
    chunkIndex: Number.isInteger(Number(item.chunkIndex)) ? Number(item.chunkIndex) : null,
    score: Math.max(-1, Math.min(1, Number(item.score))),
    cited: item.cited === true,
  }));
  return {
    version: 1,
    route: typeof value.route === 'string' ? value.route : 'documents',
    totalMs: Number.isFinite(Number(value.totalMs)) ? Math.max(0, Number(value.totalMs)) : null,
    steps,
    retrieval,
  };
}
function mountVectorScene(canvas, candidates) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const vectors = candidates.map((item, index) => {
    const radial = Math.sqrt(Math.max(0, 1 - item.score ** 2));
    const azimuth = index * Math.PI * (3 - Math.sqrt(5));
    return { ...item, vector: [item.score, radial * Math.cos(azimuth), radial * Math.sin(azimuth)] };
  });
  let yaw = -0.35;
  let pitch = 0.28;
  let zoom = 1;
  let drag = null;
  let animationFrame = 0;
  const rotate = ([x, y, z]) => {
    const x1 = x * Math.cos(yaw) + z * Math.sin(yaw);
    const z1 = -x * Math.sin(yaw) + z * Math.cos(yaw);
    return [x1, y * Math.cos(pitch) - z1 * Math.sin(pitch), y * Math.sin(pitch) + z1 * Math.cos(pitch)];
  };
  function draw(progress = 1) {
    const width = Math.max(280, canvas.clientWidth || 600);
    const height = Math.max(260, canvas.clientHeight || 330);
    const ratio = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
      canvas.width = width * ratio;
      canvas.height = height * ratio;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const origin = [width * .45, height * .54];
    const scale = Math.min(width * .31, height * .39) * zoom;
    const project = (point) => {
      const [x, y, z] = rotate(point);
      const perspective = 1 / (1.8 - z * .28);
      return [origin[0] + x * scale * perspective, origin[1] - y * scale * perspective, z];
    };
    const line = (from, to, color, lineWidth = 1, dash = []) => {
      const a = project(from); const b = project(to);
      context.beginPath(); context.moveTo(a[0], a[1]); context.lineTo(b[0], b[1]);
      context.strokeStyle = color; context.lineWidth = lineWidth; context.setLineDash(dash); context.stroke();
      context.setLineDash([]);
    };
    context.fillStyle = '#0f1117';
    context.fillRect(0, 0, width, height);
    const glow = context.createRadialGradient(origin[0], origin[1], 0, origin[0], origin[1], scale * 1.15);
    glow.addColorStop(0, '#78a7ff12'); glow.addColorStop(1, '#78a7ff00');
    context.fillStyle = glow; context.fillRect(0, 0, width, height);
    line([-1, 0, 0], [1.18, 0, 0], '#ffffff18');
    line([0, -1, 0], [0, 1, 0], '#ffffff12');
    line([0, 0, -1], [0, 0, 1], '#ffffff12');
    const query = [1.05 * progress, 0, 0];
    line([0, 0, 0], query, '#78a7ff', 3);
    const queryEnd = project(query);
    context.fillStyle = '#a9c6ff'; context.beginPath(); context.arc(queryEnd[0], queryEnd[1], 5, 0, Math.PI * 2); context.fill();
    context.font = '600 11px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
    context.fillText('CONSULTA', queryEnd[0] + 9, queryEnd[1] - 8);
    vectors.forEach((item, index) => {
      const vector = item.vector.map((coordinate) => coordinate * progress);
      const color = item.cited ? '#8fd8b2' : '#8793a8';
      line([0, 0, 0], vector, color, item.cited ? 2.5 : 1.5);
      const angle = Math.acos(item.score);
      const perpendicular = [0, item.vector[1], item.vector[2]];
      const length = Math.hypot(perpendicular[1], perpendicular[2]) || 1;
      const unit = [0, perpendicular[1] / length, perpendicular[2] / length];
      context.beginPath();
      for (let sample = 0; sample <= 18; sample++) {
        const part = angle * sample / 18;
        const point = [Math.cos(part) * .34, Math.sin(part) * unit[1] * .34, Math.sin(part) * unit[2] * .34];
        const projected = project(point);
        if (!sample) context.moveTo(projected[0], projected[1]); else context.lineTo(projected[0], projected[1]);
      }
      context.strokeStyle = `${color}99`; context.lineWidth = 1; context.stroke();
      const endpoint = project(vector);
      context.fillStyle = color; context.beginPath(); context.arc(endpoint[0], endpoint[1], item.cited ? 5 : 4, 0, Math.PI * 2); context.fill();
      context.fillStyle = item.cited ? '#c9f4dc' : '#bdc5d2';
      context.font = '600 11px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
      context.fillText(`F${index + 1}`, endpoint[0] + 7, endpoint[1] - 6);
    });
    const center = project([0, 0, 0]);
    context.fillStyle = '#eef3ff'; context.beginPath(); context.arc(center[0], center[1], 4, 0, Math.PI * 2); context.fill();
  }
  function animate(start) {
    const progress = reduceMotion ? 1 : Math.min(1, (performance.now() - start) / 520);
    draw(1 - (1 - progress) ** 3);
    if (progress < 1) animationFrame = requestAnimationFrame(() => animate(start));
  }
  const redraw = () => { cancelAnimationFrame(animationFrame); draw(); };
  canvas.addEventListener('pointerdown', (event) => { drag = [event.clientX, event.clientY]; canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener('pointermove', (event) => {
    if (!drag) return;
    yaw += (event.clientX - drag[0]) * .009; pitch = Math.max(-1.2, Math.min(1.2, pitch + (event.clientY - drag[1]) * .009));
    drag = [event.clientX, event.clientY]; redraw();
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('pointercancel', () => { drag = null; });
  canvas.addEventListener('wheel', (event) => { event.preventDefault(); zoom = Math.max(.7, Math.min(1.45, zoom - event.deltaY * .001)); redraw(); }, { passive: false });
  canvas.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', '='].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'ArrowLeft') yaw -= .12;
    if (event.key === 'ArrowRight') yaw += .12;
    if (event.key === 'ArrowUp') pitch -= .12;
    if (event.key === 'ArrowDown') pitch += .12;
    if (event.key === '+' || event.key === '=') zoom = Math.min(1.45, zoom + .1);
    if (event.key === '-') zoom = Math.max(.7, zoom - .1);
    redraw();
  });
  animate(performance.now());
}
function renderRagTrace(trace) {
  const details = el('details', 'rag-trace');
  const summary = el('summary');
  summary.append(el('span', 'rag-trace__symbol', '3D'), el('span', '', 'Explorar cómo razonó el RAG'));
  if (trace.totalMs !== null) summary.append(el('small', '', `${trace.totalMs.toLocaleString('es-PE')} ms`));
  details.append(summary);
  const content = el('div', 'rag-trace__content');
  const labels = { routing: 'Interpretar mensaje', embedding: 'Crear embedding', retrieval: 'Buscar fragmentos', generation: 'Generar respuesta', grounding: 'Validar citas' };
  const timeline = el('ol', 'rag-timeline');
  trace.steps.forEach((step) => {
    const item = el('li', `rag-step rag-step--${step.status}`);
    item.append(el('span', 'rag-step__dot'), el('strong', '', labels[step.key] || step.key));
    const detail = step.status === 'done'
      ? `${step.durationMs === null ? 'Completado' : `${Math.round(step.durationMs)} ms`}${step.dimensions ? ` · ${step.dimensions} dimensiones` : ''}`
      : 'No fue necesario';
    item.append(el('small', '', detail)); timeline.append(item);
  });
  content.append(timeline);
  if (trace.retrieval.length) {
    const visual = el('section', 'vector-lab');
    const heading = el('div', 'vector-lab__heading');
    heading.append(el('div', '', 'Espacio vectorial angular'), el('small', '', 'Arrastra para rotar · Rueda para acercar'));
    const canvas = el('canvas', 'vector-canvas');
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Representación tridimensional de la consulta y los cinco fragmentos recuperados. Usa las flechas para rotar y más o menos para acercar.');
    const legend = el('div', 'vector-legend');
    legend.append(el('span', 'vector-legend__query', 'Consulta'), el('span', 'vector-legend__cited', 'Fragmento citado'), el('span', 'vector-legend__candidate', 'Candidato'));
    const candidates = el('ol', 'vector-candidates');
    trace.retrieval.forEach((item) => {
      const angle = Math.acos(item.score) * 180 / Math.PI;
      const row = el('li', item.cited ? 'is-cited' : '');
      row.append(el('span', 'vector-rank', `F${item.rank}`));
      const description = el('span', 'vector-description');
      description.append(el('strong', '', item.source), el('small', '', `Fragmento ${item.chunkIndex === null ? '—' : item.chunkIndex + 1}${item.cited ? ' · utilizado en la respuesta' : ''}`));
      row.append(description, el('code', '', `cos ${item.score.toFixed(3)}`), el('span', 'vector-angle', `${angle.toFixed(1)}°`));
      candidates.append(row);
    });
    const note = el('p', 'vector-note', 'Proyección didáctica: cada ángulo respecto a la consulta es real. La separación alrededor del eje solo permite distinguir vectores; no reproduce literalmente las 1536 dimensiones ni representa un porcentaje de certeza.');
    visual.append(heading, canvas, legend, candidates, note);
    content.append(visual);
    let mounted = false;
    details.addEventListener('toggle', () => {
      if (details.open && !mounted) { mounted = true; requestAnimationFrame(() => mountVectorScene(canvas, trace.retrieval)); }
    });
  } else {
    content.append(el('p', 'vector-note', trace.route === 'documents'
      ? 'La búsqueda no recuperó fragmentos para representar.'
      : 'Este mensaje se resolvió como conversación; no fue necesario crear embeddings ni consultar el espacio vectorial.'));
  }
  details.append(content);
  return details;
}
function renderMessage(message) {
  const article = el('article', `message message--${message.role}`);
  const avatar = el('div', 'message__avatar', message.role === 'assistant' ? '' : 'TÚ');
  if (message.role === 'assistant') avatar.append($('.brand__mark svg').cloneNode(true));
  avatar.setAttribute('aria-hidden', 'true');
  const body = el('div', 'message__body');
  body.append(el('strong', '', message.role === 'assistant' ? 'TRAZAI' : 'Tú'));
  const text = el('p', 'message__text', message.text);
  body.append(text);
  if (message.status === 'loading') {
    article.classList.add('message--loading');
    text.textContent = 'Interpretando tu mensaje…';
    text.setAttribute('role', 'status');
  }
  if (message.status === 'error' || message.status === 'cancelled') {
    article.classList.add('message--error');
    const retry = el('button', 'text-button', 'Reintentar');
    retry.type = 'button';
    retry.disabled = busy;
    retry.addEventListener('click', () => ask(message.question, message));
    body.append(retry);
  }
  if (message.role === 'assistant' && message.status === 'done') {
    const sources = Array.isArray(message.sources) ? message.sources : [];
    const conversational = ['conversation', 'help', 'clarification'].includes(message.kind);
    if (!conversational) {
      body.append(el('div', 'message__meta', sources.length ? `${sources.length} ${sources.length === 1 ? 'fragmento citado' : 'fragmentos citados'}` : 'No se encontró información en los documentos'));
    }
    if (sources.length) {
      const details = el('details', 'source-list');
      details.append(el('summary', '', 'Ver fuentes y citas'));
      for (const source of sources) {
        const card = el('div', 'source-card');
        card.append(el('strong', '', typeof source.source === 'string' ? source.source : 'Documento'));
        const score = Number(source.score);
        const chunk = Number(source.chunkIndex);
        card.append(el('small', '', `Fragmento ${Number.isFinite(chunk) ? chunk + 1 : '—'} · Similitud coseno: ${Number.isFinite(score) ? score.toFixed(3) : '—'}`));
        for (const quote of Array.isArray(source.quotes) ? source.quotes : []) {
          if (typeof quote === 'string') card.append(el('blockquote', '', quote));
        }
        details.append(card);
      }
      body.append(details);
    }
    const trace = normalizeTrace(message.trace);
    if (trace) body.append(renderRagTrace(trace));
  }
  article.append(avatar, body);
  return article;
}
function render() {
  const chat = currentChat();
  $('#conversationTitle').textContent = chat?.title || 'Tu espacio de conocimiento';
  $('#conversationTitle').title = chat?.title || 'Tu espacio de conocimiento';
  welcome.hidden = Boolean(chat?.messages.length);
  messages.hidden = !chat?.messages.length;
  messages.replaceChildren(...(chat?.messages || []).map(renderMessage));
  renderHistory();
  $('#sourcesButton').disabled = !chat?.messages.some((m) => m.sources?.length);
  setBusy(busy, Boolean(activeRequest));
  scrollDown();
}
const errorMessage = (data) => ({
  GEMINI_QUOTA_EXCEEDED: 'La cuota de Gemini está agotada. Espera a que se restablezca para volver a preguntar.',
  GEMINI_API_KEY_NOT_CONFIGURED: 'Falta configurar la clave de Gemini en InsForge. Ejecuta scripts/configure-gemini.ps1.',
  GEMINI_MODEL_UNAVAILABLE: 'El modelo de Gemini ya no está disponible. Es necesario actualizar la configuración del servicio.',
  GEMINI_UNAVAILABLE: 'Gemini no tiene capacidad disponible en este momento. Inténtalo nuevamente más tarde.',
  GEMINI_TIMEOUT: 'Gemini tardó demasiado en responder. Inténtalo nuevamente en unos segundos.',
  GATEWAY_TIMEOUT: 'La consulta superó el tiempo disponible. Inténtalo nuevamente en unos segundos.',
  LOCAL_NOT_CONFIGURED: 'Inicia la interfaz con scripts/start-ui.ps1 para conectar con tus documentos.',
  UNAUTHORIZED: 'La conexión con InsForge necesita actualizarse. Reinicia el servidor con scripts/start-ui.ps1.',
}[data?.code] || (typeof data?.error === 'string' ? data.error : 'No se pudo completar la solicitud. Inténtalo de nuevo.'));

async function api(action, body, signal) {
  let response;
  try {
    response = await fetch(`/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    const connectionError = new Error('No se pudo conectar. Comprueba que el servidor local esté ejecutándose.');
    connectionError.code = 'CONNECTION_ERROR';
    throw connectionError;
  }
  let data;
  try { data = await response.json(); }
  catch { throw new Error('Inicia la interfaz con scripts/start-ui.ps1; el servidor actual no ofrece la conexión al chat.'); }
  if (!response.ok) {
    const requestError = new Error(errorMessage(data));
    requestError.code = data?.code;
    requestError.status = response.status;
    throw requestError;
  }
  return data;
}
async function ask(question, retryMessage = null) {
  if (busy || typeof question !== 'string' || !question.trim()) return;
  if (question.length > 4000) { announce('La pregunta puede tener hasta 4000 caracteres.'); return; }
  let chat = currentChat();
  if (!chat) {
    chat = { id: crypto.randomUUID(), title: question.slice(0, 65), messages: [] };
    chats.unshift(chat);
    chats = chats.slice(0, 30);
    activeId = chat.id;
  }
  if (!retryMessage) chat.messages.push({ role: 'user', text: question });
  const answer = retryMessage || { role: 'assistant', text: '', question };
  answer.status = 'loading';
  answer.sources = [];
  if (!retryMessage) chat.messages.push(answer);
  const controller = new AbortController();
  activeRequest = controller;
  setBusy(true, true);
  input.value = '';
  announce(''); render(); save();
  const timeout = setTimeout(() => controller.abort(), 100_000);
  try {
    const data = await api('ask', { question }, controller.signal);
    if (typeof data.answer !== 'string' || !Array.isArray(data.sources)) throw new Error('El servicio devolvió una respuesta incompleta.');
    answer.text = data.answer;
    answer.sources = data.sources;
    answer.kind = typeof data.kind === 'string' ? data.kind : undefined;
    answer.trace = normalizeTrace(data.trace);
    answer.status = 'done';
  } catch (error) {
    answer.status = controller.signal.aborted ? 'cancelled' : 'error';
    answer.text = controller.signal.aborted ? 'Solicitud detenida. Puedes reintentar tu pregunta.' : error.message;
  } finally {
    clearTimeout(timeout);
    activeRequest = null;
    setBusy(false);
    save(); render();
    input.focus();
  }
}

$('#menuButton').addEventListener('click', () => {
  sidebar.classList.add('is-open'); scrim.classList.add('is-visible');
  $('#menuButton').setAttribute('aria-expanded', 'true');
});
$('#sidebarClose').addEventListener('click', closeSidebar);
scrim.addEventListener('click', closeSidebar);
function newChat() {
  if (busy) return;
  activeId = null; input.value = ''; announce(''); save(); render(); closeSidebar(); input.focus();
}
$('#newChat').addEventListener('click', newChat);
$('.brand').addEventListener('click', (event) => { event.preventDefault(); newChat(); });
input.addEventListener('input', resizeInput);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault(); $('#composer').requestSubmit();
  }
});
$('#composer').addEventListener('submit', (event) => { event.preventDefault(); ask(input.value.trim()); });
$('#stopButton').addEventListener('click', () => activeRequest?.abort());
document.querySelectorAll('.suggestion').forEach((button) => button.addEventListener('click', () => {
  input.value = button.dataset.prompt; resizeInput(); input.focus();
}));
$('#sourcesButton').addEventListener('click', () => {
  const details = [...messages.querySelectorAll('.source-list')].at(-1);
  if (details) { details.open = true; details.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
});
$('#deleteChat').addEventListener('click', () => {
  if (busy || !currentChat()) return;
  if (!window.confirm('¿Eliminar esta conversación del historial de este navegador? Tus documentos seguirán disponibles.')) return;
  chats = chats.filter((chat) => chat.id !== activeId); activeId = null; save(); render();
});
$('#exportChat').addEventListener('click', () => {
  const chat = currentChat();
  if (!chat) return;
  const text = chat.messages.map((m) => `${m.role === 'user' ? 'Tú' : 'TRAZAI'}: ${m.text}\n${(m.sources || []).map((s) => `Fuente: ${s.source}\n${(s.quotes || []).join('\n')}`).join('\n')}`).join('\n\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = el('a'); link.href = url; link.download = 'trazai-conversacion.txt'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function openIngestionDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(INGESTION_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('jobs', { keyPath: 'fileHash' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('No se pudo abrir el almacenamiento local de ingestas.'));
  });
}
async function jobStore(mode, value) {
  const db = await openIngestionDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('jobs', mode === 'all' ? 'readonly' : 'readwrite');
      const store = tx.objectStore('jobs');
      const request = mode === 'put' ? store.put(value) : mode === 'delete' ? store.delete(value) : store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('No se pudo guardar el progreso local.'));
    });
  } finally { db.close(); }
}
const putJob = (job) => jobStore('put', job);
const deleteJob = (hash) => jobStore('delete', hash);
const allJobs = () => jobStore('all');
function bytesLabel(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}
function splitBlocks(text, target) {
  const blocks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + target, text.length);
    if (end < text.length) {
      const floor = Math.max(start + Math.floor(target * .96), start + 1);
      let boundary = text.lastIndexOf('\n', end);
      if (boundary < floor) boundary = text.lastIndexOf(' ', end);
      if (boundary >= floor) end = boundary + 1;
      if (/^[\uDC00-\uDFFF]$/.test(text[end])) end--;
    }
    const block = text.slice(start, end);
    if (block.trim()) blocks.push(block);
    start = end;
  }
  return blocks;
}
function chunkCount(text) {
  const chars = Array.from(text.trim());
  let count = 0;
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + 2000, chars.length);
    if (end < chars.length) {
      for (let boundary = end; boundary > start + 1600; boundary--) {
        if (/\s/u.test(chars[boundary])) { end = boundary; break; }
      }
    }
    if (chars.slice(start, end).join('').trim()) count++;
    if (end === chars.length) break;
    start = end - 320;
  }
  return count;
}
async function hashBytes(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function showJob(job, completedBlocks = job.completedBlocks || 0, totalChunks = job.totalChunks || 0, current = null) {
  setIngestionState(job.status);
  $('#documentPercent').textContent = `${Math.round(completedBlocks / Math.max(1, job.totalBlocks) * 100)}%`;
  $('#ingestionProgress').hidden = false;
  $('#documentProgress').max = job.totalBlocks;
  $('#documentProgress').value = completedBlocks;
  $('#documentProgressTitle').textContent = job.source;
  $('#documentProgressDetail').textContent = current === null
    ? `${completedBlocks} de ${job.totalBlocks} bloques · ${totalChunks.toLocaleString('es-PE')} de ${job.expectedChunks.toLocaleString('es-PE')} fragmentos`
    : `Procesando bloque ${current + 1} de ${job.totalBlocks} · ${totalChunks.toLocaleString('es-PE')} de ${job.expectedChunks.toLocaleString('es-PE')} fragmentos generados`;
}
function setIngestionState(status) {
  const labels = { queued: 'Preparado', processing: 'Procesando', paused: 'En pausa', failed: 'Requiere atención', ready: 'Listo para consultar' };
  $('#ingestionState').textContent = labels[status] || 'Preparado';
  $('#ingestionProgress').dataset.state = status;
}
async function retryBlock(body, signal) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await api('ingest/block', body, signal); }
    catch (error) {
      lastError = error;
      if (signal.aborted || [400, 401, 404, 409, 413, 429].includes(error.status) || attempt === 3) throw error;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, attempt * 1000);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      });
    }
  }
  throw lastError;
}
async function processJob(job) {
  if (busy) return;
  selectedJob = job;
  job.status = 'processing';
  job.updatedAt = Date.now();
  await putJob(job);
  const controller = new AbortController();
  ingestionRequest = controller;
  setBusy(true);
  $('#documentPause').hidden = false;
  $('#documentPause').disabled = false;
  $('#documentSubmit').disabled = true;
  $('#documentFile').disabled = true;
  $('#documentSource').disabled = true;
  $('#closeDocument').disabled = true;
  showJob(job);
  $('#documentStatus').textContent = 'Preparando la ingesta reanudable…';
  try {
    const blocks = splitBlocks(job.text, appConfig.blockCharacters);
    if (blocks.length !== job.totalBlocks) throw new Error('El contenido local ya no coincide con la planificación guardada.');
    const started = await api('ingest/start', {
      source: job.source, fileHash: job.fileHash, fileSizeBytes: job.fileSizeBytes,
      totalBlocks: job.totalBlocks, expectedChunks: job.expectedChunks,
    }, controller.signal);
    if (!started?.document?.id) throw new Error('El servidor no devolvió el documento de ingesta.');
    job.documentId = started.document.id;
    job.completedBlockIndexes = started.document.completeBlockIndexes || [];
    job.completedBlocks = started.document.completedBlocks || 0;
    job.totalChunks = started.document.totalChunks || 0;
    await putJob(job);
    if (started.document.status === 'ready') {
      job.status = 'ready';
      $('#documentStatus').textContent = `«${job.source}» ya estaba procesado. No se generaron duplicados.`;
      showJob(job, job.totalBlocks, started.document.totalChunks);
      await deleteJob(job.fileHash);
      selectedJob = null;
      return;
    }
    const complete = new Set(job.completedBlockIndexes);
    for (let index = 0; index < blocks.length; index++) {
      if (complete.has(index)) continue;
      showJob(job, complete.size, job.totalChunks, index);
      $('#documentStatus').textContent = `Procesando bloque ${index + 1} de ${blocks.length}…`;
      const result = await retryBlock({
        documentId: job.documentId, fileHash: job.fileHash, blockIndex: index,
        blockHash: await hashBytes(blocks[index]), text: blocks[index],
      }, controller.signal);
      complete.add(index);
      job.completedBlockIndexes = [...complete].sort((a, b) => a - b);
      job.completedBlocks = result.completedBlocks;
      job.totalChunks = result.totalChunks;
      job.updatedAt = Date.now();
      await putJob(job);
      showJob(job, result.completedBlocks, result.totalChunks);
    }
    const completed = await api('ingest/complete', { documentId: job.documentId, fileHash: job.fileHash }, controller.signal);
    job.status = 'ready';
    showJob(job, completed.completedBlocks, completed.totalChunks);
    $('#documentStatus').textContent = `«${job.source}» está listo: ${completed.totalChunks.toLocaleString('es-PE')} fragmentos generados.`;
    announce(`Documento listo: ${job.source}.`);
    await deleteJob(job.fileHash);
    selectedJob = null;
  } catch (error) {
    const paused = controller.signal.aborted;
    job.status = paused ? 'paused' : 'failed';
    setIngestionState(job.status);
    job.lastError = paused ? null : error.message;
    job.updatedAt = Date.now();
    await putJob(job).catch(() => {});
    $('#documentStatus').textContent = paused
      ? 'Procesamiento pausado. Puedes reanudarlo desde el último bloque confirmado.'
      : `${error.message} Pulsa Reintentar para continuar desde el último bloque confirmado.`;
    $('#documentSubmit').textContent = paused ? 'Reanudar' : 'Reintentar';
    $('#documentSubmit').disabled = false;
  } finally {
    ingestionRequest = null;
    $('#documentPause').hidden = true;
    $('#documentFile').disabled = Boolean(selectedJob);
    $('#documentSource').disabled = false;
    $('#closeDocument').disabled = false;
    setBusy(false);
  }
}

function openDocument() {
  if (busy) return;
  closeSidebar();
  if (selectedJob) {
    $('#documentSource').value = selectedJob.source;
    showJob(selectedJob);
    $('#documentSubmit').textContent = selectedJob.status === 'failed' ? 'Reintentar' : 'Reanudar';
    $('#documentSubmit').disabled = false;
  } else {
    $('#documentFile').value = '';
    $('#documentSource').value = '';
    $('#documentSubmit').textContent = 'Procesar documento';
    $('#documentSubmit').disabled = true;
    $('#documentStatus').textContent = `Selecciona un TXT UTF-8 de hasta ${bytesLabel(appConfig.maxTxtBytes)}.`;
    $('#ingestionProgress').hidden = true;
  }
  dialog.showModal();
}
$('#attachButton').addEventListener('click', openDocument);
document.querySelectorAll('[data-open-document]').forEach((button) => button.addEventListener('click', openDocument));
$('#closeDocument').addEventListener('click', () => { if (!busy) dialog.close(); });
dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
$('#documentPause').addEventListener('click', () => ingestionRequest?.abort());
$('#documentFile').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  $('#documentSubmit').disabled = true;
  $('#documentStatus').textContent = 'Leyendo y calculando el hash SHA-256…';
  if (!/\.txt$/i.test(file.name) || file.size < 1 || file.size > appConfig.maxTxtBytes) {
    $('#documentStatus').textContent = `Elige un archivo .txt de hasta ${bytesLabel(appConfig.maxTxtBytes)}.`;
    event.target.value = ''; return;
  }
  try {
    const buffer = await file.arrayBuffer();
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { throw new Error('El archivo no contiene texto UTF-8 válido.'); }
    text = text.replace(/^\uFEFF/, '').trim();
    if (!text || text.includes('\u0000')) throw new Error('El TXT está vacío o contiene datos binarios.');
    const blocks = splitBlocks(text, appConfig.blockCharacters);
    const expectedChunks = blocks.reduce((sum, block) => sum + chunkCount(block), 0);
    const job = {
      fileHash: await hashBytes(buffer), source: file.name.slice(0, 500), fileSizeBytes: file.size,
      text, totalBlocks: blocks.length, expectedChunks, completedBlocks: 0, totalChunks: 0,
      completedBlockIndexes: [], status: 'queued', createdAt: Date.now(), updatedAt: Date.now(),
    };
    await putJob(job);
    selectedJob = job;
    $('#documentFile').disabled = true;
    $('#documentSource').value = job.source;
    $('#documentSubmit').textContent = 'Procesar documento';
    $('#documentSubmit').disabled = false;
    showJob(job);
    $('#documentStatus').textContent = `${bytesLabel(file.size)} · ${blocks.length} bloques · ${expectedChunks.toLocaleString('es-PE')} fragmentos previstos.`;
  } catch (error) {
    $('#documentStatus').textContent = error.message;
    event.target.value = '';
  }
});
$('#documentSource').addEventListener('input', () => {
  if (selectedJob && !busy) {
    selectedJob.source = $('#documentSource').value.trim().slice(0, 500);
    $('#documentSubmit').disabled = !selectedJob.source;
  }
});
$('#documentForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !selectedJob) return;
  const source = $('#documentSource').value.trim();
  if (!source) { $('#documentStatus').textContent = 'Indica un nombre para la fuente.'; return; }
  selectedJob.source = source.slice(0, 500);
  await putJob(selectedJob);
  await processJob(selectedJob);
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !dialog.open) {
    event.preventDefault(); newChat();
  }
  if (event.key === 'Escape') closeSidebar();
});
window.addEventListener('resize', () => { if (window.innerWidth > 820) closeSidebar(); });

restore(); render();
async function restorePendingIngestion() {
  const jobs = (await allJobs()).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!jobs.length) return;
  selectedJob = jobs[0];
  $('#documentSource').value = selectedJob.source;
  $('#documentFile').disabled = true;
  showJob(selectedJob);
  dialog.showModal();
  if (selectedJob.status === 'processing') {
    $('#documentStatus').textContent = 'Reanudando desde el último bloque confirmado…';
    await processJob(selectedJob);
    return;
  }
  $('#documentSubmit').textContent = selectedJob.status === 'failed' ? 'Reintentar' : 'Reanudar';
  $('#documentSubmit').disabled = false;
  $('#documentStatus').textContent = selectedJob.status === 'failed'
    ? `${selectedJob.lastError || 'La ingesta se interrumpió.'} Pulsa Reintentar para continuar.`
    : 'El documento está guardado localmente. Pulsa Reanudar para continuar.';
}

fetch('/api/health').then((response) => response.json()).then(async (data) => {
  if (!data.configured) throw new Error();
  appConfig.maxTxtBytes = Number(data.maxTxtBytes) || appConfig.maxTxtBytes;
  appConfig.blockCharacters = Number(data.blockCharacters) || appConfig.blockCharacters;
  $('#documentLimit').textContent = `Hasta ${bytesLabel(appConfig.maxTxtBytes)}`;
  $('#connectionStatus').textContent = 'Conexión lista';
  $('#connectionStatus').classList.add('is-connected');
  await restorePendingIngestion();
}).catch(() => {
  $('#documentLimit').textContent = 'Límite no disponible sin conexión';
  $('#connectionStatus').textContent = 'Sin conexión';
  announce('Para conectar el chat, inicia el proyecto con scripts/start-ui.ps1.');
});
