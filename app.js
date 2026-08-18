const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const MODULOS = ["Comercial","Cobranza","Comunes","Contabilidad","Control de Proyectos","CRM/Contactos","Factura Electronica","Factura Electronica Peru","Activo Fijo","Punto de Venta","Tesoreria","Otro"];
const IMG_BUCKET = "incidentes-imagenes";
const MAX_IMAGENES = 3;
const MAX_IMG_BYTES = 95 * 1024; // tope objetivo por imagen: 95 KB (el bucket tiene limite de 100 KB)
const QUALITY_STEPS = [0.82, 0.7, 0.6, 0.5, 0.4, 0.3, 0.22, 0.15, 0.1]; // si sigue pesando mucho, baja calidad (nunca la resolucion)

const root = document.getElementById("app-root");

let state = {
  session: null,
  items: [],
  loading: true,
  showForm: false,
  form: emptyForm(),
  pendingImages: [],
  search: "",
  moduloFilter: "Todos",
  expandedId: null,
  collapsedModulos: {},
  errorMsg: "",
  loginError: "",
};

function emptyForm() {
  return { id: null, fecha: new Date().toISOString().slice(0,10), modulo: MODULOS[0], sintoma: "", causa_raiz: "", tablas_scripts: "", solucion: "", cliente: "", autor: "", tags: "", notas: "", imagenes: [] };
}

// ---------- Compresion de imagenes (mismo ancho/alto siempre, menor peso) ----------
function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) { reject(new Error("No se pudo comprimir la imagen")); return; }
      resolve(blob);
    }, "image/webp", quality);
  });
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => { img.src = e.target.result; };
    reader.onerror = reject;
    img.onload = () => resolve(img);
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Comprime probando escalones de calidad de mayor a menor hasta bajar de MAX_IMG_BYTES.
// La resolucion (ancho/alto) nunca cambia, solo la calidad de compresion WebP.
async function compressImage(file) {
  const img = await loadImageElement(file);
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, img.width, img.height);

  let lastBlob = null;
  for (const quality of QUALITY_STEPS) {
    const blob = await canvasToBlob(canvas, quality);
    lastBlob = blob;
    if (blob.size <= MAX_IMG_BYTES) return blob;
  }
  // Si ni con la calidad minima baja del tope, se sube la mejor version lograda
  // (esto solo pasaria con capturas inusualmente grandes o muy detalladas).
  return lastBlob;
}

async function uploadImages(files) {
  const urls = [];
  for (const file of files) {
    const blob = await compressImage(file);
    if (blob.size > 100 * 1024) {
      throw new Error(`La imagen "${file.name}" sigue pesando mas de 100 KB incluso comprimida al maximo. Prueba con una captura mas pequena o recortada.`);
    }
    const path = `${state.session.user.id}/${Date.now()}-${Math.random().toString(36).slice(2)}.webp`;
    const { error } = await supabaseClient.storage.from(IMG_BUCKET).upload(path, blob, { contentType: "image/webp" });
    if (error) throw error;
    const { data } = supabaseClient.storage.from(IMG_BUCKET).getPublicUrl(path);
    urls.push(data.publicUrl);
  }
  return urls;
}

// ---------- Carga de datos ----------
async function loadData(silent) {
  if (!silent) { state.loading = true; render(); }
  const { data, error } = await supabaseClient.from("incidentes").select("*").order("fecha", { ascending: false });
  if (!error) state.items = data;
  state.loading = false;
  render();
}

let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (!state.showForm) loadData(true);
  }, 15000);
}

// ---------- Autenticacion ----------
async function handleLogin(email, password) {
  state.loginError = "";
  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) { state.loginError = "Correo o contrasena incorrectos."; render(); return; }
}

async function handleLogout() {
  await supabaseClient.auth.signOut();
}

supabaseClient.auth.onAuthStateChange((_event, session) => {
  state.session = session;
  if (session) { loadData(); startPolling(); }
  else render();
});

