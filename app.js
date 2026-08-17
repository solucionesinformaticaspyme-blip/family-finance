/**
 * ==========================================================================
 * LÓGICA DEL FRONTEND: SINGLE PAGE APPLICATION (SPA) - VANILLA JS
 * ==========================================================================
 */

// AUXILIARES DE ALMACENAMIENTO PERSISTENTE MULTI-CAPA (localStorage + sessionStorage + Cookie)
function setCookie(name, value, days) {
  try {
    const date = new Date();
    date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
    const expires = "; expires=" + date.toUTCString();
    document.cookie = name + "=" + (encodeURIComponent(value) || "") + expires + "; path=/; SameSite=Lax";
  } catch (e) {}
}

function getCookie(name) {
  try {
    const nameEQ = name + "=";
    const ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
      let c = ca[i];
      while (c.charAt(0) === ' ') c = c.substring(1, c.length);
      if (c.indexOf(nameEQ) === 0) return decodeURIComponent(c.substring(nameEQ.length, c.length));
    }
  } catch (e) {}
  return "";
}

function clearCookie(name) {
  try {
    document.cookie = name + "=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
  } catch (e) {}
}

function getStoredItem(key) {
  try {
    let val = localStorage.getItem(key);
    if (val) return val;
  } catch (e) {}
  try {
    let val = sessionStorage.getItem(key);
    if (val) return val;
  } catch (e) {}
  return getCookie(key) || "";
}

function setStoredItem(key, value) {
  try { localStorage.setItem(key, value); } catch (e) {}
  try { sessionStorage.setItem(key, value); } catch (e) {}
  setCookie(key, value, 365);
}

function clearStoredItems() {
  try { localStorage.clear(); } catch (e) {}
  try { sessionStorage.clear(); } catch (e) {}
  clearCookie("finance_api_url");
  clearCookie("finance_device_token");
  clearCookie("finance_user");
  clearCookie("finance_user_name");
}

// ESTADO GLOBAL DE LA APLICACIÓN
const state = {
  apiUrl: getStoredItem("finance_api_url") || "",
  deviceToken: getStoredItem("finance_device_token") || "",
  currentPin: getStoredItem("finance_user_pin") || "0000", // Clave local de cifrado E2EE
  user: null,              // Datos del usuario actual { nombre, rol }
  catalog: null,           // Catálogos descargados (categorias, subcategorias, etc.)
  pinVerified: false,      // Control de acceso por PIN
  editingId: null,         // ID del movimiento que se está editando
  lastDashboardKpis: null, // Último conjunto de KPIs del dashboard para uso en otras vistas
  charts: {
    categories: null,
    monthly: null
  }
};

// ==========================================================================
// MÓDULO CRIPTOGRÁFICO DE EXTREMO A EXTREMO (E2EE - ZERO KNOWLEDGE)
// ==========================================================================
const CryptoUtils = {
  PREFIX: "ENC:",

  /**
   * Obtiene la clave de cifrado activa del cliente.
   */
  getPin() {
    return state.currentPin || getStoredItem("finance_user_pin") || "0000";
  },

  /**
   * Deriva una clave AES-GCM 256-bit a partir de la clave del cliente usando SHA-256.
   */
  async _deriveKey(pin) {
    const encoder = new TextEncoder();
    const pinData = encoder.encode(String(pin || "0000"));
    const hashBuffer = await window.crypto.subtle.digest("SHA-256", pinData);
    return await window.crypto.subtle.importKey(
      "raw",
      hashBuffer,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
  },

  /**
   * Cifra un texto o número de forma segura en el navegador antes de enviar al servidor.
   */
  async encrypt(value, customPin) {
    if (value === null || value === undefined || value === "") return "";
    const strVal = String(value);

    // Si ya viene cifrado, evitar doble cifrado
    if (strVal.startsWith(this.PREFIX)) return strVal;

    try {
      const pin = customPin || this.getPin();
      const key = await this._deriveKey(pin);
      const iv = window.crypto.getRandomValues(new Uint8Array(12));
      const encoder = new TextEncoder();
      const encodedData = encoder.encode(strVal);

      const encryptedBuffer = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        key,
        encodedData
      );

      const combined = new Uint8Array(iv.length + encryptedBuffer.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(encryptedBuffer), iv.length);

      let binary = "";
      for (let i = 0; i < combined.length; i++) {
        binary += String.fromCharCode(combined[i]);
      }
      return this.PREFIX + btoa(binary);
    } catch (e) {
      console.error("[CryptoUtils] Error al cifrar dato:", e);
      return strVal;
    }
  },

  /**
   * Descifra un dato cifrado en el navegador. Si es un registro legacy (texto plano), lo devuelve sin modificar.
   */
  async decrypt(cipherText, customPin) {
    if (cipherText === null || cipherText === undefined || cipherText === "") return "";
    const strVal = String(cipherText);

    // Retro-compatibilidad: Si el dato no empieza con "ENC:", es un registro legacy plano.
    if (!strVal.startsWith(this.PREFIX)) {
      return strVal;
    }

    try {
      const b64 = strVal.substring(this.PREFIX.length);
      const binary = atob(b64);
      const combined = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        combined[i] = binary.charCodeAt(i);
      }

      const iv = combined.slice(0, 12);
      const data = combined.slice(12);
      const pin = customPin || this.getPin();
      const key = await this._deriveKey(pin);

      const decryptedBuffer = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv },
        key,
        data
      );

      const decoder = new TextDecoder();
      return decoder.decode(decryptedBuffer);
    } catch (e) {
      console.warn("[CryptoUtils] No se pudo descifrar (¿clave incorrecta?):", e);
      return strVal;
    }
  },

  /**
   * Descifra un objeto completo de movimiento.
   */
  async decryptMovement(mov) {
    if (!mov) return mov;
    const decrypted = { ...mov };
    if (mov.MONTO) decrypted.MONTO = await this.decrypt(mov.MONTO);
    if (mov.CATEGORIA) decrypted.CATEGORIA = await this.decrypt(mov.CATEGORIA);
    if (mov.SUBCATEGORIA) decrypted.SUBCATEGORIA = await this.decrypt(mov.SUBCATEGORIA);
    if (mov.MEDIO_PAGO) decrypted.MEDIO_PAGO = await this.decrypt(mov.MEDIO_PAGO);
    if (mov.COMENTARIO) decrypted.COMENTARIO = await this.decrypt(mov.COMENTARIO);
    return decrypted;
  }
};

// ==========================================================================
// INICIALIZACIÓN Y FLUJO DE ARRANQUE
// ==========================================================================

document.addEventListener("DOMContentLoaded", () => {
  initEventListeners();
  initPwaAndNetworkStatus();
  bootApp();
});

/**
 * Registra el Service Worker de la PWA y escucha eventos de conexión red.
 */
