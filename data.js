// ================================================
// TOKO BAGIR - data.js
// ✅ FIX: mode: 'cors' untuk semua POST
// ✅ NEW: support harga per ukuran (500g, 1kg, 1 bal)
// ================================================

async function apiGet(action, extraParams) {
  const extra = extraParams ? '&' + extraParams : '';
  const res = await fetch(`${CONFIG.API_URL}?action=${action}${extra}`, {
    method: 'GET',
    mode: 'cors',
  });
  return res.json();
}

const PUBLIC_ACTIONS = ['addOrder','markReadNotif','uploadImage','adminLogin','adminLogout'];

async function apiPost(body) {
  if (!body.token && !PUBLIC_ACTIONS.includes(body.action)) {
    const t = sessionStorage.getItem('bagir_admin_token');
    if (t) body = { ...body, token: t };
  }
  // Pakai text/plain supaya tidak trigger CORS preflight (OPTIONS)
  // Google Apps Script tidak support doOptions dengan benar
  const res = await fetch(CONFIG.API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data && data.authError) {
    sessionStorage.removeItem('bagir_admin_token');
    if (typeof showToast === 'function') showToast('Sesi admin berakhir, silakan login kembali', 'error');
    if (typeof initAdmin === 'function') initAdmin();
  }
  return data;
}

// ─── PRODUK ──────────────────────────────────
async function dbGetProducts() {
  try {
    const r = await apiGet('getProducts');
    if (r.success) {
      localStorage.setItem('bagir_products_cache', JSON.stringify(r.data));
      return r.data;
    }
  } catch(e) { console.warn('Fallback ke cache produk', e); }
  const c = localStorage.getItem('bagir_products_cache');
  return c ? JSON.parse(c) : DEFAULT_PRODUCTS;
}

async function dbAddProduct(d)    { return apiPost({ action:'addProduct', ...d }); }
async function dbUpdateProduct(d) { return apiPost({ action:'updateProduct', ...d }); }
async function dbDeleteProduct(id){ return apiPost({ action:'deleteProduct', id }); }
async function dbUploadImage(base64, fileName, mimeType) { return apiPost({ action:'uploadImage', base64, fileName, mimeType }); }

// ─── SETTINGS ────────────────────────────────
async function dbGetSettings() {
  try { const r = await apiGet('getSettings'); if (r.success) return r.data; } catch(e) {}
  return {};
}
async function dbSaveSettings(d) { return apiPost({ action:'saveSettings', ...d }); }

// ─── ONGKIR ──────────────────────────────────
async function dbGetShippingRates() {
  try { const r = await apiGet('getShippingRates'); if (r.success) return r.data; } catch(e) {}
  return [];
}
async function dbSaveShippingRate(d)   { return apiPost({ action:'saveShippingRate', ...d }); }
async function dbDeleteShippingRate(id){ return apiPost({ action:'deleteShippingRate', id }); }

// ─── ADMIN AUTH ──────────────────────────────
async function dbAdminLogin(username, password) { return apiPost({ action:'adminLogin', username, password }); }
async function dbAdminLogout(token)             { return apiPost({ action:'adminLogout', token }); }
async function dbVerifySession(token) {
  try { const r = await apiGet('verifySession', 'token=' + encodeURIComponent(token)); return r; } catch(e) { return { success:false, valid:false }; }
}
async function dbAdminChangePassword(token, newPassword) { return apiPost({ action:'adminChangePassword', token, newPassword }); }

// ─── PESANAN ─────────────────────────────────
async function dbGetOrders() {
  try {
    const r = await apiGet('getOrders');
    if (r.success) {
      localStorage.setItem('bagir_orders_cache', JSON.stringify(r.data));
      return r.data;
    }
  } catch(e) { console.warn('Fallback ke cache pesanan', e); }
  const c = localStorage.getItem('bagir_orders_cache');
  return c ? JSON.parse(c) : [];
}

async function dbAddOrder(d)             { return apiPost({ action:'addOrder', ...d }); }
async function dbUpdateOrderStatus(id,s) { return apiPost({ action:'updateOrderStatus', id, status:s }); }
async function dbDeleteOrder(id)         { return apiPost({ action:'deleteOrder', id }); }
async function dbUpdateResi(id,resi)     { return apiPost({ action:'updateResi', id, resi }); }
async function dbGetSalesData() {
  try { const r = await apiGet('getSalesData'); if (r.success) return r.data; } catch(e) {}
  return { totalRevenue:0, totalOrders:0, monthly:[], topProducts:[], byStatus:{}, activeOrders:0 };
}

