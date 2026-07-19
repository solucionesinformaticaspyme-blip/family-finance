/**
 * ==========================================================================
 * LÓGICA DEL FRONTEND: SINGLE PAGE APPLICATION (SPA) - VANILLA JS
 * ==========================================================================
 */

// ESTADO GLOBAL DE LA APLICACIÓN
const state = {
  apiUrl: localStorage.getItem("finance_api_url") || "",
  deviceToken: localStorage.getItem("finance_device_token") || "",
  user: null,         // Datos del usuario actual { nombre, rol }
  catalog: null,      // Catálogos descargados (categorias, subcategorias, etc.)
  pinVerified: false, // Control de acceso por PIN
  editingId: null,    // ID del movimiento que se está editando
  charts: {
    categories: null,
    monthly: null
  }
};

// ==========================================================================
// INICIALIZACIÓN Y FLUJO DE ARRANQUE
// ==========================================================================

document.addEventListener("DOMContentLoaded", () => {
  initEventListeners();
  bootApp();
});

/**
 * Arranca la aplicación comprobando credenciales locales y estado.
 */
async function bootApp() {
  if (!state.apiUrl || !state.deviceToken) {
    showView("view-setup");
    return;
  }

  showLoader("Verificando dispositivo...");

  try {
    // 1. Descargar catálogos iniciales y verificar estado del dispositivo
    const response = await apiRequest("getUiCatalogues");

    if (response.success) {
      state.catalog = response.data;
      
      // Intentar recuperar el perfil de usuario (se obtiene al verificar o guardar en local)
      const cachedUser = localStorage.getItem("finance_user");
      if (cachedUser) {
        state.user = JSON.parse(cachedUser);
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
      if (response.errorCode === "ERR_DEVICE_PENDING") {
        document.getElementById("pending-device-id").innerText = state.deviceToken.substring(0, 8).toUpperCase();
        showView("view-pending");
      } else if (response.errorCode === "ERR_DEVICE_NOT_FOUND") {
        // Dispositivo borrado en Sheets, resetear local
        alert("Este dispositivo ha sido desvinculado por el administrador.");
        logout();
      } else {
        alert("Error de conexión con la planilla: " + response.message);
        showView("view-setup");
      }
    }
  } catch (error) {
    console.error(error);
    alert("No se pudo conectar con la API. Verifica tu conexión a internet o la URL ingresada.");
    showView("view-setup");
  } finally {
    hideLoader();
  }
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

  // Generar token UUID único para el cliente si no existe
  const token = state.deviceToken || generateUUID();

  try {
    // Configurar API temporal en el estado para probar la llamada
    state.apiUrl = url;
    state.deviceToken = token;

    const response = await apiRequest("registerDevice", { nombre: nombre });

    if (response.success) {
      // Guardar permanentemente en localStorage
      localStorage.setItem("finance_api_url", url);
      localStorage.setItem("finance_device_token", token);
      
      const userProfile = {
        nombre: nombre,
        rol: response.data.rol
      };
      localStorage.setItem("finance_user", JSON.stringify(userProfile));
      state.user = userProfile;

      if (response.data.status === "approved") {
        state.pinVerified = true; // Auto-aprobado admin inicial no requiere PIN inmediato
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
  localStorage.clear();
  state.apiUrl = "";
  state.deviceToken = "";
  state.user = null;
  state.catalog = null;
  state.pinVerified = false;
  state.editingId = null;
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
    categoria: categoria,
    subcategoria: subcategoria,
    medioPago: medioPago,
    monto: monto,
    comentario: comentario
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
    if (response.success) {
      renderDashboard(response.data);
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
  // 1. Renderizar KPIs
  const kpis = data.kpis;
  document.getElementById("kpi-saldo").innerText = Utils.formatCurrency(kpis.saldo);
  document.getElementById("kpi-ingresos").innerText = Utils.formatCurrency(kpis.ingresosMes);
  document.getElementById("kpi-gastos").innerText = Utils.formatCurrency(kpis.gastosMes);
  document.getElementById("kpi-ahorro").innerText = Utils.formatCurrency(kpis.ahorroMes);

  // Colorear saldo
  const saldoCard = document.getElementById("kpi-saldo-card");
  if (kpis.saldo < 0) {
    saldoCard.style.backgroundColor = "#fce8e6";
    saldoCard.style.borderColor = "#fad2cf";
    document.getElementById("kpi-saldo").style.color = "var(--danger-color)";
  } else {
    saldoCard.style.backgroundColor = "#e8f0fe";
    saldoCard.style.borderColor = "#aecbfa";
    document.getElementById("kpi-saldo").style.color = "var(--primary-color)";
  }

  // 2. Gráfico por Categorías (Dona)
  const catChartData = data.categoriaChart;
  const catCanvas = document.getElementById("chart-categories");

  if (state.charts.categories) {
    state.charts.categories.destroy();
  }

  if (catChartData.length === 0) {
    // Si no hay egresos, dibujar gráfico vacío explicativo
    state.charts.categories = new Chart(catCanvas, {
      type: "doughnut",
      data: {
        labels: ["Sin egresos"],
        datasets: [{
          data: [1],
          backgroundColor: ["#e8eaed"]
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true, position: "bottom" } }
      }
    });
  } else {
    state.charts.categories = new Chart(catCanvas, {
      type: "doughnut",
      data: {
        labels: catChartData.map(c => c.categoria),
        datasets: [{
          data: catChartData.map(c => c.monto),
          backgroundColor: ["#1a73e8", "#129eaf", "#f9ab00", "#d93025", "#a142f4", "#e37400", "#137333"]
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: "bottom", labels: { boxWidth: 12 } }
        }
      }
    });
  }

  // 3. Gráfico Histórico Mensual (Barras)
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
        {
          label: "Ingresos",
          data: monthlyData.map(m => m.ingresos),
          backgroundColor: "#1e8e3e"
        },
        {
          label: "Gastos",
          data: monthlyData.map(m => m.gastos),
          backgroundColor: "#d93025"
        },
        {
          label: "Ahorros",
          data: monthlyData.map(m => m.ahorros),
          backgroundColor: "#129eaf"
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { beginAtZero: true }
      },
      plugins: {
        legend: { display: true, position: "bottom", labels: { boxWidth: 12 } }
      }
    }
  });

  // 4. Últimos Movimientos
  renderDashboardRecentList(data.ultimosMovimientos);
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
    const date = new Date(fechaStr);
    if (isNaN(date.getTime())) return "";
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  },

  formatDateReadable: function(fechaStr) {
    if (!fechaStr) return "";
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