function initPwaAndNetworkStatus() {
  // 1. Registro del Service Worker (PWA)
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js")
        .then(reg => console.log("[PWA] Service Worker registrado:", reg.scope))
        .catch(err => console.error("[PWA] Error al registrar Service Worker:", err));
    });
  }

  // 2. Control de estado Offline / Online
  function updateNetworkStatus() {
    const banner = document.getElementById("offline-banner");
    if (!banner) return;
    if (!navigator.onLine) {
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  window.addEventListener("online", updateNetworkStatus);
  window.addEventListener("offline", updateNetworkStatus);
  updateNetworkStatus();
}

/**
 * Arranca la aplicación comprobando credenciales locales y estado.
 */
async function bootApp() {
  // Asegurar la sincronización de credenciales persistentes
  state.apiUrl = state.apiUrl || getStoredItem("finance_api_url");
  state.deviceToken = state.deviceToken || getStoredItem("finance_device_token");

  if (!state.apiUrl || !state.deviceToken) {
    prefillSetupForm();
    showView("view-setup");
    return;
  }

  showLoader("Verificando dispositivo...");

  try {
    // 1. Descargar catálogos iniciales y verificar estado del dispositivo
    const response = await apiRequest("getUiCatalogues");

    if (response.success) {
      state.catalog = response.data;
      
      // Sincronizar dinámicamente el perfil del usuario activo retornado por la API
      if (response.data.user) {
        state.user = response.data.user;
        setStoredItem("finance_user", JSON.stringify(state.user));
        setStoredItem("finance_user_name", state.user.nombre);
      } else {
        const cachedUser = getStoredItem("finance_user");
        if (cachedUser) {
          try { state.user = JSON.parse(cachedUser); } catch(e) {}
        }
      }

      // Inicializar etiquetas del dashboard/menú
      updateUiMeta();

      // 2. Control del PIN
      if (state.catalog.pinActivado && !state.pinVerified) {
        showView("view-pin");
      } else {
        showView("view-home");
      }
    } else {
      // Manejar estados específicos de autorización
      if (response.errorCode === "ERR_DEVICE_PENDING" || (response.message && response.message.includes("ERR_DEVICE_PENDING"))) {
        document.getElementById("pending-device-id").innerText = state.deviceToken.substring(0, 8).toUpperCase();
        showView("view-pending");
      } else if (response.errorCode === "ERR_DEVICE_NOT_FOUND" || (response.message && response.message.includes("ERR_DEVICE_NOT_FOUND"))) {
        // Dispositivo borrado en Sheets o no encontrado
        if (confirm("Este dispositivo no figura registrado en la planilla. ¿Deseas desconectarlo para volver a vincularlo?")) {
          logout();
        } else {
          prefillSetupForm();
          showView("view-setup");
        }
      } else {
        alert("Error de conexión con la planilla: " + response.message);
        prefillSetupForm();
        showView("view-setup");
      }
    }
  } catch (error) {
    console.error(error);
    alert("No se pudo conectar con la API. Verifica tu conexión a internet o la URL ingresada.");
    prefillSetupForm();
    showView("view-setup");
  } finally {
    hideLoader();
  }
}

/**
 * Pre-llena los inputs del formulario de vinculación si ya existen credenciales guardadas.
 */
function prefillSetupForm() {
  const savedUrl = getStoredItem("finance_api_url") || state.apiUrl;
  const savedName = getStoredItem("finance_user_name") || (state.user ? state.user.nombre : "");
  
  const urlInput = document.getElementById("setup-api-url");
  const nameInput = document.getElementById("setup-user-name");
  
  if (urlInput && savedUrl) urlInput.value = savedUrl;
  if (nameInput && savedName) nameInput.value = savedName;
}

/**
 * Actualiza los textos generales de la interfaz con datos de la planilla.
 */
function updateUiMeta() {
  const familyName = state.catalog.nombreFamilia || "Finanzas Familiares";
  document.getElementById("home-family-name").innerText = familyName;
  
  if (state.user) {
    document.getElementById("home-greeting").innerText = `Hola, ${state.user.nombre}`;
    
    // Mostrar u ocultar el botón de Configuración si es Administrador
    const configBtn = document.getElementById("menu-btn-config");
    if (state.user.rol === "Administrador") {
      configBtn.classList.remove("hidden");
    } else {
      configBtn.classList.add("hidden");
    }
  }
}

// ==========================================================================
// CONTROLADOR DE NAVEGACIÓN (SPA)
// ==========================================================================

/**
 * Muestra la vista objetivo y oculta las demás.
 * @param {string} viewId - ID del contenedor div de la vista.
 */
function showView(viewId) {
  document.querySelectorAll(".view").forEach(view => {
    view.classList.remove("active");
  });
  
  const target = document.getElementById(viewId);
  if (target) {
    target.classList.add("active");
    
    // Acciones específicas al cargar ciertas pantallas
    if (viewId === "view-home") {
      refreshCatalogSilently(); // Refrescar catálogos y validar estado en segundo plano de forma silenciosa
    } else if (viewId === "view-add-movement" && !state.editingId) {
      resetMovementForm();
    } else if (viewId === "view-dashboard") {
      loadDashboardData();
    } else if (viewId === "view-config") {
      loadAdminConsole();
    } else if (viewId === "view-projections") {
      resetProjectionForm();
      loadProjectionsView();
    }
  }
}

/**
 * Refresca los catálogos en segundo plano de forma silenciosa sin interrumpir la navegación.
 */
async function refreshCatalogSilently() {
  if (!state.apiUrl || !state.deviceToken) return;
  try {
    const response = await apiRequest("getUiCatalogues");
    if (response.success) {
      state.catalog = response.data;
      if (response.data.user) {
        state.user = response.data.user;
        localStorage.setItem("finance_user", JSON.stringify(state.user));
      }
      updateUiMeta();
    }
  } catch (error) {
    console.error("Error al refrescar catálogo silenciosamente:", error);
  }
}

// ==========================================================================
// PETICIONES API (HTTP POST)
// ==========================================================================

/**
 * Realiza una llamada HTTP POST estandarizada a la API de Apps Script.
 * @param {string} action - Nombre de la acción a ejecutar.
 * @param {Object} [data] - Criterios u objetos de datos.
 * @returns {Promise<Object>} Promesa con la respuesta del servidor.
 */
async function apiRequest(action, data = {}) {
  if (!state.apiUrl && action !== "registerDevice") {
    throw new Error("URL de API no configurada.");
  }

  const payload = {
    action: action,
    deviceToken: state.deviceToken,
    data: data
  };

  const response = await fetch(state.apiUrl, {
    method: "POST",
    mode: "cors",
    headers: {
      "Content-Type": "text/plain;charset=utf-8" // GAS requiere text/plain en CORS a veces para evitar preflight OPTIONS
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`HTTP Error: ${response.status}`);
  }

  return await response.json();
}

// ==========================================================================
// REGISTRO DE DISPOSITIVO (SETUP)
// ==========================================================================

async function handleSetupSubmit(e) {
  e.preventDefault();
  
  const url = document.getElementById("setup-api-url").value.trim();
  const nombre = document.getElementById("setup-user-name").value.trim();

  if (!url || !nombre) {
    alert("Completa todos los campos obligatorios.");
    return;
  }

  showLoader("Vinculando dispositivo...");

  // REUTILIZAR SIEMPRE el token de dispositivo existente de este navegador/PC
  // para NO generar usuarios duplicados ("PC 2", "PC 3"...) en la planilla.
  const token = getStoredItem("finance_device_token") || state.deviceToken || generateUUID();

  try {
    // Configurar API en el estado para la llamada
    state.apiUrl = url;
    state.deviceToken = token;

    const response = await apiRequest("registerDevice", { nombre: nombre });

    if (response.success) {
      // Guardar en almacenamiento persistente multi-capa (localStorage + sessionStorage + Cookie)
      setStoredItem("finance_api_url", url);
      setStoredItem("finance_device_token", token);
      setStoredItem("finance_user_name", nombre);
      
      const userProfile = {
        nombre: response.data.nombre || nombre,
        rol: response.data.rol
      };
      setStoredItem("finance_user", JSON.stringify(userProfile));
      state.user = userProfile;

      if (response.data.status === "approved") {
        state.pinVerified = true;
        bootApp();
      } else {
        document.getElementById("pending-device-id").innerText = token.substring(0, 8).toUpperCase();
        showView("view-pending");
      }
    } else {
      alert("Error del servidor: " + response.message);
    }
  } catch (error) {
    console.error(error);
    alert("No se pudo conectar a la URL provista. Asegúrate de haber publicado la Web App en Apps Script con acceso para 'Cualquier persona'.");
  } finally {
    hideLoader();
  }
}

function logout() {
  clearStoredItems();
  state.apiUrl = "";
  state.deviceToken = "";
  state.user = null;
  state.catalog = null;
  state.pinVerified = false;
  state.editingId = null;
  prefillSetupForm();
  showView("view-setup");
}

// ==========================================================================
// LÓGICA DE TECLADO PIN
// ==========================================================================

let typedPin = "";

function handlePinKeyClick(e) {
  const key = e.target;
  const val = key.dataset.value;

  if (val) {
    if (typedPin.length < 4) {
      typedPin += val;
      updatePinDots();
      
      if (typedPin.length === 4) {
        verifyPinCode(typedPin);
      }
    }
  }
}

function updatePinDots() {
  const dots = document.querySelectorAll(".pin-dot");
  dots.forEach((dot, index) => {
    if (index < typedPin.length) {
      dot.classList.add("filled");
    } else {
      dot.classList.remove("filled");
    }
  });
}

function clearPin() {
  typedPin = "";
  updatePinDots();
  document.getElementById("pin-error-msg").classList.add("hidden");
}

function pinBackspace() {
  if (typedPin.length > 0) {
    typedPin = typedPin.slice(0, -1);
    updatePinDots();
    document.getElementById("pin-error-msg").classList.add("hidden");
  }
}

async function verifyPinCode(pin) {
  showLoader("Verificando PIN...");
  try {
    const response = await apiRequest("verifyPin", { pin: pin });
    if (response.success) {
      state.pinVerified = true;
      state.currentPin = pin;
      setStoredItem("finance_user_pin", pin);
      document.getElementById("pin-error-msg").classList.add("hidden");
      clearPin();
      showView("view-home");
    } else {
      document.getElementById("pin-error-msg").classList.remove("hidden");
      // Sacudir los puntos de PIN como micro-animación funcional de error
      const display = document.querySelector(".pin-display");
      display.style.animation = "shake 0.3s ease";
      setTimeout(() => { display.style.animation = ""; }, 300);
      typedPin = "";
      updatePinDots();
    }
  } catch (error) {
    alert("Error de conexión al verificar el PIN.");
    typedPin = "";
    updatePinDots();
  } finally {
    hideLoader();
  }
}

// ==========================================================================
// FORMULARIO: REGISTRAR / EDITAR MOVIMIENTO
// ==========================================================================

/**
 * Resetea y precarga campos por defecto en el formulario de movimientos.
 */
function resetMovementForm() {
  state.editingId = null;
  document.getElementById("mov-id").value = "";
  document.getElementById("movement-view-title").innerText = "Registrar Movimiento";
  document.getElementById("btn-save-movement").innerText = "Guardar Movimiento";
  document.getElementById("btn-save-movement").className = "btn btn-success btn-block";

  // Fecha actual local por defecto
  document.getElementById("mov-fecha").value = Utils.getTodayDateString();
  
  // Seleccionar Egreso por defecto
  document.getElementById("tipo-egreso").checked = true;
  
  document.getElementById("mov-monto").value = "";
  document.getElementById("mov-monto").disabled = false;
  document.getElementById("mov-comentario").value = "";
  
  // Limpiar campos USD
  document.getElementById("mov-usd-cantidad").value = "";
  document.getElementById("mov-usd-tc").value = "";
  document.getElementById("usd-fields").classList.add("hidden");

  // Rellenar selectores principales
  populateCategories("Egreso");
  populatePaymentMethods();
}

/**
 * Rellena el selector de categorías basado en el tipo elegido.
 */
function populateCategories(tipo) {
  const select = document.getElementById("mov-categoria");
  select.innerHTML = '<option value="">Selecciona categoría...</option>';
  
  if (!state.catalog || !state.catalog.categories) return;

  const filtered = state.catalog.categories.filter(c => c.TIPO === tipo && c.ESTADO === "Activo");
  filtered.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c.NOMBRE;
    opt.dataset.id = c.ID_CATEGORIA;
    opt.textContent = c.NOMBRE;
    select.appendChild(opt);
  });

  // Limpiar y deshabilitar subcategorías hasta elegir una categoría
  const subSelect = document.getElementById("mov-subcategoria");
  subSelect.innerHTML = '<option value="">Selecciona subcategoría...</option>';
  subSelect.disabled = true;
}

