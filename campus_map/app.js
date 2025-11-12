// ====== 전역 ======
let map, markers = [], routing, places = [], realtime = {};
let selectedFrom = null, selectedTo = null;
// ===== 실시간 위치 추적 =====
let watchId = null;
let userMarker = null;
let accuracyCircle = null;
let gotFirstFix = false;

// ===== 엘리베이터 레이어 =====
let elevatorLayer = null;
const elevatorIcon = L.icon({
  // 작고 선명한 SVG 아이콘 (데이터 URI)
  iconUrl:
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24">
      <rect x="3" y="3" width="18" height="18" rx="4" ry="4" fill="#2563eb"/>
      <path d="M8 7h8v10H8z" fill="#fff"/>
      <circle cx="12" cy="10" r="1.3" fill="#2563eb"/>
      <rect x="9" y="11.5" width="6" height="3.2" rx="0.6" fill="#2563eb"/>
      <rect x="10.2" y="15.2" width="3.6" height="0.9" rx="0.45" fill="#2563eb"/>
    </svg>`),
  iconSize: [24, 24],
  iconAnchor: [12, 12]
});

// ===== 자동문 레이어 =====
let doorLayer = null;
const doorIcon = L.icon({
  iconUrl:
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24">
      <rect x="3" y="3" width="18" height="18" rx="4" ry="4" fill="#10b981"/>
      <path d="M7 7h10v10H7z" fill="#fff"/>
      <rect x="8.2" y="7" width="1.4" height="10" fill="#10b981"/>
      <rect x="14.4" y="7" width="1.4" height="10" fill="#10b981"/>
    </svg>`),
  iconSize: [24, 24],
  iconAnchor: [12, 12]
});


// === 부드러운 좌표 애니메이션 유틸 ===
function easeInOut(t) {
  // 0~1 -> 0~1 부드러운 가속/감속
  return t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t;
}