// ---------- Guardar / eliminar ----------
function validateForm() {
  if (!state.form.sintoma.trim()) return "Describe el sintoma o error reportado.";
  if (!state.form.solucion.trim()) return "Describe la solucion aplicada.";
  if (!state.form.modulo) return "Selecciona un modulo.";
  return "";
}

async function handleSave() {
  const v = validateForm();
  if (v) { state.errorMsg = v; render(); return; }
  state.errorMsg = "";
  try {
    let nuevasImagenes = state.form.imagenes || [];
    if (state.pendingImages.length) {
      const subidas = await uploadImages(state.pendingImages);
      nuevasImagenes = nuevasImagenes.concat(subidas);
    }
    const payload = { ...state.form, imagenes: nuevasImagenes };
    delete payload.id;
    if (state.form.id) {
      const { error } = await supabaseClient.from("incidentes").update(payload).eq("id", state.form.id);
      if (error) throw error;
    } else {
      const { error } = await supabaseClient.from("incidentes").insert(payload);
      if (error) throw error;
    }
    state.showForm = false;
    state.form = emptyForm();
    state.pendingImages = [];
    await loadData();
  } catch (err) {
    state.errorMsg = err && err.message ? err.message : "No se pudo guardar. Intenta de nuevo.";
    render();
  }
}

async function handleDelete(id) {
  await supabaseClient.from("incidentes").delete().eq("id", id);
  state.expandedId = null;
  await loadData();
}

function startEdit(item) {
  state.form = { ...item };
  state.pendingImages = [];
  state.showForm = true;
  state.expandedId = null;
  render();
}

// ---------- Render ----------
function getFiltered() {
  return state.items.filter(it => {
    if (state.moduloFilter !== "Todos" && it.modulo !== state.moduloFilter) return false;
    if (!state.search.trim()) return true;
    const q = state.search.toLowerCase();
    const haystack = [it.sintoma, it.causa_raiz, it.tablas_scripts, it.solucion, it.tags, it.cliente].join(" ").toLowerCase();
    return haystack.includes(q);
  });
}

function render() {
  if (!state.session) { renderLogin(); return; }
  const filtered = getFiltered();
  const grouped = groupByModulo(filtered);

  root.innerHTML = `
    <div class="top-bar">
      <div>
        <h2 style="margin:0;font-size:18px;color:#12275C;">Base de conocimiento - Incidentes Flexline</h2>
        <p class="hint" style="margin:2px 0 0;">Sesion: ${state.session.user.email}
          <a href="#" id="logout-link" style="color:#E12D26;margin-left:8px;">Cerrar sesion</a>
        </p>
      </div>
      <button class="btn" id="toggle-form-btn">${state.showForm ? "Cancelar" : "+ Nuevo registro"}</button>
    </div>

    <div class="search-bar">
      <input class="input" id="search-input" placeholder="Buscar por sintoma, tabla, solucion, tag..." value="${escapeAttr(state.search)}" />
      <select id="modulo-filter">
        <option value="Todos" ${state.moduloFilter === "Todos" ? "selected" : ""}>Todos los modulos</option>
        ${MODULOS.map(m => `<option value="${m}" ${state.moduloFilter === m ? "selected" : ""}>${m}</option>`).join("")}
      </select>
    </div>

    <div class="layout-cols">
      <div class="col-left">
        <div class="tree-controls">
          <button class="btn secondary" id="expand-all-btn">Expandir todo</button>
          <button class="btn secondary" id="collapse-all-btn">Contraer todo</button>
        </div>
        ${state.loading ? `<p class="hint">Cargando registros...</p>` : ""}
        ${!state.loading && filtered.length === 0 ? `<p class="hint">No hay registros que coincidan. Prueba con otro termino o crea uno nuevo.</p>` : ""}
        ${!state.loading ? renderTree(grouped) : ""}
      </div>
      <div class="col-right">
        ${state.showForm ? renderForm() : ""}
      </div>
    </div>
  `;
  attachHandlers();
}