/**
 * Rellena las subcategorías en cascada al elegir una categoría principal.
 */
function handleCategoryChange(e) {
  const categorySelect = e.target;
  const selectedOpt = categorySelect.options[categorySelect.selectedIndex];
  const subSelect = document.getElementById("mov-subcategoria");
  
  subSelect.innerHTML = '<option value="">Selecciona subcategoría...</option>';
  subSelect.disabled = true;

  // Ocultar sección USD por defecto
  toggleUsdFields(false);

  if (!selectedOpt || !selectedOpt.dataset.id) return;

  const catId = selectedOpt.dataset.id;
  const filtered = state.catalog.subcategories.filter(s => s.ID_CATEGORIA === catId && s.ESTADO === "Activo");
  
  if (filtered.length > 0) {
    filtered.forEach(s => {
      const opt = document.createElement("option");
      opt.value = s.NOMBRE;
      opt.dataset.id = s.ID_SUBCATEGORIA;
      opt.dataset.esUsd = s.ES_USD; // Guardar indicador especial
      opt.textContent = s.NOMBRE;
      subSelect.appendChild(opt);
    });
    subSelect.disabled = false;
  }
}

/**
 * Rellena medios de pago.
 */
function populatePaymentMethods() {
  const select = document.getElementById("mov-medio-pago");
  select.innerHTML = '<option value="">Selecciona medio de pago...</option>';
  
  if (!state.catalog || !state.catalog.paymentMethods) return;

  const filtered = state.catalog.paymentMethods.filter(mp => mp.ESTADO === "Activo");
  filtered.forEach(mp => {
    const opt = document.createElement("option");
    opt.value = mp.NOMBRE;
    opt.textContent = mp.NOMBRE;
    select.appendChild(opt);
  });
}

/**
 * Detecta si la subcategoría seleccionada activa el caso especial de USD.
 */
function handleSubcategoryChange(e) {
  const subcatSelect = e.target;
  const selectedOpt = subcatSelect.options[subcatSelect.selectedIndex];
  
  if (selectedOpt && (selectedOpt.dataset.esUsd === "S" || selectedOpt.dataset.esUsd === "SI")) {
    toggleUsdFields(true);
  } else {
    toggleUsdFields(false);
  }
}

/**
 * Activa o desactiva la interfaz especial de compra USD.
 */
function toggleUsdFields(show) {
  const usdFields = document.getElementById("usd-fields");
  const cantInput = document.getElementById("mov-usd-cantidad");
  const tcInput = document.getElementById("mov-usd-tc");
  const montoInput = document.getElementById("mov-monto");

  if (show) {
    usdFields.classList.remove("hidden");
    cantInput.required = true;
    tcInput.required = true;
    montoInput.disabled = true; // Bloqueado, se calcula automáticamente
    recalculateUsdTotal();
  } else {
    usdFields.classList.add("hidden");
    cantInput.required = false;
    tcInput.required = false;
    montoInput.disabled = false;
    cantInput.value = "";
    tcInput.value = "";
  }
}

/**
 * Calcula Monto ARS = Cantidad USD * Tipo Cambio.
 */
function recalculateUsdTotal() {
  const cant = parseFloat(document.getElementById("mov-usd-cantidad").value) || 0;
  const tc = parseFloat(document.getElementById("mov-usd-tc").value) || 0;
  const total = cant * tc;

  document.getElementById("mov-monto").value = total > 0 ? total.toFixed(2) : "";
}

/**
 * Envía el formulario para crear o actualizar un movimiento.
 */
async function handleMovementSubmit(e) {
  e.preventDefault();

  const id = document.getElementById("mov-id").value;
  const fecha = document.getElementById("mov-fecha").value;
  const tipo = document.querySelector('input[name="mov-tipo"]:checked').value;
  const categoria = document.getElementById("mov-categoria").value;
  const subcategoria = document.getElementById("mov-subcategoria").value;
  const medioPago = document.getElementById("mov-medio-pago").value;
  const monto = parseFloat(document.getElementById("mov-monto").value);
  const comentario = document.getElementById("mov-comentario").value.trim();

  // Validaciones
  if (!fecha || !tipo || !categoria || !subcategoria || !medioPago || isNaN(monto) || monto <= 0) {
    alert("Por favor completa todos los campos requeridos con valores válidos.");
    return;
  }

  const payload = {
    fecha: fecha,
    tipo: tipo,
    categoria: await CryptoUtils.encrypt(categoria),
    subcategoria: await CryptoUtils.encrypt(subcategoria),
    medioPago: await CryptoUtils.encrypt(medioPago),
    monto: await CryptoUtils.encrypt(monto),
    comentario: await CryptoUtils.encrypt(comentario)
  };

  // Validar datos USD si corresponde
  const subSelect = document.getElementById("mov-subcategoria");
  const selectedSub = subSelect.options[subSelect.selectedIndex];
  const esUsd = selectedSub && (selectedSub.dataset.esUsd === "S" || selectedSub.dataset.esUsd === "SI");

  if (esUsd) {
    const cant = parseFloat(document.getElementById("mov-usd-cantidad").value);
    const tc = parseFloat(document.getElementById("mov-usd-tc").value);

    if (isNaN(cant) || cant <= 0 || isNaN(tc) || tc <= 0) {
      alert("Para compra de USD debes ingresar cantidad y tipo de cambio válidos.");
      return;
    }
    payload.cantidadUsd = cant;
    payload.tipoCambio = tc;
  }

  showLoader(id ? "Actualizando movimiento..." : "Registrando movimiento...");

  try {
    let response;
    if (id) {
      // Edición de movimiento existente
      payload.id = id;
      response = await apiRequest("updateMovement", payload);
    } else {
      // Registro nuevo
      response = await apiRequest("addMovement", payload);
    }

    if (response.success) {
      // Configurar vista de éxito
      document.getElementById("success-title").innerText = id ? "Movimiento Actualizado" : "Movimiento Registrado";
      document.getElementById("success-msg").innerText = response.message;
      
      showView("view-success");
    } else {
      alert("Error: " + response.message);
    }
  } catch (error) {
    alert("Error de conexión al procesar la solicitud.");
  } finally {
    hideLoader();
  }
}

// ==========================================================================
// BÚSQUEDA Y EDICIÓN DE MOVIMIENTOS
// ==========================================================================

/**
 * Carga las categorías en el selector de filtros de búsqueda.
 */
