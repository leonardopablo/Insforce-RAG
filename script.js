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
