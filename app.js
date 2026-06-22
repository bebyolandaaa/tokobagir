// ================================================
// TOKO BAGIR - app.js
// FIX: total pembayaran di tabel, bukti TF, QRIS,
//      dashboard pendapatan, history realtime,
//      notif bunyi walaupun tab tutup
// ================================================

let cart         = [];
let activeFilter = 'semua';
let deliveryMode = 'pickup';
let payMode      = 'transfer';
let adminSubTab  = 'dashboard';
let editingProductId = null;
let allProducts  = [];
let pollTimer    = null;
let selectedImageUrl = '';
let shippingRates = [];
let selectedShipping = null;
let proofUrl = '';
let dpProofUrl = '';
let appSettings = {};
let lastNotifCount = -1;

// ── UKURAN PAKET ────────────────────────────────────────────
// 250g = harga dasar, 500g = 2x, 1kg = 4x (otomatis kalau kolom kosong di Sheets)
// 1 bal = harga manual (beda logika harga grosir)
const PACK_SIZES = [
  { key: '250g', label: '250g',  mult: 1 },
  { key: '500g', label: '500g',  mult: 2 },
  { key: '1kg',  label: '1 kg',  mult: 4 },
  { key: '1bal', label: '1 bal', mult: null }, // manual
];

function getPriceForSize(p, sizeKey) {
  if (sizeKey === '250g') return p.price;
  if (sizeKey === '500g') return p.price500 > 0 ? p.price500 : p.price * 2;
  if (sizeKey === '1kg')  return p.price1kg > 0 ? p.price1kg : p.price * 4;
  if (sizeKey === '1bal') return p.price1bal > 0 ? p.price1bal : 0;
  return p.price;
}

function hasBalOption(p) { return Number(p.price1bal) > 0; }

function itemLabel(i) {
  const sizeLabel = i.size && i.size !== '250g'
    ? ' (' + ({'500g':'500g','1kg':'1 kg','1bal':'1 bal'}[i.size] || i.size) + ')'
    : '';
  return i.name + sizeLabel + ' ×' + i.qty;
}

// ── Proxy gambar Drive lewat Worker ───────────────────────────
function proxyImg(url) {
  if (!url) return '';
  // Konversi semua format URL Drive ke thumbnail
  const idMatch = url.match(/[?&]id=([\w-]+)/) || url.match(/\/d\/([\w-]+)/);
  if (idMatch) {
    return `https://drive.google.com/thumbnail?id=${idMatch[1]}&sz=w800`;
  }
  return url;
}

// ── Service Worker — notif walau tab tutup ───────────────────
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    console.log('SW registered:', reg.scope);

    // Simpan API URL & token ke SW cache untuk background check
    if (reg.active || reg.installing || reg.waiting) {
      const cache = await caches.open('bagir-notif-v1');
      await cache.put('api-url', new Response(CONFIG.API_URL));

      // Coba daftarkan periodic sync (Chrome Android support)
      if ('periodicSync' in reg) {
        try {
          const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
          if (status.state === 'granted') {
            await reg.periodicSync.register('check-notif', { minInterval: 30 * 1000 });
          }
        } catch(e) {}
      }
    }
  } catch(e) { console.warn('SW gagal register:', e); }
}

// Simpan token admin ke SW cache (supaya background check bisa akses)
async function saveSWToken(token) {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open('bagir-notif-v1');
    if (token) {
      await cache.put('admin-token', new Response(token));
      await cache.put('api-url', new Response(CONFIG.API_URL));
    } else {
      await cache.delete('admin-token');
    }
  } catch(e) {}
}

// ── Web Push Notification ────────────────────────────────────
async function requestNotifPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

function sendBrowserNotif(title, body) {
  if (Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, {
      body,
      vibrate: [200, 100, 200],
      tag: 'toko-bagir-' + Date.now(),
    });
    n.onclick = () => { window.focus(); n.close(); };
    setTimeout(() => n.close(), 8000);
  } catch(e) {}
}

// ── Bunyi notifikasi ─────────────────────────────────────────
function playNotifSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.2);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.5);
  } catch(e) {}
}

// ── Render gambar produk ──────────────────────────────────────
function productImg(p) {
  return p && p.image
    ? `<img src="${proxyImg(p.image)}" alt="${p.name||''}" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block" onerror="this.style.display='none'">`
    : `<i class="ti ti-cookie" style="font-size:34px;color:var(--gray-300)"></i>`;
}

// ── INIT ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  registerSW();
  showLoadingGrid('Memuat produk dari database...');
  allProducts = await dbGetProducts();
  renderProducts();
  renderCart();
  renderOrderSummary();
  applySettings(await dbGetSettings());
  shippingRates = await dbGetShippingRates();
  populateProvinceOptions();
  startPoll();
});

function applySettings(s) {
  appSettings = s || {};
  const name    = appSettings.tokoName    || CONFIG.TOKO_NAME    || 'TOKO BAGIR';
  const tagline = appSettings.tokoTagline || CONFIG.TOKO_TAGLINE || '';
  document.querySelectorAll('#toko-name-display, #toko-name-footer').forEach(e => e.textContent = name);
  const tag = document.getElementById('toko-tagline-display');
  if (tag) tag.textContent = tagline;
  document.title = name + (tagline ? ' – ' + tagline : '');

  // ── FIX: QRIS gambar — pakai proxyImg supaya tidak 404 ──
  if (appSettings.qrisImage) {
    const qrisImg = document.getElementById('qris-img');
    if (qrisImg) qrisImg.src = proxyImg(appSettings.qrisImage);
  }

  if (appSettings.heroBgImage || appSettings.headerBg) {
    const bgUrl = appSettings.heroBgImage || appSettings.headerBg;
    const hero  = document.querySelector('.contact-hero, .hero-section, #hero-bg');
    if (hero) {
      hero.style.backgroundImage = `url('${bgUrl}')`;
      hero.style.backgroundSize  = 'cover';
      hero.style.backgroundPosition = 'center';
    }
  }
}

function showLoadingGrid(msg) {
  const el = document.getElementById('product-grid');
  if (el) el.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:50px 0;color:var(--gray-500)"><div class="spinner"></div><p style="margin-top:12px;font-size:13px">${msg}</p></div>`;
}

// ── Poll otomatis ─────────────────────────────────────────────
function startPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    allProducts = await dbGetProducts();
    renderProducts();
    if (sessionStorage.getItem('bagir_admin_token')) {
      await updateNotifBadge();
      if (adminSubTab === 'dashboard') {
        const el = document.getElementById('admin-content');
        if (el) await renderDashboard(el);
      }
      if (adminSubTab === 'orders') {
        const el = document.getElementById('admin-content');
        if (el) await renderOrdersAdmin(el);
      }
    }
  }, CONFIG.POLL_INTERVAL || 30000);
}

// ── NAVIGASI ──────────────────────────────────────────────────
function showPage(p) {
  document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.getElementById('page-' + p)?.classList.add('active');
  document.getElementById('tab-'  + p)?.classList.add('active');
  closeNotifPanel();
  if (p === 'cart')    renderCart();
  if (p === 'order')   renderOrderSummary();
  if (p === 'admin')   initAdmin();
  if (p === 'history') renderHistory();
}

// ── KATALOG ───────────────────────────────────────────────────
function setFilter(f, el) {
  activeFilter = f;
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  renderProducts();
}
function filterProducts() { renderProducts(); }