function populateFilterCategories() {
  const select = document.getElementById("filter-categoria");
  select.innerHTML = '<option value="">Todas</option>';
  
  if (!state.catalog || !state.catalog.categories) return;

  // Carga todas las categorías sin importar el tipo
  state.catalog.categories.forEach(c => {
    if (c.ESTADO === "Activo") {
      const opt = document.createElement("option");
      opt.value = c.NOMBRE;
      opt.textContent = c.NOMBRE;
      select.appendChild(opt);
    }
  });
}

/**
 * Ejecuta la búsqueda de movimientos aplicando filtros.
 */
async function searchMovements() {
  const from = document.getElementById("filter-date-from").value;
  const to = document.getElementById("filter-date-to").value;
  const tipo = document.getElementById("filter-tipo").value;
  const cat = document.getElementById("filter-categoria").value;
  const comment = document.getElementById("filter-comentario").value.trim();

  const filters = {};
  if (from) filters.fechaDesde = from;
  if (to) filters.fechaHasta = to;
  if (tipo) filters.tipo = tipo;
  if (cat) filters.categoria = cat;
  if (comment) filters.comentario = comment;

  showLoader("Buscando...");

  try {
    const response = await apiRequest("searchMovements", filters);
    
    if (response.success && response.data) {
      const decryptedItems = await Promise.all(response.data.map(item => CryptoUtils.decryptMovement(item)));
      renderSearchList(decryptedItems);
      document.getElementById("search-results-info").innerText = response.message;
    } else {
      alert("Error: " + response.message);
    }
  } catch (error) {
    alert("Error al buscar movimientos.");
  } finally {
    hideLoader();
  }
}

/**
 * Dibuja la lista de movimientos filtrados.
 */
function renderSearchList(items) {
  const container = document.getElementById("search-list");
  container.innerHTML = "";

  if (!items || items.length === 0) {
    container.innerHTML = '<div class="text-center text-secondary py-4">No se encontraron movimientos.</div>';
    return;
  }

  items.forEach(item => {
    const card = document.createElement("div");
    card.className = "transaction-card";

    // Tipo styling
    let typeClass = "tx-egreso";
    let typeIcon = "↓";
    let amountSign = "-";
    let amountClass = "egreso";

    if (item.TIPO === "Ingreso") {
      typeClass = "tx-ingreso";
      typeIcon = "↑";
      amountSign = "+";
      amountClass = "ingreso";
    } else if (item.TIPO === "Ahorro") {
      typeClass = "tx-ahorro";
      typeIcon = "★";
      amountSign = "";
      amountClass = "ahorro";
    }

    const formattedAmount = Utils.formatCurrency(item.MONTO);
    const commentHtml = item.COMENTARIO ? `<div class="tx-comment">${item.COMENTARIO}</div>` : "";
    
    // Detalle USD si es especial
    const usdHtml = item.CANTIDAD_USD 
      ? `<div class="text-secondary small font-weight-500">Compra: $${parseFloat(item.CANTIDAD_USD).toFixed(2)} USD a TC $${parseFloat(item.TIPO_CAMBIO).toFixed(2)}</div>` 
      : "";

    card.innerHTML = `
      <div class="tx-icon ${typeClass}">${typeIcon}</div>
      <div class="tx-main">
        <div class="tx-header">
          <span class="tx-category">${item.CATEGORIA}</span>
          <span class="tx-subcategory">${item.SUBCATEGORIA}</span>
        </div>
        <div class="tx-meta">${Utils.formatDateReadable(item.FECHA)} por <b>${item.USUARIO || "S/D"}</b></div>
        ${usdHtml}
        ${commentHtml}
      </div>
      <div class="tx-right">
        <span class="tx-amount ${amountClass}">${amountSign}${formattedAmount}</span>
        <button class="btn-edit-tx" data-id="${item.ID}">Editar</button>
      </div>
    `;

    // Asignar click al botón de editar
    card.querySelector(".btn-edit-tx").addEventListener("click", () => {
      loadMovementToEdit(item);
    });

    container.appendChild(card);
  });
}

/**
 * Carga un movimiento al formulario para su modificación.
 */
function loadMovementToEdit(item) {
  state.editingId = item.ID;
  
  // Abrir vista del formulario
  showView("view-add-movement");
  
  // Cambiar textos del header y botón
  document.getElementById("movement-view-title").innerText = "Editar Movimiento";
  document.getElementById("btn-save-movement").innerText = "Actualizar Movimiento";
  document.getElementById("btn-save-movement").className = "btn btn-primary btn-block";

  // Rellenar valores
  document.getElementById("mov-id").value = item.ID;
  document.getElementById("mov-fecha").value = Utils.formatDateInput(item.FECHA);
  document.getElementById("mov-comentario").value = item.COMENTARIO || "";
  document.getElementById("mov-monto").value = parseFloat(item.MONTO).toFixed(2);

  // Configurar Tipo de movimiento (Radio Buttons)
  const radio = document.querySelector(`input[name="mov-tipo"][value="${item.TIPO}"]`);
  if (radio) {
    radio.checked = true;
  }

  // Cargar Categorías para el tipo correspondiente
  populateCategories(item.TIPO);
  document.getElementById("mov-categoria").value = item.CATEGORIA;

  // Cargar Subcategorías
  const catSelect = document.getElementById("mov-categoria");
  handleCategoryChange({ target: catSelect });
  document.getElementById("mov-subcategoria").value = item.SUBCATEGORIA;

  // Cargar Medio de Pago
  populatePaymentMethods();
  document.getElementById("mov-medio-pago").value = item.MEDIO_PAGO;

  // Si es compra USD, llenar campos adicionales
  if (item.CANTIDAD_USD) {
    toggleUsdFields(true);
    document.getElementById("mov-usd-cantidad").value = parseFloat(item.CANTIDAD_USD).toFixed(2);
    document.getElementById("mov-usd-tc").value = parseFloat(item.TIPO_CAMBIO).toFixed(2);
    document.getElementById("mov-monto").value = parseFloat(item.MONTO).toFixed(2);
  } else {
    toggleUsdFields(false);
  }
}

// ==========================================================================
// DASHBOARD (MÉTRICAS Y GRÁFICOS CHART.JS)
// ==========================================================================

async function loadDashboardData() {
  showLoader("Cargando dashboard...");
  try {
    const response = await apiRequest("getDashboard");
    if (response.success && response.data) {
      const data = response.data;
      if (data.ultimosMovimientos && data.ultimosMovimientos.length > 0) {
        data.ultimosMovimientos = await Promise.all(
          data.ultimosMovimientos.map(item => CryptoUtils.decryptMovement(item))
        );
      }
      renderDashboard(data);
    } else {
      alert("Error al cargar dashboard: " + response.message);
    }
  } catch (error) {
    alert("Error de conexión al cargar el dashboard.");
  } finally {
    hideLoader();
  }
}

