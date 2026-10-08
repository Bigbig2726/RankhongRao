"use strict";

/* =====================================================================
   ตั้งค่า: ใส่ URL ของ Google Apps Script Web App ที่ deploy แล้วตรงนี้
   (ดูวิธี deploy ใน README.md) ตัวอย่าง:
   "https://script.google.com/macros/s/AKfycb.../exec"
   ===================================================================== */
var API_URL = "https://script.google.com/macros/s/AKfycbwDVJgrQGHqLambu7apEqv6MzQOFMEx8xVbhb0k5-sDsNnhAvrCa7YX-eGuK2qsBrQ5HQ/exec";

var CATS = ["โจ๊ก","ไข่กระทะ","ขนมปังปิ้ง","ของทอด","ไอติมทอด","กาแฟโบราณ"];
var ORDER_TYPES = [
  {id:"dine_in", label:"นั่งทาน"},
  {id:"takeaway", label:"กลับบ้าน"},
  {id:"delivery", label:"เดลิเวอรี่"}
];
var PAY_METHODS = [
  {id:"cash", label:"เงินสด"},
  {id:"promptpay", label:"พร้อมเพย์"},
  {id:"card", label:"บัตร"}
];
var RANGES = [
  {id:"today", label:"วันนี้"},
  {id:"week", label:"7 วันล่าสุด"},
  {id:"month", label:"เดือนนี้"}
];
var AUTO_REFRESH_MS = 20000; // sync across devices every 20s (no realtime push on a static site)

var state = {
  view: "pos",
  ready: false,
  menuItems: [],
  ingredients: [],
  category: "ทั้งหมด",
  orderType: "dine_in",
  cart: JSON.parse(localStorage.getItem("rkr_cart") || "[]"),
  reportRange: "today",
  reportData: null,
  reportLoading: false
};

var viewEl = document.getElementById("view");
var modalRoot = document.getElementById("modal-root");
var toastRoot = document.getElementById("toast-root");

/* ================= API ================= */
/* ใช้ JSONP (แทก <script>) สำหรับการอ่าน/เขียนข้อมูลทั่วไป เพราะ Apps Script ไม่ส่ง CORS header
   ส่วนการอัปโหลดรูป (ข้อมูลใหญ่เกินกว่าจะใส่ใน URL) ใช้ fetch แบบ no-cors แทน */
var API = {
  _jsonpCounter: 0,
  _jsonp: function (action, params) {
    return new Promise(function (resolve, reject) {
      var cbName = "rkr_cb_" + (API._jsonpCounter++) + "_" + Date.now();
      var qs = "action=" + encodeURIComponent(action) + "&callback=" + cbName;
      for (var k in (params || {})) qs += "&" + k + "=" + encodeURIComponent(params[k]);
      window[cbName] = function (data) { resolve(data); cleanup(); };
      var script = document.createElement("script");
      script.src = API_URL + "?" + qs;
      script.onerror = function () { reject(new Error("ส่งข้อมูลไม่สำเร็จ")); cleanup(); };
      function cleanup(){ delete window[cbName]; if (script.parentNode) script.parentNode.removeChild(script); }
      document.body.appendChild(script);
    });
  },
  get: function (action, params) { return API._jsonp(action, params); },
  post: function (payload) {
    var action = payload.action;
    var rest = Object.assign({}, payload);
    delete rest.action;
    return API._jsonp(action, {payload: JSON.stringify(rest)});
  },
  getMenu: function () { return API.get("menu"); },
  getIngredients: function () { return API.get("ingredients"); },
  getReport: function (range) { return API.get("report", {range: range}); },
  checkout: function (body) { return API.post(Object.assign({action:"checkout"}, body)); },
  receiveStock: function (body) { return API.post(Object.assign({action:"receiveStock"}, body)); },
  upsertIngredient: function (body) { return API.post(Object.assign({action:"upsertIngredient"}, body)); },
  deleteIngredient: function (id) { return API.post({action:"deleteIngredient", id:id}); },
  upsertMenuItem: function (body) { return API.post(Object.assign({action:"upsertMenuItem"}, body)); },
  deleteMenuItem: function (id) { return API.post({action:"deleteMenuItem", id:id}); },
  uploadImage: function (dataUrl, filename) { return API.post({action:"uploadImage", dataUrl:dataUrl, filename:filename}); },
  uploadImageAndSaveMenuItem: function (payload) {
    // รูปภาพมีขนาดใหญ่เกินกว่าจะส่งผ่าน URL (JSONP) ได้ จึงใช้ fetch แบบ no-cors แทน
    // (อ่านผลตอบกลับไม่ได้ แต่ส่งข้อมูลก้อนใหญ่ได้ — รีเฟรชข้อมูลเองหลังส่งแทนการอ่านผล)
    return fetch(API_URL, {
      method: "POST",
      headers: {"Content-Type": "text/plain;charset=utf-8"},
      mode: "no-cors",
      body: JSON.stringify(Object.assign({action:"uploadImageAndSaveMenuItem"}, payload))
    });
  }
};