function groupByModulo(items) {
  const grouped = {};
  for (const m of MODULOS) grouped[m] = [];
  for (const it of items) {
    if (!grouped[it.modulo]) grouped[it.modulo] = [];
    grouped[it.modulo].push(it);
  }
  return grouped;
}

function renderTree(grouped) {
  return MODULOS
    .filter(m => (grouped[m] || []).length > 0)
    .map(m => {
      const items = grouped[m];
      const collapsed = !!state.collapsedModulos[m];
      return `
        <div class="modulo-group">
          <div class="modulo-header" data-modulo="${escapeAttr(m)}">
            <span class="modulo-toggle">${collapsed ? "\u25B6" : "\u25BC"}</span>
            <span class="modulo-name">${m}</span>
            <span class="modulo-count">${items.length}</span>
          </div>
          ${!collapsed ? `<div class="modulo-items">${items.map(renderCard).join("")}</div>` : ""}
        </div>
      `;
    }).join("");
}

function renderForm() {
  const f = state.form;
  return `
    <div class="form-box">
      ${state.errorMsg ? `<div class="error-msg">${state.errorMsg}</div>` : ""}
      <div class="two-col field-row">
        <div><label class="label">Fecha</label><input class="input" type="date" id="f-fecha" value="${f.fecha}" /></div>
        <div><label class="label">Modulo</label>
          <select id="f-modulo">${MODULOS.map(m => `<option value="${m}" ${f.modulo === m ? "selected" : ""}>${m}</option>`).join("")}</select>
        </div>
      </div>
      <div class="field-row"><label class="label">Sintoma / error reportado por el cliente</label>
        <textarea id="f-sintoma">${escapeHtml(f.sintoma)}</textarea></div>
      <div class="field-row"><label class="label">Causa raiz</label>
        <textarea id="f-causa">${escapeHtml(f.causa_raiz || "")}</textarea></div>
      <div class="field-row"><label class="label">Tablas / scripts SQL involucrados</label>
        <input class="input" id="f-tablas" value="${escapeAttr(f.tablas_scripts || "")}" /></div>
      <div class="field-row"><label class="label">Solucion / correccion aplicada</label>
        <textarea id="f-solucion">${escapeHtml(f.solucion)}</textarea></div>
      <div class="two-col field-row">
        <div><label class="label">Cliente (opcional)</label><input class="input" id="f-cliente" value="${escapeAttr(f.cliente || "")}" /></div>
        <div><label class="label">Tecnico</label><input class="input" id="f-autor" value="${escapeAttr(f.autor || "")}" /></div>
      </div>
      <div class="field-row"><label class="label">Tags (separados por coma)</label>
        <input class="input" id="f-tags" value="${escapeAttr(f.tags || "")}" /></div>
      <div class="field-row"><label class="label">Notas adicionales (opcional)</label>
        <textarea id="f-notas">${escapeHtml(f.notas || "")}</textarea></div>
      <div class="field-row">
        <label class="label">Imagenes (maximo ${MAX_IMAGENES})</label>
        ${(f.imagenes || []).length ? `
          <div class="img-preview" id="existing-img-preview">
            ${f.imagenes.map((u, idx) => `
              <div class="img-thumb-wrap">
                <img src="${u}" />
                <button type="button" class="img-remove-btn" data-idx="${idx}" title="Quitar imagen">&times;</button>
              </div>
            `).join("")}
          </div>
        ` : ""}
        ${state.pendingImages.length ? `
          <div class="img-preview" id="pending-img-preview" style="margin-top:8px;">
            ${state.pendingImages.map((file, idx) => `
              <div class="img-thumb-wrap pending">
                <span class="pending-name">${escapeHtml(file.name)}</span>
                <button type="button" class="pending-remove-btn" data-idx="${idx}" title="Quitar">&times;</button>
              </div>
            `).join("")}
          </div>
        ` : ""}
        ${(() => {
          const total = (f.imagenes || []).length + state.pendingImages.length;
          if (total < MAX_IMAGENES) {
            return `
              <input type="file" id="f-imagenes" accept="image/*" style="margin-top:8px;" />
              <p class="hint" style="margin-top:4px;">Puedes agregar ${MAX_IMAGENES - total} imagen(es) mas, una por una si quieres.</p>
            `;
          }
          return `<p class="hint" style="margin-top:8px;">Ya alcanzaste el maximo de ${MAX_IMAGENES} imagenes. Quita alguna para poder agregar otra.</p>`;
        })()}
      </div>
      <button class="btn" id="save-btn">${f.id ? "Guardar cambios" : "Guardar registro"}</button>
    </div>
  `;
}