function renderDashboard(data) {
  // 1. Renderizar KPIs principales
  const kpis = data.kpis;
  state.lastDashboardKpis = kpis; // Guardar para uso en vista de Proyecciones
  document.getElementById("kpi-saldo").innerText = Utils.formatCurrency(kpis.saldo);
  document.getElementById("kpi-ingresos").innerText = Utils.formatCurrency(kpis.ingresosMes);
  document.getElementById("kpi-gastos").innerText = Utils.formatCurrency(kpis.gastosMes);
  document.getElementById("kpi-ahorro").innerText = Utils.formatCurrency(kpis.ahorroMes);

  // Nuevos KPIs de Proyecciones
  const gastosProyectados = kpis.gastosProyectados || 0;
  const saldoProyectado = kpis.saldoProyectado != null ? kpis.saldoProyectado : kpis.saldo;
  document.getElementById("kpi-proyectado").innerText = Utils.formatCurrency(gastosProyectados);
  document.getElementById("kpi-saldo-proyectado").innerText = Utils.formatCurrency(saldoProyectado);

  // Colorear saldo disponible (positivo/negativo)
  const saldoEl = document.getElementById("kpi-saldo");
  saldoEl.className = kpis.saldo < 0 ? "negative" : "positive";
  document.querySelector(".kpi-saldo-box").style.borderColor = kpis.saldo < 0 ? "#f8d7da" : "#d1e7dd";

  // Colorear saldo proyectado
  const saldoProjEl = document.getElementById("kpi-saldo-proyectado");
  saldoProjEl.style.color = saldoProyectado < 0 ? "var(--danger-color)" : "var(--success-color)";

  // 2. Gráfico por Categorías (Dona)
  const catChartData = data.categoriaChart;
  const catCanvas = document.getElementById("chart-categories");

  if (state.charts.categories) {
    state.charts.categories.destroy();
  }

  const CHART_COLORS = ["#1a73e8", "#0d9488", "#f9ab00", "#d93025", "#a142f4", "#e37400", "#137333", "#0b57d0", "#c5221f", "#185abc"];

  if (catChartData.length === 0) {
    state.charts.categories = new Chart(catCanvas, {
      type: "doughnut",
      data: {
        labels: ["Sin egresos este mes"],
        datasets: [{ data: [1], backgroundColor: ["#e8eaed"] }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true, position: "bottom" } }
      }
    });
    document.getElementById("dashboard-category-details").innerHTML = "<p class=\"text-secondary small text-center\">No hay egresos este mes.</p>";
  } else {
    state.charts.categories = new Chart(catCanvas, {
      type: "doughnut",
      data: {
        labels: catChartData.map(c => c.categoria),
        datasets: [{
          data: catChartData.map(c => c.monto),
          backgroundColor: CHART_COLORS
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: "bottom", labels: { boxWidth: 12, font: { size: 12 } } }
        }
      }
    });

    // Tabla desglosada de Categorías (Revolut Style)
    const totalGastos = catChartData.reduce((sum, c) => sum + c.monto, 0);
    const catDetails = document.getElementById("dashboard-category-details");
    catDetails.innerHTML = "";
    catChartData.forEach((c, idx) => {
      const pct = totalGastos > 0 ? ((c.monto / totalGastos) * 100).toFixed(1) : "0.0";
      const color = CHART_COLORS[idx % CHART_COLORS.length];
      catDetails.innerHTML += `
        <div class="percentage-item">
          <div class="percentage-header">
            <span class="percentage-label" style="display:flex;align-items:center;gap:8px;">
              <span style="width:10px;height:10px;border-radius:50%;background:${color};display:inline-block;flex-shrink:0;"></span>
              ${c.categoria}
            </span>
            <span class="percentage-values"><strong>${Utils.formatCurrency(c.monto)}</strong> ${pct}%</span>
          </div>
          <div class="progress-bar-container">
            <div class="progress-bar-fill" style="width:${pct}%;background:${color};"></div>
          </div>
        </div>`;
    });
  }

  // 3. Ranking de Subcategorías del Mes (calculado desde el acumulado del mes que proviene del backend)
  const rankingContainer = document.getElementById("dashboard-ranking-list");
  renderSubcategoryRanking(rankingContainer, data.subcategoriaChart || []);

  // 4. Gráfico Histórico Mensual (Barras)
  const monthlyData = data.mensualChart;
  const monthlyCanvas = document.getElementById("chart-monthly");

  if (state.charts.monthly) {
    state.charts.monthly.destroy();
  }

  state.charts.monthly = new Chart(monthlyCanvas, {
    type: "bar",
    data: {
      labels: monthlyData.map(m => m.mes),
      datasets: [
        { label: "Ingresos", data: monthlyData.map(m => m.ingresos), backgroundColor: "#198754" },
        { label: "Gastos", data: monthlyData.map(m => m.gastos), backgroundColor: "#dc3545" },
        { label: "Ahorros", data: monthlyData.map(m => m.ahorros), backgroundColor: "#0d9488" }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, ticks: { font: { size: 11 } } } },
      plugins: {
        legend: { display: true, position: "bottom", labels: { boxWidth: 12, font: { size: 12 } } }
      }
    }
  });

  // 5. Últimos Movimientos
  renderDashboardRecentList(data.ultimosMovimientos);
}

/**
 * Renderiza el ranking de subcategorías (Top 5) con barras de progreso.
 * Construido a partir del desglose mensual provisto por el backend.
 */
function renderSubcategoryRanking(container, subcatChartData) {
  if (!subcatChartData || subcatChartData.length === 0) {
    container.innerHTML = "<p class=\"text-secondary small text-center\">No hay egresos este mes para el ranking.</p>";
    return;
  }

  const sorted = subcatChartData.slice(0, 5);
  const maxVal = sorted.length > 0 ? sorted[0].monto : 1;

  container.innerHTML = "";
  const RANK_COLORS = ["#1a73e8", "#0d9488", "#f9ab00", "#d93025", "#a142f4"];
  sorted.forEach((item, idx) => {
    const pct = maxVal > 0 ? ((item.monto / maxVal) * 100).toFixed(0) : 0;
    container.innerHTML += `
      <div class="ranking-item">
        <div class="ranking-header">
          <span class="ranking-label">${item.subcategoria}</span>
          <span class="ranking-value" style="color:${RANK_COLORS[idx % RANK_COLORS.length]}">${Utils.formatCurrency(item.monto)}</span>
        </div>
        <div class="progress-bar-container">
          <div class="progress-bar-fill" style="width:${pct}%;background:${RANK_COLORS[idx % RANK_COLORS.length]};"></div>
        </div>
      </div>`;
  });
}


function renderDashboardRecentList(items) {
  const container = document.getElementById("dashboard-recent-list");
  container.innerHTML = "";

  if (!items || items.length === 0) {
    container.innerHTML = '<div class="text-center text-secondary py-2 small">No hay transacciones registradas.</div>';
    return;
  }

  items.forEach(item => {
    const card = document.createElement("div");
    card.className = "transaction-card";

    let typeClass = "tx-egreso";
    let typeIcon = "↓";
    let amountSign = "-";
    let amountClass = "egreso";

    if (item.TIPO === "Ingreso") {
      typeClass = "tx-ingreso";
      typeIcon = "↑";
      amountSign = "+";
      amountClass = "ingreso";
    } else if (item.TIPO === "Ahorro") {
      typeClass = "tx-ahorro";
      typeIcon = "★";
      amountSign = "";
      amountClass = "ahorro";
    }

    card.innerHTML = `
      <div class="tx-icon ${typeClass}" style="width: 32px; height: 32px; font-size: 14px;">${typeIcon}</div>
      <div class="tx-main">
        <div class="tx-header">
          <span class="tx-category" style="font-size: 13px;">${item.CATEGORIA}</span>
          <span class="tx-subcategory" style="font-size: 11px;">${item.SUBCATEGORIA}</span>
        </div>
        <div class="tx-meta" style="font-size: 10px;">${Utils.formatDateReadable(item.FECHA)}</div>
      </div>
      <div class="tx-right">
        <span class="tx-amount ${amountClass}" style="font-size: 13px;">${amountSign}${Utils.formatCurrency(item.MONTO)}</span>
      </div>
    `;
    container.appendChild(card);
  });
}

// ==========================================================================
// SECCIÓN DE CONFIGURACIÓN (ADMINISTRADOR)
// ==========================================================================

async function loadAdminConsole() {
  showLoader("Cargando variables...");
  try {
    const response = await apiRequest("getAdminConsole");
    if (response.success) {
      renderAdminConsole(response.data);
    } else {
      alert("Error al cargar configuración: " + response.message);
      showView("view-home");
    }
  } catch (error) {
    alert("Error de conexión al cargar la configuración.");
  } finally {
    hideLoader();
  }
}