// ─── NOTIFIKASI ──────────────────────────────
async function dbGetNotifications() {
  try {
    const r = await apiGet('getNotifications');
    if (r.success) return r.data;
  } catch(e) {}
  return [];
}
async function dbMarkReadNotif(id)  { return apiPost({ action:'markReadNotif', id }); }
async function dbMarkAllReadNotif() { return apiPost({ action:'markReadNotif', markAll:true }); }

// ─── DATA DEFAULT (fallback offline) ─────────
const DEFAULT_PRODUCTS = [
  {id:1,  name:'Nastar Nanas',    cat:'classic',   emoji:'🍍', price:65000,  price500:120000, price1kg:220000, price1bal:400000, weight:'250g', stock:15, desc:'Nastar lembut isi selai nanas pilihan, rasa manis legit.'},
  {id:2,  name:'Putri Salju',     cat:'classic',   emoji:'❄️', price:60000,  price500:110000, price1kg:200000, price1bal:380000, weight:'250g', stock:12, desc:'Lumer di mulut, taburan gula halus yang membuatnya istimewa.'},
  {id:3,  name:'Kastengel',       cat:'savory',    emoji:'🧀', price:70000,  price500:130000, price1kg:240000, price1bal:450000, weight:'250g', stock:8,  desc:'Gurih keju edam asli pilihan, renyah dan aroma keju kuat.'},
  {id:4,  name:'Lidah Kucing',    cat:'classic',   emoji:'🍪', price:55000,  price500:100000, price1kg:190000, price1bal:360000, weight:'250g', stock:20, desc:'Renyah tipis dan manis sempurna, cocok untuk semua usia.'},
  {id:5,  name:'Choco Chips',     cat:'chocolate', emoji:'🍫', price:75000,  price500:140000, price1kg:260000, price1bal:490000, weight:'250g', stock:10, desc:'Kaya coklat premium dengan chips cokelat melimpah.'},
  {id:6,  name:'Semprit Mawar',   cat:'classic',   emoji:'🌸', price:55000,  price500:100000, price1kg:190000, price1bal:360000, weight:'250g', stock:5,  desc:'Cantik berwarna, manis lembut, cocok untuk parcel.'},
  {id:7,  name:'Almond Butter',   cat:'premium',   emoji:'🥜', price:95000,  price500:180000, price1kg:340000, price1bal:620000, weight:'200g', stock:5,  desc:'Kacang almond panggang pilihan, kaya rasa dan tekstur kress.'},
  {id:8,  name:'Choco Crinkle',   cat:'chocolate', emoji:'🍩', price:80000,  price500:150000, price1kg:280000, price1bal:520000, weight:'200g', stock:0,  desc:'Lembut dalam, renyah luar, full coklat yang memanjakan lidah.'},
  {id:9,  name:'Abon Gulung',     cat:'savory',    emoji:'🥐', price:85000,  price500:160000, price1kg:300000, price1bal:560000, weight:'200g', stock:7,  desc:'Gurih abon sapi suwir premium, tekstur crispy tahan lama.'},
  {id:10, name:'Red Velvet',      cat:'premium',   emoji:'🎂', price:90000,  price500:170000, price1kg:320000, price1bal:590000, weight:'200g', stock:6,  desc:'Warna merah elegan dengan rasa cream cheese yang khas.'},
  {id:11, name:'Biscotti Vanila', cat:'premium',   emoji:'☕', price:85000,  price500:160000, price1kg:300000, price1bal:560000, weight:'200g', stock:9,  desc:'Double-baked khas Italia, cocok menemani kopi atau teh.'},
  {id:12, name:'Sus Kering',      cat:'classic',   emoji:'🫧', price:65000,  price500:120000, price1kg:220000, price1bal:400000, weight:'250g', stock:11, desc:'Ringan renyah dengan isi krim vanila yang harum.'},
];

// ─── HELPER ──────────────────────────────────
function fmt(n) { return 'Rp ' + Number(n).toLocaleString('id-ID'); }

function fmtDate(d) {
  if (!d) return '-';
  try { return new Date(d).toLocaleDateString('id-ID',{day:'2-digit',month:'long',year:'numeric'}); } catch(e) { return d; }
}

function fmtDateTime(d) {
  if (!d) return '-';
  try { return new Date(d).toLocaleString('id-ID',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}); } catch(e) { return d; }
}