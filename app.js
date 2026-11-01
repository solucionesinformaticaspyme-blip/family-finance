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
  currentPin: getStoredItem("finance_user_pin") || "0000",
  user: null,              // Datos del usuario actual { nombre, rol }
  catalog: null,           // Catálogos descargados (categorias, subcategorias, etc.)
  pinVerified: false,      // Control de acceso por PIN
  editingId: null,         // ID del movimiento que se está editando
  lastDashboardKpis: null, // Último conjunto de KPIs del dashboard para uso en otras vistas
  
  // Caché SWR e interactividad del Dashboard
  cachedDashboardData: null,
  dashboardNeedsRefresh: true,  // Se marca true cuando se guarda/edita/paga un movimiento
  cachedAnalysisData: null,
  analysisNeedsRefresh: true,   // Se marca true para refrescar conclusiones
  selectedDonutPeriod: null,    // Período seleccionado para el gráfico de dona
  pivotExpandedCategories: {},  // Categorías de la tabla pivot actualmente desplegadas
  pivotExpandAll: false,        // Estado de expandir/colapsar todas
  pivotMode: "months",          // Modo temporal de la tabla pivot ("months" | "years")
  privacyMode: getStoredItem("finance_privacy_mode") === "true", // Modo Privacidad (Ocultar/Mostrar importes)

  // Arqueo y Notificaciones
  cuentasArqueo: [],
  currentSaldoApp: 0,
  ultimoArqueo: null,
  notificationEmails: [],
  geminiApiKey: getStoredItem("finance_gemini_api_key") || "",

  charts: {
    categories: null,
    monthly: null,
    savingsRate: null,
    paymentMethods: null
  }
};

// ==========================================================================
// v1.2 - VELOCIDAD: caché local persistente y control de peticiones duplicadas
// ==========================================================================

// Cuando se marca "hay que refrescar", se incrementa una generación. Así, si un dato cambia
// MIENTRAS viaja una petición, su respuesta (ya vieja) no se considera actualizada.
(function () {
  const defineGen = (prop, genProp) => {
    let value = state[prop];
    state[genProp] = 0;
    Object.defineProperty(state, prop, {
      get() { return value; },
      set(v) {
        if (v) {
          state[genProp]++;
          if (prop === "dashboardNeedsRefresh") state.remindersFetchedAt = 0; // v1.3: recordatorios también
        }
        value = v;
      },
      enumerable: true,
      configurable: true
    });
  };
  defineGen("dashboardNeedsRefresh", "_dashGen");
  defineGen("analysisNeedsRefresh", "_analysisGen");
})();
state.catalogLoadedAt = 0;
const CATALOG_REFRESH_MS = 5 * 60 * 1000; // re-validar catálogos/usuario cada 5 minutos como máximo

/** Guarda datos en el dispositivo asociados a este dispositivo vinculado. */
function writeLocalCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ token: state.deviceToken, savedAt: Date.now(), data: data }));
  } catch (e) { /* almacenamiento lleno o no disponible: se ignora */ }
}

/** Lee datos guardados en el dispositivo (solo si pertenecen al dispositivo vinculado actual). */
function readLocalCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.token !== state.deviceToken) return null;
    return obj.data || null;
  } catch (e) {
    return null;
  }
}

let _dashboardInflight = null;
/**
 * Pide el dashboard al servidor. Si ya hay una petición en curso, reutiliza esa misma
 * (evita las llamadas duplicadas que antes se disparaban al abrir la app).
 */
function fetchDashboard() {
  if (_dashboardInflight) return _dashboardInflight;
  const gen = state._dashGen;
  _dashboardInflight = (async () => {
    try {
      const res = await apiRequest("getDashboard");
      if (res && res.success && res.data) {
        state.cachedDashboardData = res.data;
        if (res.data.kpis) {
          state.lastDashboardKpis = res.data.kpis;
          state.currentSaldoApp = res.data.kpis.saldo;
        }
        if (state._dashGen === gen) state.dashboardNeedsRefresh = false;
        writeLocalCache("finance_cache_dashboard", res.data);
      }
      return res;
    } finally {
      _dashboardInflight = null;
    }
  })();
  return _dashboardInflight;
}

/** Gira el ícono de un botón mientras se actualiza en segundo plano. */
function setButtonSpinning(btnId, spinning) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  try {
    if (spinning) {
      if (!btn._spinAnim) {
        btn._spinAnim = btn.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 900, iterations: Infinity });
      }
    } else if (btn._spinAnim) {
      btn._spinAnim.cancel();
      btn._spinAnim = null;
    }
  } catch (e) {}
}

let _analysisInflight = null;
/** Pide el análisis financiero (sin duplicar peticiones en curso). */
function fetchAnalysisData() {
  if (_analysisInflight) return _analysisInflight;
  const gen = state._analysisGen;
  _analysisInflight = (async () => {
    try {
      const response = await apiRequest("getFinancialInsights");
      if (response && response.success && response.data) {
        state.cachedAnalysisData = response.data;
        if (state._analysisGen === gen) state.analysisNeedsRefresh = false;
        writeLocalCache("finance_cache_analysis", response.data);
      }
      return response;
    } finally {
      _analysisInflight = null;
    }
  })();
  return _analysisInflight;
}

// ---------- v1.3: Recordatorios y Configuración sin esperas ----------
state.cachedReminders = null;
state.remindersFetchedAt = 0;
state.cachedAdminConsole = null;
state.adminFetchedAt = 0;
const PREFETCH_MAX_AGE_MS = 5 * 60 * 1000;

let _remindersInflight = null;
/** Pide los recordatorios (sin duplicar peticiones en curso) y los guarda en el dispositivo. */
function fetchReminders() {
  if (_remindersInflight) return _remindersInflight;
  _remindersInflight = (async () => {
    try {
      const res = await apiRequest("getReminders");
      if (res && res.success) {
        state.cachedReminders = res.data || [];
        state.remindersFetchedAt = Date.now();
        writeLocalCache("finance_cache_reminders", state.cachedReminders);
      }
      return res;
    } finally {
      _remindersInflight = null;
    }
  })();
  return _remindersInflight;
}

let _adminInflight = null;
/** Pide la consola de administración (sin duplicar peticiones en curso). */
function fetchAdminConsole() {
  if (_adminInflight) return _adminInflight;
  _adminInflight = (async () => {
    try {
      const res = await apiRequest("getAdminConsole");
      if (res && res.success) {
        state.cachedAdminConsole = res.data;
        state.adminFetchedAt = Date.now();
        writeLocalCache("finance_cache_admin", res.data);
      }
      return res;
    } finally {
      _adminInflight = null;
    }
  })();
  return _adminInflight;
}

/**
 * Precarga en segundo plano las pantallas que más se usan, para que abran al instante.
 * Solo pide lo que no se actualizó en los últimos 5 minutos.
 */
let _prefetchTimer = null;
function schedulePrefetch() {
  if (_prefetchTimer) return;
  _prefetchTimer = setTimeout(async () => {
    _prefetchTimer = null;
    if (!state.apiUrl || !state.deviceToken || !navigator.onLine) return;
    try {
      if (!state.remindersFetchedAt || Date.now() - state.remindersFetchedAt > PREFETCH_MAX_AGE_MS) {
        await fetchReminders();
      }
      if (!state.cachedAnalysisData || state.analysisNeedsRefresh) {
        await fetchAnalysisData();
      }
      if (state.user && state.user.rol === "Administrador" &&
          (!state.adminFetchedAt || Date.now() - state.adminFetchedAt > PREFETCH_MAX_AGE_MS)) {
        await fetchAdminConsole();
      }
    } catch (e) {
      console.warn("Precarga en segundo plano no completada:", e);
    }
  }, 2500);
}