function renderAdminConsole(data) {
  // --- 1. Tab Seguridad y Ajustes Generales ---
  document.getElementById("cfg-family-name").value = data.nombreFamilia;
  document.getElementById("cfg-pin-active").checked = data.pinActivado;
  document.getElementById("cfg-new-pin").value = ""; // Limpiar campo

  // --- 2. Tab Usuarios ---
  const usersList = document.getElementById("config-users-list");
  usersList.innerHTML = "";

  data.users.forEach(u => {
    const row = document.createElement("div");
    row.className = "admin-user-row";

    const badgeRol = u.ROL === "Administrador" ? "badge-admin" : "badge-user";
    const badgeEstado = u.ESTADO === "Activo" ? "badge-active" : "badge-inactive";

    row.innerHTML = `
      <div class="user-row-header">
        <span class="user-row-name">${u.NOMBRE}</span>
        <div>
          <span class="user-badge ${badgeRol}">${u.ROL}</span>
          <span class="user-badge ${badgeEstado}">${u.ESTADO}</span>
        </div>
      </div>
      <div class="text-secondary small">Token: <code>${u.DEVICE_TOKEN.substring(0, 8)}...</code></div>
      
      <!-- Controles para el Admin (No auto-modificarse el rol de sí mismo para no perder acceso) -->
      <div class="user-row-controls">
        <select class="select-user-rol" data-id="${u.ID_USUARIO}" ${u.DEVICE_TOKEN === state.deviceToken ? "disabled" : ""}>
          <option value="Usuario" ${u.ROL === "Usuario" ? "selected" : ""}>Usuario</option>
          <option value="Administrador" ${u.ROL === "Administrador" ? "selected" : ""}>Administrador</option>
        </select>
        <select class="select-user-estado" data-id="${u.ID_USUARIO}" ${u.DEVICE_TOKEN === state.deviceToken ? "disabled" : ""}>
          <option value="Activo" ${u.ESTADO === "Activo" ? "selected" : ""}>Activo</option>
          <option value="Inactivo" ${u.ESTADO === "Inactivo" ? "selected" : ""}>Inactivo</option>
        </select>
        <button class="btn btn-secondary btn-save-user-row" data-id="${u.ID_USUARIO}" ${u.DEVICE_TOKEN === state.deviceToken ? "disabled" : ""} style="height: 36px; padding: 0 12px; font-size: 12px;">Aplicar</button>
      </div>
    `;

    // Asignar evento de guardado
    row.querySelector(".btn-save-user-row").addEventListener("click", () => {
      const selectRol = row.querySelector(".select-user-rol");
      const selectEstado = row.querySelector(".select-user-estado");
      
      updateUserFromAdmin({
        idUsuario: u.ID_USUARIO,
        nombre: u.NOMBRE,
        rol: selectRol.value,
        estado: selectEstado.value
      });
    });

    usersList.appendChild(row);
  });

  // --- 3. Tab Catálogos (Rellenar Listas y selectores) ---
  // Rellenar selectores del formulario de subcategorías con categorías activas
  const subCatSelect = document.getElementById("cfg-sub-cat-id");
  subCatSelect.innerHTML = '<option value="">Selecciona categoría padre...</option>';
  
  data.categories.forEach(c => {
    if (c.ESTADO === "Activo") {
      const opt = document.createElement("option");
      opt.value = c.ID_CATEGORIA;
      opt.textContent = `${c.NOMBRE} (${c.TIPO})`;
      subCatSelect.appendChild(opt);
    }
  });

  // Renderizar tablas/listados de catálogos
  renderCatalogList("list-cfg-categories", data.categories, "ID_CATEGORIA", "CATEGORIAS", (item) => {
    document.getElementById("cfg-cat-id").value = item.ID_CATEGORIA;
    document.getElementById("cfg-cat-nombre").value = item.NOMBRE;
    document.getElementById("cfg-cat-tipo").value = item.TIPO;
    document.getElementById("cfg-cat-estado").value = item.ESTADO;
  });

  renderCatalogList("list-cfg-subcategories", data.subcategories, "ID_SUBCATEGORIA", "SUBCATEGORIAS", (item) => {
    document.getElementById("cfg-sub-id").value = item.ID_SUBCATEGORIA;
    document.getElementById("cfg-sub-cat-id").value = item.ID_CATEGORIA;
    document.getElementById("cfg-sub-nombre").value = item.NOMBRE;
    document.getElementById("cfg-sub-usd").checked = item.ES_USD === "S" || item.ES_USD === "SI";
    document.getElementById("cfg-sub-estado").value = item.ESTADO;
  });

  renderCatalogList("list-cfg-mp", data.paymentMethods, "ID_MEDIO", "MEDIOS_PAGO", (item) => {
    document.getElementById("cfg-mp-id").value = item.ID_MEDIO;
    document.getElementById("cfg-mp-nombre").value = item.NOMBRE;
    document.getElementById("cfg-mp-estado").value = item.ESTADO;
  });
}

/**
 * Función genérica para renderizar listas de catálogos.
 */
function renderCatalogList(containerId, items, pkField, entityType, onEditCallback) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";

  if (items.length === 0) {
    container.innerHTML = '<div class="p-2 text-center text-secondary small">Vacío</div>';
    return;
  }

  items.forEach(item => {
    const row = document.createElement("div");
    row.className = "catalog-item-row";

    const labelEstado = item.ESTADO === "Activo" ? "✅" : "❌";
    const extraLabel = item.ES_USD === "S" || item.ES_USD === "SI" ? ' <span class="user-badge badge-admin">USD</span>' : "";

    row.innerHTML = `
      <div class="catalog-item-info">
        <span>${labelEstado}</span>
        <span><b>${item.NOMBRE}</b> ${extraLabel}</span>
      </div>
      <button class="btn-catalog-edit">✍️ Editar</button>
    `;

    row.querySelector(".btn-catalog-edit").addEventListener("click", () => {
      onEditCallback(item);
    });

    container.appendChild(row);
  });
}

/**
 * Petición para actualizar usuario.
 */
async function updateUserFromAdmin(userData) {
  showLoader("Actualizando usuario...");
  try {
    const response = await apiRequest("updateUser", userData);
    if (response.success) {
      alert(response.message);
      loadAdminConsole(); // Recargar consola
    } else {
      alert("Error: " + response.message);
    }
  } catch (error) {
    alert("Error de conexión al guardar cambios de usuario.");
  } finally {
    hideLoader();
  }
}

/**
 * Petición para guardar configuración de sistema.
 */
async function handleSystemSettingsSubmit(e) {
  e.preventDefault();
  
  const nombre = document.getElementById("cfg-family-name").value.trim();
  const pinActivo = document.getElementById("cfg-pin-active").checked;
  const nuevoPin = document.getElementById("cfg-new-pin").value;

  const payload = {
    nombreFamilia: nombre,
    pinActivado: pinActivo
  };

  if (nuevoPin) {
    if (!/^\d{4}$/.test(nuevoPin)) {
      alert("El PIN debe constar exactamente de 4 dígitos numéricos.");
      return;
    }
    payload.nuevoPin = nuevoPin;
  }

  showLoader("Guardando cambios...");

  try {
    const response = await apiRequest("saveSystemSettings", payload);
    if (response.success) {
      alert(response.message);
      loadAdminConsole();
    } else {
      alert("Error: " + response.message);
    }
  } catch (error) {
    alert("Error de conexión al guardar configuración.");
  } finally {
    hideLoader();
  }
}

/**
 * Guardar elemento de catálogo (Categorías, Subcategorías, Medios de Pago)
 */
async function handleCatalogSubmit(e, entityType, pkField, idInputId, getDataCallback, resetFormCallback) {
  e.preventDefault();

  const id = document.getElementById(idInputId).value;
  const itemData = getDataCallback();

  if (id) {
    itemData[pkField] = id;
  }

  showLoader("Guardando catálogo...");

  try {
    const response = await apiRequest("saveCatalogueItem", {
      entityType: entityType,
      pkName: pkField,
      itemData: itemData
    });

    if (response.success) {
      alert(response.message);
      resetFormCallback();
      loadAdminConsole(); // Recargar toda la consola
    } else {
      alert("Error: " + response.message);
    }
  } catch (error) {
    alert("Error al guardar catálogo.");
  } finally {
    hideLoader();
  }
}

// ==========================================================================
// EVENT LISTENERS DEL FRONTEND
// ==========================================================================