function animateLatLng(layer, fromLatLng, toLatLng, { duration = 700 } = {}) {
  // layer: L.circleMarker, L.circle 등 setLatLng 지원 레이어
  // fromLatLng, toLatLng: [lat, lng]
  return new Promise(resolve => {
    const start = performance.now();
    const [lat0, lng0] = fromLatLng;
    const [lat1, lng1] = toLatLng;

    function frame(now) {
      const t = Math.min((now - start) / duration, 1);
      const k = easeInOut(t);
      const lat = lat0 + (lat1 - lat0) * k;
      const lng = lng0 + (lng1 - lng0) * k;
      layer.setLatLng([lat, lng]);
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}


function updateUserPosition({ latitude, longitude, accuracy }) {
  const latlng = [latitude, longitude];
  const auto = document.querySelector('#autotrack')?.checked ?? true;
  const isRoutingActive = !!routing;

  // (1) 마커/정확도 원 생성 또는 갱신
  if (!userMarker) {
    userMarker = L.circleMarker(latlng, { radius: 8, color: 'blue' })
      .addTo(map)
      .bindPopup('내 위치');
  } else {
    const prev = userMarker.getLatLng();
    // autotrack 여부와 무관하게 파란 점은 부드럽게 이동
    animateLatLng(userMarker, [prev.lat, prev.lng], latlng, { duration: 700 });
  }

  if (!accuracyCircle) {
    accuracyCircle = L.circle(latlng, {
      radius: accuracy || 15,
      weight: 1,
      fillOpacity: 0.1
    }).addTo(map);
  } else {
    const prevAcc = accuracyCircle.getLatLng();
    animateLatLng(accuracyCircle, [prevAcc.lat, prevAcc.lng], latlng, { duration: 700 });
    if (accuracy) accuracyCircle.setRadius(accuracy);
  }

  // (2) 지도 중심 이동 제어
  //  - 길찾기 중이면 절대 움직이지 않음
  //  - autotrack 꺼져 있으면 절대 움직이지 않음
  //  - autotrack 켜져 있고 길찾기 없음: 첫 고정 1회 setView, 이후 화면 밖으로 나갈 때만 panTo
  if (auto && !isRoutingActive) {
    if (!gotFirstFix) {
      map.setView(latlng, 18);
      gotFirstFix = true;
    } else {
      // 뷰포트 밖으로 벗어난 경우에만 따라붙기 → 과한 흔들림 방지
      if (!map.getBounds().pad(-0.15).contains(latlng)) {
        map.panTo(latlng, { animate: true });
      }
    }
  }
}


function startWatchingLocation() {
  if (watchId) return; // 이미 감시 중이면 중복 방지
  if (!navigator.geolocation) {
    alert("이 브라우저는 위치 기능을 지원하지 않습니다.");
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      updateUserPosition({ latitude, longitude, accuracy }); // 지도에 파란 점만 업데이트
    },
    (err) => console.warn("위치 추적 실패:", err),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );
}

function stopWatchingLocation() {
  if (watchId) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}





// 프로필별 가중치(확장 여지)
const profile = {
  current: "default",
  set(v){ this.current = v; renderMarkers(); }
};

// ====== 유틸 ======
const $ = (sel)=>document.querySelector(sel);
function speak(text){
  if(!window.speechSynthesis) return alert("이 브라우저는 음성안내를 지원하지 않습니다.");
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ko-KR";
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}
function amenityChips(a){
  const yesNo = (v)=> v ? "⭕" : "❌";
  return `
    <span class="marker-badge">엘베 ${yesNo(a.elevator)}</span>
    <span class="marker-badge">경사로 ${yesNo(a.ramp)}</span>
    <span class="marker-badge">자동문 ${yesNo(a.autoDoor)}</span>
  `;
}

// ====== 지도 초기화 ======
function initMap(){
  const catholicCenter = [37.4865, 126.8013];
  map = L.map('map').setView(catholicCenter, 18);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 20,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  const coordBox = document.getElementById('coordbox');

  map.on('mousemove', (e) => {
    const { lat, lng } = e.latlng;
    coordBox.textContent = `lat,lng = ${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  });

  map.on('click', async (e) => {
    const { lat, lng } = e.latlng;
    const text = `lat,lng = ${lat.toFixed(6)}, ${lng.toFixed(6)}`;

  L.circleMarker(e.latlng, { radius:6 }).addTo(map).bindPopup(text).openPopup();

  try { await navigator.clipboard.writeText(text); } catch(e){}
  });

  elevatorLayer = L.layerGroup().addTo(map);
  doorLayer = L.layerGroup().addTo(map);
}

// ====== 데이터 로드 ======
async function loadData(){
  const res = await fetch('data/places.json');
  const data = await res.json();
  places = data.places;
  realtime = data.realtime || {};
  renderMarkers();
  renderRealtime();
}

// ====== 마커 렌더 ======
function renderMarkers(){
  // 기존 마커 제거
  markers.forEach(m=>map.removeLayer(m));
  markers = [];

  places.forEach(p=>{
    // 프로필에 따른 표시/필터 예시: 휠체어는 엘리베이터/경사로 둘 중 하나라도 있어야 표시
    if(profile.current === 'wheelchair' && !(p.amenities.elevator || p.amenities.ramp)) return;

    const m = L.marker([p.lat, p.lng]).addTo(map);
    m.bindPopup(`
      <b>${p.name}</b><br/>
      ${amenityChips(p.amenities)}<br/>
      <small>${p.note || ""}</small><br/>
      <button onclick="setFrom('${p.id}')">출발로 설정</button>
      <button onclick="setTo('${p.id}')">도착으로 설정</button>
    `);
    m.on('click', ()=>{
      $('#info').innerHTML = `
        <h3>${p.name}</h3>
        ${amenityChips(p.amenities)}
        <p>${p.note || ""}</p>
      `;
      $('#search').value = p.name;
    });
    markers.push(m);
  });
}

window.setFrom = function(id){
  const p = places.find(x=>x.id===id);
  if(!p) return;
  selectedFrom = p;
  $('#from').value = p.name;
}
window.setTo = function(id){
  const p = places.find(x=>x.id===id);
  if(!p) return;
  selectedTo = p;
  $('#to').value = p.name;
}

// ====== 길찾기 ======
function route(){
  if(!selectedFrom || !selectedTo){
    return alert("출발지와 도착지를 모두 선택하세요.");
  }
  // 기존 경로 제거
  if(routing){ map.removeControl(routing); routing = null; }

  // 프로필에 따라 ‘계단 우회’ 같은 고급 로직은 백엔드/커스텀 라우팅 필요.
  // 여기서는 OSRM 기본 길찾기를 사용(야외 경로).
  routing = L.Routing.control({
    waypoints: [
      L.latLng(selectedFrom.lat, selectedFrom.lng),
      L.latLng(selectedTo.lat, selectedTo.lng)
    ],
    lineOptions: { addWaypoints: false },
    router: L.Routing.osrmv1({ serviceUrl: 'https://router.project-osrm.org/route/v1' }),
    show: false
  }).addTo(map);

  routing.on('routesfound', function(e){
    const summary = e.routes[0].summary; // 거리/시간
    const min = Math.round(summary.totalTime/60);
    $('#info').innerHTML += `<p><b>예상 소요:</b> ${min}분, ${(summary.totalDistance/1000).toFixed(2)} km</p>`;
    if(profile.current === 'vision'){
      speak(`경로를 안내합니다. 예상 소요 ${min}분입니다.`);
    }
  });
}

// ====== 실시간(더미) ======
function renderRealtime(){
  const list = $('#realtimeList');
  list.innerHTML = '';
  const elevators = realtime.elevators || {};
  Object.keys(elevators).forEach(k=>{
    const it = elevators[k];
    const li = document.createElement('li');
    li.textContent = `${k}: 대기 ${it.waitSec}초 (${it.status})`;
    list.appendChild(li);
  });
}

function bindUI(){
  $('#profile').addEventListener('change', e => profile.set(e.target.value));

  // 출발/도착이 '정문' / 'M407'일 때만 고정경로 표시
  $('#routeBtn').addEventListener('click', () => {
    const from = $('#from').value.trim();
    const to = $('#to').value.trim();
    if (from.includes('정문') && to.toUpperCase().includes('M407')) {
      drawPredefinedAccessibleRoute();  // ✅ 여기서 호출
    } else {
      alert('해당 출발지–도착지 조합에 대한 경로 정보가 없습니다.');
    }
  });

  $('#ttsBtn').addEventListener('click', ()=>{
    const text = $('#info').innerText || '안내할 내용이 없습니다.';
    speak(text);
  });

  // '내 위치' 버튼은 재중심용 (실시간 추적은 자동 시작)
  document.getElementById("locateBtn").addEventListener("click", () => {
    startWatchingLocation();
  });


  // 검색 엔터
  $('#search').addEventListener('keydown', (e)=>{
    if(e.key!=='Enter') return;
    const q = e.target.value.trim();
    const p = places.find(x=>x.name.includes(q));
    if(p){ map.setView([p.lat,p.lng], 19); }
  });

  // 엘리베이터 아이콘 초기 로드
  loadElevators();

  // 엘리베이터 표시 토글 (HTML에 #toggleElev 있으면 동작)
  const elevToggle = document.querySelector('#toggleElev');
  if (elevToggle) {
    elevToggle.addEventListener('change', (e) => {
      if (e.target.checked) elevatorLayer.addTo(map);
      else map.removeLayer(elevatorLayer);
    });
  }

  // 자동문 표시 토글
  const doorToggle = document.querySelector('#toggleDoors');
  if (doorToggle) {
    doorToggle.addEventListener('change', (e) => {
      if (e.target.checked) doorLayer.addTo(map);
      else map.removeLayer(doorLayer);
    });
  }


  // ✅ 페이지 로드 시 실시간 위치 추적 시작
  startWatchingLocation();
}



async function drawPredefinedAccessibleRoute() {
  const res = await fetch('data/routes.json');
  const data = await res.json();
  const { nodes, path } = data;

  // 기존 경로 제거
  if (window._routeLayer) map.removeLayer(window._routeLayer);
  if (window._routePins) window._routePins.forEach(p => map.removeLayer(p));
  window._routePins = [];

  // 좌표 시퀀스
  const latlngs = path.map(id => [nodes[id].lat, nodes[id].lng]);

  // 경로 라인 표시
  window._routeLayer = L.polyline(latlngs, { color: 'blue', weight: 6 }).addTo(map);
  map.fitBounds(window._routeLayer.getBounds(), { padding: [40, 40] });

  // 단계별 설명
  const stepTexts = [
    "정문에서 김수환관 출입구로 이동",
    "김수환관 1층 엘리베이터로 진입",
    "엘리베이터를 타고 4층으로 이동",
    "4층 출구를 통해 마리아관 방향으로 이동",
    "마리아관 1층 입구로 진입",
    "마리아관 1층 엘리베이터 탑승",
    "4층 M407 강의실 도착"
  ];

  // 번호 마커 표시
  path.forEach((id, i) => {
    const n = nodes[id];
    const icon = L.divIcon({
      className: 'step-pin',
      html: (i + 1).toString(),
      iconSize: [26, 26]
    });
    const pin = L.marker([n.lat, n.lng], { icon })
      .addTo(map)
      .bindPopup(`<b>${i + 1}단계</b><br>${n.name}<br>${stepTexts[i]}`);
    window._routePins.push(pin);
  });

  // 패널 내용 및 음성 안내
  const list = stepTexts.map(t => `<li>${t}</li>`).join('');
  $('#info').innerHTML = `
    <h3>정문 → 마리아관 4층 (M407) 무계단 경로</h3>
    <ol class="steps">${list}</ol>
  `;
  speak("정문에서 김수환관을 거쳐 마리아관 4층 M407 강의실로 가는 무계단 경로를 표시했습니다.");
}


async function loadElevators() {
  try {
    const res = await fetch('data/elevators.json');
    const data = await res.json();
    renderElevators(data.elevators || []);
  } catch (e) {
    console.warn('elevators.json 로드 실패', e);
  }
}

function renderElevators(list) {
  elevatorLayer.clearLayers();
  list.forEach(ev => {
    L.marker([ev.lat, ev.lng], { icon: elevatorIcon, zIndexOffset: 500 })
      .addTo(elevatorLayer)
      .bindPopup(`<b>엘리베이터</b><br>${ev.name}${ev.note ? `<br><small>${ev.note}</small>` : ''}`);
  });
}

async function loadDoors() {
  try {
    const res = await fetch('data/doors.json');
    const data = await res.json();
    renderDoors(data.doors || []);
  } catch (e) {
    console.warn('doors.json 로드 실패', e);
  }
}

function renderDoors(list) {
  doorLayer.clearLayers();
  list.forEach(d => {
    L.marker([d.lat, d.lng], { icon: doorIcon, zIndexOffset: 400 })
      .addTo(doorLayer)
      .bindPopup(`<b>자동문</b><br>${d.name}${d.note ? `<br><small>${d.note}</small>` : ''}`);
  });
}

async function loadRealtime() {
  try {
    const res = await fetch('data/realtime.json?_=' + Date.now()); // 캐시 방지
    const data = await res.json();
    updateRealtimeDisplay(data);
    updateIconsByRealtime(data);
    renderRealtimeWidgetTiles(data);
  } catch (e) {
    console.warn('realtime.json 로드 실패', e);
  }
}

function updateRealtimeDisplay(data) {
  const list = $('#realtimeList');
  list.innerHTML = '';

  Object.entries(data.elevators).forEach(([name, v]) => {
    const li = document.createElement('li');
    li.textContent = `🛗 ${name}: 대기 ${v.waitSec}초 (${v.status})`;
    list.appendChild(li);
  });

  Object.entries(data.doors).forEach(([name, v]) => {
    const li = document.createElement('li');
    li.textContent = `🚪 ${name}: 이용 ${v.useFreq} (${v.status})`;
    list.appendChild(li);
  });
}

function updateIconsByRealtime(data) {
  // 엘리베이터 혼잡도에 따라 아이콘 색 변경
  elevatorLayer.eachLayer(layer => {
    const name = layer.getPopup().getContent().match(/<br>(.*?)</)?.[1];
    const info = data.elevators[name];
    if (!info) return;
    const color = info.status === "혼잡" ? "red" : "blue";
    layer.setIcon(L.divIcon({
      html: "🛗",
      className: "emoji-icon",
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      style: `filter: drop-shadow(0 0 4px ${color});`
    }));
  });
}

// 상태 문자열 → 클래스 매핑
function statusClass(s){
  if(!s) return "rt-norm";
  const t = String(s).toLowerCase();
  if(["여유","free","low","낮음"].some(k=>t.includes(k))) return "rt-ok";
  if(["혼잡","busy","crowd","높음"].some(k=>t.includes(k))) return "rt-busy";
  if(["점검","주의","warn","closed"].some(k=>t.includes(k))) return "rt-warn";
  return "rt-norm"; // 보통
}

// 좌하단 위젯 타일 렌더
function renderRealtimeWidgetTiles(data){
  // 1순위: 모바일 패널 왼쪽(#rt-panel), 2순위: 데스크톱 오버레이(#rt-widget)
  const box = document.getElementById('rt-panel') || document.getElementById('rt-widget');
  if(!box) return;

  const makeTiles = (obj, emoji) => Object.entries(obj||{}).map(([name, v])=>{
    const label = v.status || (v.waitSec!=null ? `${v.waitSec}s` : (v.useFreq || "보통"));
    const cls = statusClass(label);
    return `
      <div class="rt-tile">
        <div class="rt-name">${emoji} ${name}</div>
        <div class="rt-badge ${cls}">${label}</div>
      </div>`;
  }).join('');

  box.innerHTML = `
    <h4>실시간 혼잡</h4>
    <div class="rt-grid">
      ${makeTiles(data.elevators, "🛗")}
      ${makeTiles(data.doors, "🚪")}
    </div>
  `;
}




// ====== 시작 ======
initMap();
loadData();
loadElevators(); 
loadDoors();
bindUI();

loadRealtime(); // 첫 실행