function renderProducts() {
  const q = (document.getElementById('search-input')?.value || '').toLowerCase();
  let list = allProducts.filter(p => {
    const matchCat = activeFilter === 'semua' || p.cat === activeFilter;
    const matchQ   = p.name.toLowerCase().includes(q) || (p.desc||'').toLowerCase().includes(q);
    return matchCat && matchQ;
  });
  const grid = document.getElementById('product-grid');
  if (!grid) return;
  if (!list.length) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:50px 0;color:var(--gray-400)"><i class="ti ti-search-off" style="font-size:40px;display:block;margin-bottom:10px"></i>Produk tidak ditemukan</div>`;
    return;
  }
  grid.innerHTML = list.map(p => {
    let sb = p.stock === 0 ? `<span class="stock-badge badge-out">Habis</span>`
           : p.stock <= 5  ? `<span class="stock-badge badge-low">Sisa ${p.stock}</span>`
           :                  `<span class="stock-badge badge-ok">Stok ${p.stock}</span>`;
    const sizeOpts = PACK_SIZES.filter(s => s.key !== '1bal' || hasBalOption(p));
    return `<div class="product-card ${p.stock===0?'out-of-stock':''}">
      <div onclick="showDetail(${p.id})" style="cursor:pointer">
        <div class="product-img">${productImg(p)}</div>
        <div class="product-info">
          <div class="product-name">${p.name}</div>
          <div class="product-weight">${p.weight} &nbsp;${sb}</div>
        </div>
      </div>
      <div class="product-info" style="padding-top:0">
        <select class="size-select" id="size-sel-${p.id}" onclick="event.stopPropagation()" onchange="updateCardPrice(${p.id})">
          ${sizeOpts.map(s => `<option value="${s.key}">${s.label} — ${fmt(getPriceForSize(p,s.key))}</option>`).join('')}
        </select>
        <div class="product-bottom">
          <span class="product-price" id="card-price-${p.id}">${fmt(p.price)}</span>
          <button class="add-btn" onclick="event.stopPropagation();addToCart(${p.id}, document.getElementById('size-sel-${p.id}').value)" ${p.stock===0?'disabled':''}>+</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function updateCardPrice(id) {
  const p = allProducts.find(x => x.id === id);
  const sel = document.getElementById('size-sel-' + id);
  const priceEl = document.getElementById('card-price-' + id);
  if (p && sel && priceEl) priceEl.textContent = fmt(getPriceForSize(p, sel.value));
}

function showDetail(id) {
  const p = allProducts.find(x => x.id === id);
  if (!p) return;
  const sizeOpts = PACK_SIZES.filter(s => s.key !== '1bal' || hasBalOption(p));
  document.getElementById('detail-box').innerHTML = `
    <div style="width:120px;height:120px;margin:0 auto 12px;border-radius:14px;overflow:hidden;background:linear-gradient(135deg,var(--blue-50),#EEF4FF);display:flex;align-items:center;justify-content:center">${productImg(p)}</div>
    <div style="font-size:18px;font-weight:800;margin-bottom:4px">${p.name}</div>
    <div style="font-size:12px;color:var(--gray-500);margin-bottom:10px">${p.weight} · ${p.cat}</div>
    <div style="font-size:13px;color:var(--gray-700);line-height:1.6;margin-bottom:16px">${p.desc||''}</div>
    <div style="text-align:left;margin-bottom:14px">
      <label class="form-label">Pilih Ukuran</label>
      <select class="form-select" id="detail-size-sel" onchange="updateDetailPrice(${p.id})">
        ${sizeOpts.map(s => `<option value="${s.key}">${s.label}</option>`).join('')}
      </select>
    </div>
    <div style="font-size:22px;font-weight:900;color:var(--blue-600);margin-bottom:20px" id="detail-price">${fmt(p.price)}</div>
    <div style="display:flex;gap:10px;justify-content:center">
      <button class="submit-btn" style="width:auto;padding:10px 24px"
        onclick="addToCart(${p.id}, document.getElementById('detail-size-sel').value);closeDetail()" ${p.stock===0?'disabled':''}>
        <i class="ti ti-cart-plus"></i>${p.stock===0?'Stok Habis':'Tambah ke Keranjang'}
      </button>
      <button onclick="closeDetail()" style="padding:10px 20px;border:1.5px solid var(--gray-200);border-radius:var(--r-md);background:#fff;cursor:pointer;font-size:13px;font-weight:600">Tutup</button>
    </div>`;
  document.getElementById('detail-modal').classList.add('show');
}

function updateDetailPrice(id) {
  const p = allProducts.find(x => x.id === id);
  const sel = document.getElementById('detail-size-sel');
  const priceEl = document.getElementById('detail-price');
  if (p && sel && priceEl) priceEl.textContent = fmt(getPriceForSize(p, sel.value));
}
function closeDetail() { document.getElementById('detail-modal').classList.remove('show'); }

// ── KERANJANG ─────────────────────────────────────────────────
// cartKey = "id-size" supaya ukuran berbeda dianggap item terpisah
function addToCart(id, size) {
  size = size || '250g';
  const p = allProducts.find(x => x.id === id);
  if (!p || p.stock === 0) return;
  const unitPrice = getPriceForSize(p, size);
  if (size === '1bal' && unitPrice <= 0) { showToast('Ukuran 1 bal belum tersedia untuk produk ini', 'warn'); return; }

  const cartKey = id + '-' + size;
  const ex = cart.find(c => c.cartKey === cartKey);
  if (ex) {
    if (ex.qty < p.stock) ex.qty++;
    else { showToast(`Stok ${p.name} hanya ${p.stock}`, 'warn'); return; }
  } else {
    cart.push({ ...p, cartKey, size, price: unitPrice, qty: 1 });
  }
  updateCartBadge();
  showToast(`${p.name} (${size}) ditambahkan!`);
  renderCart();
  renderOrderSummary();
}

function updateCartBadge() {
  document.getElementById('cart-badge').textContent = cart.reduce((s,c) => s+c.qty, 0);
}

function renderCart() {
  const el = document.getElementById('cart-content');
  if (!el) return;
  if (!cart.length) {
    el.innerHTML = `<div class="cart-empty">
      <i class="ti ti-shopping-cart-off"></i>
      <p style="font-size:14px;font-weight:700;color:var(--gray-700)">Keranjang masih kosong</p>
      <p style="font-size:12px;margin-top:4px">Yuk pilih kue favorit kamu!</p>
      <button onclick="showPage('catalog')" style="margin-top:16px;padding:10px 24px;background:var(--blue-600);color:#fff;border:none;border-radius:var(--r-md);cursor:pointer;font-size:13px;font-weight:700">Lihat Katalog</button>
    </div>`;
    return;
  }
  const sub = cart.reduce((s,c) => s+c.price*c.qty, 0);
  el.innerHTML = cart.map(c => `
    <div class="cart-item">
      <div class="cart-item-icon">${productImg(c)}</div>
      <div class="cart-item-info">
        <div class="cart-item-name">${c.name} <span style="font-weight:600;color:var(--blue-600);font-size:11px">(${PACK_SIZES.find(s=>s.key===c.size)?.label||c.size})</span></div>
        <div class="cart-item-price">${fmt(c.price)} / ${PACK_SIZES.find(s=>s.key===c.size)?.label||c.size}</div>
      </div>
      <div class="qty-ctrl">
        <button class="qty-btn" onclick="changeQty('${c.cartKey}',-1)">−</button>
        <span class="qty-num">${c.qty}</span>
        <button class="qty-btn" onclick="changeQty('${c.cartKey}',1)">+</button>
        <button class="del-btn" onclick="removeItem('${c.cartKey}')"><i class="ti ti-trash"></i></button>
      </div>
    </div>`).join('') +
  `<div class="cart-summary">
    <div class="summary-row"><span>Subtotal (${cart.reduce((s,c)=>s+c.qty,0)} item)</span><span>${fmt(sub)}</span></div>
    <div class="summary-row"><span>Ongkos kirim</span><span>Sesuai lokasi</span></div>
    <div class="summary-total"><span>Total Produk</span><span>${fmt(sub)}</span></div>
    <button class="checkout-btn" onclick="showPage('order')"><i class="ti ti-clipboard-list"></i> Lanjut Pesan</button>
  </div>`;
}

function changeQty(cartKey, d) {
  const item = cart.find(c => c.cartKey === cartKey);
  if (!item) return;
  const p = allProducts.find(x => x.id === item.id);
  item.qty += d;
  if (item.qty <= 0) cart = cart.filter(c => c.cartKey !== cartKey);
  else if (p && item.qty > p.stock) item.qty = p.stock;
  updateCartBadge(); renderCart(); renderOrderSummary();
}
function removeItem(cartKey) {
  cart = cart.filter(c => c.cartKey !== cartKey);
  updateCartBadge(); renderCart(); renderOrderSummary();
}
function clearCart() {
  if (!cart.length) return;
  if (confirm('Kosongkan semua item?')) { cart = []; updateCartBadge(); renderCart(); renderOrderSummary(); }
}

// ── FORM PEMESANAN ────────────────────────────────────────────
function calcGrandTotal() {
  const subtotal = cart.reduce((s,c) => s+c.price*c.qty, 0);
  const ongkir   = (deliveryMode === 'delivery' && selectedShipping) ? selectedShipping.cost : 0;
  return subtotal + ongkir;
}

function renderOrderSummary() {
  const el  = document.getElementById('order-summary-items');
  const tel = document.getElementById('order-total-disp');
  if (!el) return;
  if (!cart.length) {
    el.innerHTML = '<p style="color:var(--blue-400);font-size:12px;margin-bottom:8px">Belum ada produk di keranjang.</p>';
    if (tel) tel.textContent = 'Rp 0';
    return;
  }
  let html = cart.map(c =>
    `<div style="display:flex;justify-content:space-between;font-size:13px;color:var(--blue-800);margin-bottom:5px">
      <span>${c.name} (${PACK_SIZES.find(s=>s.key===c.size)?.label||c.size}) ×${c.qty}</span><span>${fmt(c.price*c.qty)}</span>
    </div>`).join('');
  if (deliveryMode === 'delivery' && selectedShipping) {
    html += `<div style="display:flex;justify-content:space-between;font-size:13px;color:var(--blue-800);margin-bottom:5px;border-top:1px dashed var(--gray-200);padding-top:6px">
      <span>Ongkir (${selectedShipping.courier} ${selectedShipping.service})</span><span>${fmt(selectedShipping.cost)}</span>
    </div>`;
  }
  el.innerHTML = html;
  if (tel) tel.textContent = fmt(calcGrandTotal());
  updateDpVisibility();
}

function selectOpt(group, el, val) {
  if (group === 'delivery') {
    deliveryMode = val;
    document.querySelectorAll('#delivery-opts .radio-opt').forEach(x => x.classList.remove('sel'));
    document.getElementById('addr-row').style.display = val === 'delivery' ? 'block' : 'none';
    const ongkirRow  = document.getElementById('ongkir-row');
    const ongkirInfo = document.getElementById('ongkir-info');
    if (val === 'delivery') {
      ongkirRow.style.display = 'grid';
    } else {
      ongkirRow.style.display = 'none';
      ongkirInfo.style.display = 'none';
      selectedShipping = null;
    }
  } else {
    payMode = val;
    document.querySelectorAll('#pay-opts .radio-opt').forEach(x => x.classList.remove('sel'));
    const qrisBox  = document.getElementById('qris-box');
    if (qrisBox) qrisBox.style.display = val === 'qris' ? 'block' : 'none';
    const proofBox = document.getElementById('proof-box');
    if (proofBox) proofBox.style.display = (val === 'transfer' || val === 'qris') ? 'block' : 'none';
    // Label ganti sesuai metode
    const proofLabel = document.getElementById('proof-label');
    if (proofLabel) proofLabel.textContent = val === 'qris' ? 'Upload Bukti QRIS *' : 'Upload Bukti Transfer *';
  }
  el.classList.add('sel');
  updateDpVisibility();
  renderOrderSummary();
}

function updateDpVisibility() {
  const dpBox = document.getElementById('dp-box');
  if (!dpBox) return;
  const total = cart.reduce((s,c) => s+c.price*c.qty, 0);
  const needDp = payMode === 'cod' && deliveryMode === 'pickup' && total >= 100000;
  dpBox.style.display = needDp ? 'block' : 'none';
}

// ── ONGKIR ────────────────────────────────────────────────────
function populateProvinceOptions() {
  const sel = document.getElementById('f-province');
  if (!sel) return;
  const provinces = [...new Set(shippingRates.map(r => r.province))];
  sel.innerHTML = '<option value="">— Pilih Provinsi —</option>' +
    provinces.map(p => `<option value="${p}">${p}</option>`).join('');
}

function onProvinceChange() {
  const province = document.getElementById('f-province').value;
  const citySel  = document.getElementById('f-city');
  const cities   = shippingRates.filter(r => r.province === province).map(r => r.city);
  citySel.innerHTML = '<option value="">— Pilih Kota —</option>' +
    cities.map(c => `<option value="${c}">${c}</option>`).join('');
  selectedShipping = null;
  document.getElementById('ongkir-info').style.display = 'none';
  renderOrderSummary();
}

function onCityChange() {
  const province = document.getElementById('f-province').value;
  const city     = document.getElementById('f-city').value;
  const rate     = shippingRates.find(r => r.province === province && r.city === city);
  const infoBox  = document.getElementById('ongkir-info');
  if (rate) {
    selectedShipping = rate;
    document.getElementById('ongkir-detail').textContent = `${rate.courier} ${rate.service} · estimasi ${rate.etd}`;
    document.getElementById('ongkir-cost').textContent = fmt(rate.cost);
    infoBox.style.display = 'block';
  } else {
    selectedShipping = null;
    infoBox.style.display = 'none';
    if (city) showToast('Ongkir untuk kota ini belum tersedia','error');
  }
  renderOrderSummary();
}

// ── UPLOAD BUKTI ──────────────────────────────────────────────
async function handleProofUpload(ev, wrapId, onDone) {
  const file = ev.target.files[0];
  if (!file) return;
  const wrap = document.getElementById(wrapId);
  wrap.classList.remove('empty');
  wrap.innerHTML = `<div class="spinner" style="width:24px;height:24px;border-width:2px"></div>`;
  const reader = new FileReader();
  reader.onload = async () => {
    const base64 = reader.result.split(',')[1];
    try {
      const res = await dbUploadImage(base64, file.name, file.type);
      if (res.success) {
        wrap.innerHTML = `<img src="${proxyImg(res.url)}" style="max-width:100%;border-radius:8px">`;
        onDone(res.url);
        showToast('Bukti berhasil diupload ✅');
      } else {
        wrap.innerHTML = `<i class="ti ti-photo-off"></i>`;
        wrap.classList.add('empty');
        showToast(res.message || 'Gagal upload bukti','error');
      }
    } catch(e) {
      wrap.innerHTML = `<i class="ti ti-photo-off"></i>`;
      wrap.classList.add('empty');
      showToast('Gagal upload. Cek koneksi!','error');
    }
  };
  reader.readAsDataURL(file);
}
function onProofSelected(ev)   { handleProofUpload(ev, 'proof-preview-wrap',    url => proofUrl = url); }
function onDpProofSelected(ev) { handleProofUpload(ev, 'dp-proof-preview-wrap', url => dpProofUrl = url); }

// ── SUBMIT PESANAN ────────────────────────────────────────────
async function submitOrder() {
  const name         = document.getElementById('f-name').value.trim();
  const phone        = document.getElementById('f-phone').value.trim();
  const orderDate    = document.getElementById('f-date').value;
  const deliveryDate = document.getElementById('f-delivery-date')?.value || '';
  const addr         = document.getElementById('f-addr').value.trim();
  const note         = document.getElementById('f-note').value.trim();
  const total        = calcGrandTotal();
  const subtotal     = cart.reduce((s,c) => s+c.price*c.qty, 0);

  if (!name)  { showToast('Nama lengkap wajib diisi!','error'); return; }
  if (!phone) { showToast('Nomor WhatsApp wajib diisi!','error'); return; }
  if (!cart.length) { showToast('Keranjang masih kosong!','error'); return; }
  if (deliveryMode === 'delivery') {
    if (!addr) { showToast('Alamat pengiriman wajib diisi!','error'); return; }
    if (!selectedShipping) { showToast('Pilih provinsi & kota tujuan untuk hitung ongkir!','error'); return; }
  }
  if ((payMode === 'transfer' || payMode === 'qris') && !proofUrl) {
    showToast('Upload bukti pembayaran terlebih dahulu!','error'); return;
  }
  const needDp = payMode === 'cod' && deliveryMode === 'pickup' && subtotal >= 100000;
  let dpAmount = 0;
  if (needDp) {
    dpAmount = Number(document.getElementById('f-dp').value);
    if (!dpAmount || dpAmount < subtotal * 0.5) {
      showToast('DP minimal 50% wajib diisi!','error'); return;
    }
    if (!dpProofUrl) { showToast('Upload bukti DP terlebih dahulu!','error'); return; }
  }

  const btn = document.getElementById('order-submit-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:20px;height:20px;border-width:2px;display:inline-block;margin-right:8px"></div> Menyimpan...';

  try {
    const res = await dbAddOrder({
      name, phone,
      items: cart.map(c => ({ name:c.name, size:c.size, qty:c.qty, price:c.price })),
      total,
      orderDate: orderDate || new Date().toISOString().slice(0,10),
      deliveryDate,
      delivery: deliveryMode, payment: payMode,
      address: addr, note,
      courier: selectedShipping?.courier || '',
      service: selectedShipping?.service || '',
      shippingCost: selectedShipping?.cost || 0,
      city: selectedShipping?.city || '',
      province: selectedShipping?.province || '',
      paymentProof: proofUrl || dpProofUrl || '',
      dpAmount
    });

    // Update stok cache lokal
    cart.forEach(c => {
      const p = allProducts.find(x => x.id === c.id);
      if (p) p.stock = Math.max(0, p.stock - c.qty);
    });
    localStorage.setItem('bagir_products_cache', JSON.stringify(allProducts));

    // Simpan ke history lokal
    localStorage.setItem('bagir_my_phone', phone);
    const history = JSON.parse(localStorage.getItem('bagir_my_orders') || '[]');
    history.unshift({
      id: res.id, name,
      items: cart.map(itemLabel).join(', '),
      total, date: orderDate || new Date().toISOString().slice(0,10),
      status: 'baru', resi: ''
    });
    localStorage.setItem('bagir_my_orders', JSON.stringify(history));

    // Reset form
    cart = []; updateCartBadge(); renderCart(); renderOrderSummary();
    ['f-name','f-phone','f-date','f-delivery-date','f-addr','f-note','f-dp'].forEach(id => {
      const e = document.getElementById(id); if (e) e.value = '';
    });
    selectedShipping = null; proofUrl = ''; dpProofUrl = '';
    document.getElementById('ongkir-row').style.display  = 'none';
    document.getElementById('ongkir-info').style.display = 'none';
    document.getElementById('dp-box').style.display      = 'none';
    const pw1 = document.getElementById('proof-preview-wrap');
    const pw2 = document.getElementById('dp-proof-preview-wrap');
    if (pw1) { pw1.innerHTML = '<i class="ti ti-receipt"></i>'; pw1.classList.add('empty'); }
    if (pw2) { pw2.innerHTML = '<i class="ti ti-receipt"></i>'; pw2.classList.add('empty'); }

    document.getElementById('success-msg').innerHTML =
      `Halo <strong>${name}</strong>! 🎉<br>
       Pesanan <strong>${res.id}</strong> senilai <strong>${fmt(total)}</strong> sudah kami terima.<br>
       Kami akan segera menghubungi kamu di <strong>${phone}</strong>.<br>
       Pantau status pesanan di tab <strong>History</strong> ya!`;
    document.getElementById('success-modal').classList.add('show');
  } catch(e) {
    showToast('Gagal menyimpan pesanan. Cek koneksi!','error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="ti ti-check"></i> Konfirmasi Pesanan';
  }
}

function closeSuccess() {
  document.getElementById('success-modal').classList.remove('show');
  showPage('catalog');
}

// ── HISTORY (customer) — FIX: selalu sync dari server ────────
async function renderHistory() {
  const el = document.getElementById('history-content');
  if (!el) return;

  const savedPhone = localStorage.getItem('bagir_my_phone') || '';
  let orders = JSON.parse(localStorage.getItem('bagir_my_orders') || '[]');

  el.innerHTML = `<div style="text-align:center;padding:20px;color:var(--gray-400)"><div class="spinner" style="margin:0 auto 8px"></div>Memperbarui status dari server...</div>`;

  try {
    // FIX: selalu fetch dari server (bukan hanya kalau ada orders lokal)
    const allOrders = await dbGetOrders();
    const myOrders  = savedPhone
      ? allOrders.filter(o => o.phone && o.phone.replace(/\D/g,'').endsWith(savedPhone.replace(/\D/g,'').slice(-8)))
      : [];

    if (myOrders.length) {
      // Merge — update status & resi dari server
      myOrders.forEach(serverOrder => {
        const local = orders.find(x => x.id === serverOrder.id);
        if (local) {
          local.status = serverOrder.status;
          local.resi   = serverOrder.resi || '';
          local.total  = serverOrder.total;
          local.items  = Array.isArray(serverOrder.items)
            ? serverOrder.items.map(itemLabel).join(', ')
            : serverOrder.items;
        } else {
          orders.unshift({
            id: serverOrder.id, name: serverOrder.name,
            items: Array.isArray(serverOrder.items)
              ? serverOrder.items.map(itemLabel).join(', ')
              : serverOrder.items,
            total: serverOrder.total, date: serverOrder.orderDate,
            status: serverOrder.status, resi: serverOrder.resi || ''
          });
        }
      });
      localStorage.setItem('bagir_my_orders', JSON.stringify(orders));
    }
  } catch(e) { /* tampilkan dari cache */ }

  if (!orders.length) {
    el.innerHTML = `<div class="cart-empty">
      <i class="ti ti-clock-off"></i>
      <p style="font-size:14px;font-weight:700;color:var(--gray-700)">Belum ada riwayat pesanan</p>
      <p style="font-size:12px;margin-top:4px">Pesanan kamu akan muncul di sini setelah konfirmasi</p>
    </div>`;
    return;
  }

  el.innerHTML = orders.map(o => `
    <div class="history-card">
      <div class="history-header">
        <span class="history-id">#${o.id}</span>
        <span class="history-date"><i class="ti ti-calendar" style="margin-right:3px"></i>${fmtDate(o.date)}</span>
      </div>
      ${buildStatusTracker(o.status)}
      <div class="history-items">${o.items}</div>
      <div class="history-footer">
        <span class="history-total">${fmt(o.total)}</span>
        ${o.resi?`<span style="font-size:11px;background:#EEF4FF;color:var(--blue-700);padding:3px 8px;border-radius:20px;font-weight:700">📦 Resi: ${o.resi}</span>`:''}
        <span style="font-size:11px;color:var(--gray-400)">
          ${o.status==='selesai'?'✅ Pesanan selesai':o.status==='batal'?'❌ Dibatalkan':'⏳ Dalam proses'}
        </span>
      </div>
      <button onclick="refreshHistorySingle('${o.id}')" style="margin-top:8px;font-size:11px;padding:5px 12px;border:1.5px solid var(--gray-200);border-radius:20px;background:#fff;cursor:pointer;color:var(--gray-600)">
        <i class="ti ti-refresh"></i> Perbarui Status
      </button>
    </div>`).join('');
}

async function refreshHistorySingle(id) {
  showToast('Memperbarui status...','warn');
  try {
    const allOrders = await dbGetOrders();
    const o = allOrders.find(x => x.id === id);
    if (o) {
      const orders = JSON.parse(localStorage.getItem('bagir_my_orders') || '[]');
      const local  = orders.find(x => x.id === id);
      if (local) { local.status = o.status; local.resi = o.resi || ''; }
      localStorage.setItem('bagir_my_orders', JSON.stringify(orders));
      showToast('Status diperbarui ✅');
      renderHistory();
    }
  } catch(e) { showToast('Gagal ambil data','error'); }
}

function buildStatusTracker(status) {
  const steps = [
    { key:'baru',    icon:'📋', label:'Diterima' },
    { key:'proses',  icon:'🔄', label:'Diproses' },
    { key:'selesai', icon:'✅', label:'Selesai'  },
  ];
  if (status === 'batal') {
    return `<div style="text-align:center;margin:12px 0;padding:8px;background:var(--red-50);border-radius:var(--r-md)">
      <span style="color:var(--red-700);font-size:13px;font-weight:700">❌ Pesanan Dibatalkan</span>
    </div>`;
  }
  const order = ['baru','proses','selesai'];
  const cur   = order.indexOf(status);
  let html = '<div class="status-tracker">';
  steps.forEach((s, i) => {
    const isDone   = i < cur;
    const isActive = i === cur;
    const cls = isDone ? 'done' : isActive ? 'active' : '';
    html += `<div class="tracker-step">
      <div class="tracker-circle ${cls}">${s.icon}</div>
      <div class="tracker-label ${cls}">${s.label}</div>
    </div>`;
    if (i < steps.length - 1) {
      html += `<div class="tracker-line ${isDone?'done':''}"></div>`;
    }
  });
  html += '</div>';
  return html;
}

// ── NOTIFIKASI ────────────────────────────────────────────────
async function updateNotifBadge() {
  const notifs   = await dbGetNotifications();
  const unread   = notifs.filter(n => n.isRead !== true && n.isRead !== 'true');
  const unreadCount = unread.length;
  const dot = document.getElementById('notif-dot');
  if (dot) { dot.textContent = unreadCount; dot.style.display = unreadCount ? 'flex' : 'none'; }

  if (unreadCount > lastNotifCount && lastNotifCount >= 0) {
    const newest = unread[0];
    if (newest) {
      playNotifSound();
      sendBrowserNotif(
        '🛒 Toko Bagir — ' + (newest.type === 'order' ? 'Pesanan Baru!' : 'Notifikasi'),
        newest.message
      );
    }
  }
  lastNotifCount = unreadCount;

  // Update SW cache untuk background check
  const token = sessionStorage.getItem('bagir_admin_token');
  if (token) saveSWToken(token);
}

function toggleNotifPanel() {
  const panel = document.getElementById('notif-panel');
  if (panel.classList.contains('show')) {
    panel.classList.remove('show');
  } else {
    panel.classList.add('show');
    loadNotifPanel();
  }
}
function closeNotifPanel() {
  document.getElementById('notif-panel')?.classList.remove('show');
}

async function loadNotifPanel() {
  const list = document.getElementById('notif-list');
  if (!list) return;
  list.innerHTML = '<div class="notif-empty"><div class="spinner" style="width:20px;height:20px;border-width:2px;margin:0 auto 8px"></div>Memuat...</div>';
  const notifs = await dbGetNotifications();
  if (!notifs.length) { list.innerHTML = '<div class="notif-empty">Belum ada notifikasi</div>'; return; }
  list.innerHTML = notifs.slice(0,20).map(n => {
    const isUnread = n.isRead !== true && n.isRead !== 'true';
    return `<div class="notif-item ${isUnread?'unread':''}" onclick="markNotifRead(${n.id})">
      <div class="notif-msg">${n.message}</div>
      <div class="notif-time">${fmtDateTime(n.createdAt)}</div>
    </div>`;
  }).join('');
  updateNotifBadge();
}

async function markNotifRead(id) {
  await dbMarkReadNotif(id);
  loadNotifPanel();
}
async function markAllRead() {
  await dbMarkAllReadNotif();
  loadNotifPanel();
  showToast('Semua notifikasi dibaca ✅');
}

// ── ADMIN LOGIN ───────────────────────────────────────────────
async function initAdmin() {
  const token = sessionStorage.getItem('bagir_admin_token');
  let ok = false;
  if (token) {
    const r = await dbVerifySession(token);
    ok = r.success && r.valid;
    if (!ok) { sessionStorage.removeItem('bagir_admin_token'); saveSWToken(null); }
  }
  document.getElementById('admin-login').style.display  = ok ? 'none'  : 'block';
  document.getElementById('admin-panel').style.display  = ok ? 'block' : 'none';
  if (ok) {
    renderAdmin();
    updateNotifBadge();
    document.getElementById('notif-btn-wrap').style.display = 'block';
  } else {
    document.getElementById('notif-btn-wrap').style.display = 'none';
  }
}

async function doLogin() {
  const username = document.getElementById('admin-username').value.trim();
  const pw       = document.getElementById('admin-password').value;
  if (!username || !pw) {
    document.getElementById('login-error').textContent = '❌ Username dan password wajib diisi!';
    document.getElementById('login-error').style.display = 'block';
    return;
  }
  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;display:inline-block;margin-right:6px"></div> Memeriksa...';
  try {
    const res = await dbAdminLogin(username, pw);
    if (res.success) {
      sessionStorage.setItem('bagir_admin_token', res.token);
      saveSWToken(res.token);
      document.getElementById('login-error').style.display = 'none';
      document.getElementById('admin-password').value = '';
      requestNotifPermission();
      await initAdmin();
    } else {
      document.getElementById('login-error').textContent = '❌ ' + (res.message || 'Login gagal');
      document.getElementById('login-error').style.display = 'block';
      document.getElementById('admin-password').value = '';
    }
  } catch(e) {
    document.getElementById('login-error').textContent = '❌ Gagal terhubung ke server. Cek koneksi!';
    document.getElementById('login-error').style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="ti ti-login"></i> Masuk';
  }
}

async function doLogout() {
  const token = sessionStorage.getItem('bagir_admin_token');
  if (token) { try { await dbAdminLogout(token); } catch(e) {} }
  sessionStorage.removeItem('bagir_admin_token');
  saveSWToken(null);
  document.getElementById('notif-btn-wrap').style.display = 'none';
  initAdmin();
}

// ── ADMIN PANEL ───────────────────────────────────────────────
function showAdminTab(tab, el) {
  adminSubTab = tab;
  document.querySelectorAll('.admin-tab').forEach(x => x.classList.remove('active'));
  el.classList.add('active');
  editingProductId = null;
  renderAdmin();
}

async function renderAdmin() {
  const el = document.getElementById('admin-content');
  if (!el) return;
  el.innerHTML = `<div style="text-align:center;padding:40px"><div class="spinner"></div><p style="margin-top:10px;color:var(--gray-500);font-size:13px">Memuat data...</p></div>`;
  if      (adminSubTab === 'dashboard')   await renderDashboard(el);
  else if (adminSubTab === 'orders')      await renderOrdersAdmin(el);
  else if (adminSubTab === 'products')    await renderProductsAdmin(el);
  else if (adminSubTab === 'add-product') renderAddProductForm(el);
  else if (adminSubTab === 'settings')    await renderSettingsAdmin(el);
}

// ── FIX: Dashboard pendapatan hitung dari orders langsung ─────
async function renderDashboard(el) {
  const [products, orders, sales] = await Promise.all([dbGetProducts(), dbGetOrders(), dbGetSalesData()]);
  allProducts = products;

  // FIX: hitung revenue dari orders (bukan sales.totalRevenue yang kadang 0)
  const activeOrders = orders.filter(o => o.status !== 'batal');
  const rev     = activeOrders.reduce((s,o) => s + (Number(o.total) || 0), 0);
  const newOrd  = orders.filter(o => o.status === 'baru').length;
  const lowStk  = products.filter(p => p.stock <= 5).length;
  const totalQtyTerjual = sales.topProducts ? sales.topProducts.reduce((s,p)=>s+p.qty,0) : 0;

  el.innerHTML = `
    <div class="admin-info-panel">
      <div class="admin-info-title"><i class="ti ti-shield-check"></i> Yang Bisa Dikelola Admin</div>
      <ul class="admin-info-list">
        <li>Tambah, edit, hapus produk (nama, harga, stok, deskripsi, foto)</li>
        <li>Update status pesanan: Baru → Proses → Selesai / Batal</li>
        <li>Hapus pesanan yang tidak valid</li>
        <li>Pantau stok — produk stok rendah ditampilkan di dashboard</li>
        <li>Lihat semua pesanan masuk beserta detail pembeli & tanggal</li>
        <li>Terima notifikasi setiap ada pesanan baru masuk</li>
        <li>Data produk & pesanan tersinkron real-time dengan Google Sheets</li>
      </ul>
    </div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-num">${orders.length}</div><div class="stat-label">Total Pesanan</div></div>
      <div class="stat-card"><div class="stat-num" style="font-size:16px">${fmt(rev)}</div><div class="stat-label">Total Pendapatan</div></div>
      <div class="stat-card"><div class="stat-num" style="color:var(--yellow-700)">${newOrd}</div><div class="stat-label">Pesanan Baru</div></div>
      <div class="stat-card"><div class="stat-num" style="color:var(--red-700)">${lowStk}</div><div class="stat-label">Stok Perlu Diisi</div></div>
      <div class="stat-card"><div class="stat-num" style="color:var(--green-700)">${totalQtyTerjual}</div><div class="stat-label">Produk Terjual</div></div>
    </div>
    <div style="font-size:13px;font-weight:700;margin:18px 0 10px">📈 Grafik Penjualan (per bulan)</div>
    ${buildSalesChart(sales.monthly||[])}
    <div style="font-size:13px;font-weight:700;margin:18px 0 10px">🏆 Produk Terlaris</div>
    ${buildTopProductsTable(sales.topProducts||[])}
    <div style="font-size:13px;font-weight:700;margin-bottom:10px">📋 Pesanan Terbaru</div>
    ${buildOrderTable(orders.slice(-6).reverse())}
    <div style="font-size:13px;font-weight:700;margin:18px 0 10px">⚠️ Stok Rendah / Habis</div>
    ${buildLowStockTable(products.filter(p=>p.stock<=5))}`;
}

function buildSalesChart(monthly) {
  if (!monthly.length) return `<p style="font-size:13px;color:var(--gray-400);margin-bottom:14px">Belum ada data penjualan.</p>`;
  const max = Math.max(...monthly.map(m=>m.revenue), 1);
  return `<div style="display:flex;align-items:flex-end;gap:10px;height:160px;padding:10px 4px 0;margin-bottom:14px;border-bottom:1.5px solid var(--gray-200);overflow-x:auto">
    ${monthly.map(m => {
      const h = Math.max(4, Math.round((m.revenue/max)*130));
      return `<div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0;min-width:48px">
        <div style="font-size:10px;color:var(--blue-600);font-weight:700;margin-bottom:4px">${fmt(m.revenue).replace('Rp ','')}</div>
        <div style="width:28px;height:${h}px;background:linear-gradient(180deg,var(--blue-400),var(--blue-600));border-radius:4px 4px 0 0"></div>
        <div style="font-size:10px;color:var(--gray-400);margin-top:6px">${m.month}</div>
      </div>`;
    }).join('')}
  </div>`;
}

function buildTopProductsTable(list) {
  if (!list.length) return `<p style="font-size:13px;color:var(--gray-400);margin-bottom:14px">Belum ada produk terjual.</p>`;
  const max = Math.max(...list.map(p=>p.qty), 1);
  return `<div style="margin-bottom:14px">
    ${list.map(p => `<div style="margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:600;margin-bottom:3px"><span>${p.name}</span><span>${p.qty} terjual</span></div>
      <div style="height:8px;background:var(--gray-100);border-radius:4px;overflow:hidden">
        <div style="height:100%;width:${(p.qty/max)*100}%;background:var(--blue-500);border-radius:4px"></div>
      </div>
    </div>`).join('')}
  </div>`;
}

async function renderOrdersAdmin(el) {
  const orders = await dbGetOrders();
  el.innerHTML = `
    <div style="font-size:13px;font-weight:700;margin-bottom:12px">Semua Pesanan (${orders.length})</div>
    ${buildOrderTable(orders.slice().reverse())}`;
}

// ── FIX: tabel pesanan — total tampil & bukti bisa dibuka ─────
function buildOrderTable(list) {
  if (!list.length) return `<p style="font-size:13px;color:var(--gray-400);margin-bottom:12px">Belum ada pesanan.</p>`;
  return `<div class="table-wrap" style="overflow-x:auto;margin-bottom:14px">
    <table class="data-table">
      <thead><tr>
        <th>ID</th><th>Tanggal</th><th>Nama Pembeli</th>
        <th>Item</th><th>Total</th><th>Pengiriman</th><th>Pembayaran</th><th>No. Resi</th><th>Status</th><th>Aksi</th>
      </tr></thead>
      <tbody>${list.map(o => {
        // FIX: hitung total dengan benar
        const items = Array.isArray(o.items) ? o.items : [];
        const subtotal = items.reduce((s,i) => s + (Number(i.price)||0)*(Number(i.qty)||1), 0);
        const ongkir   = Number(o.shippingCost) || 0;
        const totalVal = Number(o.total) || subtotal + ongkir;

        // FIX: bukti TF — pakai proxyImg supaya tidak 404
        const proofHtml = o.paymentProof
          ? `<a href="${proxyImg(o.paymentProof)}" target="_blank" class="action-btn" style="display:inline-block;margin-top:3px"><i class="ti ti-photo"></i> Lihat Bukti</a>`
          : '<span style="color:var(--gray-400);font-size:11px">Belum ada</span>';

        return `<tr>
          <td style="font-family:monospace;font-weight:800;color:var(--blue-600)">${o.id}</td>
          <td>
            <div style="font-size:12px;font-weight:600">${fmtDate(o.orderDate||o.date)}</div>
            ${o.deliveryDate?`<div style="font-size:10px;color:var(--gray-400)">Kirim: ${fmtDate(o.deliveryDate)}</div>`:''}
          </td>
          <td>
            <div style="font-weight:700">${o.name}</div>
            <div style="font-size:11px;color:var(--gray-400)">${o.phone||''}</div>
          </td>
          <td style="font-size:11px;color:var(--gray-500);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${items.map(itemLabel).join(', ')||'-'}
          </td>
          <td>
            <div style="font-weight:800;color:var(--blue-600);font-size:13px">${fmt(totalVal)}</div>
            ${ongkir?`<div style="font-size:10px;color:var(--gray-400)">+ongkir ${fmt(ongkir)}</div>`:''}
            ${o.dpAmount?`<div style="font-size:10px;color:var(--green-700)">DP: ${fmt(o.dpAmount)}</div>`:''}
          </td>
          <td>${o.delivery==='delivery'?`🚚 ${o.city||'Kirim'}`:'🏠 Ambil'}</td>
          <td style="font-size:11px">
            <div style="text-transform:capitalize;font-weight:700">${o.payment||'-'}</div>
            ${proofHtml}
          </td>
          <td>
            <div style="display:flex;gap:4px;min-width:110px">
              <input type="text" value="${o.resi||''}" id="resi-${o.id}" placeholder="No. resi"
                style="font-size:11px;padding:5px 7px;border:1.5px solid var(--gray-200);border-radius:5px;width:80px">
              <button class="action-btn" onclick="saveResi('${o.id}')"><i class="ti ti-device-floppy"></i></button>
            </div>
          </td>
          <td>${statusBadge(o.status)}</td>
          <td>
            <div style="display:flex;flex-direction:column;gap:5px;min-width:110px">
              <select onchange="changeStatus('${o.id}',this.value)"
                style="font-size:11px;padding:5px 7px;border:1.5px solid var(--gray-200);border-radius:5px;cursor:pointer;background:#fff;font-weight:600">
                <option value="baru"    ${o.status==='baru'?'selected':''}>🔵 Baru</option>
                <option value="proses"  ${o.status==='proses'?'selected':''}>🟡 Proses</option>
                <option value="selesai" ${o.status==='selesai'?'selected':''}>🟢 Selesai</option>
                <option value="batal"   ${o.status==='batal'?'selected':''}>🔴 Batal</option>
              </select>
              <button class="action-btn" onclick="printInvoice('${o.id}')"><i class="ti ti-printer"></i> Invoice</button>
              <button class="action-btn del" onclick="hapusOrder('${o.id}')">Hapus</button>
            </div>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table>
  </div>`;
}

async function saveResi(id) {
  const val = document.getElementById('resi-'+id).value.trim();
  await dbUpdateResi(id, val);
  showToast('No. resi disimpan ✅');
}

// ── FIX: Invoice format Shopee-like ──────────────────────────
function printInvoice(id) {
  dbGetOrders().then(orders => {
    const o = orders.find(x => x.id === id);
    if (!o) { showToast('Pesanan tidak ditemukan','error'); return; }
    const items    = Array.isArray(o.items) ? o.items : [];
    const subtotal = items.reduce((s,i) => s + (Number(i.price)||0)*(Number(i.qty)||1), 0);
    const ongkir   = Number(o.shippingCost) || 0;
    const total    = Number(o.total) || subtotal + ongkir;
    const sisaBayar = o.dpAmount ? Math.max(0, total - Number(o.dpAmount)) : 0;
    const statusLabel = {baru:'Menunggu Konfirmasi',proses:'Sedang Diproses',selesai:'Selesai',batal:'Dibatalkan'}[o.status] || o.status;
    const payLabel    = {transfer:'Transfer Bank',cod:'COD (Bayar di Tempat)',qris:'QRIS'}[o.payment] || o.payment;
    const statusColor = {baru:'#2563eb',proses:'#d97706',selesai:'#16a34a',batal:'#dc2626'}[o.status] || '#888';

    const rows = items.map(i => `
      <tr>
        <td style="padding:12px 0;border-bottom:1px dashed #f0f0f0">
          <div style="font-weight:600;font-size:13px;color:#222">${i.name}${i.size && i.size!=='250g' ? ` <span style="color:#ee4d2d;font-weight:700">(${({'500g':'500g','1kg':'1 kg','1bal':'1 bal'}[i.size]||i.size)})</span>` : ''}</div>
          <div style="font-size:11px;color:#888;margin-top:2px">${fmt(Number(i.price))} × ${i.qty} pcs</div>
        </td>
        <td style="padding:12px 0;border-bottom:1px dashed #f0f0f0;text-align:right;font-weight:700;font-size:13px;color:#ee4d2d;white-space:nowrap">
          ${fmt((Number(i.price)||0)*(Number(i.qty)||1))}
        </td>
      </tr>`).join('');

    const proofSection = o.paymentProof
      ? `<div style="margin-top:12px">
           <div style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Bukti Pembayaran</div>
           <img src="${proxyImg(o.paymentProof)}" style="max-width:220px;border-radius:8px;border:1px solid #eee;display:block">
         </div>`
      : '';

    const html = `<!DOCTYPE html><html lang="id"><head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Invoice ${o.id}</title>
      <style>
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:'Segoe UI',Arial,sans-serif;background:#f5f5f5;color:#222;padding:16px}
        .wrap{max-width:480px;margin:0 auto}
        /* Header Shopee-style */
        .header{background:#ee4d2d;color:#fff;padding:20px;border-radius:12px 12px 0 0;position:relative}
        .header-logo{font-size:22px;font-weight:900;letter-spacing:1px;display:flex;align-items:center;gap:8px}
        .header-sub{font-size:11px;opacity:.8;margin-top:2px}
        .invoice-num{position:absolute;top:20px;right:20px;background:rgba(255,255,255,.2);border-radius:20px;padding:4px 12px;font-size:12px;font-weight:700}
        /* Status bar */
        .status-bar{background:#fff8f6;border-left:4px solid ${statusColor};padding:12px 16px;display:flex;align-items:center;gap:10px}
        .status-dot{width:10px;height:10px;border-radius:50%;background:${statusColor};flex-shrink:0}
        .status-text{font-size:13px;font-weight:700;color:${statusColor}}
        /* Body */
        .body{background:#fff;padding:20px;border-radius:0 0 12px 12px;box-shadow:0 2px 10px rgba(0,0,0,.08)}
        .section{margin-bottom:20px;padding-bottom:20px;border-bottom:1px solid #f5f5f5}
        .section:last-of-type{border-bottom:none;margin-bottom:0;padding-bottom:0}
        .sec-title{font-size:10px;font-weight:700;color:#ee4d2d;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}
        .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
        .info-item .k{font-size:11px;color:#999;margin-bottom:2px}
        .info-item .v{font-size:13px;font-weight:600;color:#222}
        table{width:100%;border-collapse:collapse}
        /* Total box */
        .total-box{background:#fff8f6;border-radius:8px;padding:14px;margin-top:12px}
        .tot-row{display:flex;justify-content:space-between;font-size:13px;color:#666;margin-bottom:6px}
        .tot-grand{display:flex;justify-content:space-between;font-size:16px;font-weight:800;color:#ee4d2d;padding-top:10px;margin-top:6px;border-top:1.5px solid #f5c5b5}
        .sisa-tag{display:inline-block;background:#fff3e0;color:#e65100;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;margin-top:4px}
        /* Footer */
        .footer-note{text-align:center;font-size:11px;color:#bbb;margin-top:20px;padding-top:16px;border-top:1px dashed #eee;line-height:1.7}
        .print-btn{display:block;width:100%;margin-top:16px;padding:13px;background:#ee4d2d;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;letter-spacing:.3px}
        .print-btn:hover{background:#c73d20}
        @media print{.print-btn{display:none}body{background:#fff;padding:0}.wrap{max-width:100%}}
      </style></head>
    <body>
    <div class="wrap">
      <div class="header">
        <div class="header-logo">🍪 ${CONFIG.TOKO_NAME||'TOKO BAGIR'}</div>
        <div class="header-sub">${CONFIG.TOKO_TAGLINE||'Grosir Kue Kering'} · ${CONFIG.TOKO_ALAMAT||''}</div>
        <div class="invoice-num">#${o.id}</div>
      </div>

      <div class="status-bar">
        <div class="status-dot"></div>
        <div class="status-text">${statusLabel}</div>
      </div>

      <div class="body">

        <div class="section">
          <div class="sec-title">Info Pesanan</div>
          <div class="info-grid">
            <div class="info-item"><div class="k">No. Pesanan</div><div class="v" style="color:#ee4d2d">${o.id}</div></div>
            <div class="info-item"><div class="k">Tanggal Pesan</div><div class="v">${fmtDate(o.orderDate||o.date)}</div></div>
            <div class="info-item"><div class="k">Nama Pembeli</div><div class="v">${o.name}</div></div>
            <div class="info-item"><div class="k">No. WhatsApp</div><div class="v">${o.phone||'-'}</div></div>
            ${o.deliveryDate?`<div class="info-item"><div class="k">Tgl Kirim/Ambil</div><div class="v">${fmtDate(o.deliveryDate)}</div></div>`:''}
            ${o.resi?`<div class="info-item"><div class="k">No. Resi</div><div class="v" style="color:#2563eb">${o.resi}</div></div>`:''}
          </div>
        </div>

        ${o.address?`
        <div class="section">
          <div class="sec-title">Alamat Pengiriman</div>
          <div style="font-size:13px;line-height:1.6;color:#444">${o.address}${o.city?', '+o.city:''}${o.province?', '+o.province:''}</div>
          ${o.courier?`<div style="font-size:11px;color:#999;margin-top:4px">Kurir: ${o.courier} ${o.service||''}</div>`:''}
        </div>`:''}

        <div class="section">
          <div class="sec-title">Detail Produk</div>
          <table>${rows}</table>
          <div class="total-box">
            <div class="tot-row"><span>Subtotal</span><span>${fmt(subtotal)}</span></div>
            ${ongkir?`<div class="tot-row"><span>Ongkos Kirim (${o.courier||''})</span><span>${fmt(ongkir)}</span></div>`:''}
            ${o.dpAmount?`<div class="tot-row" style="color:#16a34a"><span>DP Dibayar</span><span>- ${fmt(Number(o.dpAmount))}</span></div>`:''}
            <div class="tot-grand"><span>Total Pembayaran</span><span>${fmt(total)}</span></div>
            ${sisaBayar>0?`<div style="text-align:right;margin-top:4px"><span class="sisa-tag">Sisa bayar: ${fmt(sisaBayar)}</span></div>`:''}
          </div>
        </div>

        <div class="section">
          <div class="sec-title">Metode Pembayaran</div>
          <div style="font-size:13px;font-weight:700;color:#222">${payLabel}</div>
          ${proofSection}
        </div>

        ${o.note?`
        <div class="section">
          <div class="sec-title">Catatan</div>
          <div style="font-size:13px;color:#555;line-height:1.6">${o.note}</div>
        </div>`:''}

        <div class="footer-note">
          Terima kasih sudah berbelanja di <strong>${CONFIG.TOKO_NAME||'TOKO BAGIR'}</strong>! 🍪<br>
          Ada pertanyaan? Hub kami di WA: <strong>${CONFIG.TOKO_WA||''}</strong>
        </div>

        <button class="print-btn" onclick="window.print()">🖨️ Cetak / Simpan PDF</button>
      </div>
    </div>
    </body></html>`;

    const w = window.open('','_blank');
    if (w) { w.document.write(html); w.document.close(); }
    else showToast('Pop-up diblokir browser. Izinkan pop-up untuk cetak invoice.','warn');
  });
}

function buildLowStockTable(list) {
  if (!list.length) return `<p style="font-size:13px;color:var(--green-700);margin-bottom:14px">✅ Semua stok aman!</p>`;
  return `<div class="table-wrap" style="margin-bottom:14px">
    <table class="data-table">
      <thead><tr><th>Produk</th><th>Stok Sekarang</th><th>Aksi</th></tr></thead>
      <tbody>${list.map(p=>`<tr>
        <td>${p.name}</td>
        <td>${p.stock===0?'<span class="status-badge s-batal">Habis</span>':`<span class="status-badge s-proses">${p.stock}</span>`}</td>
        <td><button class="action-btn" onclick="quickEditStock(${p.id})"><i class="ti ti-edit"></i> Update Stok</button></td>
      </tr>`).join('')}</tbody>
    </table>
  </div>`;
}

async function changeStatus(id, status) {
  await dbUpdateOrderStatus(id, status);
  showToast(`Status pesanan ${id} → ${status} ✅`);
  // Sync history lokal
  const history = JSON.parse(localStorage.getItem('bagir_my_orders') || '[]');
  const o = history.find(x => x.id === id);
  if (o) { o.status = status; localStorage.setItem('bagir_my_orders', JSON.stringify(history)); }
  renderAdmin();
}

async function hapusOrder(id) {
  if (!confirm('Hapus pesanan ' + id + '?')) return;
  await dbDeleteOrder(id);
  showToast('Pesanan dihapus');
  renderAdmin();
}

function statusBadge(s) {
  const m = {baru:'s-baru',proses:'s-proses',selesai:'s-selesai',batal:'s-batal'};
  return `<span class="status-badge ${m[s]||'s-baru'}">${s.charAt(0).toUpperCase()+s.slice(1)}</span>`;
}

// ── SETTINGS ──────────────────────────────────────────────────
async function renderSettingsAdmin(el) {
  appSettings   = await dbGetSettings();
  shippingRates = await dbGetShippingRates();
  el.innerHTML = `
    <div class="add-product-form" style="margin-bottom:16px">
      <h3>🏷️ Identitas Toko</h3>
      <div class="form-row">
        <label class="form-label">Nama Toko</label>
        <input class="form-input" id="set-toko-name" type="text" value="${appSettings.tokoName || CONFIG.TOKO_NAME || ''}">
      </div>
      <div class="form-row">
        <label class="form-label">Tagline</label>
        <input class="form-input" id="set-toko-tagline" type="text" value="${appSettings.tokoTagline || CONFIG.TOKO_TAGLINE || ''}">
      </div>
      <div class="form-row-2">
        <div>
          <label class="form-label">No. WhatsApp (tanpa +)</label>
          <input class="form-input" id="set-toko-wa" type="text" value="${appSettings.tokoWa || CONFIG.TOKO_WA || ''}">
        </div>
        <div>
          <label class="form-label">Username Instagram</label>
          <input class="form-input" id="set-toko-ig" type="text" value="${appSettings.tokoInstagram || CONFIG.TOKO_INSTAGRAM || ''}">
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">Alamat Toko</label>
        <input class="form-input" id="set-toko-alamat" type="text" value="${appSettings.tokoAlamat || CONFIG.TOKO_ALAMAT || ''}">
      </div>
      <div class="form-row">
        <label class="form-label">Gambar QRIS (Upload ke Drive dulu, paste URL)</label>
        <input class="form-input" id="set-qris-url" type="text" placeholder="URL gambar QRIS dari Drive..." value="${appSettings.qrisImage || ''}">
        <div style="margin-top:6px">
          <label class="form-label">Atau upload langsung</label>
          <input type="file" accept="image/*" class="form-input" onchange="uploadQrisImage(event)">
          <div id="qris-preview" style="margin-top:6px">
            ${appSettings.qrisImage?`<img src="${proxyImg(appSettings.qrisImage)}" style="max-width:160px;border-radius:8px;border:1px solid var(--gray-200)">`:''}
          </div>
        </div>
      </div>
      <button class="save-btn" onclick="saveBrandSettings()"><i class="ti ti-device-floppy"></i> Simpan Identitas Toko</button>
    </div>

    <div class="add-product-form" style="margin-bottom:16px">
      <h3>🚚 Ongkos Kirim</h3>
      <p style="font-size:12px;color:var(--gray-400);margin-bottom:10px">Atur tarif pengiriman per kota/provinsi.</p>
      <div id="ongkir-list">${buildOngkirTable(shippingRates)}</div>
      <h4 style="font-size:13px;margin:14px 0 8px">+ Tambah Tarif Baru</h4>
      <div class="form-row-2">
        <div><label class="form-label">Provinsi</label><input class="form-input" id="ong-province" type="text" placeholder="Jawa Barat"></div>
        <div><label class="form-label">Kota/Kabupaten</label><input class="form-input" id="ong-city" type="text" placeholder="Bandung"></div>
      </div>
      <div class="form-row-2">
        <div><label class="form-label">Kurir</label><input class="form-input" id="ong-courier" type="text" placeholder="JNE"></div>
        <div><label class="form-label">Layanan</label><input class="form-input" id="ong-service" type="text" placeholder="REG"></div>
      </div>
      <div class="form-row-2">
        <div><label class="form-label">Ongkir (Rp)</label><input class="form-input" id="ong-cost" type="number" placeholder="20000"></div>
        <div><label class="form-label">Estimasi</label><input class="form-input" id="ong-etd" type="text" placeholder="1-2 hari"></div>
      </div>
      <button class="save-btn" onclick="addOngkirRate()"><i class="ti ti-plus"></i> Tambah Tarif</button>
    </div>

    <div class="add-product-form">
      <h3>🔒 Keamanan Akun Admin</h3>
      <div class="form-row">
        <label class="form-label">Password Baru (min. 6 karakter)</label>
        <input class="form-input" id="set-new-password" type="password" placeholder="Password baru..." autocomplete="new-password">
      </div>
      <div class="form-row">
        <label class="form-label">Konfirmasi Password Baru</label>
        <input class="form-input" id="set-new-password2" type="password" placeholder="Ulangi password baru..." autocomplete="new-password">
      </div>
      <button class="save-btn" onclick="changeAdminPassword()"><i class="ti ti-lock"></i> Ganti Password</button>
    </div>`;
}

// Upload QRIS langsung dari Settings
async function uploadQrisImage(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  showToast('Upload QRIS...','warn');
  const reader = new FileReader();
  reader.onload = async () => {
    const base64 = reader.result.split(',')[1];
    try {
      const res = await dbUploadImage(base64, file.name, file.type);
      if (res.success) {
        document.getElementById('set-qris-url').value = res.url;
        document.getElementById('qris-preview').innerHTML =
          `<img src="${proxyImg(res.url)}" style="max-width:160px;border-radius:8px;border:1px solid var(--gray-200)">`;
        // Update QRIS di form order juga
        const qrisImg = document.getElementById('qris-img');
        if (qrisImg) qrisImg.src = proxyImg(res.url);
        showToast('QRIS berhasil diupload ✅');
      } else {
        showToast(res.message || 'Gagal upload QRIS','error');
      }
    } catch(e) { showToast('Gagal upload QRIS','error'); }
  };
  reader.readAsDataURL(file);
}

function buildOngkirTable(list) {
  if (!list.length) return `<p style="font-size:12px;color:var(--gray-400)">Belum ada tarif ongkir.</p>`;
  return `<div class="table-wrap" style="margin-bottom:10px">
    <table class="data-table">
      <thead><tr><th>Provinsi</th><th>Kota</th><th>Kurir</th><th>Layanan</th><th>Ongkir</th><th>Estimasi</th><th>Aksi</th></tr></thead>
      <tbody>${list.map(r=>`<tr>
        <td>${r.province}</td><td>${r.city}</td><td>${r.courier}</td><td>${r.service}</td>
        <td>${fmt(r.cost)}</td><td>${r.etd}</td>
        <td><button class="action-btn del" onclick="removeOngkirRate(${r.id})"><i class="ti ti-trash"></i></button></td>
      </tr>`).join('')}</tbody>
    </table>
  </div>`;
}

async function addOngkirRate() {
  const province = document.getElementById('ong-province').value.trim();
  const city     = document.getElementById('ong-city').value.trim();
  const courier  = document.getElementById('ong-courier').value.trim();
  const service  = document.getElementById('ong-service').value.trim();
  const cost     = Number(document.getElementById('ong-cost').value);
  const etd      = document.getElementById('ong-etd').value.trim();
  if (!province||!city||!courier||!cost) { showToast('Lengkapi data ongkir!','error'); return; }
  await dbSaveShippingRate({ province, city, courier, service, cost, etd });
  showToast('Tarif ongkir ditambahkan ✅');
  renderAdmin();
}

async function removeOngkirRate(id) {
  if (!confirm('Hapus tarif ongkir ini?')) return;
  await dbDeleteShippingRate(id);
  showToast('Tarif ongkir dihapus');
  renderAdmin();
}

async function saveBrandSettings() {
  const qrisUrl = document.getElementById('set-qris-url').value.trim();
  const data = {
    tokoName:      document.getElementById('set-toko-name').value.trim(),
    tokoTagline:   document.getElementById('set-toko-tagline').value.trim(),
    tokoWa:        document.getElementById('set-toko-wa').value.trim(),
    tokoInstagram: document.getElementById('set-toko-ig').value.trim(),
    tokoAlamat:    document.getElementById('set-toko-alamat').value.trim(),
    qrisImage:     qrisUrl,
  };
  await dbSaveSettings(data);
  applySettings(data);
  showToast('Identitas toko disimpan ✅');
}

async function changeAdminPassword() {
  const pw1 = document.getElementById('set-new-password').value;
  const pw2 = document.getElementById('set-new-password2').value;
  if (pw1.length < 6) { showToast('Password minimal 6 karakter!','error'); return; }
  if (pw1 !== pw2) { showToast('Konfirmasi password tidak cocok!','error'); return; }
  const token = sessionStorage.getItem('bagir_admin_token');
  const res = await dbAdminChangePassword(token, pw1);
  if (res.success) {
    showToast('Password berhasil diganti ✅');
    document.getElementById('set-new-password').value  = '';
    document.getElementById('set-new-password2').value = '';
  } else {
    showToast(res.message || 'Gagal mengganti password','error');
  }
}

async function renderProductsAdmin(el) {
  const products = await dbGetProducts();
  allProducts    = products;
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <span style="font-size:13px;font-weight:700">Daftar Produk (${products.length} item)</span>
      <button class="save-btn" style="padding:8px 18px;font-size:12px" onclick="switchToAdd()">+ Tambah Produk</button>
    </div>
    <div class="table-wrap" style="overflow-x:auto">
      <table class="data-table">
        <thead><tr><th>Produk</th><th>Kategori</th><th>Harga 250g</th><th>Harga 500g</th><th>Harga 1kg</th><th>Harga 1bal</th><th>Stok</th><th>Aksi</th></tr></thead>
        <tbody>${products.map(p=>`<tr>
          <td><span style="display:inline-block;width:34px;height:34px;border-radius:7px;overflow:hidden;background:var(--blue-50);vertical-align:middle;margin-right:7px">${productImg(p)}</span><strong>${p.name}</strong>
            <div style="font-size:11px;color:var(--gray-400);margin-top:2px">${p.desc?p.desc.slice(0,40)+'…':''}</div>
          </td>
          <td style="text-transform:capitalize">${p.cat}</td>
          <td style="font-weight:800;color:var(--blue-600)">${fmt(p.price)}</td>
          <td style="color:var(--gray-500)">${fmt(getPriceForSize(p,'500g'))}${!p.price500?' <span style="font-size:10px">(auto)</span>':''}</td>
          <td style="color:var(--gray-500)">${fmt(getPriceForSize(p,'1kg'))}${!p.price1kg?' <span style="font-size:10px">(auto)</span>':''}</td>
          <td style="color:var(--gray-500)">${hasBalOption(p)?fmt(p.price1bal):'<span style="color:var(--gray-300)">-</span>'}</td>
          <td>${p.stock===0?'<span class="status-badge s-batal">Habis</span>':p.stock<=5?`<span class="status-badge s-proses">${p.stock}</span>`:p.stock}</td>
          <td>
            <button class="action-btn" onclick="editProduct(${p.id})"><i class="ti ti-edit"></i> Edit</button>
            <button class="action-btn del" onclick="hapusProduct(${p.id})"><i class="ti ti-trash"></i> Hapus</button>
          </td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
}

function switchToAdd() {
  editingProductId = null;
  adminSubTab = 'add-product';
  document.querySelectorAll('.admin-tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.admin-tab')[3].classList.add('active');
  renderAdmin();
}

async function editProduct(id) {
  editingProductId = id;
  adminSubTab = 'add-product';
  document.querySelectorAll('.admin-tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.admin-tab')[3].classList.add('active');
  renderAdmin();
}

async function hapusProduct(id) {
  if (!confirm('Hapus produk ini?')) return;
  await dbDeleteProduct(id);
  allProducts = allProducts.filter(p => p.id !== id);
  localStorage.setItem('bagir_products_cache', JSON.stringify(allProducts));
  renderProducts();
  showToast('Produk dihapus ✅');
  renderAdmin();
}

async function quickEditStock(id) {
  const p = allProducts.find(x => x.id === id);
  if (!p) return;
  const val = prompt(`Update stok "${p.name}" (sekarang: ${p.stock}):`, p.stock);
  if (val === null) return;
  const n = parseInt(val);
  if (isNaN(n)||n<0) { showToast('Stok tidak valid','error'); return; }
  p.stock = n;
  await dbUpdateProduct({ ...p });
  localStorage.setItem('bagir_products_cache', JSON.stringify(allProducts));
  renderProducts();
  showToast('Stok diupdate ✅');
  renderAdmin();
}

function renderAddProductForm(el) {
  const p = editingProductId ? allProducts.find(x => x.id === editingProductId) : null;
  selectedImageUrl = p?.image || '';
  el.innerHTML = `
    <div class="add-product-form">
      <h3>${p ? '✏️ Edit Produk' : '➕ Tambah Produk Baru'}</h3>
      <div class="form-row-2">
        <div>
          <label class="form-label">Nama Produk *</label>
          <input class="form-input" id="p-name" type="text" placeholder="Contoh: Nastar Nanas" value="${p?p.name:''}">
        </div>
        <div>
          <label class="form-label">Kategori *</label>
          <select class="form-select" id="p-cat">
            ${['Pedas','Manis','Cemilan','Best Seller'].map(c=>`<option value="${c}" ${p&&p.cat===c?'selected':''}>${c}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row-2">
        <div>
          <label class="form-label">Harga 250g (Rp) *</label>
          <input class="form-input" id="p-price" type="number" placeholder="65000" value="${p?p.price:''}">
        </div>
        <div>
          <label class="form-label">Berat / Ukuran Dasar</label>
          <input class="form-input" id="p-weight" type="text" placeholder="250g" value="${p?p.weight:''}">
        </div>
      </div>
      <div class="form-row" style="background:var(--blue-50);border-radius:var(--r-md);padding:12px">
        <label class="form-label" style="margin-bottom:8px">💰 Harga Per Ukuran Lain</label>
        <p style="font-size:11px;color:var(--gray-500);margin-bottom:10px">500g & 1kg otomatis dihitung dari harga 250g (×2 dan ×4) kalau dikosongkan. 1 bal <strong>wajib diisi manual</strong> kalau mau ditampilkan sebagai pilihan.</p>
        <div class="form-row-2">
          <div>
            <label class="form-label">Harga 500g (kosongkan = otomatis)</label>
            <input class="form-input" id="p-price500" type="number" placeholder="${p?getPriceForSize(p,'500g'):'otomatis'}" value="${p&&p.price500?p.price500:''}">
          </div>
          <div>
            <label class="form-label">Harga 1kg (kosongkan = otomatis)</label>
            <input class="form-input" id="p-price1kg" type="number" placeholder="${p?getPriceForSize(p,'1kg'):'otomatis'}" value="${p&&p.price1kg?p.price1kg:''}">
          </div>
        </div>
        <div class="form-row" style="margin-bottom:0">
          <label class="form-label">Harga 1 Bal (manual, kosongkan jika tidak jual per bal)</label>
          <input class="form-input" id="p-price1bal" type="number" placeholder="Contoh: 400000" value="${p&&p.price1bal?p.price1bal:''}">
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">Stok Awal *</label>
        <input class="form-input" id="p-stock" type="number" placeholder="10" value="${p?p.stock:''}">
      </div>
      <div class="form-row">
        <label class="form-label">Deskripsi Produk</label>
        <input class="form-input" id="p-desc" type="text" placeholder="Ceritakan keistimewaan produk..." value="${p?p.desc:''}">
      </div>
      <div class="form-row">
        <label class="form-label">Foto Produk</label>
        <div class="img-upload-box">
          <input type="file" id="p-image" accept="image/*" class="form-input" onchange="onProductImageSelected(event)">
          <small style="color:#666">Pilih gambar dari galeri.</small>
          <div class="img-preview-wrap ${selectedImageUrl?'':'empty'}" id="preview-wrap">
            ${selectedImageUrl ? `<img id="preview-image" src="${proxyImg(selectedImageUrl)}">` : `<i class="ti ti-photo"></i>`}
          </div>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:10px">
        <button class="save-btn" id="save-btn" onclick="saveProduct()">
          <i class="ti ti-device-floppy"></i> ${p?'Simpan Perubahan':'Tambahkan ke Database'}
        </button>
        <button onclick="cancelForm()" style="padding:11px 20px;border:1.5px solid var(--gray-200);border-radius:var(--r-md);background:#fff;cursor:pointer;font-size:13px;font-weight:600">Batal</button>
      </div>
    </div>`;
}

function onProductImageSelected(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const wrap = document.getElementById('preview-wrap');
  wrap.classList.remove('empty');
  wrap.innerHTML = `<div class="spinner" style="width:24px;height:24px;border-width:2px"></div>`;
  const reader = new FileReader();
  reader.onload = async () => {
    const base64 = reader.result.split(',')[1];
    try {
      const res = await dbUploadImage(base64, file.name, file.type);
      if (res.success) {
        selectedImageUrl = res.url;
        wrap.innerHTML = `<img id="preview-image" src="${proxyImg(res.url)}">`;
        showToast('Foto berhasil diupload ✅');
      } else {
        wrap.innerHTML = `<i class="ti ti-photo-off"></i>`; wrap.classList.add('empty');
        showToast(res.message || 'Gagal upload foto','error');
      }
    } catch(e) {
      wrap.innerHTML = `<i class="ti ti-photo-off"></i>`; wrap.classList.add('empty');
      showToast('Gagal upload foto','error');
    }
  };
  reader.readAsDataURL(file);
}

async function saveProduct() {
  const name  = document.getElementById('p-name').value.trim();
  const cat   = document.getElementById('p-cat').value;
  const price = parseInt(document.getElementById('p-price').value);
  const weight= document.getElementById('p-weight').value.trim() || '250g';
  const stock = parseInt(document.getElementById('p-stock').value);
  const desc  = document.getElementById('p-desc').value.trim();
  const price500raw  = document.getElementById('p-price500').value.trim();
  const price1kgraw  = document.getElementById('p-price1kg').value.trim();
  const price1balraw = document.getElementById('p-price1bal').value.trim();
  if (!name)               { showToast('Nama produk wajib!','error'); return; }
  if (isNaN(price)||price<=0){ showToast('Harga 250g tidak valid!','error'); return; }
  if (isNaN(stock)||stock<0) { showToast('Stok tidak valid!','error'); return; }
  // 500g & 1kg: kosong = 0 (artinya otomatis dihitung saat ditampilkan)
  const price500  = price500raw  ? Number(price500raw)  : 0;
  const price1kg  = price1kgraw  ? Number(price1kgraw)  : 0;
  const price1bal = price1balraw ? Number(price1balraw) : 0;
  const btn = document.getElementById('save-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;display:inline-block;margin-right:6px"></div> Menyimpan...';
  try {
    if (editingProductId) {
      await dbUpdateProduct({ id:editingProductId, name, cat, emoji:'', price, weight, stock, desc, image:selectedImageUrl, price500, price1kg, price1bal });
      const idx = allProducts.findIndex(x=>x.id===editingProductId);
      if (idx!==-1) allProducts[idx] = {id:editingProductId,name,cat,price,weight,stock,desc,image:selectedImageUrl,price500,price1kg,price1bal};
    } else {
      const res = await dbAddProduct({ name, cat, emoji:'', price, weight, stock, desc, image:selectedImageUrl, price500, price1kg, price1bal });
      allProducts.push({id:res.id||Date.now(),name,cat,price,weight,stock,desc,image:selectedImageUrl,price500,price1kg,price1bal});
    }
    localStorage.setItem('bagir_products_cache', JSON.stringify(allProducts));
    renderProducts();
    showToast('✅ Produk tersimpan!');
    editingProductId = null;
    adminSubTab = 'products';
    document.querySelectorAll('.admin-tab').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.admin-tab')[2].classList.add('active');
    renderAdmin();
  } catch(e) {
    showToast('Gagal menyimpan. Cek koneksi & URL API.','error');
    btn.disabled = false;
    btn.innerHTML = '<i class="ti ti-device-floppy"></i> Simpan';
  }
}

function cancelForm() {
  editingProductId = null;
  adminSubTab = 'products';
  document.querySelectorAll('.admin-tab').forEach(x=>x.classList.remove('active'));
  document.querySelectorAll('.admin-tab')[2].classList.add('active');
  renderAdmin();
}

// ── TOAST ─────────────────────────────────────────────────────
function showToast(msg, type='success') {
  let t = document.getElementById('toast');
  if (!t) { t=document.createElement('div'); t.id='toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.style.background = type==='error'?'var(--red-700)':type==='warn'?'var(--yellow-700)':'var(--blue-600)';
  t.style.opacity='1'; t.style.transform='translateX(-50%) translateY(0)';
  clearTimeout(t._t);
  t._t = setTimeout(()=>{t.style.opacity='0';t.style.transform='translateX(-50%) translateY(60px)';},2800);
}

// Tutup notif panel kalau klik di luar
document.addEventListener('click', e => {
  const panel = document.getElementById('notif-panel');
  const btn   = document.getElementById('notif-btn');
  if (panel && !panel.contains(e.target) && btn && !btn.contains(e.target)) {
    panel.classList.remove('show');
  }
});