function initEventListeners() {
  // Setup inicial
  document.getElementById("form-setup").addEventListener("submit", handleSetupSubmit);
  document.getElementById("btn-reset-setup").addEventListener("click", logout);
  document.getElementById("btn-logout").addEventListener("click", () => {
    if (confirm("¿Seguro que deseas desconectar este dispositivo? Deberás enlazarlo nuevamente.")) {
      logout();
    }
  });

  // Verificar estado del dispositivo pendiente
  document.getElementById("btn-check-status").addEventListener("click", bootApp);

  // Teclado PIN
  document.querySelectorAll(".pin-key:not(.clear):not(.backspace)").forEach(k => {
    k.addEventListener("click", handlePinKeyClick);
  });
  document.getElementById("pin-clear").addEventListener("click", clearPin);
  document.getElementById("pin-backspace").addEventListener("click", pinBackspace);

  // Navegación principal
  document.querySelectorAll(".menu-card").forEach(card => {
    card.addEventListener("click", () => {
      const target = card.dataset.target;
      showView(target);
    });
  });

  document.querySelectorAll(".btn-back").forEach(btn => {
    btn.addEventListener("click", () => {
      showView("view-home");
    });
  });

  // Formulario Movimientos
  document.querySelectorAll('input[name="mov-tipo"]').forEach(radio => {
    radio.addEventListener("change", (e) => {
      populateCategories(e.target.value);
    });
  });

  document.getElementById("mov-categoria").addEventListener("change", handleCategoryChange);
  document.getElementById("mov-subcategoria").addEventListener("change", handleSubcategoryChange);
  
  // Calcular total en base a USD ingresado
  document.getElementById("mov-usd-cantidad").addEventListener("input", recalculateUsdTotal);
  document.getElementById("mov-usd-tc").addEventListener("input", recalculateUsdTotal);

  // Submit Movimiento
  document.getElementById("form-movement").addEventListener("submit", handleMovementSubmit);

  // Success screen redirections
  document.getElementById("btn-success-again").addEventListener("click", () => {
    resetMovementForm();
    showView("view-add-movement");
  });
  document.getElementById("btn-success-home").addEventListener("click", () => {
    showView("view-home");
  });

  // Búsqueda
  document.getElementById("btn-apply-filters").addEventListener("click", searchMovements);
  // Auto cargar filtros de categorías cuando se abre vista buscador
  document.querySelector('.menu-card[data-target="view-search"]').addEventListener("click", () => {
    populateFilterCategories();
    // Limpiar inputs del buscador
    document.getElementById("filter-date-from").value = "";
    document.getElementById("filter-date-to").value = "";
    document.getElementById("filter-tipo").value = "";
    document.getElementById("filter-categoria").value = "";
    document.getElementById("filter-comentario").value = "";
    renderSearchList([]); // Vaciar lista inicial
    document.getElementById("search-results-info").innerText = "Aplica filtros para buscar movimientos.";
  });

  // Config Tabs
  document.querySelectorAll(".config-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".config-tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".config-tab-content").forEach(c => c.classList.remove("active"));
      
      btn.classList.add("active");
      const tabId = btn.dataset.tab;
      document.getElementById(tabId).classList.add("active");
    });
  });

  // Submit Configuraciones de Seguridad
  document.getElementById("form-config-settings").addEventListener("submit", handleSystemSettingsSubmit);

  // Submit Catálogos (Categoría)
  document.getElementById("form-config-category").addEventListener("submit", (e) => {
    handleCatalogSubmit(
      e,
      "CATEGORIAS",
      "ID_CATEGORIA",
      "cfg-cat-id",
      () => ({
        NOMBRE: document.getElementById("cfg-cat-nombre").value.trim(),
        TIPO: document.getElementById("cfg-cat-tipo").value,
        ESTADO: document.getElementById("cfg-cat-estado").value
      }),
      () => {
        document.getElementById("cfg-cat-id").value = "";
        document.getElementById("cfg-cat-nombre").value = "";
        document.getElementById("cfg-cat-tipo").value = "Egreso";
        document.getElementById("cfg-cat-estado").value = "Activo";
      }
    );
  });

  // Submit Catálogos (Subcategoría)
  document.getElementById("form-config-subcategory").addEventListener("submit", (e) => {
    handleCatalogSubmit(
      e,
      "SUBCATEGORIAS",
      "ID_SUBCATEGORIA",
      "cfg-sub-id",
      () => ({
        ID_CATEGORIA: document.getElementById("cfg-sub-cat-id").value,
        NOMBRE: document.getElementById("cfg-sub-nombre").value.trim(),
        ES_USD: document.getElementById("cfg-sub-usd").checked ? "S" : "N",
        ESTADO: document.getElementById("cfg-sub-estado").value
      }),
      () => {
        document.getElementById("cfg-sub-id").value = "";
        document.getElementById("cfg-sub-cat-id").value = "";
        document.getElementById("cfg-sub-nombre").value = "";
        document.getElementById("cfg-sub-usd").checked = false;
        document.getElementById("cfg-sub-estado").value = "Activo";
      }
    );
  });

  // Submit Catálogos (Medios de Pago)
  document.getElementById("form-config-mp").addEventListener("submit", (e) => {
    handleCatalogSubmit(
      e,
      "MEDIOS_PAGO",
      "ID_MEDIO",
      "cfg-mp-id",
      () => ({
        NOMBRE: document.getElementById("cfg-mp-nombre").value.trim(),
        ESTADO: document.getElementById("cfg-mp-estado").value
      }),
      () => {
        document.getElementById("cfg-mp-id").value = "";
        document.getElementById("cfg-mp-nombre").value = "";
        document.getElementById("cfg-mp-estado").value = "Activo";
      }
    );
  });

  // Dashboard: card de Proyectados → ir a gestionar proyecciones
  document.getElementById("kpi-proyectado-card").addEventListener("click", () => {
    showView("view-projections");
  });

  // Proyecciones: formulario de guardado
  document.getElementById("form-projection").addEventListener("submit", handleSaveProjection);

  // Proyecciones: botón limpiar/cancelar edición
  document.getElementById("btn-cancel-projection").addEventListener("click", resetProjectionForm);

  // Modal de pago: toggle campos de conversión
  document.getElementById("pay-proj-convert").addEventListener("change", (e) => {
    document.getElementById("pay-conversion-fields").style.display = e.target.checked ? "flex" : "none";
  });

  // Modal de pago: categoría→subcategoría en cascada
  document.getElementById("pay-mov-categoria").addEventListener("change", (e) => {
    const catSelect = e.target;
    const selectedOpt = catSelect.options[catSelect.selectedIndex];
    const subSelect = document.getElementById("pay-mov-subcategoria");
    subSelect.innerHTML = '<option value="">Selecciona subcategoría...</option>';
    subSelect.disabled = true;

    if (!selectedOpt || !selectedOpt.dataset.id) return;
    const catId = selectedOpt.dataset.id;
    const filtered = (state.catalog.subcategories || []).filter(s => s.ID_CATEGORIA === catId && s.ESTADO === "Activo");
    if (filtered.length > 0) {
      filtered.forEach(s => {
        const opt = document.createElement("option");
        opt.value = s.NOMBRE;
        opt.dataset.id = s.ID_SUBCATEGORIA;
        opt.textContent = s.NOMBRE;
        subSelect.appendChild(opt);
      });
      subSelect.disabled = false;
    }
  });

  // Modal de pago: cancelar
  document.getElementById("btn-modal-pay-cancel").addEventListener("click", () => {
    document.getElementById("modal-pay-projection").classList.add("hidden");
  });

  // Modal de pago: confirmar pago
  document.getElementById("form-pay-projection").addEventListener("submit", handlePayProjection);
}

// ==========================================================================
// PROYECCIONES DE FIN DE MES
// ==========================================================================

/**
 * Carga y renderiza la vista de proyecciones.
 * Se almacena el saldo actual en estado para poder mostrarlo en la vista.
 */
async function loadProjectionsView() {
  showLoader("Cargando proyecciones...");
  try {
    const response = await apiRequest("getProjections");
    if (response.success) {
      renderProjectionsList(response.data || []);
    } else {
      alert("Error al cargar proyecciones: " + response.message);
    }
  } catch (error) {
    alert("Error de conexión al cargar proyecciones.");
  } finally {
    hideLoader();
  }
  
  // Actualizar resumen de saldo en vista proyecciones usando datos del estado
  // (se poblan cuando se carga el dashboard; si no están disponibles, ocultamos)
  if (state.lastDashboardKpis) {
    const kpis = state.lastDashboardKpis;
    document.getElementById("proj-summary-actual").innerText = Utils.formatCurrency(kpis.saldo);
    document.getElementById("proj-summary-pending").innerText = Utils.formatCurrency(kpis.gastosProyectados || 0);
    const saldoFin = kpis.saldoProyectado != null ? kpis.saldoProyectado : kpis.saldo;
    const finalEl = document.getElementById("proj-summary-final");
    finalEl.innerText = Utils.formatCurrency(saldoFin);
    finalEl.style.color = saldoFin < 0 ? "var(--danger-color)" : "var(--primary-color)";
  }
}

/**
 * Renderiza la lista de proyecciones pendientes.
 */
function renderProjectionsList(items) {
  const container = document.getElementById("projections-list");
  container.innerHTML = "";

  const pendientes = items.filter(p => p.ESTADO === "Pendiente");

  if (pendientes.length === 0) {
    container.innerHTML = '<div class="text-center text-secondary py-4" style="padding:24px 0;">No hay gastos proyectados pendientes.</div>';
    return;
  }

  pendientes.forEach(item => {
    const card = document.createElement("div");
    card.className = "transaction-card";
    const fechaStr = item.FECHA ? Utils.formatDateReadable(item.FECHA) : "Sin fecha";
    card.innerHTML = `
      <div class="tx-icon tx-egreso">
        <span class="material-symbols-rounded" style="font-size:20px;">pending_actions</span>
      </div>
      <div class="tx-main">
        <div class="tx-header">
          <span class="tx-category">${item.CONCEPTO || "Sin concepto"}</span>
        </div>
        <div class="tx-meta">${fechaStr}</div>
        <div class="proj-actions">
          <button class="btn-proj-pay" data-id="${item.ID}" data-concepto="${item.CONCEPTO}" data-monto="${item.MONTO}">✓ Pagar</button>
          <button class="btn-edit-tx btn-proj-edit" data-id="${item.ID}" data-fecha="${item.FECHA}" data-concepto="${item.CONCEPTO}" data-monto="${item.MONTO}">Editar</button>
          <button class="btn-proj-delete" data-id="${item.ID}">Eliminar</button>
        </div>
      </div>
      <div class="tx-right">
        <span class="tx-amount egreso">-${Utils.formatCurrency(item.MONTO)}</span>
        <span class="proj-pendiente-badge">Pendiente</span>
      </div>
    `;

    // Editar proyección
    card.querySelector(".btn-proj-edit").addEventListener("click", () => {
      document.getElementById("proj-id").value = item.ID;
      document.getElementById("proj-fecha").value = item.FECHA ? item.FECHA.toString().substring(0, 10) : "";
      document.getElementById("proj-concepto").value = item.CONCEPTO;
      document.getElementById("proj-monto").value = parseFloat(item.MONTO).toFixed(2);
      document.getElementById("projection-form-title").innerText = "Editar Gasto Proyectado";
      document.getElementById("btn-save-projection").innerText = "Actualizar";
      card.closest(".view-content") && card.closest(".view-content").scrollTo(0, 0);
      document.getElementById("card-form-projection").scrollIntoView({ behavior: "smooth" });
    });

    // Pagar proyección
    card.querySelector(".btn-proj-pay").addEventListener("click", () => {
      openPayModal(item.ID, item.CONCEPTO, item.MONTO);
    });

    // Eliminar proyección
    card.querySelector(".btn-proj-delete").addEventListener("click", () => {
      handleDeleteProjection(item.ID, item.CONCEPTO);
    });

    container.appendChild(card);
  });
}