function esc(s){
  return String(s==null?"":s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c];
  });
}
function fmt(n){
  n = Number(n)||0;
  return n.toLocaleString("th-TH",{minimumFractionDigits:0,maximumFractionDigits:2});
}
function baht(n){ return fmt(n) + " บาท"; }
function toast(msg){
  var t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  toastRoot.appendChild(t);
  setTimeout(function(){ t.remove(); }, 2600);
}
function saveCart(){
  try{ localStorage.setItem("rkr_cart", JSON.stringify(state.cart)); }catch(e){}
}

/* ================= boot ================= */
function boot(){
  if (API_URL.indexOf("PASTE_YOUR") === 0){
    viewEl.innerHTML = '<div class="empty"><h3>ยังไม่ได้ตั้งค่า API</h3>'+
      '<p>เปิดไฟล์ app.js แล้วใส่ URL ของ Google Apps Script Web App ในตัวแปร API_URL ก่อนใช้งาน (ดูขั้นตอนใน README.md)</p></div>';
    return;
  }
  bindTabs();
  render();
  loadCore();
  setInterval(loadCore, AUTO_REFRESH_MS);
}
boot();

function loadCore(){
  Promise.all([API.getMenu(), API.getIngredients()]).then(function(res){
    state.menuItems = res[0];
    state.ingredients = res[1];
    state.ready = true;
    render();
  }).catch(function(err){
    console.error(err);
    if (!state.ready){
      viewEl.innerHTML = '<div class="empty"><h3>เชื่อมต่อฐานข้อมูลไม่ได้</h3>'+
        '<p>ตรวจสอบว่า Apps Script deploy แล้วและตั้งค่า "Who has access: Anyone"</p></div>';
    }
  });
}

function bindTabs(){
  document.querySelectorAll(".tab-btn").forEach(function(btn){
    btn.addEventListener("click", function(){
      setView(btn.getAttribute("data-tab"));
    });
  });
}
function setView(v){
  state.view = v;
  document.querySelectorAll(".tab-btn").forEach(function(btn){
    btn.setAttribute("aria-selected", btn.getAttribute("data-tab")===v ? "true":"false");
  });
  if (v === "reports" && !state.reportData) loadReport();
  render();
}