function renderCard(item) {
  const isOpen = state.expandedId === item.id;
  const sintomaShort = item.sintoma.length > 90 && !isOpen ? item.sintoma.slice(0,90) + "..." : item.sintoma;
  const puedeEliminar = !item.creado_por || item.creado_por === state.session.user.id;
  return `
    <div class="card" data-id="${item.id}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <span style="font-size:14px;font-weight:500;">${escapeHtml(sintomaShort)}</span>
        <span class="badge">${item.modulo}</span>
      </div>
      <div class="hint" style="margin-top:4px;">${item.fecha}${item.autor ? " - " + escapeHtml(item.autor) : ""}${item.cliente ? " - " + escapeHtml(item.cliente) : ""}</div>
      ${isOpen ? `
        <div class="card-detail">
          ${item.causa_raiz ? `<p style="margin:0 0 6px;"><b>Causa raiz:</b> ${escapeHtml(item.causa_raiz)}</p>` : ""}
          ${item.tablas_scripts ? `<p style="margin:0 0 6px;"><b>Tablas/scripts:</b> ${escapeHtml(item.tablas_scripts)}</p>` : ""}
          <p style="margin:0 0 6px;"><b>Solucion:</b> ${escapeHtml(item.solucion)}</p>
          ${item.tags ? `<p style="margin:0 0 6px;"><b>Tags:</b> ${escapeHtml(item.tags)}</p>` : ""}
          ${item.notas ? `<p style="margin:0 0 6px;"><b>Notas:</b> ${escapeHtml(item.notas)}</p>` : ""}
          ${(item.imagenes || []).length ? `<div class="img-preview">${item.imagenes.map(u => `<a href="${u}" target="_blank"><img src="${u}" /></a>`).join("")}</div>` : ""}
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button class="btn secondary edit-btn" data-id="${item.id}">Editar</button>
            ${puedeEliminar ? `<button class="btn danger delete-btn" data-id="${item.id}">Eliminar</button>` : ""}
          </div>
        </div>
      ` : ""}
    </div>
  `;
}

function renderLogin() {
  root.innerHTML = `
    <div class="login-box">
      <h2>Base de conocimiento - Incidentes Flexline</h2>
      ${state.loginError ? `<div class="error-msg">${state.loginError}</div>` : ""}
      <label class="label">Correo</label>
      <input class="input" id="login-email" type="email" style="margin-bottom:10px;" />
      <label class="label">Contrasena</label>
      <input class="input" id="login-password" type="password" style="margin-bottom:14px;" />
      <button class="btn" id="login-btn" style="width:100%;">Ingresar</button>
      <p class="hint" style="margin-top:10px;">Si no tienes cuenta, pide al administrador que te la cree en Supabase.</p>
    </div>
  `;
  document.getElementById("login-btn").onclick = () => {
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    handleLogin(email, password);
  };
}