/**
 * Resetea el formulario de Proyección al estado inicial (nuevo).
 */
function resetProjectionForm() {
  document.getElementById("proj-id").value = "";
  document.getElementById("proj-fecha").value = Utils.getTodayDateString();
  document.getElementById("proj-concepto").value = "";
  document.getElementById("proj-monto").value = "";
  document.getElementById("projection-form-title").innerText = "Agregar Gasto Proyectado";
  document.getElementById("btn-save-projection").innerText = "Guardar";
}

/**
 * Envía el formulario para crear o actualizar una proyección.
 */
async function handleSaveProjection(e) {
  e.preventDefault();
  const id = document.getElementById("proj-id").value;
  const fecha = document.getElementById("proj-fecha").value;
  const concepto = document.getElementById("proj-concepto").value.trim();
  const monto = parseFloat(document.getElementById("proj-monto").value);

  if (!fecha || !concepto || isNaN(monto) || monto <= 0) {
    alert("Completa todos los campos con valores válidos.");
    return;
  }

  showLoader(id ? "Actualizando proyección..." : "Guardando proyección...");
  try {
    const payload = { fecha, concepto, monto };
    if (id) payload.id = id;

    const response = await apiRequest("saveProjection", payload);
    if (response.success) {
      resetProjectionForm();
      loadProjectionsView();
    } else {
      alert("Error: " + response.message);
    }
  } catch (error) {
    alert("Error de conexión al guardar proyección.");
  } finally {
    hideLoader();
  }
}

/**
 * Elimina una proyección tras confirmación del usuario.
 */
async function handleDeleteProjection(id, concepto) {
  if (!confirm(`¿Confirmas eliminar el gasto proyectado "${concepto}"?`)) return;

  showLoader("Eliminando...");
  try {
    const response = await apiRequest("deleteProjection", { id });
    if (response.success) {
      loadProjectionsView();
    } else {
      alert("Error: " + response.message);
    }
  } catch (error) {
    alert("Error de conexión al eliminar proyección.");
  } finally {
    hideLoader();
  }
}

/**
 * Abre el modal de confirmación de pago.
 */
function openPayModal(id, concepto, monto) {
  document.getElementById("pay-proj-id").value = id;
  document.getElementById("pay-proj-concept-text").innerText = `"${concepto}" — ${Utils.formatCurrency(monto)}`;
  document.getElementById("pay-proj-convert").checked = true;
  document.getElementById("pay-conversion-fields").style.display = "flex";
  document.getElementById("pay-mov-comentario").value = concepto;

  // Poblar selectores de categoría y medio de pago en el modal
  initPayConversionSelects();

  document.getElementById("modal-pay-projection").classList.remove("hidden");
}

/**
 * Inicializa los selectores de Categoría y Medio de Pago en el modal de pago.
 */
function initPayConversionSelects() {
  const catSelect = document.getElementById("pay-mov-categoria");
  catSelect.innerHTML = '<option value="">Selecciona categoría...</option>';
  const subSelect = document.getElementById("pay-mov-subcategoria");
  subSelect.innerHTML = '<option value="">Selecciona subcategoría...</option>';
  subSelect.disabled = true;
  const medioSelect = document.getElementById("pay-mov-medio");
  medioSelect.innerHTML = '<option value="">Selecciona medio de pago...</option>';

  if (!state.catalog) return;

  // Solo categorías de Egreso (las proyecciones son gastos)
  const egressCats = (state.catalog.categories || []).filter(c => c.TIPO === "Egreso" && c.ESTADO === "Activo");
  egressCats.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c.NOMBRE;
    opt.dataset.id = c.ID_CATEGORIA;
    opt.textContent = c.NOMBRE;
    catSelect.appendChild(opt);
  });

  (state.catalog.paymentMethods || []).filter(mp => mp.ESTADO === "Activo").forEach(mp => {
    const opt = document.createElement("option");
    opt.value = mp.NOMBRE;
    opt.textContent = mp.NOMBRE;
    medioSelect.appendChild(opt);
  });
}

/**
 * Procesa el pago de una proyección (con o sin conversión a movimiento real).
 */
async function handlePayProjection(e) {
  e.preventDefault();
  const id = document.getElementById("pay-proj-id").value;
  const convertToMovement = document.getElementById("pay-proj-convert").checked;

  const payload = { id, convertToMovement };

  if (convertToMovement) {
    const categoria = document.getElementById("pay-mov-categoria").value;
    const subcategoria = document.getElementById("pay-mov-subcategoria").value;
    const medioPago = document.getElementById("pay-mov-medio").value;
    const comentario = document.getElementById("pay-mov-comentario").value.trim();

    if (!categoria || !subcategoria || !medioPago) {
      alert("Para convertir a movimiento real debes seleccionar Categoría, Subcategoría y Medio de Pago.");
      return;
    }

    // Recuperar el concepto y monto del modal para el movimiento real
    const conceptText = document.getElementById("pay-proj-concept-text").innerText;
    // El monto lo recuperamos del id de la proyección — no tenemos state local, así que usamos el concepto
    payload.movement = {
      fecha: Utils.getTodayDateString(),
      tipo: "Egreso",
      categoria,
      subcategoria,
      medioPago,
      monto: null, // Se completará con el monto del registro en el backend
      comentario
    };

    // Para poder enviar el monto correcto, lo buscamos en la lista renderizada
    const payBtn = document.querySelector(`.btn-proj-pay[data-id="${id}"]`);
    if (payBtn && payBtn.dataset.monto) {
      payload.movement.monto = parseFloat(payBtn.dataset.monto);
    }
  }

  showLoader("Procesando pago...");
  try {
    const response = await apiRequest("payProjection", payload);
    if (response.success) {
      document.getElementById("modal-pay-projection").classList.add("hidden");
      loadProjectionsView();
    } else {
      alert("Error: " + response.message);
    }
  } catch (error) {
    alert("Error de conexión al procesar el pago.");
  } finally {
    hideLoader();
  }
}

// ==========================================================================
// FUNCIONES AUXILIARES Y DE CARGA (UTILS)
// ==========================================================================

const Utils = {
  getTodayDateString: function() {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  },

  formatDateInput: function(fechaStr) {
    if (!fechaStr) return "";
    if (typeof fechaStr === "string" && fechaStr.includes("-")) {
      const parts = fechaStr.substring(0, 10).split("-");
      if (parts.length === 3) {
        return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
      }
    }
    const date = new Date(fechaStr);
    if (isNaN(date.getTime())) return "";
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  },

  formatDateReadable: function(fechaStr) {
    if (!fechaStr) return "";
    if (typeof fechaStr === "string" && fechaStr.includes("-")) {
      const parts = fechaStr.substring(0, 10).split("-");
      if (parts.length === 3) {
        const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
        return d.toLocaleDateString("es-AR", { day: "numeric", month: "short", year: "numeric" });
      }
    }
    const date = new Date(fechaStr);
    if (isNaN(date.getTime())) return fechaStr;
    return date.toLocaleDateString("es-AR", { day: "numeric", month: "short", year: "numeric" });
  },

  formatCurrency: function(monto) {
    const val = parseFloat(monto) || 0;
    return new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: "ARS",
      minimumFractionDigits: 2
    }).format(val);
  }
};

/**
 * Genera un UUID v4 básico para identificar dispositivos.
 */
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Control del Loader
function showLoader(message = "Cargando...") {
  document.getElementById("global-loader-text").innerText = message;
  document.getElementById("global-loader").classList.remove("hidden");
}

function hideLoader() {
  document.getElementById("global-loader").classList.add("hidden");
}