/* ================= render root ================= */
function render(){
  document.querySelectorAll(".tab-btn").forEach(function(btn){
    var on = btn.getAttribute("data-tab") === state.view;
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  if (!state.ready){
    viewEl.innerHTML = '<div class="loading">กำลังโหลดข้อมูลร้าน…</div>';
    return;
  }
  if (state.view === "pos") renderPOS();
  else if (state.view === "inventory") renderInventory();
  else if (state.view === "manage") renderManage();
  else renderReports();
}

/* ================= POS ================= */
function renderPOS(){
  var cats = ["ทั้งหมด"].concat(CATS);
  var items = state.menuItems.filter(function(m){
    return state.category === "ทั้งหมด" || m.category === state.category;
  });

  var html = '';
  html += '<div class="ordertype-row" role="group" aria-label="ประเภทออเดอร์">';
  ORDER_TYPES.forEach(function(t){
    html += '<button class="chip" data-ordertype="'+t.id+'" aria-pressed="'+(state.orderType===t.id)+'">'+t.label+'</button>';
  });
  html += '</div>';

  html += '<div class="pos-grid"><div style="min-width:0">';
  html += '<div class="chiprow" role="group" aria-label="หมวดหมู่เมนู">';
  cats.forEach(function(c){
    html += '<button class="chip" data-cat="'+esc(c)+'" aria-pressed="'+(state.category===c)+'">'+esc(c)+'</button>';
  });
  html += '</div>';

  if (!items.length){
    html += '<div class="empty"><h3>ยังไม่มีเมนูในหมวดนี้</h3><p>เพิ่มเมนูได้จากแท็บ "จัดการเมนู"</p></div>';
  } else {
    html += '<div class="menu-grid">';
    items.forEach(function(m){
      html += '<button class="menu-card" data-add="'+esc(m.id)+'">'+
        (m.imageUrl
          ? '<img class="thumb" src="'+esc(m.imageUrl)+'" alt="" loading="lazy">'
          : '<span class="thumb-placeholder">'+esc((m.name||"?").charAt(0))+'</span>')+
        '<span class="body"><span class="name">'+esc(m.name)+'</span>'+
        '<span class="price">'+baht(m.price)+'</span></span></button>';
    });
    html += '</div>';
  }
  html += '</div>';

  html += renderCartHtml();
  html += '</div>';

  viewEl.innerHTML = html;

  viewEl.querySelectorAll("[data-cat]").forEach(function(b){
    b.addEventListener("click", function(){ state.category = b.getAttribute("data-cat"); renderPOS(); });
  });
  viewEl.querySelectorAll("[data-ordertype]").forEach(function(b){
    b.addEventListener("click", function(){
      state.orderType = b.getAttribute("data-ordertype"); renderPOS();
    });
  });
  viewEl.querySelectorAll("[data-add]").forEach(function(b){
    b.addEventListener("click", function(){ addToCart(b.getAttribute("data-add")); });
  });
  bindCartControls();
}

function renderCartHtml(){
  var total = cartTotal();
  var html = '<aside class="cart" aria-label="ตะกร้าออเดอร์"><h3>ออเดอร์ปัจจุบัน</h3>';
  if (!state.cart.length){
    html += '<div class="cart-empty">แตะเมนูเพื่อเริ่มออเดอร์</div>';
  } else {
    state.cart.forEach(function(line, i){
      html += '<div class="cart-line">'+
        '<div class="cl-name"><span class="n">'+esc(line.name)+'</span><span class="p">'+baht(line.price)+' / หน่วย</span></div>'+
        '<div class="qty">'+
          '<button data-dec="'+i+'" aria-label="ลดจำนวน">−</button>'+
          '<span>'+line.qty+'</span>'+
          '<button data-inc="'+i+'" aria-label="เพิ่มจำนวน">+</button>'+
        '</div></div>';
    });
    html += '<div class="cart-total"><span>ยอดรวม</span><span class="amt">'+baht(total)+'</span></div>';
  }
  html += '<button class="btn btn-primary" id="checkout-btn" '+(state.cart.length?'':'disabled')+'>ชำระเงิน</button>';
  html += '</aside>';
  return html;
}
function bindCartControls(){
  viewEl.querySelectorAll("[data-inc]").forEach(function(b){
    b.addEventListener("click", function(){ changeQty(+b.getAttribute("data-inc"), 1); });
  });
  viewEl.querySelectorAll("[data-dec]").forEach(function(b){
    b.addEventListener("click", function(){ changeQty(+b.getAttribute("data-dec"), -1); });
  });
  var co = document.getElementById("checkout-btn");
  if (co) co.addEventListener("click", openCheckoutModal);
}
function cartTotal(){
  return state.cart.reduce(function(sum, l){ return sum + l.price*l.qty; }, 0);
}
function addToCart(menuItemId){
  var m = state.menuItems.find(function(x){ return x.id === menuItemId; });
  if (!m) return;
  var line = state.cart.find(function(l){ return l.menuItemId === menuItemId; });
  if (line) line.qty += 1;
  else state.cart.push({menuItemId:m.id, name:m.name, price:m.price, qty:1});
  saveCart();
  renderPOS();
}
function changeQty(idx, delta){
  var line = state.cart[idx];
  if (!line) return;
  line.qty += delta;
  if (line.qty <= 0) state.cart.splice(idx,1);
  saveCart();
  renderPOS();
}

/* ---- checkout modal ---- */
var checkoutPay = "cash";
function openCheckoutModal(){
  checkoutPay = "cash";
  var total = cartTotal();
  var html = '<div class="overlay" id="ov"><div class="modal">'+
    '<h3>ยืนยันการชำระเงิน</h3>'+
    '<div style="margin-bottom:14px">';
  state.cart.forEach(function(l){
    html += '<div class="receipt-line"><span>'+esc(l.name)+' × '+l.qty+'</span><span>'+baht(l.price*l.qty)+'</span></div>';
  });
  html += '<div class="receipt-total"><span>ยอดรวม</span><span>'+baht(total)+'</span></div></div>';
  html += '<div class="field"><label>วิธีชำระเงิน</label><div class="pay-grid">';
  PAY_METHODS.forEach(function(p){
    html += '<button class="pay-opt" data-pay="'+p.id+'" aria-pressed="'+(p.id==="cash")+'">'+p.label+'</button>';
  });
  html += '</div></div>';
  html += '<div class="modal-actions"><button class="btn btn-ghost" id="cancel-pay">ยกเลิก</button>'+
    '<button class="btn btn-primary" id="confirm-pay">ยืนยันรับเงิน</button></div></div></div>';
  modalRoot.innerHTML = html;
  modalRoot.querySelectorAll("[data-pay]").forEach(function(b){
    b.addEventListener("click", function(){
      checkoutPay = b.getAttribute("data-pay");
      modalRoot.querySelectorAll("[data-pay]").forEach(function(x){
        x.setAttribute("aria-pressed", x===b ? "true":"false");
      });
    });
  });
  document.getElementById("cancel-pay").addEventListener("click", closeModal);
  document.getElementById("confirm-pay").addEventListener("click", function(){
    confirmCheckout(checkoutPay);
  });
}
function closeModal(){ modalRoot.innerHTML = ""; }

function confirmCheckout(payMethod){
  var btn = document.getElementById("confirm-pay");
  if (btn){ btn.disabled = true; btn.textContent = "กำลังบันทึก…"; }
  var cartSnapshot = state.cart.slice();
  var total = cartTotal();
  var orderTypeLabel = ORDER_TYPES.find(function(t){ return t.id===state.orderType; }).label;

  API.checkout({
    items: cartSnapshot.map(function(l){ return {menuItemId:l.menuItemId,name:l.name,price:l.price,qty:l.qty}; }),
    type: state.orderType,
    typeLabel: orderTypeLabel,
    paymentMethod: payMethod
  }).then(function(res){
    if (!res || res.ok === false) throw new Error((res && res.error) || "checkout failed");
    state.cart = [];
    saveCart();
    closeModal();
    renderPOS();
    loadCore(); // refresh stock levels right away
    toast("บันทึกออเดอร์แล้ว "+baht(total));
  }).catch(function(err){
    console.error(err);
    if (btn){ btn.disabled=false; btn.textContent="ยืนยันรับเงิน"; }
    toast("บันทึกไม่สำเร็จ ลองอีกครั้ง");
  });
}

/* ================= Inventory ================= */
function renderInventory(){
  var low = state.ingredients.filter(function(i){ return Number(i.stockQty) <= Number(i.reorderPoint); });
  var html = '';
  if (low.length){
    html += '<div class="alert-strip">วัตถุดิบใกล้หมด '+low.length+' รายการ: '+
      low.map(function(i){ return esc(i.name); }).join(", ") + '</div>';
  }
  html += '<div class="section-head"><h2>วัตถุดิบคงเหลือ</h2><button class="btn-small" id="goto-manage">จัดการเมนู/วัตถุดิบ</button></div>';
  if (!state.ingredients.length){
    html += '<div class="empty"><h3>ยังไม่มีวัตถุดิบในระบบ</h3></div>';
  } else {
    html += '<div class="inv-list">';
    state.ingredients.forEach(function(ing){
      var isLow = Number(ing.stockQty) <= Number(ing.reorderPoint);
      html += '<div class="inv-row">'+
        '<div class="info"><div class="iname">'+esc(ing.name)+'</div>'+
        '<div class="imeta">ต้นทุน '+baht(ing.costPerUnit)+' / '+esc(ing.unit)+' · จุดสั่งซื้อ '+fmt(ing.reorderPoint)+' '+esc(ing.unit)+'</div>'+
        (isLow ? '<span class="badge-low">ใกล้หมด</span>' : '')+
        '</div>'+
        '<div class="stock"><div class="n">'+fmt(ing.stockQty)+'</div><div class="u">'+esc(ing.unit)+'</div></div>'+
        '<button class="btn-small" data-receive="'+esc(ing.id)+'">รับของเข้า</button>'+
        '</div>';
    });
    html += '</div>';
  }
  viewEl.innerHTML = html;
  viewEl.querySelectorAll("[data-receive]").forEach(function(b){
    b.addEventListener("click", function(){ openReceiveModal(b.getAttribute("data-receive")); });
  });
  var gm = document.getElementById("goto-manage");
  if (gm) gm.addEventListener("click", function(){ setView("manage"); });
}

function openReceiveModal(ingredientId){
  var ing = state.ingredients.find(function(i){ return i.id === ingredientId; });
  if (!ing) return;
  var html = '<div class="overlay" id="ov"><div class="modal">'+
    '<h3>รับ'+esc(ing.name)+'เข้าสต๊อก</h3>'+
    '<div class="field"><label>จำนวนที่รับเข้า ('+esc(ing.unit)+')</label>'+
    '<input type="number" id="recv-qty" min="0" step="any" inputmode="decimal" placeholder="0"></div>'+
    '<div class="field"><label>ราคาต้นทุนต่อหน่วย (บาท) — เว้นว่างถ้าไม่เปลี่ยน</label>'+
    '<input type="number" id="recv-cost" min="0" step="any" inputmode="decimal" placeholder="'+ing.costPerUnit+'"></div>'+
    '<div class="modal-actions"><button class="btn btn-ghost" id="recv-cancel">ยกเลิก</button>'+
    '<button class="btn btn-primary" id="recv-confirm">บันทึกรับของ</button></div></div></div>';
  modalRoot.innerHTML = html;
  document.getElementById("recv-cancel").addEventListener("click", closeModal);
  document.getElementById("recv-confirm").addEventListener("click", function(){
    var qty = parseFloat(document.getElementById("recv-qty").value);
    var costRaw = document.getElementById("recv-cost").value;
    if (!qty || qty <= 0){ toast("กรอกจำนวนให้ถูกต้อง"); return; }
    var btn = document.getElementById("recv-confirm");
    btn.disabled = true; btn.textContent = "กำลังบันทึก…";
    API.receiveStock({ingredientId: ingredientId, qty: qty, costPerUnit: costRaw})
      .then(function(res){
        if (!res || res.ok === false) throw new Error((res && res.error) || "failed");
        closeModal();
        loadCore();
        toast("รับ"+ing.name+"เข้าสต๊อกแล้ว");
      }).catch(function(err){
        console.error(err);
        btn.disabled=false; btn.textContent="บันทึกรับของ";
        toast("บันทึกไม่สำเร็จ ลองอีกครั้ง");
      });
  });
}

/* ================= Reports ================= */
function loadReport(){
  state.reportLoading = true;
  render();
  API.getReport(state.reportRange).then(function(data){
    state.reportData = data;
    state.reportLoading = false;
    render();
  }).catch(function(err){
    console.error(err);
    state.reportLoading = false;
    state.reportData = {revenue:0,count:0,cogs:0,profit:0,marginPct:0,byType:{},topItems:[]};
    render();
  });
}

function renderReports(){
  var html = '<div class="chiprow" role="group" aria-label="ช่วงเวลา">';
  RANGES.forEach(function(r){
    html += '<button class="chip" data-range="'+r.id+'" aria-pressed="'+(state.reportRange===r.id)+'">'+r.label+'</button>';
  });
  html += '</div>';

  if (state.reportLoading || !state.reportData){
    html += '<div class="loading">กำลังคำนวณรายงาน…</div>';
    viewEl.innerHTML = html;
    bindReportRangeButtons();
    return;
  }

  var d = state.reportData;
  html += '<div class="tile-row">'+
    '<div class="tile"><div class="label">ยอดขายรวม</div><div class="value accent">'+baht(d.revenue)+'</div></div>'+
    '<div class="tile"><div class="label">จำนวนออเดอร์</div><div class="value">'+fmt(d.count)+'</div></div>'+
    '<div class="tile"><div class="label">ต้นทุนวัตถุดิบโดยประมาณ</div><div class="value">'+baht(d.cogs)+'</div></div>'+
    '<div class="tile"><div class="label">กำไรขั้นต้นโดยประมาณ</div><div class="value good">'+baht(d.profit)+' ('+fmt(d.marginPct)+'%)</div></div>'+
    '</div>';

  html += '<div class="channel-row">';
  ORDER_TYPES.forEach(function(t){
    html += '<div class="channel-pill"><div class="l">'+t.label+'</div><div class="v">'+baht((d.byType&&d.byType[t.id])||0)+'</div></div>';
  });
  html += '</div>';

  html += '<div class="section-head"><h2>เมนูขายดี</h2>'+
    '<button class="btn-small" id="export-csv">ดาวน์โหลดรายงาน (CSV)</button></div>';

  if (!d.topItems || !d.topItems.length){
    html += '<div class="empty"><h3>ยังไม่มีออเดอร์ในช่วงนี้</h3></div>';
  } else {
    html += '<div class="table-wrap"><table><thead><tr>'+
      '<th>เมนู</th><th class="num">จำนวนที่ขาย</th><th class="num">รายได้</th>'+
      '</tr></thead><tbody>';
    d.topItems.forEach(function(it){
      html += '<tr><td>'+esc(it.name)+'</td><td class="num">'+fmt(it.qty)+'</td><td class="num">'+baht(it.revenue)+'</td></tr>';
    });
    html += '</tbody></table></div>';
  }

  viewEl.innerHTML = html;
  bindReportRangeButtons();
  var exportBtn = document.getElementById("export-csv");
  if (exportBtn) exportBtn.addEventListener("click", exportReportCSV);
}
function bindReportRangeButtons(){
  viewEl.querySelectorAll("[data-range]").forEach(function(b){
    b.addEventListener("click", function(){
      state.reportRange = b.getAttribute("data-range");
      loadReport();
    });
  });
}
function exportReportCSV(){
  var d = state.reportData;
  var rangeLabel = RANGES.find(function(r){ return r.id===state.reportRange; }).label;
  var rows = [];
  rows.push(["รายงานยอดขาย ร้านของเรา", rangeLabel]);
  rows.push(["ยอดขายรวม (บาท)", d.revenue]);
  rows.push(["จำนวนออเดอร์", d.count]);
  rows.push(["ต้นทุนวัตถุดิบโดยประมาณ (บาท)", d.cogs.toFixed(2)]);
  rows.push(["กำไรขั้นต้นโดยประมาณ (บาท)", d.profit.toFixed(2)]);
  rows.push([]);
  rows.push(["เมนู","จำนวนที่ขาย","รายได้ (บาท)"]);
  (d.topItems||[]).forEach(function(it){ rows.push([it.name, it.qty, it.revenue]); });
  var csv = rows.map(function(r){
    return r.map(function(c){
      var s = String(c==null?"":c);
      return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
    }).join(",");
  }).join("\n");
  var blob = new Blob(["﻿"+csv], {type:"text/csv;charset=utf-8"});
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = "rayngan-yodkai-"+state.reportRange+".csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  toast("ดาวน์โหลดรายงานแล้ว");
}

/* ================= Manage (add/edit/delete menu items & ingredients) ================= */
function renderManage(){
  var html = '';

  html += '<div class="manage-section"><div class="section-head"><h2>เมนู ('+state.menuItems.length+')</h2></div>';
  html += '<button class="btn btn-brand add-fab" id="add-menu-btn">+ เพิ่มเมนูใหม่</button>';
  if (!state.menuItems.length){
    html += '<div class="empty"><h3>ยังไม่มีเมนู</h3></div>';
  } else {
    state.menuItems.forEach(function(m){
      var ringredCount = (m.recipe||[]).length;
      html += '<div class="manage-row">'+
        (m.imageUrl
          ? '<img class="mthumb" src="'+esc(m.imageUrl)+'" alt="">'
          : '<span class="mthumb-placeholder">'+esc((m.name||"?").charAt(0))+'</span>')+
        '<div class="info"><div class="mname">'+esc(m.name)+'</div>'+
        '<div class="mmeta">'+esc(m.category)+' · '+baht(m.price)+' · สูตร '+ringredCount+' วัตถุดิบ</div></div>'+
        '<div class="mactions">'+
          '<button class="btn-icon" data-edit-menu="'+esc(m.id)+'" aria-label="แก้ไข">✎</button>'+
          '<button class="btn-icon danger" data-del-menu="'+esc(m.id)+'" aria-label="ลบ">🗑</button>'+
        '</div></div>';
    });
  }
  html += '</div>';

  html += '<div class="manage-section"><div class="section-head"><h2>วัตถุดิบ ('+state.ingredients.length+')</h2></div>';
  html += '<button class="btn btn-brand add-fab" id="add-ing-btn">+ เพิ่มวัตถุดิบใหม่</button>';
  if (!state.ingredients.length){
    html += '<div class="empty"><h3>ยังไม่มีวัตถุดิบ</h3></div>';
  } else {
    state.ingredients.forEach(function(ing){
      html += '<div class="manage-row">'+
        '<div class="info"><div class="mname">'+esc(ing.name)+'</div>'+
        '<div class="mmeta">'+fmt(ing.stockQty)+' '+esc(ing.unit)+' คงเหลือ · ต้นทุน '+baht(ing.costPerUnit)+'/'+esc(ing.unit)+'</div></div>'+
        '<div class="mactions">'+
          '<button class="btn-icon" data-edit-ing="'+esc(ing.id)+'" aria-label="แก้ไข">✎</button>'+
          '<button class="btn-icon danger" data-del-ing="'+esc(ing.id)+'" aria-label="ลบ">🗑</button>'+
        '</div></div>';
    });
  }
  html += '</div>';

  viewEl.innerHTML = html;

  document.getElementById("add-menu-btn").addEventListener("click", function(){ openMenuModal(null); });
  document.getElementById("add-ing-btn").addEventListener("click", function(){ openIngredientModal(null); });
  viewEl.querySelectorAll("[data-edit-menu]").forEach(function(b){
    b.addEventListener("click", function(){ openMenuModal(b.getAttribute("data-edit-menu")); });
  });
  viewEl.querySelectorAll("[data-edit-ing]").forEach(function(b){
    b.addEventListener("click", function(){ openIngredientModal(b.getAttribute("data-edit-ing")); });
  });
  bindDeleteConfirm(viewEl.querySelectorAll("[data-del-menu]"), function(id){ deleteMenuItem(id); });
  bindDeleteConfirm(viewEl.querySelectorAll("[data-del-ing]"), function(id){ deleteIngredient(id); });
}

function bindDeleteConfirm(nodeList, onConfirm){
  nodeList.forEach(function(btn){
    var armed = false, timer = null;
    var id = btn.getAttribute("data-del-menu") || btn.getAttribute("data-del-ing");
    btn.addEventListener("click", function(){
      if (!armed){
        armed = true;
        btn.classList.add("confirming");
        btn.textContent = "?";
        timer = setTimeout(function(){ armed=false; btn.classList.remove("confirming"); btn.textContent="🗑"; }, 3000);
      } else {
        clearTimeout(timer);
        onConfirm(id);
      }
    });
  });
}

/* ---- ingredient add/edit modal ---- */
function openIngredientModal(ingredientId){
  var editing = !!ingredientId;
  var ing = editing ? state.ingredients.find(function(i){ return i.id===ingredientId; }) : null;
  var html = '<div class="overlay" id="ov"><div class="modal">'+
    '<h3>'+(editing ? "แก้ไขวัตถุดิบ" : "เพิ่มวัตถุดิบใหม่")+'</h3>'+
    '<div class="field"><label>ชื่อวัตถุดิบ</label><input id="ing-name" value="'+(ing?esc(ing.name):'')+'" placeholder="เช่น ข้าวสาร"></div>'+
    '<div class="field"><label>หน่วยนับ</label><input id="ing-unit" value="'+(ing?esc(ing.unit):'')+'" placeholder="เช่น กก., ฟอง, แผ่น"></div>'+
    '<div class="field"><label>สต๊อกคงเหลือ</label><input type="number" id="ing-stock" min="0" step="any" inputmode="decimal" value="'+(ing?ing.stockQty:'')+'"></div>'+
    '<div class="field"><label>ราคาต้นทุนต่อหน่วย (บาท)</label><input type="number" id="ing-cost" min="0" step="any" inputmode="decimal" value="'+(ing?ing.costPerUnit:'')+'"></div>'+
    '<div class="field"><label>จุดสั่งซื้อขั้นต่ำ (แจ้งเตือนเมื่อต่ำกว่านี้)</label><input type="number" id="ing-reorder" min="0" step="any" inputmode="decimal" value="'+(ing?ing.reorderPoint:'')+'"></div>'+
    '<div class="modal-actions"><button class="btn btn-ghost" id="ing-cancel">ยกเลิก</button>'+
    '<button class="btn btn-primary" id="ing-save">'+(editing?"บันทึกการแก้ไข":"เพิ่มวัตถุดิบ")+'</button></div></div></div>';
  modalRoot.innerHTML = html;
  document.getElementById("ing-cancel").addEventListener("click", closeModal);
  document.getElementById("ing-save").addEventListener("click", function(){
    var name = document.getElementById("ing-name").value.trim();
    var unit = document.getElementById("ing-unit").value.trim();
    var stock = parseFloat(document.getElementById("ing-stock").value);
    var cost = parseFloat(document.getElementById("ing-cost").value);
    var reorder = parseFloat(document.getElementById("ing-reorder").value);
    if (!name || !unit || isNaN(stock) || isNaN(cost) || isNaN(reorder)){
      toast("กรอกข้อมูลให้ครบถ้วน"); return;
    }
    var btn = document.getElementById("ing-save");
    btn.disabled = true; btn.textContent = "กำลังบันทึก…";
    API.upsertIngredient({
      id: editing ? ingredientId : undefined,
      name:name, unit:unit, stockQty:stock, costPerUnit:cost, reorderPoint:reorder
    }).then(function(res){
      if (!res || res.ok === false) throw new Error((res && res.error) || "failed");
      closeModal();
      loadCore();
      toast(editing ? "แก้ไขวัตถุดิบแล้ว" : "เพิ่มวัตถุดิบแล้ว");
    }).catch(function(err){
      console.error(err);
      btn.disabled=false; btn.textContent = editing?"บันทึกการแก้ไข":"เพิ่มวัตถุดิบ";
      toast("บันทึกไม่สำเร็จ ลองอีกครั้ง");
    });
  });
}
function deleteIngredient(ingredientId){
  API.deleteIngredient(ingredientId).then(function(){
    loadCore();
    toast("ลบวัตถุดิบแล้ว");
  }).catch(function(err){
    console.error(err);
    toast("ลบไม่สำเร็จ ลองอีกครั้ง");
  });
}

/* ---- menu item add/edit modal (with recipe builder + image) ---- */
var menuRecipeDraft = []; // [{ingredientId, qty}]
var menuImageDraft = {currentUrl:null, newFile:null, removed:false};
function openMenuModal(menuItemId){
  var editing = !!menuItemId;
  var m = editing ? state.menuItems.find(function(x){ return x.id===menuItemId; }) : null;
  menuRecipeDraft = editing && m.recipe ? m.recipe.map(function(r){ return {ingredientId:r.ingredientId, qty:r.qty}; }) : [];
  menuImageDraft = {currentUrl: (m && m.imageUrl) || null, newFile:null, removed:false};

  var html = '<div class="overlay" id="ov"><div class="modal">'+
    '<h3>'+(editing ? "แก้ไขเมนู" : "เพิ่มเมนูใหม่")+'</h3>'+
    '<div class="field"><label>รูปเมนู (ให้ลูกค้าดู)</label><div class="image-picker" id="image-picker"></div></div>'+
    '<div class="field"><label>ชื่อเมนู</label><input id="menu-name" value="'+(m?esc(m.name):'')+'" placeholder="เช่น โจ๊กหมู"></div>'+
    '<div class="field"><label>หมวดหมู่</label><input id="menu-cat" list="cat-list" value="'+(m?esc(m.category):'')+'" placeholder="เลือกหรือพิมพ์หมวดใหม่">'+
    '<datalist id="cat-list">'+CATS.map(function(c){ return '<option value="'+esc(c)+'">'; }).join('')+'</datalist></div>'+
    '<div class="field"><label>ราคาขาย (บาท)</label><input type="number" id="menu-price" min="0" step="any" inputmode="decimal" value="'+(m?m.price:'')+'"></div>'+
    '<div class="field"><label>สูตร (วัตถุดิบที่ใช้)</label><div id="recipe-rows"></div>'+
    '<button type="button" class="recipe-add" id="recipe-add-row">+ เพิ่มวัตถุดิบในสูตร</button></div>'+
    '<div class="modal-actions"><button class="btn btn-ghost" id="menu-cancel">ยกเลิก</button>'+
    '<button class="btn btn-primary" id="menu-save">'+(editing?"บันทึกการแก้ไข":"เพิ่มเมนู")+'</button></div></div></div>';
  modalRoot.innerHTML = html;
  renderRecipeRows();
  renderImagePicker();

  document.getElementById("recipe-add-row").addEventListener("click", function(){
    var firstIng = state.ingredients[0];
    menuRecipeDraft.push({ingredientId: firstIng ? firstIng.id : "", qty: 1});
    renderRecipeRows();
  });
  document.getElementById("menu-cancel").addEventListener("click", closeModal);
  document.getElementById("menu-save").addEventListener("click", function(){
    var name = document.getElementById("menu-name").value.trim();
    var category = document.getElementById("menu-cat").value.trim();
    var price = parseFloat(document.getElementById("menu-price").value);
    if (!name || !category || isNaN(price)){ toast("กรอกข้อมูลให้ครบถ้วน"); return; }
    var recipe = menuRecipeDraft.filter(function(r){ return r.ingredientId && r.qty>0; });
    var btn = document.getElementById("menu-save");
    btn.disabled = true; btn.textContent = "กำลังบันทึก…";

    if (menuImageDraft.newFile){
      fileToDataUrl(menuImageDraft.newFile).then(function(dataUrl){
        return API.uploadImageAndSaveMenuItem({
          id: editing ? menuItemId : undefined,
          name:name, category:category, price:price, recipe:recipe,
          dataUrl: dataUrl, filename: menuImageDraft.newFile.name
        });
      }).then(function(){
        closeModal();
        setTimeout(loadCore, 1500);
        toast(editing ? "แก้ไขเมนูแล้ว" : "เพิ่มเมนูแล้ว");
      }).catch(function(err){
        console.error(err);
        btn.disabled=false; btn.textContent = editing?"บันทึกการแก้ไข":"เพิ่มเมนู";
        toast("บันทึกไม่สำเร็จ ลองอีกครั้ง");
      });
    } else {
      var payload = { id: editing ? menuItemId : undefined, name:name, category:category, price:price, recipe:recipe };
      if (menuImageDraft.removed) payload.imageUrl = "";
      API.upsertMenuItem(payload).then(function(res){
        if (!res || res.ok === false) throw new Error((res && res.error) || "failed");
        closeModal();
        loadCore();
        toast(editing ? "แก้ไขเมนูแล้ว" : "เพิ่มเมนูแล้ว");
      }).catch(function(err){
        console.error(err);
        btn.disabled=false; btn.textContent = editing?"บันทึกการแก้ไข":"เพิ่มเมนู";
        toast("บันทึกไม่สำเร็จ ลองอีกครั้ง");
      });
    }
  });
}
function fileToDataUrl(file){
  return new Promise(function(resolve, reject){
    var reader = new FileReader();
    reader.onload = function(){
      var img = new Image();
      img.onload = function(){
        var maxW = 700;
        var scale = Math.min(1, maxW / img.width);
        var canvas = document.createElement("canvas");
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.65));
      };
      img.onerror = function(){ resolve(reader.result); };
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function renderImagePicker(){
  var wrap = document.getElementById("image-picker");
  if (!wrap) return;
  var previewSrc = null;
  if (menuImageDraft.newFile) previewSrc = URL.createObjectURL(menuImageDraft.newFile);
  else if (menuImageDraft.currentUrl && !menuImageDraft.removed) previewSrc = menuImageDraft.currentUrl;

  var html = previewSrc
    ? '<img class="preview" src="'+previewSrc+'" alt="">'
    : '<span class="preview-placeholder">ยังไม่มีรูป</span>';
  html += '<div class="picker-actions">'+
    '<input type="file" id="image-file-input" accept="image/png,image/jpeg,image/webp,image/gif">'+
    (previewSrc ? '<button type="button" class="btn-small" id="image-remove-btn">ลบรูปนี้</button>' : '')+
    '</div>';
  wrap.innerHTML = html;
  document.getElementById("image-file-input").addEventListener("change", function(e){
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 10*1024*1024){ toast("ไฟล์รูปใหญ่เกิน 10MB"); return; }
    menuImageDraft.newFile = file;
    menuImageDraft.removed = false;
    renderImagePicker();
  });
  var rmBtn = document.getElementById("image-remove-btn");
  if (rmBtn) rmBtn.addEventListener("click", function(){
    menuImageDraft.newFile = null;
    menuImageDraft.removed = true;
    renderImagePicker();
  });
}
function renderRecipeRows(){
  var wrap = document.getElementById("recipe-rows");
  if (!wrap) return;
  if (!state.ingredients.length){
    wrap.innerHTML = '<div class="muted" style="font-size:12px">ยังไม่มีวัตถุดิบในระบบ — เพิ่มวัตถุดิบก่อนตั้งสูตร</div>';
    return;
  }
  var html = '';
  menuRecipeDraft.forEach(function(r, i){
    html += '<div class="recipe-row">'+
      '<select data-ridx="'+i+'" data-rfield="ing">'+
      state.ingredients.map(function(ing){
        return '<option value="'+esc(ing.id)+'" '+(ing.id===r.ingredientId?'selected':'')+'>'+esc(ing.name)+' ('+esc(ing.unit)+')</option>';
      }).join('')+
      '</select>'+
      '<input type="number" min="0" step="any" inputmode="decimal" data-ridx="'+i+'" data-rfield="qty" value="'+r.qty+'">'+
      '<button type="button" class="btn-icon danger" data-rdel="'+i+'" aria-label="ลบแถว">✕</button>'+
      '</div>';
  });
  wrap.innerHTML = html;
  wrap.querySelectorAll("[data-rfield='ing']").forEach(function(sel){
    sel.addEventListener("change", function(){
      menuRecipeDraft[+sel.getAttribute("data-ridx")].ingredientId = sel.value;
    });
  });
  wrap.querySelectorAll("[data-rfield='qty']").forEach(function(inp){
    inp.addEventListener("input", function(){
      menuRecipeDraft[+inp.getAttribute("data-ridx")].qty = parseFloat(inp.value)||0;
    });
  });
  wrap.querySelectorAll("[data-rdel]").forEach(function(b){
    b.addEventListener("click", function(){
      menuRecipeDraft.splice(+b.getAttribute("data-rdel"), 1);
      renderRecipeRows();
    });
  });
}
function deleteMenuItem(menuItemId){
  API.deleteMenuItem(menuItemId).then(function(){
    loadCore();
    toast("ลบเมนูแล้ว");
  }).catch(function(err){
    console.error(err);
    toast("ลบไม่สำเร็จ ลองอีกครั้ง");
  });
}