function isViewActive(viewId) {
  const el = document.getElementById(viewId);
  return !!(el && el.classList.contains("active"));
}

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
      // v1.5: el service worker se revisa siempre contra el servidor (sin caché HTTP)
      navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })
        .then(reg => {
          console.log("[PWA] Service Worker registrado:", reg.scope);
          try { reg.update(); } catch (e) {}
        })
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

  // v1.2: si este dispositivo ya tiene datos guardados, la app abre AL INSTANTE con ellos
  // y la verificación con el servidor se hace en segundo plano.
  const cachedDash = readLocalCache("finance_cache_dashboard");
  if (cachedDash && !state.cachedDashboardData) {
    state.cachedDashboardData = cachedDash;
    state.lastDashboardKpis = cachedDash.kpis || null;
    state.dashboardNeedsRefresh = true; // se mostrará, pero se actualiza igual
  }
  const cachedAnalysis = readLocalCache("finance_cache_analysis");
  if (cachedAnalysis && !state.cachedAnalysisData) {
    state.cachedAnalysisData = cachedAnalysis;
    state.analysisNeedsRefresh = true;
  }
  const cachedRem = readLocalCache("finance_cache_reminders");
  if (cachedRem && !state.cachedReminders) state.cachedReminders = cachedRem;
  const cachedAdmin = readLocalCache("finance_cache_admin");
  if (cachedAdmin && !state.cachedAdminConsole) state.cachedAdminConsole = cachedAdmin;
  const cachedCatalog = readLocalCache("finance_cache_catalog");
  if (cachedCatalog && !state.catalog) {
    state.catalog = cachedCatalog;
    const cachedUser = getStoredItem("finance_user");
    if (cachedUser && !state.user) {
      try { state.user = JSON.parse(cachedUser); } catch (e) {}
    }
    state.catalogLoadedAt = Date.now(); // evita una segunda consulta de catálogos al mostrar el inicio
    updateUiMeta();
    if (state.catalog.pinActivado && !state.pinVerified) {
      showView("view-pin");
    } else {
      showView("view-home");
    }
    validateDeviceInBackground();
    return;
  }

  showLoader("Verificando dispositivo...");

  try {
    // 1. Descargar catálogos iniciales y verificar estado del dispositivo
    const response = await apiRequest("getUiCatalogues");

    if (response.success) {
      state.catalog = response.data;
      state.catalogLoadedAt = Date.now();
      writeLocalCache("finance_cache_catalog", response.data);
      
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

      if (response.data.geminiApiKey) {
        state.geminiApiKey = response.data.geminiApiKey;
        setStoredItem("finance_gemini_api_key", response.data.geminiApiKey);
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
 * v1.2: Verifica el dispositivo y actualiza catálogos en segundo plano (arranque instantáneo).
 * Si el servidor indica que el dispositivo está pendiente o no existe, se actúa igual que antes.
 * Ante un error de red se mantiene la app abierta con los datos guardados (antes enviaba a la
 * pantalla de vinculación).
 */
async function validateDeviceInBackground() {
  try {
    const response = await apiRequest("getUiCatalogues");
    if (response && response.success) {
      state.catalog = response.data;
      state.catalogLoadedAt = Date.now();
      writeLocalCache("finance_cache_catalog", response.data);
      if (response.data.user) {
        state.user = response.data.user;
        setStoredItem("finance_user", JSON.stringify(state.user));
        setStoredItem("finance_user_name", state.user.nombre);
      }
      if (response.data.geminiApiKey) {
        state.geminiApiKey = response.data.geminiApiKey;
        setStoredItem("finance_gemini_api_key", response.data.geminiApiKey);
      }
      updateUiMeta();
      // Si el PIN se activó desde otro dispositivo, se exige ahora
      if (state.catalog.pinActivado && !state.pinVerified && !isViewActive("view-pin")) {
        showView("view-pin");
      }
    } else if (response) {
      if (response.errorCode === "ERR_DEVICE_PENDING" || (response.message && response.message.includes("ERR_DEVICE_PENDING"))) {
        document.getElementById("pending-device-id").innerText = state.deviceToken.substring(0, 8).toUpperCase();
        showView("view-pending");
      } else if (response.errorCode === "ERR_DEVICE_NOT_FOUND" || (response.message && response.message.includes("ERR_DEVICE_NOT_FOUND"))) {
        if (confirm("Este dispositivo no figura registrado en la planilla. ¿Deseas desconectarlo para volver a vincularlo?")) {
          logout();
        } else {
          prefillSetupForm();
          showView("view-setup");
        }
      } else {
        console.warn("Verificación en segundo plano sin éxito:", response.message);
      }
    }
  } catch (error) {
    console.warn("Sin conexión para verificar el dispositivo; se usan los datos guardados.", error);
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
const APP_VERSION = "1.5";

/** v1.5: muestra la versión de la app al pie del inicio (para confirmar actualizaciones). */
function renderAppVersionLabel() {
  const home = document.getElementById("view-home");
  if (!home || document.getElementById("app-version-label")) return;
  const p = document.createElement("p");
  p.id = "app-version-label";
  p.textContent = "Versión " + APP_VERSION;
  p.style.cssText = "text-align:center;font-size:11px;color:var(--text-secondary);opacity:0.7;margin:12px 0 18px;";
  home.appendChild(p);
}

function updateUiMeta() {
  renderAppVersionLabel();
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

  updateHomeBalance();
}

/**
 * Actualiza la tarjeta de saldo disponible en la pantalla principal.
 */
async function updateHomeBalance() {
  const saldoEl = document.getElementById("home-saldo-amount");
  const activityEl = document.getElementById("home-last-activity");
  if (!saldoEl) return;

  // v1.2: se pinta al instante el último saldo conocido (atenuado si se está actualizando)
  const paint = () => {
    if (state.lastDashboardKpis && state.lastDashboardKpis.saldo !== undefined) {
      saldoEl.innerText = Utils.formatCurrency(state.lastDashboardKpis.saldo);
      if (activityEl && state.cachedDashboardData && state.cachedDashboardData.lastActivityTimestamp) {
        activityEl.innerText = state.cachedDashboardData.lastActivityTimestamp;
      }
    }
    saldoEl.style.opacity = state.dashboardNeedsRefresh ? "0.55" : "";
  };
  paint();

  if (state.lastDashboardKpis && state.lastDashboardKpis.saldo !== undefined && !state.dashboardNeedsRefresh) {
    return;
  }

  // Si no está en memoria o requiere refresco, consultar en segundo plano (sin duplicar peticiones)
  if (state.apiUrl && state.deviceToken) {
    try {
      await fetchDashboard();
    } catch (e) {
      // Si falla en silencio, se mantiene el último valor
    }
    paint();
    saldoEl.style.opacity = "";
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
      state.editingId = null; // v1.1: al volver al inicio se sale del modo edición
      updateHomeBalance();
      schedulePrefetch(); // v1.3
      refreshCatalogSilently(); // Refrescar catálogos y validar estado en segundo plano de forma silenciosa
    } else if (viewId === "view-add-movement" && !state.editingId) {
      resetMovementForm();
    } else if (viewId === "view-dashboard") {
      if (state.cachedDashboardData && !state.dashboardNeedsRefresh) {
        renderDashboard(state.cachedDashboardData);
      } else {
        loadDashboardData(true);
      }
    } else if (viewId === "view-config") {
      loadAdminConsole();
    } else if (viewId === "view-projections") {
      resetProjectionForm();
      loadProjectionsView();
    } else if (viewId === "view-reminders") {
      resetReminderForm();
      loadRemindersView();
    } else if (viewId === "view-analysis") {
      loadAnalysisView();
    }
  }
}

/**
 * Refresca los catálogos en segundo plano de forma silenciosa sin interrumpir la navegación.
 */
let _catalogInflight = null;
async function refreshCatalogSilently() {
  if (!state.apiUrl || !state.deviceToken) return;
  // v1.2: no repetir la consulta si se hizo hace menos de 5 minutos o si ya hay una en curso
  if (_catalogInflight) return;
  if (state.catalogLoadedAt && (Date.now() - state.catalogLoadedAt) < CATALOG_REFRESH_MS) return;
  _catalogInflight = true;
  try {
    const response = await apiRequest("getUiCatalogues");
    if (response.success) {
      state.catalog = response.data;
      state.catalogLoadedAt = Date.now();
      writeLocalCache("finance_cache_catalog", response.data);
      if (response.data.user) {
        state.user = response.data.user;
        localStorage.setItem("finance_user", JSON.stringify(state.user));
      }
      updateUiMeta();
    }
  } catch (error) {
    console.error("Error al refrescar catálogo silenciosamente:", error);
  } finally {
    _catalogInflight = null;
  }
}

// ==========================================================================
// PETICIONES API (HTTP POST)
// ==========================================================================

/**
 * Realiza una llamada HTTP POST estandarizada a la API de Apps Script.
 * Incorpora AbortController para prevenir cuelgues indefinidos en redes móviles lentas.
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

  // Timeout de 28 segundos para evitar bloqueos en conexiones móviles con señal intermitente
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 28000);

  try {
    const response = await fetch(state.apiUrl, {
      method: "POST",
      mode: "cors",
      headers: {
        "Content-Type": "text/plain;charset=utf-8" // GAS requiere text/plain en CORS para evitar preflight OPTIONS
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status}`);
    }

    return await response.json();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err && err.name === "AbortError") {
      const timeoutErr = new Error("TIMEOUT");
      timeoutErr.isTimeout = true;
      throw timeoutErr;
    }
    throw err;
  }
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
  // v1.3: borrar también los datos guardados en memoria de la sesión anterior
  state.cachedDashboardData = null;
  state.lastDashboardKpis = null;
  state.cachedAnalysisData = null;
  state.cachedReminders = null;
  state.cachedAdminConsole = null;
  state.remindersFetchedAt = 0;
  state.adminFetchedAt = 0;
  state.catalogLoadedAt = 0;
  state.dashboardNeedsRefresh = true;
  state.analysisNeedsRefresh = true;
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

  // Limpiar comprobante escaneado
  const receiptFile = document.getElementById("mov-receipt-file");
  if (receiptFile) receiptFile.value = "";
  const receiptUrl = document.getElementById("mov-comprobante-url");
  if (receiptUrl) receiptUrl.value = "";
  const receiptPrev = document.getElementById("receipt-preview-container");
  if (receiptPrev) receiptPrev.classList.add("hidden");
  const suggestedBadge = document.getElementById("receipt-suggested-badge");
  if (suggestedBadge) suggestedBadge.classList.add("hidden");

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
  const cant = Utils.parseNumber(document.getElementById("mov-usd-cantidad").value);
  const tc = Utils.parseNumber(document.getElementById("mov-usd-tc").value);
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
  const monto = Utils.parseNumber(document.getElementById("mov-monto").value);
  const comentario = document.getElementById("mov-comentario").value.trim();

  // Validaciones
  if (!fecha || !tipo || !categoria || !subcategoria || !medioPago || monto <= 0) {
    alert("Por favor completa todos los campos requeridos con valores válidos.");
    return;
  }

  // Prevenir dobles clics deshabilitando el botón de envío inmediatamente
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const originalBtnText = submitBtn ? submitBtn.innerText : "";
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = "Guardando...";
  }

  // Generar ID de cliente anticipado para idempotencia en nuevos movimientos
  const clientMovId = id || ("mov_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7));

  const payload = {
    id: clientMovId,
    fecha: fecha,
    tipo: tipo,
    categoria: categoria,
    subcategoria: subcategoria,
    medioPago: medioPago,
    monto: monto,
    comentario: comentario
  };

  const comprobanteUrl = document.getElementById("mov-comprobante-url") ? document.getElementById("mov-comprobante-url").value : "";
  if (comprobanteUrl) {
    payload.comprobanteUrl = comprobanteUrl;
  }

  // Validar datos USD si corresponde
  const subSelect = document.getElementById("mov-subcategoria");
  const selectedSub = subSelect.options[subSelect.selectedIndex];
  const esUsd = selectedSub && (selectedSub.dataset.esUsd === "S" || selectedSub.dataset.esUsd === "SI");

  if (esUsd) {
    const cant = Utils.parseNumber(document.getElementById("mov-usd-cantidad").value);
    const tc = Utils.parseNumber(document.getElementById("mov-usd-tc").value);

    if (cant <= 0 || tc <= 0) {
      alert("Para compra de USD debes ingresar cantidad y tipo de cambio válidos.");
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerText = originalBtnText;
      }
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
      response = await apiRequest("updateMovement", payload);
    } else {
      // Registro nuevo (lleva clientMovId para evitar duplicados si reintenta por corte de red)
      response = await apiRequest("addMovement", payload);
    }

    if (response.success) {
      // Invalidar caché del dashboard para forzar recálculo fiel con el nuevo dato
      state.dashboardNeedsRefresh = true;
      state.analysisNeedsRefresh = true;

      // Configurar vista de éxito
      document.getElementById("success-title").innerText = id ? "Movimiento Actualizado" : "Movimiento Registrado";
      document.getElementById("success-msg").innerText = response.message;
      
      showView("view-success");
    } else {
      alert("Error: " + response.message);
    }
  } catch (error) {
    if (error && error.isTimeout) {
      // Timeout de red: invalidamos caché y tranquilizamos al usuario
      state.dashboardNeedsRefresh = true;
      alert("La conexión con el servidor tardó más de lo habitual. El movimiento muy probablemente se guardó en la planilla. Verificá en el Dashboard o en Movimientos antes de volver a cargarlo.");
    } else {
      alert("Error de conexión al procesar la solicitud: " + (error.message || ""));
    }
  } finally {
    hideLoader();
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = originalBtnText;
    }
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
    
    if (response.success) {
      renderSearchList(response.data);
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
      ? `<div class="text-secondary small font-weight-500">Compra: $${Utils.parseNumber(item.CANTIDAD_USD).toFixed(2)} USD a TC $${Utils.parseNumber(item.TIPO_CAMBIO).toFixed(2)}</div>` 
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
        <div class="tx-actions">
          <button type="button" class="btn-edit-tx" data-id="${item.ID}" title="Editar movimiento">
            <span class="material-symbols-rounded" style="font-size:14px;">edit</span>
            Editar
          </button>
          <button type="button" class="btn-delete-tx" data-id="${item.ID}" title="Eliminar movimiento">
            <span class="material-symbols-rounded" style="font-size:15px;">delete</span>
          </button>
        </div>
      </div>
    `;

    // Asignar clicks a los botones de editar y eliminar
    card.querySelector(".btn-edit-tx").addEventListener("click", () => {
      loadMovementToEdit(item);
    });

    card.querySelector(".btn-delete-tx").addEventListener("click", () => {
      handleDeleteMovement(item.ID, `${item.CATEGORIA} - ${item.SUBCATEGORIA} (${amountSign}${formattedAmount})`);
    });

    container.appendChild(card);
  });
}

/**
 * Elimina un movimiento tras confirmación y actualiza datos de forma reactiva.
 */
async function handleDeleteMovement(id, detalle = "") {
  const confirmMsg = detalle
    ? `¿Estás seguro de que deseas eliminar este movimiento?\n\n"${detalle}"\n\nEsta acción no se puede deshacer.`
    : "¿Estás seguro de que deseas eliminar este movimiento? Esta acción no se puede deshacer.";

  if (!confirm(confirmMsg)) return;

  showLoader("Eliminando movimiento...");
  try {
    const response = await apiRequest("deleteMovement", { id });
    if (response && response.success) {
      // Invalidar cachés (v1.2: se conserva la última versión para mostrarla mientras se actualiza)
      state.dashboardNeedsRefresh = true;
      state.analysisNeedsRefresh = true;

      // Si estamos en la vista de búsqueda, refrescar lista
      const searchView = document.getElementById("view-search");
      if (searchView && !searchView.classList.contains("hidden") && searchView.classList.contains("active")) {
        await searchMovements();
      }

      // Si estamos en el dashboard se actualiza ahí mismo; si no, en segundo plano sin bloquear
      if (isViewActive("view-dashboard")) {
        loadDashboardData(true);
      } else {
        fetchDashboard().catch(() => {});
      }
      alert("Movimiento eliminado correctamente.");
    } else {
      alert("Error al eliminar: " + (response && response.message ? response.message : "Error desconocido."));
    }
  } catch (error) {
    alert("Error de conexión al eliminar el movimiento.");
  } finally {
    hideLoader();
  }
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
  document.getElementById("mov-monto").value = Utils.parseNumber(item.MONTO).toFixed(2);

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
    document.getElementById("mov-usd-cantidad").value = Utils.parseNumber(item.CANTIDAD_USD).toFixed(2);
    document.getElementById("mov-usd-tc").value = Utils.parseNumber(item.TIPO_CAMBIO).toFixed(2);
    document.getElementById("mov-monto").value = Utils.parseNumber(item.MONTO).toFixed(2);
  } else {
    toggleUsdFields(false);
  }
}

// ==========================================================================
// DASHBOARD (MÉTRICAS, GRÁFICOS Y TABLA DINÁMICA)
// ==========================================================================

/**
 * Destruye de forma segura y defensiva cualquier instancia previa de Chart.js en un canvas.
 * Previene el error fatal 'Canvas is already in use' que traba el Dashboard.
 * @param {string|HTMLCanvasElement} canvasOrId
 * @returns {HTMLCanvasElement|null}
 */
function safeDestroyChart(canvasOrId) {
  const canvas = typeof canvasOrId === "string" ? document.getElementById(canvasOrId) : canvasOrId;
  if (!canvas) return null;
  if (window.Chart && typeof Chart.getChart === "function") {
    try {
      const existing = Chart.getChart(canvas);
      if (existing) {
        existing.destroy();
      }
    } catch (e) {
      console.warn("Aviso al destruir Chart:", e);
    }
  }
  return canvas;
}

/**
 * Carga los datos consolidados del dashboard.
 * Implementa estrategia SWR (Stale-While-Revalidate): usa la memoria si no hubo cambios.
 * @param {boolean} [force=false] - Forzar actualización desde el backend.
 */
async function loadDashboardData(force = false) {
  // Si no se fuerza y tenemos caché válida sin mutaciones pendientes, renderizamos al instante
  if (!force && state.cachedDashboardData && !state.dashboardNeedsRefresh) {
    try {
      renderDashboard(state.cachedDashboardData);
    } catch (e) {
      console.error("Error al renderizar dashboard desde caché:", e);
    }
    return;
  }

  // v1.2: si hay una versión anterior, se muestra AL INSTANTE y se actualiza en segundo plano
  // (el botón de refresco gira mientras tanto). Sin datos previos, se usa el cargador de siempre.
  if (state.cachedDashboardData) {
    try {
      renderDashboard(state.cachedDashboardData);
    } catch (e) {
      console.error("Error al renderizar dashboard desde caché:", e);
    }
    setButtonSpinning("btn-refresh-dashboard", true);
    try {
      const response = await fetchDashboard();
      if (response && response.success && response.data) {
        if (isViewActive("view-dashboard")) renderDashboard(state.cachedDashboardData);
      } else {
        console.warn("Respuesta no satisfactoria, se mantiene la versión anterior:", response);
      }
    } catch (error) {
      console.warn("Error de conexión al refrescar dashboard, se mantiene la versión anterior:", error);
    } finally {
      setButtonSpinning("btn-refresh-dashboard", false);
    }
    return;
  }

  showLoader("Cargando dashboard...");
  try {
    const response = await fetchDashboard();
    if (response && response.success && response.data) {
      renderDashboard(state.cachedDashboardData);
    } else {
      alert("Error al cargar dashboard: " + (response && response.message ? response.message : "Sin respuesta del servidor"));
    }
  } catch (error) {
    console.error("Error al cargar dashboard:", error);
    alert("Error de conexión al cargar el dashboard. Verifica tu conexión a internet.");
  } finally {
    hideLoader();
  }
}

/**
 * Orquesta el renderizado de todos los módulos del Dashboard.
 * Cada bloque está aislado en try/catch para máxima resiliencia.
 * @param {Object} data - Datos completos del dashboard.
 */
function renderDashboard(data) {
  if (!data) return;

  // Actualizar última actividad y saldo actual en memoria
  if (data.lastActivityTimestamp) {
    const activityEl = document.getElementById("home-last-activity");
    if (activityEl) activityEl.innerText = data.lastActivityTimestamp;
  }
  if (data.kpis && data.kpis.saldo !== undefined) {
    state.currentSaldoApp = data.kpis.saldo;
  }
  if (data.ultimoArqueo) {
    state.ultimoArqueo = data.ultimoArqueo;
  }

  // 1. Renderizar KPIs principales y analíticos
  try {
    renderDashboardKpis(data.kpis);
  } catch (e) {
    console.error("Error al renderizar KPIs:", e);
  }

  // 2. Gráfico por Categorías (Dona) y Desglose Revolut-style
  try {
    renderDonutSection(data);
  } catch (e) {
    console.error("Error al renderizar sección de dona:", e);
  }

  // 3. Ranking de Subcategorías del Mes
  try {
    const rankingContainer = document.getElementById("dashboard-ranking-list");
    if (rankingContainer) {
      renderSubcategoryRanking(rankingContainer, data.subcategoriaChart || []);
    }
  } catch (e) {
    console.error("Error al renderizar ranking:", e);
  }

  // 4. Nueva Tabla Dinámica Pivot
  try {
    if (data.pivotData) {
      renderPivotTable(data.pivotData, data.kpis);
    }
  } catch (e) {
    console.error("Error al renderizar tabla pivot:", e);
  }

  // 5. Gráfico Histórico Mensual con Etiquetas Superiores
  try {
    renderMonthlyBarChart(data.mensualChart || []);
  } catch (e) {
    console.error("Error al renderizar gráfico mensual:", e);
  }

  // 6. Nuevo Gráfico: Evolución de la Tasa de Ahorro Histórica (%)
  try {
    renderSavingsRateChart(data.mensualChart || []);
  } catch (e) {
    console.error("Error al renderizar gráfico de tasa de ahorro:", e);
  }

  // 7. Últimos Movimientos
  try {
    renderDashboardRecentList(data.ultimosMovimientos || []);
  } catch (e) {
    console.error("Error al renderizar últimos movimientos:", e);
  }
}

/**
 * Renderiza los KPIs monetarios principales y las tarjetas de análisis comparativo.
 */
function renderDashboardKpis(kpis) {
  if (!kpis) return;
  state.lastDashboardKpis = kpis;

  // Etiqueta indicadora del mes en curso y regla de imputación
  const monthBadge = document.getElementById("dashboard-current-month-badge");
  if (monthBadge) {
    const monthNames = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
    const now = new Date();
    const curMonthName = monthNames[now.getMonth()];
    const curYear = now.getFullYear();
    monthBadge.innerText = `Mes en curso: ${curMonthName} ${curYear} • Los movimientos se imputan según su fecha de movimiento`;
  }

  // KPIs Monetarios Base
  const saldoEl = document.getElementById("kpi-saldo");
  if (saldoEl) {
    saldoEl.innerText = Utils.formatCurrency(kpis.saldo);
    saldoEl.className = kpis.saldo < 0 ? "negative" : "positive";
    const boxEl = document.querySelector(".kpi-saldo-box");
    if (boxEl) boxEl.style.borderColor = kpis.saldo < 0 ? "#f8d7da" : "#d1e7dd";
  }

  const ingEl = document.getElementById("kpi-ingresos");
  if (ingEl) ingEl.innerText = Utils.formatCurrency(kpis.ingresosMes);

  const gastEl = document.getElementById("kpi-gastos");
  if (gastEl) gastEl.innerText = Utils.formatCurrency(kpis.gastosMes);

  const ahorrEl = document.getElementById("kpi-ahorro");
  if (ahorrEl) ahorrEl.innerText = Utils.formatCurrency(kpis.ahorroMes);

  // Proyecciones
  const gastosProyectados = kpis.gastosProyectados || 0;
  const saldoProyectado = kpis.saldoProyectado != null ? kpis.saldoProyectado : kpis.saldo;

  const projEl = document.getElementById("kpi-proyectado");
  if (projEl) projEl.innerText = Utils.formatCurrency(gastosProyectados);

  const saldoProjEl = document.getElementById("kpi-saldo-proyectado");
  if (saldoProjEl) {
    saldoProjEl.innerText = Utils.formatCurrency(saldoProyectado);
    saldoProjEl.style.color = saldoProyectado < 0 ? "var(--danger-color)" : "var(--success-color)";
  }

  // KPIs Analíticos Comparativos (Fase 5)
  const varGastosEl = document.getElementById("kpi-var-gastos");
  const varGastosDiffEl = document.getElementById("kpi-var-gastos-diff");
  if (varGastosEl && varGastosDiffEl) {
    if (kpis.varExpensePct !== null && kpis.varExpensePct !== undefined) {
      const sign = kpis.varExpensePct > 0 ? "+" : "";
      varGastosEl.innerText = `${sign}${kpis.varExpensePct}%`;
      const diffAmount = Math.abs(kpis.varExpenseAmount || 0);
      const diffSign = (kpis.varExpenseAmount || 0) >= 0 ? "más que mes ant." : "menos que mes ant.";
      varGastosDiffEl.innerText = `${Utils.formatCurrency(diffAmount)} ${diffSign}`;
      
      // Coloración neutra y objetiva
      varGastosEl.style.color = (kpis.varExpensePct > 0) ? "#c5221f" : "#137333";
    } else {
      varGastosEl.innerText = "—";
      varGastosEl.style.color = "inherit";
      varGastosDiffEl.innerText = "Primer mes con datos";
    }
  }

  const tasaAhorroEl = document.getElementById("kpi-tasa-ahorro");
  if (tasaAhorroEl) {
    const tasa = kpis.tasaAhorro != null ? kpis.tasaAhorro : 0;
    tasaAhorroEl.innerText = `${tasa}%`;
  }
}

/**
 * Renderiza el gráfico de dona de gastos y la lista desglosada, con soporte para
 * cambio instantáneo de período a partir de los datos en memoria.
 */
function renderDonutSection(data) {
  const catCanvas = document.getElementById("chart-categories");
  if (!catCanvas) return;

  const CHART_COLORS = ["#1a73e8", "#0d9488", "#f9ab00", "#d93025", "#a142f4", "#e37400", "#137333", "#0b57d0", "#c5221f", "#185abc"];

  // Poblar selector de período si existe catálogo
  const selectPeriod = document.getElementById("donut-period-select");
  let activeCategories = [];
  let totalGastos = 0;

  if (selectPeriod && data.periodsCatalog && data.periodsCatalog.length > 0) {
    if (!state.selectedDonutPeriod || !data.periodsCatalog.some(p => p.key === state.selectedDonutPeriod)) {
      state.selectedDonutPeriod = data.selectedPeriodKey || data.periodsCatalog[0].key;
    }

    // Actualizar opciones del select sólo si difieren
    if (selectPeriod.options.length !== data.periodsCatalog.length) {
      selectPeriod.innerHTML = "";
      data.periodsCatalog.forEach(p => {
        const opt = document.createElement("option");
        opt.value = p.key;
        opt.textContent = p.label;
        selectPeriod.appendChild(opt);
      });
    }
    selectPeriod.value = state.selectedDonutPeriod;

    const activePeriod = data.periodsCatalog.find(p => p.key === state.selectedDonutPeriod) || data.periodsCatalog[0];
    activeCategories = activePeriod.categories || [];
    totalGastos = activePeriod.totalGastos || 0;
  } else {
    activeCategories = data.categoriaChart || [];
    totalGastos = activeCategories.reduce((sum, c) => sum + (c.monto || 0), 0);
  }

  // Destruir instancia anterior de forma segura
  safeDestroyChart(catCanvas);

  if (activeCategories.length === 0) {
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
    const catDetails = document.getElementById("dashboard-category-details");
    if (catDetails) catDetails.innerHTML = '<p class="text-secondary small text-center py-2">No hay egresos registrados en este período.</p>';
  } else {
    state.charts.categories = new Chart(catCanvas, {
      type: "doughnut",
      data: {
        labels: activeCategories.map(c => c.categoria),
        datasets: [{
          data: activeCategories.map(c => c.monto),
          backgroundColor: CHART_COLORS
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: "bottom", labels: { boxWidth: 12, font: { size: 12 } } },
          tooltip: {
            callbacks: {
              label: function(context) {
                const val = context.raw || 0;
                const pct = totalGastos > 0 ? ((val / totalGastos) * 100).toFixed(1) : "0.0";
                return `${context.label}: ${Utils.formatCurrency(val)} (${pct}%)`;
              }
            }
          }
        }
      }
    });

    // Desglose estilo Revolut
    const catDetails = document.getElementById("dashboard-category-details");
    if (catDetails) {
      catDetails.innerHTML = "";
      activeCategories.forEach((c, idx) => {
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
  }
}

/**
 * Formateo numérico exclusivo para celdas de la tabla Pivot.
 * Sin signo $, sin abreviaturas (K, M), sin decimales, número completo con separador de miles por punto.
 * Ejemplo: 4300 -> "4.300", 125850 -> "125.850", 1250000 -> "1.250.000"
 * @param {number} val - Importe numérico.
 * @returns {string} Texto formateado o "—" si es 0 o nulo.
 */
function formatPivotNumber(val) {
  if (val === null || val === undefined || isNaN(val)) return "—";
  const num = Math.round(val);
  if (num === 0) return "—";
  return num.toLocaleString("es-AR", { maximumFractionDigits: 0 });
}

/**
 * Renderiza la Tabla Dinámica Tipo Pivot con soporte de dos modos temporales:
 * - Modo "months": 4 meses cronológicos (3 anteriores + mes actual) + Total Año Anterior + YTD + % Var YTD.
 * - Modo "years": Años históricos disponibles + Año Actual YTD + % Var YTD homogénea.
 * Conserva la primera columna fija (sticky), jerarquía de categorías/subcategorías,
 * y expansión/colapso sin recargar datos ni realizar llamadas de red.
 */
function renderPivotTable(pivotData, kpis) {
  const container = document.getElementById("pivot-table-container");
  if (!container) return;

  if (!pivotData || !pivotData.months || pivotData.months.length === 0) {
    container.innerHTML = '<p class="text-secondary small text-center py-3">No hay suficientes datos para la comparativa.</p>';
    return;
  }

  // Sincronizar estado visual de los botones de modo
  const btnMonths = document.getElementById("btn-pivot-mode-months");
  const btnYears = document.getElementById("btn-pivot-mode-years");
  if (btnMonths) btnMonths.classList.toggle("active", state.pivotMode === "months");
  if (btnYears) btnYears.classList.toggle("active", state.pivotMode === "years");

  const subtitleEl = document.getElementById("pivot-subtitle");
  if (subtitleEl) {
    subtitleEl.innerText = state.pivotMode === "years"
      ? "Evolución interanual y comparativa histórica."
      : "Evolución mensual y comparativa anual homogénea.";
  }

  const isYearsMode = state.pivotMode === "years";
  const months = pivotData.months;

  // Años pasados para el modo años
  const allYears = pivotData.years && pivotData.years.length > 0
    ? pivotData.years
    : [pivotData.prevYear, pivotData.currYear];
  let pastYears = allYears.filter(y => y < pivotData.currYear);
  if (pastYears.length === 0) pastYears = [pivotData.prevYear];

  const totalCols = isYearsMode ? (pastYears.length + 3) : (months.length + 4);

  // Encabezado de la tabla
  let html = '<table class="pivot-table"><thead><tr>';
  html += '<th style="text-align:left;">Concepto</th>';

  if (isYearsMode) {
    pastYears.forEach(yr => {
      html += `<th>${yr}</th>`;
    });
    html += `<th class="pivot-th-current">${pivotData.currYear} YTD</th>`;
    html += `<th>Var. Anual</th>`;
  } else {
    months.forEach((m, idx) => {
      const isCurrent = (idx === 3);
      html += `<th class="${isCurrent ? 'pivot-th-current' : ''}">${m.label}</th>`;
    });
    html += `<th>Total ${pivotData.prevYear}</th>`;
    html += `<th>YTD ${pivotData.currYear}</th>`;
    html += `<th>Var. Anual</th>`;
  }
  html += '</tr></thead><tbody>';

  // Helper para generar celdas numéricas con el formato exclusivo de la Pivot
  function renderCells(node, isNet = false) {
    let cellsHtml = '';

    if (isYearsMode) {
      // Columnas de años pasados
      pastYears.forEach(yr => {
        const val = (node.yearly && node.yearly[yr] !== undefined)
          ? node.yearly[yr]
          : (yr === pivotData.prevYear ? (node.prevYearTotal || 0) : 0);

        if (isNet) {
          const colClass = val < 0 ? 'text-danger' : (val > 0 ? 'text-success' : '');
          cellsHtml += `<td class="${colClass}">${formatPivotNumber(val)}</td>`;
        } else {
          cellsHtml += `<td>${val > 0 ? formatPivotNumber(val) : '—'}</td>`;
        }
      });

      // Columna Año Actual YTD
      const currYtd = (node.yearly && node.yearly[pivotData.currYear] !== undefined)
        ? node.yearly[pivotData.currYear]
        : (node.currYearYtd || 0);

      if (isNet) {
        const colClass = currYtd < 0 ? 'text-danger' : (currYtd > 0 ? 'text-success' : '');
        cellsHtml += `<td class="font-weight-bold pivot-td-current ${colClass}">${formatPivotNumber(currYtd)}</td>`;
      } else {
        cellsHtml += `<td class="font-weight-bold pivot-td-current">${currYtd > 0 ? formatPivotNumber(currYtd) : '—'}</td>`;
      }
    } else {
      // Columnas de 4 meses
      for (let i = 0; i < 4; i++) {
        const val = node['m' + i] || 0;
        const isCur = (i === 3);
        if (isNet) {
          const colClass = val < 0 ? 'text-danger' : (val > 0 ? 'text-success' : '');
          cellsHtml += `<td class="${isCur ? 'pivot-td-current font-weight-bold' : ''} ${colClass}">${formatPivotNumber(val)}</td>`;
        } else {
          cellsHtml += `<td class="${isCur ? 'pivot-td-current' : ''}">${val > 0 ? formatPivotNumber(val) : '—'}</td>`;
        }
      }

      // Total Año Anterior
      const prevTot = node.prevYearTotal || 0;
      if (isNet) {
        cellsHtml += `<td class="${prevTot < 0 ? 'text-danger' : 'text-success'}">${formatPivotNumber(prevTot)}</td>`;
      } else {
        cellsHtml += `<td>${prevTot > 0 ? formatPivotNumber(prevTot) : '—'}</td>`;
      }

      // YTD Año Actual
      const currYtd = node.currYearYtd || 0;
      if (isNet) {
        cellsHtml += `<td class="font-weight-bold ${currYtd < 0 ? 'text-danger' : 'text-success'}">${formatPivotNumber(currYtd)}</td>`;
      } else {
        cellsHtml += `<td class="font-weight-bold">${currYtd > 0 ? formatPivotNumber(currYtd) : '—'}</td>`;
      }
    }

    // Variación Anual Homogénea (YTD Actual vs YTD Anterior Homogéneo)
    const prevHomog = node.prevYearYtdHomog || 0;
    const currYtd = node.currYearYtd || 0;
    let trendHtml = '—';

    if (isNet) {
      if (prevHomog !== 0 || currYtd !== 0) {
        const diff = currYtd - prevHomog;
        const sign = diff >= 0 ? '+' : '';
        trendHtml = `<span class="trend-badge ${diff >= 0 ? 'trend-up' : 'trend-down'}">${sign}${formatPivotNumber(diff)}</span>`;
      }
    } else if (prevHomog > 0 && currYtd > 0) {
      const varPct = Math.round(((currYtd - prevHomog) / prevHomog) * 1000) / 10;
      const sign = varPct > 0 ? '+' : '';
      const badgeClass = varPct > 0 ? 'trend-down' : 'trend-up';
      trendHtml = `<span class="trend-badge ${badgeClass}">${sign}${varPct}%</span>`;
    }
    cellsHtml += `<td>${trendHtml}</td>`;
    return cellsHtml;
  }

  // --- SECCIÓN 1: INGRESOS ---
  html += `<tr class="pivot-section-hdr"><td colspan="${totalCols}">INGRESOS</td></tr>`;
  if (pivotData.ingresos && pivotData.ingresos.length > 0) {
    pivotData.ingresos.forEach(cat => {
      const catKey = "Ingreso_" + cat.categoria;
      const isExpanded = !!state.pivotExpandedCategories[catKey];
      const hasSubs = cat.subcategorias && cat.subcategorias.length > 0;

      html += `<tr class="pivot-row-cat" onclick="togglePivotCategory('${catKey}')">`;
      html += `<td><span class="pivot-cat-inner">`;
      if (hasSubs) {
        html += `<span class="material-symbols-rounded pivot-chevron ${isExpanded ? 'open' : ''}">chevron_right</span>`;
      } else {
        html += `<span style="display:inline-block;width:24px;"></span>`;
      }
      html += `<span>${cat.categoria}</span></span></td>`;
      html += renderCells(cat.valores);
      html += `</tr>`;

      if (isExpanded && hasSubs) {
        cat.subcategorias.forEach(sub => {
          html += `<tr class="pivot-row-sub">`;
          html += `<td><span class="pivot-cat-inner"><span>${sub.nombre}</span></span></td>`;
          html += renderCells(sub.valores);
          html += `</tr>`;
        });
      }
    });

    html += `<tr class="pivot-row-total">`;
    html += `<td>Total Ingresos</td>`;
    html += renderCells(pivotData.totales.ingresos);
    html += `</tr>`;
  } else {
    html += `<tr><td colspan="${totalCols}" class="text-secondary small text-center py-2">Sin ingresos registrados.</td></tr>`;
  }

  // --- SECCIÓN 2: GASTOS ---
  html += `<tr class="pivot-section-hdr"><td colspan="${totalCols}">GASTOS</td></tr>`;
  if (pivotData.gastos && pivotData.gastos.length > 0) {
    pivotData.gastos.forEach(cat => {
      const catKey = "Egreso_" + cat.categoria;
      const isExpanded = !!state.pivotExpandedCategories[catKey];
      const hasSubs = cat.subcategorias && cat.subcategorias.length > 0;

      html += `<tr class="pivot-row-cat" onclick="togglePivotCategory('${catKey}')">`;
      html += `<td><span class="pivot-cat-inner">`;
      if (hasSubs) {
        html += `<span class="material-symbols-rounded pivot-chevron ${isExpanded ? 'open' : ''}">chevron_right</span>`;
      } else {
        html += `<span style="display:inline-block;width:24px;"></span>`;
      }
      html += `<span>${cat.categoria}</span></span></td>`;
      html += renderCells(cat.valores);
      html += `</tr>`;

      if (isExpanded && hasSubs) {
        cat.subcategorias.forEach(sub => {
          html += `<tr class="pivot-row-sub">`;
          html += `<td><span class="pivot-cat-inner"><span>${sub.nombre}</span></span></td>`;
          html += renderCells(sub.valores);
          html += `</tr>`;
        });
      }
    });

    html += `<tr class="pivot-row-total">`;
    html += `<td>Total Gastos</td>`;
    html += renderCells(pivotData.totales.gastos);
    html += `</tr>`;
  } else {
    html += `<tr><td colspan="${totalCols}" class="text-secondary small text-center py-2">Sin gastos registrados.</td></tr>`;
  }

  // --- SECCIÓN 3: RESULTADO NETO ---
  html += `<tr class="pivot-row-net">`;
  html += `<td>RESULTADO NETO</td>`;
  html += renderCells(pivotData.totales.resultado, true);
  html += `</tr>`;

  html += '</tbody></table>';

  // Nota explicativa al pie de la tabla según el modo activo
  if (isYearsMode) {
    html += `
      <div class="pivot-info-note">
        <span class="material-symbols-rounded" style="font-size:16px;">info</span>
        <span>Nota: El año <strong>${pivotData.currYear}</strong> se muestra acumulado hasta ${pivotData.currentMonthName} (YTD). La columna <strong>% Var YTD</strong> compara contra el período equivalente de ${pivotData.prevYear}.</span>
      </div>`;
  } else if (kpis && kpis.varAnualHomogGastoPct !== null && kpis.varAnualHomogGastoPct !== undefined) {
    const sign = kpis.varAnualHomogGastoPct > 0 ? '+' : '';
    html += `
      <div class="pivot-info-note">
        <span class="material-symbols-rounded" style="font-size:16px;">info</span>
        <span>Comparativa YTD Homogénea (Ene-${pivotData.currentMonthName} ${pivotData.prevYear} vs Ene-${pivotData.currentMonthName} ${pivotData.currYear}): 
        Variación Gasto Acumulado <strong>${sign}${kpis.varAnualHomogGastoPct}%</strong></span>
      </div>`;
  }

  container.innerHTML = html;
}

/**
 * Expande o colapsa una categoría en la tabla dinámica.
 */
window.togglePivotCategory = function(catKey) {
  state.pivotExpandedCategories[catKey] = !state.pivotExpandedCategories[catKey];
  if (state.cachedDashboardData && state.cachedDashboardData.pivotData) {
    renderPivotTable(state.cachedDashboardData.pivotData, state.cachedDashboardData.kpis);
  }
};

/**
 * Renderiza el gráfico histórico mensual de barras con valores compactos encima de cada barra.
 */
function renderMonthlyBarChart(monthlyData) {
  const monthlyCanvas = document.getElementById("chart-monthly");
  safeDestroyChart(monthlyCanvas);

  if (!monthlyData || monthlyData.length === 0) {
    state.charts.monthly = new Chart(monthlyCanvas, {
      type: "bar",
      data: {
        labels: ["Sin datos históricos"],
        datasets: [{ label: "Sin movimientos", data: [0], backgroundColor: "#e2e8f0" }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false
      }
    });
    return;
  }

  // Plugin Chart.js para dibujar valores numéricos compactos sobre cada barra
  const topLabelsPlugin = {
    id: "topLabelsPlugin",
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      ctx.save();
      ctx.font = "600 9.5px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";

      chart.data.datasets.forEach((dataset, datasetIndex) => {
        const meta = chart.getDatasetMeta(datasetIndex);
        if (meta.hidden) return;

        meta.data.forEach((bar, index) => {
          const val = dataset.data[index];
          if (val > 0) {
            const text = Utils.formatCompactCurrency(val);
            ctx.fillStyle = dataset.backgroundColor || "#4b5563";
            ctx.fillText(text, bar.x, bar.y - 3);
          }
        });
      });
      ctx.restore();
    }
  };

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
      layout: {
        padding: { top: 22, left: 0, right: 0, bottom: 0 }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            font: { size: 10 },
            callback: function(val) { return Utils.formatCompactCurrency(val); }
          }
        },
        x: {
          ticks: { font: { size: 11 } }
        }
      },
      plugins: {
        legend: { display: true, position: "bottom", labels: { boxWidth: 12, font: { size: 12 } } },
        tooltip: {
          callbacks: {
            label: function(context) {
              return `${context.dataset.label}: ${Utils.formatCurrency(context.raw)}`;
            }
          }
        }
      }
    },
    plugins: [topLabelsPlugin]
  });
}

/**
 * Renderiza el gráfico de Evolución de la Tasa de Ahorro Histórica (%)
 * Muestra el porcentaje de ingresos retenidos mes a mes en los últimos 6 meses.
 */
function renderSavingsRateChart(monthlyData) {
  const canvas = document.getElementById("chart-savings-rate");
  if (!canvas) return;

  safeDestroyChart(canvas);

  if (!monthlyData || monthlyData.length === 0) {
    state.charts.savingsRate = new Chart(canvas, {
      type: "line",
      data: {
        labels: ["Sin datos"],
        datasets: [{ label: "Tasa de Ahorro", data: [0], borderColor: "#cbd5e1" }]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });
    return;
  }

  // Calcular tasa de ahorro para cada mes: (ingresos - gastos) / ingresos * 100
  const labels = monthlyData.map(m => m.mes);
  const rates = monthlyData.map(m => {
    const ing = Utils.parseNumber(m.ingresos);
    const gas = Utils.parseNumber(m.gastos);
    if (ing <= 0) return 0;
    const tasa = ((ing - gas) / ing) * 100;
    return Math.round(tasa * 10) / 10;
  });

  const pointColors = rates.map(r => r >= 0 ? "#198754" : "#dc3545");

  state.charts.savingsRate = new Chart(canvas, {
    type: "line",
    data: {
      labels: labels,
      datasets: [{
        label: "Tasa de Ahorro (%)",
        data: rates,
        borderColor: "#1a73e8",
        backgroundColor: "rgba(26, 115, 232, 0.08)",
        fill: true,
        tension: 0.35,
        pointBackgroundColor: pointColors,
        pointBorderColor: "#ffffff",
        pointBorderWidth: 2,
        pointRadius: 6,
        pointHoverRadius: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: { top: 20, left: 10, right: 10, bottom: 5 }
      },
      scales: {
        y: {
          ticks: {
            font: { size: 10 },
            callback: function(val) { return val + "%"; }
          },
          grid: {
            color: "rgba(0, 0, 0, 0.05)"
          }
        },
        x: {
          ticks: { font: { size: 11 } },
          grid: { display: false }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(context) {
              const r = context.raw;
              const idx = context.dataIndex;
              const m = monthlyData[idx];
              const ahorroNeto = (m.ingresos || 0) - (m.gastos || 0);
              return [
                `Tasa de Ahorro: ${r}%`,
                `Ahorro Neto: ${Utils.formatCurrency(ahorroNeto)}`,
                `Ingresos: ${Utils.formatCurrency(m.ingresos || 0)} | Gastos: ${Utils.formatCurrency(m.gastos || 0)}`
              ];
            }
          }
        }
      }
    }
  });
}

/**
 * Renderiza el gráfico y desglose de Gastos por Medio de Pago para el período activo.
 * Se sincroniza automáticamente con el selector de períodos del Dashboard.
 */
function renderPaymentMethodsSection(data) {
  const canvas = document.getElementById("chart-payment-methods");
  const detailsEl = document.getElementById("dashboard-payment-methods-details");
  if (!canvas) return;

  safeDestroyChart(canvas);

  let methodsData = [];
  let totalGastos = 0;

  // Buscar el período activo en el catálogo
  if (data.periodsCatalog && data.periodsCatalog.length > 0) {
    const activePeriod = data.periodsCatalog.find(p => p.key === state.selectedDonutPeriod) || data.periodsCatalog[0];
    methodsData = activePeriod.paymentMethods || [];
    totalGastos = activePeriod.totalGastos || 0;
  } else if (data.paymentMethodChart) {
    methodsData = data.paymentMethodChart;
    totalGastos = methodsData.reduce((sum, m) => sum + (m.monto || 0), 0);
  }

  const PM_COLORS = ["#0d9488", "#1a73e8", "#f9ab00", "#e37400", "#7c3aed", "#d93025", "#5f6368"];

  if (!methodsData || methodsData.length === 0) {
    state.charts.paymentMethods = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels: ["Sin egresos registrados"],
        datasets: [{ data: [1], backgroundColor: ["#e8eaed"] }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true, position: "bottom" } }
      }
    });
    if (detailsEl) {
      detailsEl.innerHTML = '<p class="text-secondary small text-center py-2">No hay egresos en este período.</p>';
    }
    return;
  }

  state.charts.paymentMethods = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: methodsData.map(m => m.medioPago),
      datasets: [{
        data: methodsData.map(m => m.monto),
        backgroundColor: PM_COLORS
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: "bottom",
          labels: { boxWidth: 12, font: { size: 11 } }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const val = context.raw || 0;
              const pct = totalGastos > 0 ? ((val / totalGastos) * 100).toFixed(1) : "0.0";
              return `${context.label}: ${Utils.formatCurrency(val)} (${pct}%)`;
            }
          }
        }
      }
    }
  });

  // Desglose estilo lista con porcentajes
  if (detailsEl) {
    detailsEl.innerHTML = "";
    methodsData.forEach((m, idx) => {
      const pct = totalGastos > 0 ? ((m.monto / totalGastos) * 100).toFixed(1) : "0.0";
      const color = PM_COLORS[idx % PM_COLORS.length];
      detailsEl.innerHTML += `
        <div class="percentage-item">
          <div class="percentage-header">
            <span class="percentage-label" style="display:flex;align-items:center;gap:8px;">
              <span style="width:10px;height:10px;border-radius:50%;background:${color};display:inline-block;flex-shrink:0;"></span>
              ${m.medioPago}
            </span>
            <span class="percentage-values"><strong>${Utils.formatCurrency(m.monto)}</strong> ${pct}%</span>
          </div>
          <div class="progress-bar-container">
            <div class="progress-bar-fill" style="width:${pct}%;background:${color};"></div>
          </div>
        </div>`;
    });
  }
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

    const formattedAmount = Utils.formatCurrency(item.MONTO);

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
        <span class="tx-amount ${amountClass}" style="font-size: 13px;">${amountSign}${formattedAmount}</span>
        <div class="tx-actions" style="margin-top:2px;">
          <button type="button" class="btn-edit-tx" data-id="${item.ID}" title="Editar" style="padding: 2px 7px; font-size: 11px;">
            <span class="material-symbols-rounded" style="font-size:13px;">edit</span>
          </button>
          <button type="button" class="btn-delete-tx" data-id="${item.ID}" title="Eliminar" style="padding: 2px 7px; font-size: 11px;">
            <span class="material-symbols-rounded" style="font-size:13px;">delete</span>
          </button>
        </div>
      </div>
    `;

    card.querySelector(".btn-edit-tx").addEventListener("click", () => {
      loadMovementToEdit(item);
    });

    card.querySelector(".btn-delete-tx").addEventListener("click", () => {
      handleDeleteMovement(item.ID, `${item.CATEGORIA} - ${item.SUBCATEGORIA} (${amountSign}${formattedAmount})`);
    });

    container.appendChild(card);
  });
}

// ==========================================================================
// VISTA: ANÁLISIS FINANCIERO E INSIGHTS INTELIGENTES
// ==========================================================================

/**
 * Carga los datos consolidados de análisis financiero e insights.
 * @param {boolean} [force=false] - Forzar actualización desde el servidor.
 */
async function loadAnalysisView(force = false) {
  if (!force && state.cachedAnalysisData && !state.analysisNeedsRefresh) {
    try {
      renderAnalysisInsights(state.cachedAnalysisData);
    } catch (e) {
      console.error("Error al renderizar análisis desde caché:", e);
    }
    return;
  }

  const fetchAnalysis = fetchAnalysisData; // v1.3: compartida con la precarga

  // v1.2: versión anterior al instante + actualización en segundo plano
  if (state.cachedAnalysisData) {
    try {
      renderAnalysisInsights(state.cachedAnalysisData);
    } catch (e) {
      console.error("Error al renderizar análisis desde caché:", e);
    }
    setButtonSpinning("btn-refresh-analysis", true);
    try {
      const response = await fetchAnalysis();
      if (response && response.success && response.data && isViewActive("view-analysis")) {
        renderAnalysisInsights(state.cachedAnalysisData);
      }
    } catch (err) {
      console.warn("Error de conexión al actualizar análisis, se mantiene la versión anterior:", err);
    } finally {
      setButtonSpinning("btn-refresh-analysis", false);
    }
    return;
  }

  showLoader("Generando análisis y conclusiones...");
  try {
    const response = await fetchAnalysis();
    if (response && response.success && response.data) {
      renderAnalysisInsights(response.data);
    } else {
      alert("Error al obtener análisis: " + (response && response.message ? response.message : "Sin respuesta"));
    }
  } catch (err) {
    console.error("Error al cargar análisis:", err);
    alert("Error de conexión al cargar el análisis financiero.");
  } finally {
    hideLoader();
  }
}

/**
 * Renderiza las tarjetas de conclusiones ordenadas por impacto financiero.
 * @param {Object} data - Objeto con { insights, summary }.
 */
/**
 * v1.4: Tarjetas de "Pronóstico de cierre del mes" y "Presupuesto del mes" (semáforo).
 * Usa los datos { forecast, budgets } que devuelve getFinancialInsights.
 */
function renderForecastAndBudgetHtml(data) {
  if (!data) return "";
  const f = data.forecast;
  const b = data.budgets;
  const money = v => Utils.formatCurrency(v || 0);
  const esc = t => escapeHtml(String(t == null ? "" : t));
  let html = "";

  const row = (label, value, opts = {}) => `
    <div style="display:flex;justify-content:space-between;align-items:baseline;padding:6px 0;border-bottom:1px solid var(--border-light);${opts.strong ? "font-weight:700;" : ""}">
      <span style="color:var(--text-secondary);font-size:13px;">${label}</span>
      <span style="font-size:${opts.big ? "17px" : "14px"};${opts.color ? "color:" + opts.color + ";" : ""}">${value}</span>
    </div>`;

  if (f) {
    const progress = Math.round((f.dia / f.diasMes) * 100);
    const res = f.resultadoProyectado;
    const resColor = res < 0 ? "var(--danger-color)" : "var(--success-color)";
    const saldoColor = f.saldoFinMesProyectado < 0 ? "var(--danger-color)" : "var(--primary-color)";
    const varTxt = (f.varGastoVsPromedioPct === null || f.varGastoVsPromedioPct === undefined) ? "" :
      ` <small style="color:${f.varGastoVsPromedioPct > 0 ? "var(--danger-color)" : "var(--success-color)"};">(${f.varGastoVsPromedioPct > 0 ? "+" : ""}${f.varGastoVsPromedioPct}% vs habitual)</small>`;
    const conf = { buena: "buena", media: "media", baja: "baja" }[f.confianza] || f.confianza;
    html += `
      <div class="card" style="background:var(--card-bg);border-radius:var(--radius-md);padding:16px;margin-bottom:14px;box-shadow:var(--shadow-sm);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <h4 style="margin:0;font-size:15px;color:var(--text-primary);display:flex;align-items:center;gap:6px;">
            <span class="material-symbols-rounded" style="font-size:20px;color:var(--primary-color);">query_stats</span>
            Pronóstico de cierre · ${esc(f.periodoLabel)}
          </h4>
          <span style="font-size:11px;color:var(--text-secondary);">Día ${f.dia} de ${f.diasMes}</span>
        </div>
        <div class="progress-bar-container" style="margin-bottom:10px;"><div class="progress-bar-fill" style="width:${progress}%;background:var(--primary-color);"></div></div>
        ${row("Gastado a la fecha", money(f.egresos.aLaFecha))}
        ${row("Gasto proyectado del mes", money(f.egresos.proyectado) + varTxt, { strong: true })}
        ${f.ahorroEnEgresos && f.ahorroEnEgresos.proyectado > 0 ? row("…de lo cual va a ahorro/inversión", money(f.ahorroEnEgresos.proyectado)) : ""}
        ${row("Ingresos proyectados", money(f.ingresos.proyectado))}
        ${row("Resultado proyectado del mes", money(res), { strong: true, color: resColor })}
        ${f.tasaAhorroRealPct !== null && f.tasaAhorroRealPct !== undefined ? row("Ahorro real proyectado (incluye inversión)", money(f.ahorroRealProyectado) + ` <small>(${f.tasaAhorroRealPct}% de ingresos)</small>`, { color: f.ahorroRealProyectado < 0 ? "var(--danger-color)" : "var(--success-color)" }) : ""}
        ${row("Saldo disponible estimado a fin de mes", money(f.saldoFinMesProyectado), { strong: true, big: true, color: saldoColor })}
        <p class="text-secondary" style="font-size:11px;margin:8px 0 0;">
          Calculado con tu ritmo habitual de gastos e ingresos de ${esc(f.mesesReferenciaLabel)} (confiabilidad ${conf}). Montos nominales, sin ajuste por inflación.
        </p>
      </div>`;
  } else {
    html += `
      <div class="card" style="background:var(--card-bg);border-radius:var(--radius-md);padding:14px;margin-bottom:14px;">
        <h4 style="margin:0 0 4px;font-size:15px;">Pronóstico de cierre del mes</h4>
        <p class="text-secondary small" style="margin:0;">Se activa automáticamente cuando haya al menos un mes completo de movimientos registrados.</p>
      </div>`;
  }

  if (b && b.items && b.items.length > 0) {
    const COLORS = { rojo: "var(--danger-color)", amarillo: "#E0A100", verde: "var(--success-color)", nuevo: "#94A3B8" };
    const LABEL = { rojo: "Superado", amarillo: "Cerca", verde: "En rango", nuevo: "Nuevo" };
    const totalPct = b.totalPresupuesto > 0 ? Math.round((b.totalGastado / b.totalPresupuesto) * 100) : 0;
    let itemsHtml = "";
    b.items.forEach(it => {
      const color = COLORS[it.estado] || COLORS.nuevo;
      const width = it.pct === null ? 100 : Math.min(100, it.pct);
      itemsHtml += `
        <div class="percentage-item">
          <div class="percentage-header">
            <span class="percentage-label" style="display:flex;align-items:center;gap:8px;">
              <span style="width:10px;height:10px;border-radius:50%;background:${color};display:inline-block;flex-shrink:0;" title="${LABEL[it.estado] || ""}"></span>
              ${esc(it.categoria)}${it.esAhorro ? ' <small class="text-secondary">(ahorro)</small>' : ""}
            </span>
            <span class="percentage-values" style="white-space:nowrap;"><strong>${Utils.formatCompactCurrency(it.gastado)}</strong> / ${Utils.formatCompactCurrency(it.presupuesto)}${it.pct !== null ? " · " + it.pct + "%" : ""}</span>
          </div>
          <div class="progress-bar-container">
            <div class="progress-bar-fill" style="width:${width}%;background:${color};"></div>
          </div>
        </div>`;
    });
    html += `
      <div class="card" style="background:var(--card-bg);border-radius:var(--radius-md);padding:16px;margin-bottom:14px;box-shadow:var(--shadow-sm);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <h4 style="margin:0;font-size:15px;color:var(--text-primary);display:flex;align-items:center;gap:6px;">
            <span class="material-symbols-rounded" style="font-size:20px;color:var(--primary-color);">traffic</span>
            Presupuesto del mes
          </h4>
          <span style="font-size:12px;font-weight:700;">${totalPct}% usado</span>
        </div>
        <p class="text-secondary" style="font-size:11px;margin:0 0 10px;">
          Presupuesto automático = ${esc(b.base)}. 🟢 en rango · 🟡 90–110% · 🔴 más de 10% por encima.
        </p>
        ${itemsHtml}
      </div>`;
  }

  if (html) {
    html += `<h4 style="font-size:14px;margin:6px 0 10px;color:var(--text-primary);">Conclusiones</h4>`;
  }
  return html;
}

function renderAnalysisInsights(data) {
  const container = document.getElementById("analysis-insights-container");
  if (!container) return;
  container.innerHTML = "";

  const statCount = document.getElementById("stat-analysis-count");
  const statMax = document.getElementById("stat-analysis-max-impact");

  const insights = (data && data.insights) ? data.insights : [];
  const summary = (data && data.summary) ? data.summary : { totalInsights: 0, maxImpact: 0 };

  if (statCount) statCount.innerText = summary.totalInsights !== undefined ? summary.totalInsights : insights.length;
  if (statMax) statMax.innerText = Utils.formatCurrency(summary.maxImpact || 0);

  // v1.4: Pronóstico de cierre y presupuesto automático (arriba de las conclusiones)
  try {
    const extra = renderForecastAndBudgetHtml(data);
    if (extra) container.insertAdjacentHTML("beforeend", extra);
  } catch (e) {
    console.error("Error al renderizar pronóstico/presupuesto:", e);
  }

  if (insights.length === 0) {
    container.innerHTML += `
      <div class="card text-center p-4" style="background: var(--bg-card); border-radius: var(--radius-md);">
        <span class="material-symbols-rounded" style="font-size: 40px; color: var(--text-secondary); opacity: 0.6;">check_circle</span>
        <h4 class="mt-2" style="color: var(--text-primary); font-size: 15px;">Sin desvíos extraordinarios detectados</h4>
        <p class="text-secondary small mt-1">Tus gastos se mantienen estables dentro de sus rangos normales o aún se requiere mayor historial para modelar patrones estacionales.</p>
      </div>
    `;
    return;
  }

  insights.forEach((item, idx) => {
    const card = document.createElement("div");
    card.className = `insight-card level-${item.level || "info"}`;

    const tipHtml = item.actionTip ? `
      <div class="insight-tip-box">
        <span class="material-symbols-rounded insight-tip-icon">lightbulb</span>
        <p class="insight-tip-text"><b>Sugerencia:</b> ${item.actionTip}</p>
      </div>
    ` : "";

    card.innerHTML = `
      <div class="insight-header-row">
        <span class="insight-badge">${item.badge || "Análisis"}</span>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="insight-impact-rank">#${idx + 1} en impacto</span>
          <span class="insight-metric-tag">${item.metric || ""}</span>
        </div>
      </div>
      <h4 class="insight-title">${item.title}</h4>
      <p class="insight-desc">${item.description}</p>
      ${tipHtml}
    `;

    container.appendChild(card);
  });
}

// ==========================================================================
// SECCIÓN DE CONFIGURACIÓN (ADMINISTRADOR)
// ==========================================================================

async function loadAdminConsole(opts) {
  opts = opts || {};
  // v1.3: se muestra al instante la última versión y se actualiza en segundo plano.
  // Tras un cambio del propio administrador (opts.fresh) se actualiza sin mostrar datos viejos.
  if (state.cachedAdminConsole && !opts.blocking) {
    if (!opts.fresh) renderAdminConsole(state.cachedAdminConsole);
    const before = JSON.stringify(state.cachedAdminConsole);
    try {
      const response = await fetchAdminConsole();
      if (response && response.success && isViewActive("view-config")) {
        // Solo se vuelve a dibujar si algo cambió (evita pisar lo que el usuario esté escribiendo)
        if (opts.fresh || JSON.stringify(state.cachedAdminConsole) !== before) {
          renderAdminConsole(state.cachedAdminConsole);
        }
      } else if (response && !response.success && !opts.fresh) {
        alert("Error al cargar configuración: " + response.message);
        showView("view-home");
      }
    } catch (error) {
      console.warn("Sin conexión al actualizar la configuración; se muestra la última versión.", error);
    }
    return;
  }

  showLoader("Cargando variables...");
  try {
    const response = await fetchAdminConsole();
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

  // Cuentas de Arqueo Real
  if (data.cuentasArqueo) {
    state.cuentasArqueo = data.cuentasArqueo;
    renderCatalogList("list-cfg-cuentas-arqueo", data.cuentasArqueo, "ID_CUENTA", "CUENTAS_ARQUEO", (item) => {
      document.getElementById("cfg-cta-id").value = item.ID_CUENTA;
      document.getElementById("cfg-cta-nombre").value = item.NOMBRE;
      document.getElementById("cfg-cta-estado").value = item.ESTADO;
    });
  }

  // Notificaciones por Email y Gemini
  state.notificationEmails = data.notificationEmails || [];
  renderConfigEmailsList();
  const geminiInput = document.getElementById("cfg-gemini-key");
  if (geminiInput) {
    geminiInput.value = data.geminiApiKey || "";
  }
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
      loadAdminConsole({ fresh: true }); // Recargar consola (v1.3: sin bloquear)
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
      state.catalogLoadedAt = 0; // v1.2: nombre de familia / PIN se reflejan al volver al inicio
      alert(response.message);
      loadAdminConsole({ fresh: true });
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
      state.dashboardNeedsRefresh = true;
      state.catalogLoadedAt = 0; // v1.2: forzar recarga de catálogos al volver al inicio
      alert(response.message);
      resetFormCallback();
      loadAdminConsole({ fresh: true }); // Recargar toda la consola (v1.3: sin bloquear)
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
// GESTIÓN DE NOTIFICACIONES, ARQUEO Y COMPROBANTES CON IA
// ==========================================================================

/**
 * Renderiza la lista de destinatarios de correo en la pestaña de Notificaciones.
 */
function renderConfigEmailsList() {
  const container = document.getElementById("list-cfg-emails");
  if (!container) return;
  container.innerHTML = "";

  if (!state.notificationEmails || state.notificationEmails.length === 0) {
    container.innerHTML = '<div class="p-2 text-center text-secondary small">No hay correos configurados.</div>';
    return;
  }

  state.notificationEmails.forEach((email, idx) => {
    const item = document.createElement("div");
    item.className = "email-recipient-chip";
    item.innerHTML = `
      <span class="email-recipient-address">${email}</span>
      <button type="button" class="btn-remove-email" data-index="${idx}" title="Eliminar">&times;</button>
    `;
    item.querySelector(".btn-remove-email").addEventListener("click", () => {
      removeNotificationEmail(idx);
    });
    container.appendChild(item);
  });
}

/**
 * Elimina un correo de la lista de notificaciones y guarda en backend.
 */
async function removeNotificationEmail(index) {
  if (index < 0 || index >= state.notificationEmails.length) return;
  const removed = state.notificationEmails.splice(index, 1);
  renderConfigEmailsList();
  try {
    const res = await apiRequest("saveNotificationSettings", {
      notificationEmails: state.notificationEmails
    });
    if (!res.success) {
      alert("Error al actualizar destinatarios: " + res.message);
      // Revertir si falló
      state.notificationEmails.splice(index, 0, removed[0]);
      renderConfigEmailsList();
    }
  } catch (err) {
    alert("Error de conexión al eliminar correo.");
    state.notificationEmails.splice(index, 0, removed[0]);
    renderConfigEmailsList();
  }
}

/**
 * Agrega un nuevo correo de notificación.
 */
async function handleConfigEmailAdd(e) {
  e.preventDefault();
  const input = document.getElementById("cfg-new-email");
  if (!input) return;
  const email = input.value.trim().toLowerCase();

  if (!email || !email.includes("@") || !email.includes(".")) {
    alert("Ingresa una dirección de correo válida.");
    return;
  }

  if (state.notificationEmails.includes(email)) {
    alert("Este correo ya está en la lista.");
    return;
  }

  showLoader("Guardando destinatario...");
  try {
    const updatedList = [...state.notificationEmails, email];
    const res = await apiRequest("saveNotificationSettings", {
      notificationEmails: updatedList
    });
    if (res.success) {
      state.notificationEmails = updatedList;
      input.value = "";
      renderConfigEmailsList();
    } else {
      alert("Error al guardar: " + res.message);
    }
  } catch (err) {
    alert("Error de conexión al guardar correo.");
  } finally {
    hideLoader();
  }
}

/**
 * Guarda la clave de Gemini para lectura inteligente de tickets.
 */
async function handleConfigGeminiSubmit(e) {
  e.preventDefault();
  const input = document.getElementById("cfg-gemini-key");
  if (!input) return;
  const key = input.value.trim();

  showLoader("Guardando clave de Gemini...");
  try {
    const res = await apiRequest("saveNotificationSettings", {
      geminiApiKey: key
    });
    if (res.success) {
      state.geminiApiKey = key;
      setStoredItem("finance_gemini_api_key", key);
      alert("Clave de Gemini guardada correctamente.");
    } else {
      alert("Error al guardar clave: " + res.message);
    }
  } catch (err) {
    alert("Error de conexión al guardar clave de Gemini.");
  } finally {
    hideLoader();
  }
}

/**
 * Envía un correo de prueba manual de inmediato.
 */
async function handleSendTestEmail() {
  if (!state.notificationEmails || state.notificationEmails.length === 0) {
    alert("Primero debes agregar al menos una dirección de correo en la lista.");
    return;
  }

  showLoader("Enviando correo de prueba...");
  try {
    const res = await apiRequest("sendTestEmail");
    if (res.success) {
      alert(res.message || "Correo de prueba enviado con éxito.");
    } else {
      alert("No se pudo enviar el correo: " + res.message);
    }
  } catch (err) {
    alert("Error de conexión al enviar correo de prueba.");
  } finally {
    hideLoader();
  }
}

/**
 * Abre el modal de arqueo vs dinero real y carga los datos actuales.
 */
async function openArqueoModal() {
  showLoader("Cargando arqueo...");
  try {
    const res = await apiRequest("getArqueoData");
    if (res.success && res.data) {
      state.cuentasArqueo = res.data.cuentas || [];
      state.ultimoArqueo = res.data.ultimoArqueo || null;
      if (res.data.saldoActual !== undefined) {
        state.currentSaldoApp = res.data.saldoActual;
      }

      // 1. Badge de fecha del último arqueo
      const badge = document.getElementById("arqueo-last-date-badge");
      if (badge) {
        if (state.ultimoArqueo && state.ultimoArqueo.FECHA) {
          badge.innerText = `Último arqueo: ${state.ultimoArqueo.FECHA}`;
        } else {
          badge.innerText = "Último arqueo: Sin registros previos";
        }
      }

      // 2. Renderizar filas de cuentas dinámicas
      const container = document.getElementById("arqueo-accounts-container");
      container.innerHTML = "";

      if (state.cuentasArqueo.length === 0) {
        container.innerHTML = '<div class="text-secondary small p-2">No hay cuentas de arqueo configuradas. Puedes agregarlas desde Configuración > Catálogos.</div>';
      } else {
        const lastDetalle = (state.ultimoArqueo && state.ultimoArqueo.DETALLE) ? state.ultimoArqueo.DETALLE : {};
        
        state.cuentasArqueo.forEach(acc => {
          const row = document.createElement("div");
          row.className = "arqueo-account-row";

          const prevVal = lastDetalle[acc.NOMBRE] !== undefined ? lastDetalle[acc.NOMBRE] : "";
          const displayVal = prevVal !== "" ? (typeof prevVal === "number" ? prevVal.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : prevVal) : "";

          row.innerHTML = `
            <label for="arq-acc-${acc.ID_CUENTA}">${acc.NOMBRE}</label>
            <input type="text" 
                   inputmode="decimal" 
                   id="arq-acc-${acc.ID_CUENTA}" 
                   class="arqueo-account-input" 
                   data-cuenta-id="${acc.ID_CUENTA}" 
                   data-cuenta-nombre="${acc.NOMBRE}" 
                   placeholder="0,00" 
                   value="${displayVal}">
          `;

          const inputEl = row.querySelector("input");
          inputEl.addEventListener("input", recalculateArqueoTotals);
          container.appendChild(row);
        });
      }

      recalculateArqueoTotals();
      document.getElementById("modal-arqueo").classList.remove("hidden");
    } else {
      alert("Error al cargar datos de arqueo: " + (res ? res.message : "Error desconocido"));
    }
  } catch (err) {
    console.error("Error al abrir modal arqueo:", err);
    alert("Error de conexión al cargar datos de arqueo.");
  } finally {
    hideLoader();
  }
}

/**
 * Cierra el modal de arqueo.
 */
function closeArqueoModal() {
  const modal = document.getElementById("modal-arqueo");
  if (modal) modal.classList.add("hidden");
}

/**
 * Recalcula en tiempo real el total de dinero real, saldo en la app y diferencia.
 */
function recalculateArqueoTotals() {
  const inputs = document.querySelectorAll(".arqueo-account-input");
  let totalReal = 0;

  inputs.forEach(inp => {
    const val = Utils.parseNumber(inp.value);
    totalReal += val;
  });

  const saldoApp = state.currentSaldoApp || 0;
  const diferencia = totalReal - saldoApp;

  const totalEl = document.getElementById("arqueo-total-real");
  const saldoEl = document.getElementById("arqueo-saldo-app");
  const diffEl = document.getElementById("arqueo-diferencia");

  if (totalEl) totalEl.innerText = Utils.formatCurrency(totalReal);
  if (saldoEl) saldoEl.innerText = Utils.formatCurrency(saldoApp);

  if (diffEl) {
    diffEl.innerText = Utils.formatCurrency(diferencia);
    diffEl.classList.remove("diff-match", "diff-surplus", "diff-shortage");
    if (Math.abs(diferencia) < 0.01) {
      diffEl.classList.add("diff-match");
    } else if (diferencia > 0) {
      diffEl.classList.add("diff-surplus");
    } else {
      diffEl.classList.add("diff-shortage");
    }
  }
}

/**
 * Guarda el arqueo actual en Google Sheets (Variables.ULTIMO_ARQUEO).
 */
async function handleSaveArqueo(e) {
  e.preventDefault();
  const inputs = document.querySelectorAll(".arqueo-account-input");
  const detalle = {};
  let totalReal = 0;

  inputs.forEach(inp => {
    const cuentaNombre = inp.dataset.cuentaNombre || inp.id;
    const val = Utils.parseNumber(inp.value);
    detalle[cuentaNombre] = val;
    totalReal += val;
  });

  const saldoApp = state.currentSaldoApp || 0;
  const diferencia = totalReal - saldoApp;

  showLoader("Guardando arqueo...");
  try {
    const res = await apiRequest("saveArqueo", {
      totalReal: totalReal,
      saldoApp: saldoApp,
      diferencia: diferencia,
      detalle: detalle
    });

    if (res.success) {
      state.ultimoArqueo = res.data;
      if (res.data && res.data.FECHA) {
        const badge = document.getElementById("arqueo-last-date-badge");
        if (badge) badge.innerText = `Último arqueo: ${res.data.FECHA}`;
      }
      closeArqueoModal();
      alert("¡Arqueo guardado con éxito!");
    } else {
      alert("Error al guardar arqueo: " + res.message);
    }
  } catch (err) {
    console.error("Error al guardar arqueo:", err);
    alert("Error de conexión al guardar el arqueo.");
  } finally {
    hideLoader();
  }
}

/**
 * Comprime una imagen seleccionada por el usuario en el cliente usando HTML5 Canvas.
 * Limita el tamaño a max 1200x1200px y formato JPEG 0.8 para envíos ligeros y rápidos.
 */
function compressImage(file, maxWidth = 1200, maxHeight = 1200, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          }
        } else {
          if (height > maxHeight) {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        const base64Data = dataUrl.split(",")[1];
        resolve({
          dataUrl: dataUrl,
          base64Data: base64Data,
          mimeType: "image/jpeg"
        });
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Maneja la subida del comprobante/ticket, previsualización y análisis automático con IA.
 */
async function handleReceiptFileChange(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  showLoader("Procesando y analizando ticket...");
  try {
    const compressed = await compressImage(file);

    // Mostrar previsualización de inmediato
    const prevImg = document.getElementById("receipt-preview-img");
    const prevContainer = document.getElementById("receipt-preview-container");
    const statusText = document.getElementById("receipt-status-text");
    const suggestedBadge = document.getElementById("receipt-suggested-badge");

    if (prevImg) prevImg.src = compressed.dataUrl;
    if (prevContainer) prevContainer.classList.remove("hidden");
    if (statusText) statusText.innerText = "Subiendo a Drive...";
    if (suggestedBadge) suggestedBadge.classList.add("hidden");

    const currentApiKey = state.geminiApiKey || getStoredItem("finance_gemini_api_key") || "";

    const response = await apiRequest("uploadReceipt", {
      base64Data: compressed.base64Data,
      mimeType: compressed.mimeType,
      fileName: file.name || "ticket.jpg",
      apiKey: currentApiKey
    });

    if (response.success && response.data) {
      const urlInput = document.getElementById("mov-comprobante-url");
      if (urlInput) urlInput.value = response.data.fileUrl || "";

      // Si Gemini extrajo datos, autocompletar campos sugeridos en el formulario
      if (response.data.extracted) {
        if (statusText) statusText.innerText = "Ticket analizado con éxito";
        const ext = response.data.extracted;
        if (suggestedBadge) {
          suggestedBadge.innerText = "✨ Datos sugeridos con IA";
          suggestedBadge.classList.remove("hidden");
        }

        if (ext.monto && !isNaN(Number(ext.monto))) {
          const montoInput = document.getElementById("mov-monto");
          if (montoInput) montoInput.value = ext.monto;
        }

        if (ext.fecha && /^\d{4}-\d{2}-\d{2}$/.test(ext.fecha)) {
          const fechaInput = document.getElementById("mov-fecha");
          if (fechaInput) fechaInput.value = ext.fecha;
        }

        if (ext.concepto) {
          const comInput = document.getElementById("mov-comentario");
          if (comInput) comInput.value = ext.concepto;
        }

        // Sugerir categoría si coincide
        if (ext.categoria && state.catalog && state.catalog.categories) {
          const catSelect = document.getElementById("mov-categoria");
          const extCatLower = ext.categoria.toLowerCase();
          for (let opt of catSelect.options) {
            if (opt.value && (opt.value.toLowerCase().includes(extCatLower) || extCatLower.includes(opt.value.toLowerCase()))) {
              catSelect.value = opt.value;
              catSelect.dispatchEvent(new Event("change"));
              break;
            }
          }
        }

        // Sugerir medio de pago si coincide
        if (ext.medioPago && state.catalog && state.catalog.paymentMethods) {
          const mpSelect = document.getElementById("mov-medio-pago");
          const extMpLower = ext.medioPago.toLowerCase();
          for (let opt of mpSelect.options) {
            if (opt.value && (opt.value.toLowerCase().includes(extMpLower) || extMpLower.includes(opt.value.toLowerCase()))) {
              mpSelect.value = opt.value;
              break;
            }
          }
        }
      } else {
        var errorMsg = response.data.aiError || "";
        if (errorMsg) {
          if (statusText) statusText.innerText = "Comprobante adjuntado (" + errorMsg + ")";
          alert("Aviso de IA: " + errorMsg + "\nPuedes cargar los datos manualmente.");
        } else {
          if (statusText) statusText.innerText = "Comprobante guardado en Drive";
        }
      }
    } else {
      alert("Aviso: " + (response.message || "No se pudo subir a Drive"));
      if (statusText) statusText.innerText = "Error al subir";
    }
  } catch (err) {
    console.error("Error al procesar ticket:", err);
    alert("No se pudo procesar la imagen del ticket.");
  } finally {
    hideLoader();
  }
}

/**
 * Quita el comprobante adjunto del formulario de movimiento.
 */
function handleRemoveReceipt() {
  const fileInput = document.getElementById("mov-receipt-file");
  if (fileInput) fileInput.value = "";
  const urlInput = document.getElementById("mov-comprobante-url");
  if (urlInput) urlInput.value = "";
  const prevContainer = document.getElementById("receipt-preview-container");
  if (prevContainer) prevContainer.classList.add("hidden");
  const suggestedBadge = document.getElementById("receipt-suggested-badge");
  if (suggestedBadge) suggestedBadge.classList.add("hidden");
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

  // Dashboard: card de Proyectados (opcional si existe)
  const kpiProjCard = document.getElementById("kpi-proyectado-card");
  if (kpiProjCard) {
    kpiProjCard.addEventListener("click", () => {
      showView("view-projections");
    });
  }

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

  // Botón de refresco manual del Dashboard
  const btnRefresh = document.getElementById("btn-refresh-dashboard");
  if (btnRefresh) {
    btnRefresh.addEventListener("click", () => {
      loadDashboardData(true);
    });
  }

  // Selector interactivo de período de gastos (Dona y Medios de Pago)
  const donutPeriodSelect = document.getElementById("donut-period-select");
  if (donutPeriodSelect) {
    donutPeriodSelect.addEventListener("change", (e) => {
      state.selectedDonutPeriod = e.target.value;
      if (state.cachedDashboardData) {
        renderDonutSection(state.cachedDashboardData);
      }
    });
  }

  // Botón expandir/colapsar todas las categorías de la tabla Pivot
  const btnToggleAllPivot = document.getElementById("btn-toggle-all-pivot");
  if (btnToggleAllPivot) {
    btnToggleAllPivot.addEventListener("click", () => {
      state.pivotExpandAll = !state.pivotExpandAll;
      if (state.cachedDashboardData && state.cachedDashboardData.pivotData) {
        const p = state.cachedDashboardData.pivotData;
        const allKeys = [
          ...p.ingresos.map(c => "Ingreso_" + c.categoria),
          ...p.gastos.map(c => "Egreso_" + c.categoria)
        ];
        allKeys.forEach(k => {
          state.pivotExpandedCategories[k] = state.pivotExpandAll;
        });

        const icon = document.getElementById("btn-toggle-all-icon");
        const text = document.getElementById("btn-toggle-all-text");
        if (icon) icon.textContent = state.pivotExpandAll ? "unfold_less" : "unfold_more";
        if (text) text.textContent = state.pivotExpandAll ? "Colapsar" : "Expandir";

        renderPivotTable(state.cachedDashboardData.pivotData, state.cachedDashboardData.kpis);
      }
    });
  }

  // Botones de conmutación de modo Pivot: Meses / Años (cambio instantáneo en memoria)
  const btnPivotMonths = document.getElementById("btn-pivot-mode-months");
  const btnPivotYears = document.getElementById("btn-pivot-mode-years");
  if (btnPivotMonths) {
    btnPivotMonths.addEventListener("click", () => {
      if (state.pivotMode !== "months") {
        state.pivotMode = "months";
        if (state.cachedDashboardData && state.cachedDashboardData.pivotData) {
          renderPivotTable(state.cachedDashboardData.pivotData, state.cachedDashboardData.kpis);
        }
      }
    });
  }
  if (btnPivotYears) {
    btnPivotYears.addEventListener("click", () => {
      if (state.pivotMode !== "years") {
        state.pivotMode = "years";
        if (state.cachedDashboardData && state.cachedDashboardData.pivotData) {
          renderPivotTable(state.cachedDashboardData.pivotData, state.cachedDashboardData.kpis);
        }
      }
    });
  }

  // Modo Privacidad ("Ojo de Seguridad")
  const btnTogglePrivacy = document.getElementById("btn-toggle-privacy");
  if (btnTogglePrivacy) {
    btnTogglePrivacy.addEventListener("click", togglePrivacyMode);
  }
  const btnTogglePrivacyDash = document.getElementById("btn-toggle-privacy-dash");
  if (btnTogglePrivacyDash) {
    btnTogglePrivacyDash.addEventListener("click", togglePrivacyMode);
  }
  updatePrivacyIcon();

  // PENDIENTES Y RECORDATORIOS
  const btnToggleNewRem = document.getElementById("btn-toggle-new-reminder");
  if (btnToggleNewRem) {
    btnToggleNewRem.addEventListener("click", () => {
      const card = document.getElementById("card-form-reminder");
      card.classList.toggle("hidden");
      if (!card.classList.contains("hidden")) {
        populateReminderCategories();
      }
    });
  }

  const btnCloseRemForm = document.getElementById("btn-close-reminder-form");
  if (btnCloseRemForm) {
    btnCloseRemForm.addEventListener("click", () => {
      document.getElementById("card-form-reminder").classList.add("hidden");
      resetReminderForm();
    });
  }

  const btnCancelRem = document.getElementById("btn-cancel-reminder");
  if (btnCancelRem) {
    btnCancelRem.addEventListener("click", () => {
      document.getElementById("card-form-reminder").classList.add("hidden");
      resetReminderForm();
    });
  }

  const remCatSelect = document.getElementById("rem-categoria");
  if (remCatSelect) {
    remCatSelect.addEventListener("change", handleReminderCategoryChange);
  }

  const formReminder = document.getElementById("form-reminder");
  if (formReminder) {
    formReminder.addEventListener("submit", handleSaveReminder);

    // Radios de periodicidad: mostrar u ocultar selector de meses
    document.querySelectorAll('input[name="rem-periodicidad"]').forEach(r => {
      r.addEventListener("change", (e) => {
        const picker = document.getElementById("rem-months-picker");
        if (picker) {
          if (e.target.value === "personalizado") {
            picker.classList.remove("hidden");
          } else {
            picker.classList.add("hidden");
          }
        }
      });
    });
  }

  // Arqueo vs Dinero Real
  const btnOpenArqueo = document.getElementById("btn-open-arqueo");
  if (btnOpenArqueo) {
    btnOpenArqueo.addEventListener("click", openArqueoModal);
  }

  const btnCloseArqueo = document.getElementById("btn-close-arqueo");
  if (btnCloseArqueo) {
    btnCloseArqueo.addEventListener("click", closeArqueoModal);
  }

  const btnCancelArqueo = document.getElementById("btn-cancel-arqueo");
  if (btnCancelArqueo) {
    btnCancelArqueo.addEventListener("click", closeArqueoModal);
  }

  const formArqueo = document.getElementById("form-arqueo");
  if (formArqueo) {
    formArqueo.addEventListener("submit", handleSaveArqueo);
  }

  // Notificaciones e IA (Configuración)
  const formCfgCuentasArqueo = document.getElementById("form-config-cuentas-arqueo");
  if (formCfgCuentasArqueo) {
    formCfgCuentasArqueo.addEventListener("submit", (e) => {
      handleCatalogSubmit(
        e,
        "CUENTAS_ARQUEO",
        "ID_CUENTA",
        "cfg-cta-id",
        () => ({
          NOMBRE: document.getElementById("cfg-cta-nombre").value.trim(),
          ESTADO: document.getElementById("cfg-cta-estado").value
        }),
        () => {
          document.getElementById("cfg-cta-id").value = "";
          document.getElementById("cfg-cta-nombre").value = "";
          document.getElementById("cfg-cta-estado").value = "Activo";
        }
      );
    });
  }

  const formCfgEmailAdd = document.getElementById("form-config-email-add");
  if (formCfgEmailAdd) {
    formCfgEmailAdd.addEventListener("submit", handleConfigEmailAdd);
  }

  const btnTestEmail = document.getElementById("btn-test-email");
  if (btnTestEmail) {
    btnTestEmail.addEventListener("click", handleSendTestEmail);
  }

  const formCfgGemini = document.getElementById("form-config-gemini");
  if (formCfgGemini) {
    formCfgGemini.addEventListener("submit", handleConfigGeminiSubmit);
  }

  // Escaneo de comprobantes / fotos de ticket
  const btnScanReceipt = document.getElementById("btn-scan-receipt");
  const movReceiptFile = document.getElementById("mov-receipt-file");
  if (btnScanReceipt && movReceiptFile) {
    btnScanReceipt.addEventListener("click", () => {
      movReceiptFile.click();
    });
    movReceiptFile.addEventListener("change", handleReceiptFileChange);
  }

  const btnRemoveReceipt = document.getElementById("btn-remove-receipt");
  if (btnRemoveReceipt) {
    btnRemoveReceipt.addEventListener("click", handleRemoveReceipt);
  }

  // Navegación y refresco de Análisis Financiero
  const btnDashToAnalysis = document.getElementById("btn-dash-to-analysis");
  if (btnDashToAnalysis) {
    btnDashToAnalysis.addEventListener("click", () => {
      showView("view-analysis");
    });
  }

  const btnRefreshAnalysis = document.getElementById("btn-refresh-analysis");
  if (btnRefreshAnalysis) {
    btnRefreshAnalysis.addEventListener("click", () => {
      loadAnalysisView(true);
    });
  }
}

// ==========================================================================
// PENDIENTES Y RECORDATORIOS (CHECKLIST MENSUAL)
// ==========================================================================

/**
 * Rellena las categorías de tipo Egreso en el formulario de recordatorio.
 */
function populateReminderCategories() {
  const select = document.getElementById("rem-categoria");
  if (!select) return;
  select.innerHTML = '<option value="">Selecciona categoría...</option>';

  if (!state.catalog || !state.catalog.categories) return;

  const egresos = state.catalog.categories.filter(c => c.TIPO === "Egreso" && c.ESTADO === "Activo");
  egresos.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c.NOMBRE;
    opt.dataset.id = c.ID_CATEGORIA;
    opt.textContent = c.NOMBRE;
    select.appendChild(opt);
  });

  const subSelect = document.getElementById("rem-subcategoria");
  if (subSelect) {
    subSelect.innerHTML = '<option value="">Selecciona subcategoría...</option>';
    subSelect.disabled = true;
  }
}

/**
 * Cascada de categoría a subcategoría para recordatorios.
 */
function handleReminderCategoryChange(e) {
  const selectedOpt = e.target.options[e.target.selectedIndex];
  const subSelect = document.getElementById("rem-subcategoria");
  if (!subSelect) return;

  subSelect.innerHTML = '<option value="">Selecciona subcategoría...</option>';
  subSelect.disabled = true;

  if (!selectedOpt || !selectedOpt.dataset.id) return;
  const catId = selectedOpt.dataset.id;
  const subs = (state.catalog.subcategories || []).filter(s => s.ID_CATEGORIA === catId && s.ESTADO === "Activo");

  if (subs.length > 0) {
    subs.forEach(s => {
      const opt = document.createElement("option");
      opt.value = s.NOMBRE;
      opt.dataset.id = s.ID_SUBCATEGORIA;
      opt.textContent = s.NOMBRE;
      subSelect.appendChild(opt);
    });
    subSelect.disabled = false;
  }
}

/**
 * Resetea el formulario de recordatorios.
 */
function resetReminderForm() {
  const form = document.getElementById("form-reminder");
  if (form) form.reset();
  const idInput = document.getElementById("rem-id");
  if (idInput) idInput.value = "";
  const subSelect = document.getElementById("rem-subcategoria");
  if (subSelect) {
    subSelect.innerHTML = '<option value="">Selecciona subcategoría...</option>';
    subSelect.disabled = true;
  }
  const picker = document.getElementById("rem-months-picker");
  if (picker) picker.classList.add("hidden");
  document.querySelectorAll('input[name="rem-month"]').forEach(chk => { chk.checked = false; });
  const radioDefault = document.getElementById("rem-per-mensual");
  if (radioDefault) radioDefault.checked = true;
}

/**
 * Carga los recordatorios desde el backend y los dibuja en pantalla.
 */
async function loadRemindersView(opts) {
  opts = opts || {};
  // v1.3: con datos guardados se muestran al instante y se actualizan en segundo plano
  if (state.cachedReminders && !opts.blocking) {
    if (!opts.keepCurrent) renderRemindersList(state.cachedReminders);
    const bar = document.getElementById("reminders-summary-bar");
    if (bar) bar.style.opacity = "0.55";
    try {
      const response = await fetchReminders();
      if (response && response.success && isViewActive("view-reminders")) {
        renderRemindersList(state.cachedReminders);
      }
    } catch (err) {
      console.warn("Sin conexión al actualizar recordatorios; se muestra la última versión.", err);
    } finally {
      if (bar) bar.style.opacity = "";
    }
    return;
  }

  showLoader("Cargando pendientes y recordatorios...");
  try {
    const response = await fetchReminders();
    if (response.success) {
      renderRemindersList(response.data || []);
    } else {
      alert("Error al cargar recordatorios: " + response.message);
    }
  } catch (err) {
    console.error("Error al cargar recordatorios:", err);
    alert("Error de conexión al cargar recordatorios.");
  } finally {
    hideLoader();
  }
}

/**
 * Renderiza las tarjetas de recordatorios con sus colores y estados.
 * Estados:
 * - status-overdue: Vencido de meses anteriores (Fondo Rojo Claro)
 * - status-pending: Pendiente mensual en curso (Fondo Base de la app)
 * - status-paid: Pagado en el mes actual (Fondo Verde Claro + Tachado)
 */
function renderRemindersList(items) {
  const container = document.getElementById("reminders-list");
  const totalPendingEl = document.getElementById("reminders-total-pending");
  if (!container) return;

  container.innerHTML = "";

  if (!items || items.length === 0) {
    container.innerHTML = `
      <div class="card text-center text-secondary py-4" style="padding: 24px;">
        <span class="material-symbols-rounded" style="font-size:36px;color:var(--text-secondary);margin-bottom:8px;">checklist</span>
        <p>No tienes recordatorios configurados aún.</p>
        <p class="small">Toca el botón <strong>+</strong> arriba para agregar tus pagos fijos (alquiler, impuestos, cuotas, etc.).</p>
      </div>`;
    if (totalPendingEl) totalPendingEl.innerText = Utils.formatCurrency(0);
    return;
  }

  let totalPendiente = 0;

  items.forEach(item => {
    // Calcular suma pendiente (solo lo no pagado: overdue o pending)
    if (item.estadoCalculado !== "paid") {
      totalPendiente += Utils.parseNumber(item.montoEstimado);
    }

    const card = document.createElement("div");
    card.className = `reminder-card status-${item.estadoCalculado}`;

    // Etiqueta del período (Mes al que corresponde el compromiso)
    const periodBadge = item.mesNombre ? `<span class="reminder-period-badge">${escapeHtml(item.mesNombre)}</span>` : "";

    let estadoTag = "";
    if (item.estadoCalculado === "overdue") {
      estadoTag = `<span class="reminder-tag">Vencido</span>`;
    } else if (item.estadoCalculado === "paid") {
      const notaPago = item.isManualPaid ? "Tildado manual" : "Registrado en planilla";
      estadoTag = `<span class="reminder-tag">Completado (${notaPago})</span>`;
    } else {
      estadoTag = `<span class="reminder-tag">Pendiente</span>`;
    }

    const montoFormateado = Utils.formatCurrency(item.montoEstimado || item.monto);
    const montoNota = item.esPromedio ? "prom. 3 meses" : "monto fijo";

    const commentHtml = item.concepto || item.comentario ? `<div class="reminder-comment">${escapeHtml(item.concepto || item.comentario)}</div>` : "";

    // Botón / Checkbox de tildar pago manual
    const isPaidChecked = (item.estadoCalculado === "paid");
    const checkBtnIcon = isPaidChecked ? "check" : "";
    const checkBtnTitle = isPaidChecked ? "Destildar (marcar pendiente)" : "Marcar como pagado";

    // Botón para descartar impago viejo
    let dismissBtn = "";
    if (item.estadoCalculado === "overdue" || item.canDismiss) {
      dismissBtn = `
        <button type="button" class="btn-reminder-action btn-dismiss" onclick="handleDismissReminder('${item.id}', '${item.periodo || item.mesClave || ''}')">
          <span class="material-symbols-rounded" style="font-size:16px;">visibility_off</span>
          Descartar impago
        </button>`;
    }

    const deleteBtn = `
      <button type="button" class="btn-reminder-action btn-delete" onclick="handleDeleteReminder('${item.id}')" title="Eliminar regla recurrente">
        <span class="material-symbols-rounded" style="font-size:16px;">delete</span>
        Eliminar
      </button>`;

    card.innerHTML = `
      <div class="reminder-header-row" style="align-items: center; gap: 12px;">
        <button type="button" class="reminder-check-btn" onclick="handleToggleReminderCheck('${item.id}', '${item.periodo || ''}')" title="${checkBtnTitle}">
          <span class="material-symbols-rounded" style="font-size:18px;">${checkBtnIcon}</span>
        </button>
        <div class="reminder-info">
          <div class="reminder-concept">${escapeHtml(item.subcategoria)}</div>
          <div class="text-secondary small" style="margin-bottom: 2px;">${escapeHtml(item.categoria)}</div>
          ${commentHtml}
          <div class="reminder-meta" style="margin-top: 4px;">
            ${periodBadge}
            ${estadoTag}
          </div>
        </div>
        <div class="reminder-amount-col">
          <span class="reminder-amount">${montoFormateado}</span>
          <span class="reminder-amount-note">${montoNota}</span>
        </div>
      </div>
      <div class="reminder-actions-row">
        ${dismissBtn}
        ${deleteBtn}
      </div>
    `;

    container.appendChild(card);
  });

  if (totalPendingEl) {
    totalPendingEl.innerText = Utils.formatCurrency(totalPendiente);
  }
}

/**
 * Guarda o actualiza un recordatorio recurrente.
 */
async function handleSaveReminder(e) {
  e.preventDefault();
  const cat = document.getElementById("rem-categoria").value.trim();
  const sub = document.getElementById("rem-subcategoria").value.trim();
  const com = document.getElementById("rem-comentario").value.trim();
  const montoInput = document.getElementById("rem-monto").value.trim();
  const periodicidad = document.querySelector('input[name="rem-periodicidad"]:checked').value;

  let meses = "";
  if (periodicidad === "personalizado") {
    const selectedMonths = [];
    document.querySelectorAll('input[name="rem-month"]:checked').forEach(chk => {
      selectedMonths.push(chk.value);
    });
    if (selectedMonths.length === 0) {
      alert("Selecciona al menos un mes para la opción de meses específicos.");
      return;
    }
    meses = selectedMonths.join(",");
  } else if (periodicidad === "unico") {
    // Mes actual YYYY-MM
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    meses = `${now.getFullYear()}-${mm}`;
  }

  if (!cat || !sub) {
    alert("Selecciona la categoría y subcategoría.");
    return;
  }

  showLoader("Guardando recordatorio...");
  try {
    const payload = {
      categoria: cat,
      subcategoria: sub,
      comentario: com,
      concepto: com,
      montoEstimado: montoInput ? Utils.parseNumber(montoInput) : 0,
      periodicidad: periodicidad,
      meses: meses
    };

    const response = await apiRequest("saveReminder", payload);
    if (response.success) {
      document.getElementById("card-form-reminder").classList.add("hidden");
      resetReminderForm();
      loadRemindersView({ keepCurrent: true });
    } else {
      alert("Error: " + response.message);
    }
  } catch (err) {
    alert("Error de conexión al guardar el recordatorio.");
  } finally {
    hideLoader();
  }
}

/**
 * Tilda o destilda manualmente un recordatorio como pagado en un período.
 */
window.handleToggleReminderCheck = async function(id, periodo) {
  // v1.3: el tilde cambia al instante; la confirmación del servidor llega en segundo plano
  const ev = window.event;
  const card = ev && ev.target && ev.target.closest ? ev.target.closest(".reminder-card") : null;
  const icon = card ? card.querySelector(".reminder-check-btn .material-symbols-rounded") : null;
  const prevIcon = icon ? icon.textContent : null;
  if (card) card.style.opacity = "0.6";
  if (icon) icon.textContent = prevIcon === "check" ? "" : "check";
  try {
    const response = await apiRequest("toggleReminderManualPayment", {
      id: id,
      periodo: periodo
    });
    if (response && response.success) {
      state.remindersFetchedAt = 0;
      await loadRemindersView({ keepCurrent: true });
    } else {
      if (icon) icon.textContent = prevIcon;
      alert("Error: " + (response ? response.message : "No se pudo actualizar"));
    }
  } catch (err) {
    if (icon) icon.textContent = prevIcon;
    alert("Error de conexión al actualizar estado.");
  } finally {
    if (card) card.style.opacity = "";
  }
};

/**
 * Elimina una regla de recordatorio recurrente.
 */
window.handleDeleteReminder = async function(id) {
  if (!confirm("¿Deseas eliminar este recordatorio recurrente?")) return;
  const ev = window.event;
  const card = ev && ev.target && ev.target.closest ? ev.target.closest(".reminder-card") : null;
  if (card) card.style.display = "none"; // v1.3: respuesta visual inmediata
  try {
    const response = await apiRequest("deleteReminder", { id: id });
    if (response.success) {
      state.remindersFetchedAt = 0;
      loadRemindersView({ keepCurrent: true });
    } else {
      if (card) card.style.display = "";
      alert("Error: " + response.message);
    }
  } catch (err) {
    if (card) card.style.display = "";
    alert("Error de conexión al eliminar.");
  } finally {
    // sin cargador bloqueante (v1.3)
  }
};

/**
 * Descarta manualmente una ocurrencia impaga anterior para que no moleste más en la lista.
 */
window.handleDismissReminder = async function(idRecordatorio, mesClave) {
  if (!confirm("¿Descartar este pendiente anterior para que ya no aparezca?")) return;
  const ev = window.event;
  const card = ev && ev.target && ev.target.closest ? ev.target.closest(".reminder-card") : null;
  if (card) card.style.display = "none"; // v1.3: respuesta visual inmediata
  try {
    const response = await apiRequest("dismissReminderOccurrence", {
      idRecordatorio: idRecordatorio,
      mesClave: mesClave
    });
    if (response.success) {
      state.remindersFetchedAt = 0;
      loadRemindersView({ keepCurrent: true });
    } else {
      if (card) card.style.display = "";
      alert("Error: " + response.message);
    }
  } catch (err) {
    if (card) card.style.display = "";
    alert("Error de conexión al descartar.");
  } finally {
    // sin cargador bloqueante (v1.3)
  }
};

/**
 * Escapa HTML para prevenir inyecciones.
 */
function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
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
      document.getElementById("proj-monto").value = Utils.parseNumber(item.MONTO).toFixed(2);
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
  const monto = Utils.parseNumber(document.getElementById("proj-monto").value);

  if (!fecha || !concepto || monto <= 0) {
    alert("Completa todos los campos con valores válidos.");
    return;
  }

  showLoader(id ? "Actualizando proyección..." : "Guardando proyección...");
  try {
    const payload = { fecha, concepto, monto };
    if (id) payload.id = id;

    const response = await apiRequest("saveProjection", payload);
    if (response.success) {
      state.dashboardNeedsRefresh = true;
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
      state.dashboardNeedsRefresh = true;
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
      payload.movement.monto = Utils.parseNumber(payBtn.dataset.monto);
    }
  }

  showLoader("Procesando pago...");
  try {
    const response = await apiRequest("payProjection", payload);
    if (response.success) {
      state.dashboardNeedsRefresh = true;
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

  parseNumber: function(val) {
    if (val === null || val === undefined || val === "") return 0;
    if (typeof val === "number") return isNaN(val) ? 0 : val;

    let s = String(val).trim();
    s = s.replace(/[^0-9.,+-]/g, "");
    if (!s) return 0;

    const hasDot = s.includes(".");
    const hasComma = s.includes(",");

    if (hasDot && hasComma) {
      if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
        // Formato AR/ES: "1.250,50" -> quitar puntos y coma a punto
        s = s.replace(/\./g, "").replace(",", ".");
      } else {
        // Formato US/EN: "1,250.50" -> quitar comas
        s = s.replace(/,/g, "");
      }
    } else if (hasComma) {
      const commaParts = s.split(",");
      if (commaParts.length > 2) {
        s = s.replace(/,/g, "");
      } else {
        s = s.replace(",", ".");
      }
    } else if (hasDot) {
      const dotParts = s.split(".");
      if (dotParts.length > 2) {
        s = s.replace(/\./g, "");
      }
    }

    const num = parseFloat(s);
    return isNaN(num) ? 0 : num;
  },

  formatCurrency: function(monto) {
    if (state.privacyMode) {
      return "••••••";
    }
    const val = this.parseNumber(monto);
    return new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: "ARS",
      minimumFractionDigits: 2
    }).format(val);
  },

  formatCompactCurrency: function(monto) {
    if (state.privacyMode) {
      return "••••••";
    }
    const val = this.parseNumber(monto);
    const absVal = Math.abs(val);
    const sign = val < 0 ? "-" : "";
    if (absVal >= 1000000) {
      const formatted = (absVal / 1000000).toLocaleString("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      return sign + "$" + formatted + "M";
    }
    if (absVal >= 1000) {
      const formatted = (absVal / 1000).toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
      return sign + "$" + formatted + "K";
    }
    return sign + "$" + Math.round(absVal).toLocaleString("es-AR");
  }
};

/**
 * Conmuta el modo de privacidad ocultando o mostrando los importes sensibles.
 */
function togglePrivacyMode() {
  state.privacyMode = !state.privacyMode;
  setStoredItem("finance_privacy_mode", state.privacyMode ? "true" : "false");
  updatePrivacyIcon();
  
  // Refrescar vistas activas en pantalla
  updateHomeBalance();
  if (state.cachedDashboardData) {
    renderDashboard(state.cachedDashboardData);
  }
  const currentView = document.querySelector(".view.active");
  if (currentView) {
    if (currentView.id === "view-reminders") {
      loadRemindersView();
    } else if (currentView.id === "view-projections") {
      loadProjectionsView();
    }
  }
}

/**
 * Actualiza el icono del ojo de seguridad en todos los encabezados.
 */
function updatePrivacyIcon() {
  const icon = document.getElementById("icon-privacy");
  if (icon) {
    icon.textContent = state.privacyMode ? "visibility_off" : "visibility";
    icon.title = state.privacyMode ? "Mostrar montos" : "Ocultar montos";
  }
  const iconDash = document.getElementById("icon-privacy-dash");
  if (iconDash) {
    iconDash.textContent = state.privacyMode ? "visibility_off" : "visibility";
    iconDash.title = state.privacyMode ? "Mostrar montos" : "Ocultar montos";
  }
}

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