function attachHandlers() {
  const logoutLink = document.getElementById("logout-link");
  if (logoutLink) logoutLink.onclick = (e) => { e.preventDefault(); handleLogout(); };

  const toggleBtn = document.getElementById("toggle-form-btn");
  if (toggleBtn) toggleBtn.onclick = () => {
    state.showForm = !state.showForm;
    if (state.showForm) { state.form = emptyForm(); state.pendingImages = []; }
    state.errorMsg = "";
    render();
  };

  const searchInput = document.getElementById("search-input");
  if (searchInput) searchInput.oninput = (e) => { state.search = e.target.value; render(); document.getElementById("search-input").focus(); document.getElementById("search-input").selectionStart = document.getElementById("search-input").value.length; };

  const moduloFilter = document.getElementById("modulo-filter");
  if (moduloFilter) moduloFilter.onchange = (e) => { state.moduloFilter = e.target.value; render(); };

  const expandAllBtn = document.getElementById("expand-all-btn");
  if (expandAllBtn) expandAllBtn.onclick = () => { state.collapsedModulos = {}; render(); };

  const collapseAllBtn = document.getElementById("collapse-all-btn");
  if (collapseAllBtn) collapseAllBtn.onclick = () => {
    const todos = {};
    MODULOS.forEach(m => { todos[m] = true; });
    state.collapsedModulos = todos;
    render();
  };

  root.querySelectorAll(".modulo-header").forEach(header => {
    header.onclick = () => {
      const m = header.dataset.modulo;
      state.collapsedModulos[m] = !state.collapsedModulos[m];
      render();
    };
  });

  // Form fields
  bindField("f-fecha", "fecha");
  bindField("f-modulo", "modulo");
  bindField("f-sintoma", "sintoma");
  bindField("f-causa", "causa_raiz");
  bindField("f-tablas", "tablas_scripts");
  bindField("f-solucion", "solucion");
  bindField("f-cliente", "cliente");
  bindField("f-autor", "autor");
  bindField("f-tags", "tags");
  bindField("f-notas", "notas");

  const imgInput = document.getElementById("f-imagenes");
  if (imgInput) imgInput.onchange = (e) => {
    const totalActual = (state.form.imagenes || []).length + state.pendingImages.length;
    const cupo = Math.max(MAX_IMAGENES - totalActual, 0);
    const nuevos = Array.from(e.target.files).slice(0, cupo);
    state.pendingImages = state.pendingImages.concat(nuevos);
    e.target.value = ""; // permite volver a elegir otra imagen despues sin recargar
    render();
  };

  root.querySelectorAll(".img-remove-btn").forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.idx);
      state.form.imagenes = state.form.imagenes.filter((_, i) => i !== idx);
      render();
    };
  });

  root.querySelectorAll(".pending-remove-btn").forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.idx);
      state.pendingImages = state.pendingImages.filter((_, i) => i !== idx);
      render();
    };
  });

  const saveBtn = document.getElementById("save-btn");
  if (saveBtn) saveBtn.onclick = handleSave;

  root.querySelectorAll(".card").forEach(card => {
    card.onclick = (e) => {
      if (e.target.closest(".edit-btn") || e.target.closest(".delete-btn")) return;
      const id = card.dataset.id;
      state.expandedId = state.expandedId === id ? null : id;
      render();
    };
  });
  root.querySelectorAll(".edit-btn").forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); const item = state.items.find(i => i.id === btn.dataset.id); startEdit(item); };
  });
  root.querySelectorAll(".delete-btn").forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); handleDelete(btn.dataset.id); };
  });
}

function bindField(elId, stateKey) {
  const el = document.getElementById(elId);
  if (el) el.oninput = (e) => { state.form[stateKey] = e.target.value; };
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

// ---------- Arranque ----------
(async function init() {
  const { data } = await supabaseClient.auth.getSession();
  state.session = data.session;
  if (state.session) { await loadData(); startPolling(); }
  else render();
})();
