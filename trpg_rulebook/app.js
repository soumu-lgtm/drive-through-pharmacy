// ===== Supabase初期化 =====
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ローカルモード判定（Supabase未設定時のフォールバック）
const isLocalMode = typeof LOCAL_MODE !== 'undefined' && LOCAL_MODE;

// ===== 状態管理 =====
let currentUser = null;
let screenshots = [];
let systems = [];
let tagMaster = [];
let activeFilters = new Set();
let currentTags = [];         // アップロード時のタグ
let uploadFiles = [];         // アップロード時のファイル
let filteredList = [];
let currentLbIndex = -1;

// カテゴリ分類用
const chapterTagNames = ['キャラ作成', '戦闘', '判定', 'ワールド', 'セッション進行'];

// ===== ローカルモード用デフォルトデータ =====
const defaultSystems = [
  { id: 1, name: 'ダブルクロス3rd', short_name: 'DX3', color: '#e94560' },
  { id: 2, name: 'クトゥルフ7版', short_name: 'CoC7', color: '#2ed573' },
  { id: 3, name: 'ソードワールド2.5', short_name: 'SW25', color: '#ffa502' },
  { id: 4, name: 'インセイン', short_name: 'INS', color: '#a55eea' },
];

const defaultTagMaster = [
  { name: 'シンドローム', system_name: 'ダブルクロス3rd', category: 'content', sort_order: 1 },
  { name: 'エフェクト', system_name: 'ダブルクロス3rd', category: 'content', sort_order: 2 },
  { name: 'コンボ', system_name: 'ダブルクロス3rd', category: 'content', sort_order: 3 },
  { name: 'ロイス', system_name: 'ダブルクロス3rd', category: 'content', sort_order: 4 },
  { name: 'タイタス', system_name: 'ダブルクロス3rd', category: 'content', sort_order: 5 },
  { name: '侵蝕率', system_name: 'ダブルクロス3rd', category: 'content', sort_order: 6 },
  { name: 'Dロイス', system_name: 'ダブルクロス3rd', category: 'content', sort_order: 7 },
  { name: 'アイテム', system_name: 'ダブルクロス3rd', category: 'content', sort_order: 8 },
  { name: 'ユニークアイテム', system_name: 'ダブルクロス3rd', category: 'content', sort_order: 9 },
  { name: 'ワークス', system_name: 'ダブルクロス3rd', category: 'content', sort_order: 10 },
  { name: 'レネゲイドビーイング', system_name: 'ダブルクロス3rd', category: 'content', sort_order: 11 },
  { name: 'キャラ作成', system_name: null, category: 'chapter', sort_order: 1 },
  { name: '戦闘', system_name: null, category: 'chapter', sort_order: 2 },
  { name: '判定', system_name: null, category: 'chapter', sort_order: 3 },
  { name: 'ワールド', system_name: null, category: 'chapter', sort_order: 4 },
];

// ===== 認証 =====
async function checkSession() {
  if (isLocalMode) {
    // ローカルモード: ログインスキップ
    currentUser = { id: 'local', user_metadata: { display_name: 'ローカルユーザー' }, email: 'local@test' };
    showMainApp();
    return;
  }
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    currentUser = session.user;
    showMainApp();
  }
}

async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';

  if (!email || !password) {
    errEl.textContent = 'メールアドレスとパスワードを入力してください';
    return;
  }

  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    errEl.textContent = 'ログインに失敗しました: ' + error.message;
    return;
  }
  currentUser = data.user;
  showMainApp();
}

async function doSignup() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const displayName = document.getElementById('loginDisplayName').value.trim();
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';

  if (!email || !password) {
    errEl.textContent = 'メールアドレスとパスワードを入力してください';
    return;
  }
  if (!displayName) {
    errEl.textContent = '表示名を入力してください';
    return;
  }

  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName } }
  });
  if (error) {
    errEl.textContent = '登録に失敗しました: ' + error.message;
    return;
  }

  // メール確認不要設定の場合はそのままログイン
  if (data.session) {
    currentUser = data.user;
    showMainApp();
  } else {
    errEl.textContent = '';
    errEl.style.color = 'var(--success)';
    errEl.textContent = '登録しました。確認メールを送信した場合はメール内のリンクをクリックしてください。';
  }
}

async function doLogout() {
  await sb.auth.signOut();
  currentUser = null;
  document.getElementById('mainApp').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'flex';
}

function getDisplayName() {
  if (!currentUser) return '不明';
  return currentUser.user_metadata?.display_name || currentUser.email?.split('@')[0] || '不明';
}

// ===== メイン画面表示 =====
async function showMainApp() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('mainApp').style.display = 'block';
  document.getElementById('currentUser').textContent = getDisplayName();
  document.getElementById('loadingIndicator').style.display = 'block';

  await Promise.all([loadSystems(), loadTagMaster(), loadScreenshots()]);

  document.getElementById('loadingIndicator').style.display = 'none';
  render();
}

// ===== データ読み込み =====
async function loadSystems() {
  if (isLocalMode) { systems = defaultSystems; return; }
  const { data, error } = await sb
    .from('rulebook_systems')
    .select('*')
    .order('name');
  if (!error && data) systems = data;
}

async function loadTagMaster() {
  if (isLocalMode) { tagMaster = defaultTagMaster; return; }
  const { data, error } = await sb
    .from('rulebook_tags')
    .select('*')
    .order('sort_order');
  if (!error && data) tagMaster = data;
}

async function loadScreenshots() {
  if (isLocalMode) {
    // ローカルモード: localStorageからロード
    const saved = localStorage.getItem('rulebook_screenshots');
    screenshots = saved ? JSON.parse(saved) : [];
    return;
  }
  const { data, error } = await sb
    .from('rulebook_screenshots')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('loadScreenshots error:', error);
    return;
  }
  screenshots = data || [];
}

function saveLocalScreenshots() {
  if (isLocalMode) {
    localStorage.setItem('rulebook_screenshots', JSON.stringify(screenshots));
  }
}

// ===== 画像URL取得 =====
function getImageUrl(imagePath) {
  if (!imagePath) return null;
  const { data } = sb.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(imagePath);
  return data?.publicUrl || null;
}

function getSignedUrl(imagePath) {
  // publicでない場合はsigned URLを使う
  return sb.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(imagePath, 3600); // 1時間
}

// キャッシュ
const imageUrlCache = {};
async function resolveImageUrl(imagePath) {
  if (imageUrlCache[imagePath]) return imageUrlCache[imagePath];
  // まずpublic URLを試す
  const pubUrl = getImageUrl(imagePath);
  imageUrlCache[imagePath] = pubUrl;
  return pubUrl;
}

// ===== システムの色取得 =====
function getSystemColor(systemName) {
  const sys = systems.find(s => s.name === systemName);
  return sys?.color || '#666';
}

function getSystemShort(systemName) {
  const sys = systems.find(s => s.name === systemName);
  return sys?.short_name || systemName.charAt(0);
}

// ===== サイドバー描画 =====
function getAllTags(category) {
  const m = {};
  screenshots.forEach(s => {
    if (category === 'system') {
      m[s.system_name] = (m[s.system_name] || 0) + 1;
    } else if (category === 'page') {
      if (s.page_number) m[s.page_number] = (m[s.page_number] || 0) + 1;
    } else {
      (s.tags || []).forEach(t => {
        const isChapter = chapterTagNames.includes(t);
        if (category === 'chapter' && isChapter) m[t] = (m[t] || 0) + 1;
        else if (category === 'content' && !isChapter) m[t] = (m[t] || 0) + 1;
      });
    }
  });
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}

function renderSidebar() {
  const sections = {
    systemTags: 'system',
    chapterTags: 'chapter',
    contentTags: 'content',
    pageTags: 'page',
  };
  for (const [elId, cat] of Object.entries(sections)) {
    const el = document.getElementById(elId);
    const tags = getAllTags(cat);
    el.innerHTML = tags.map(([name, count]) => {
      const escaped = name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
      return `<span class="tag ${activeFilters.has(name) ? 'active' : ''}" data-cat="${cat}" onclick="toggleFilter('${escaped}')">${name} <span class="count">${count}</span></span>`;
    }).join('');
  }
}

function toggleFilter(tag) {
  activeFilters.has(tag) ? activeFilters.delete(tag) : activeFilters.add(tag);
  render();
}

function clearFilters() {
  activeFilters.clear();
  document.getElementById('searchBox').value = '';
  render();
}

// ===== フィルタ =====
function getFiltered() {
  const q = document.getElementById('searchBox').value.toLowerCase();
  return screenshots.filter(s => {
    for (const f of activeFilters) {
      const allTags = [s.system_name, s.page_number, ...(s.tags || [])];
      if (!allTags.includes(f)) return false;
    }
    if (q) {
      const hay = [s.title, s.system_name, s.page_number, ...(s.tags || []), s.memo || ''].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ===== カード描画 =====
async function renderCards() {
  filteredList = getFiltered();
  document.getElementById('resultCount').textContent = `${filteredList.length} 件のスクリーンショット`;

  const fi = document.getElementById('filterInfo');
  if (activeFilters.size > 0) {
    fi.classList.add('visible');
    document.getElementById('filterText').textContent =
      `絞り込み: ${[...activeFilters].join(' + ')}（${filteredList.length}件）`;
  } else {
    fi.classList.remove('visible');
  }

  const grid = document.getElementById('cardGrid');
  grid.innerHTML = filteredList.map((s, idx) => {
    const color = getSystemColor(s.system_name);
    const pageLabel = s.page_number || '';
    const tags = s.tags || [];
    const dateStr = s.created_at ? s.created_at.slice(0, 10) : '';
    const hasLocalImg = s._dataUrl;
    const imgHtml = hasLocalImg
      ? `<img src="${s._dataUrl}" alt="">`
      : `<span class="placeholder-icon" style="color:${color}">読込中</span>`;
    return `
    <div class="card" onclick="openLightbox(${idx})">
      <div class="card-img" data-path="${s.image_path || ''}" style="background: linear-gradient(135deg, ${color}15, var(--bg));">
        ${imgHtml}
        <span class="system-badge" style="background:${color}">${s.system_name}</span>
        ${pageLabel ? `<span class="page-label">${pageLabel}</span>` : ''}
      </div>
      <div class="card-body">
        <div class="card-title">${s.title || s.memo || 'スクリーンショット'}</div>
        <div class="card-tags">
          ${tags.slice(0, 3).map(t => `<span class="card-tag">${t}</span>`).join('')}
          ${tags.length > 3 ? `<span class="card-tag">+${tags.length - 3}</span>` : ''}
        </div>
        <div class="card-meta">
          <span>${s.uploader_name}</span>
          <span>${dateStr}</span>
        </div>
      </div>
    </div>`;
  }).join('');

  // 画像を非同期で読み込み
  loadCardImages();
}

async function loadCardImages() {
  const cardImgs = document.querySelectorAll('.card-img[data-path]');
  for (const el of cardImgs) {
    const path = el.dataset.path;
    if (!path) continue;
    try {
      const url = await resolveImageUrl(path);
      if (url) {
        const img = new Image();
        img.onload = () => {
          el.innerHTML = `<img src="${url}" alt="">` +
            el.querySelector('.system-badge').outerHTML +
            (el.querySelector('.page-label')?.outerHTML || '');
        };
        img.src = url;
      }
    } catch (e) {
      // 読み込み失敗時はプレースホルダのまま
    }
  }
}

function render() {
  renderSidebar();
  renderCards();
}

// ===== アップロード =====
function openUpload() {
  document.getElementById('uploadModal').classList.add('visible');
  uploadFiles = [];
  currentTags = [];
  renderUploadPreview();
  renderCurrentTags();
  document.getElementById('uploadPage').value = '';
  document.getElementById('uploadMemo').value = '';
  document.getElementById('uploadStatus').textContent = '';
  document.getElementById('fileInput').value = '';
  updateSubmitBtn();
  renderSystemSelect();
  renderQuickTags();
}

function closeUpload() {
  document.getElementById('uploadModal').classList.remove('visible');
}

function renderSystemSelect() {
  const sel = document.getElementById('uploadSystem');
  sel.innerHTML = systems.map(s =>
    `<option value="${s.name}">${s.name}</option>`
  ).join('') + '<option value="__new">+ 新しいシステムを追加...</option>';

  sel.onchange = () => {
    if (sel.value === '__new') {
      const name = prompt('新しいルールブック名を入力してください:');
      if (name && name.trim()) {
        addNewSystem(name.trim());
      } else {
        sel.selectedIndex = 0;
      }
    }
    renderQuickTags();
  };
}

async function addNewSystem(name) {
  const { data, error } = await supabase
    .from('rulebook_systems')
    .insert({ name, short_name: name.slice(0, 3), color: '#888' })
    .select()
    .single();
  if (!error && data) {
    systems.push(data);
    renderSystemSelect();
    document.getElementById('uploadSystem').value = name;
  }
}

function renderQuickTags() {
  const selectedSystem = document.getElementById('uploadSystem').value;
  const el = document.getElementById('quickTags');
  // システム専用タグ + 共通タグ
  const tags = tagMaster.filter(t =>
    t.system_name === selectedSystem || t.system_name === null
  );
  el.innerHTML = tags.map(t =>
    `<span class="quick-tag" onclick="addTag('${t.name.replace(/'/g, "\\'")}')">${t.name}</span>`
  ).join('');
}

// ドラッグ&ドロップ
document.addEventListener('DOMContentLoaded', () => {
  const dz = document.getElementById('dropZone');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });
});

function handleFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const reader = new FileReader();
    reader.onload = e => {
      uploadFiles.push({ file, dataUrl: e.target.result });
      renderUploadPreview();
      updateSubmitBtn();
    };
    reader.readAsDataURL(file);
  }
}

function renderUploadPreview() {
  const el = document.getElementById('uploadPreview');
  el.innerHTML = uploadFiles.map((f, i) =>
    `<div class="preview-item">
      <img src="${f.dataUrl}" alt="">
      <button class="remove-preview" onclick="removeFile(${i})">&times;</button>
    </div>`
  ).join('');
}

function removeFile(i) {
  uploadFiles.splice(i, 1);
  renderUploadPreview();
  updateSubmitBtn();
}

// タグ入力
function addTag(name) {
  name = name.trim();
  if (!name || currentTags.includes(name)) return;
  currentTags.push(name);
  renderCurrentTags();
}

function removeCurrentTag(i) {
  currentTags.splice(i, 1);
  renderCurrentTags();
}

function renderCurrentTags() {
  const wrap = document.getElementById('tagInputWrap');
  const input = document.getElementById('tagInput');
  wrap.querySelectorAll('.added-tag').forEach(el => el.remove());
  currentTags.forEach((t, i) => {
    const span = document.createElement('span');
    span.className = 'added-tag';
    span.innerHTML = `${t} <span class="remove-tag" onclick="removeCurrentTag(${i})">&times;</span>`;
    wrap.insertBefore(span, input);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('tagInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTag(e.target.value);
      e.target.value = '';
    }
  });
});

function updateSubmitBtn() {
  document.getElementById('submitBtn').disabled = uploadFiles.length === 0;
}

async function submitUpload() {
  if (uploadFiles.length === 0) return;

  const btn = document.getElementById('submitBtn');
  const status = document.getElementById('uploadStatus');
  btn.disabled = true;
  status.textContent = 'アップロード中...';

  const systemName = document.getElementById('uploadSystem').value;
  const page = document.getElementById('uploadPage').value.trim();
  const memo = document.getElementById('uploadMemo').value.trim();

  let successCount = 0;

  for (let i = 0; i < uploadFiles.length; i++) {
    const f = uploadFiles[i];
    status.textContent = `アップロード中... (${i + 1}/${uploadFiles.length})`;

    try {
      const pageLabel = page
        ? (uploadFiles.length > 1 ? `P${page}-${i + 1}` : `P${page}`)
        : null;
      const title = memo || f.file.name.replace(/\.\w+$/, '');

      if (isLocalMode) {
        // ローカルモード: dataUrlで保存
        screenshots.unshift({
          id: 'local_' + Date.now() + '_' + i,
          title,
          system_name: systemName,
          page_number: pageLabel,
          tags: [...currentTags],
          memo,
          image_path: null,
          _dataUrl: f.dataUrl,  // ローカル用
          uploader_id: currentUser.id,
          uploader_name: getDisplayName(),
          created_at: new Date().toISOString(),
        });
        successCount++;
        continue;
      }

      // 1. Storage にアップロード
      const ext = f.file.name.split('.').pop() || 'jpg';
      const filePath = `${systemName}/${Date.now()}_${i}.${ext}`;

      const { error: storageError } = await sb.storage
        .from(STORAGE_BUCKET)
        .upload(filePath, f.file, { contentType: f.file.type });

      if (storageError) {
        console.error('Storage upload error:', storageError);
        continue;
      }

      // 2. DBにレコード追加
      const { error: dbError } = await supabase
        .from('rulebook_screenshots')
        .insert({
          title,
          system_name: systemName,
          page_number: pageLabel,
          tags: currentTags,
          memo,
          image_path: filePath,
          uploader_id: currentUser.id,
          uploader_name: getDisplayName(),
        });

      if (dbError) {
        console.error('DB insert error:', dbError);
        continue;
      }

      successCount++;
    } catch (e) {
      console.error('Upload error:', e);
    }
  }

  status.textContent = `${successCount}枚をアップロードしました`;

  // データ保存・再読み込み
  saveLocalScreenshots();
  if (!isLocalMode) await loadScreenshots();

  setTimeout(() => {
    closeUpload();
    render();
  }, 800);
}

// ===== ライトボックス =====
async function openLightbox(idx) {
  currentLbIndex = idx;
  await showLightboxItem();
  document.getElementById('lightbox').classList.add('visible');
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('visible');
}

function navLightbox(dir) {
  currentLbIndex += dir;
  if (currentLbIndex < 0) currentLbIndex = filteredList.length - 1;
  if (currentLbIndex >= filteredList.length) currentLbIndex = 0;
  showLightboxItem();
}

async function showLightboxItem() {
  const s = filteredList[currentLbIndex];
  if (!s) return;

  const wrap = document.getElementById('lbImgWrap');
  const color = getSystemColor(s.system_name);

  // 画像表示
  if (s._dataUrl) {
    wrap.innerHTML = `<img src="${s._dataUrl}" alt="${s.title || ''}">`;
  } else if (s.image_path) {
    const url = await resolveImageUrl(s.image_path);
    if (url) {
      wrap.innerHTML = `<img src="${url}" alt="${s.title || ''}">`;
    } else {
      wrap.innerHTML = `<div class="lb-placeholder" style="color:${color}">${getSystemShort(s.system_name)}</div>`;
    }
  } else {
    wrap.innerHTML = `<div class="lb-placeholder" style="color:${color}">${getSystemShort(s.system_name)}</div>`;
  }

  const pageStr = s.page_number ? `（${s.page_number}）` : '';
  document.getElementById('lbTitle').textContent = `${s.title || 'スクリーンショット'}${pageStr}`;
  document.getElementById('lbTags').innerHTML = [s.system_name, ...(s.tags || [])].map(t =>
    `<span class="card-tag" style="font-size:12px; padding:4px 10px;">${t}</span>`
  ).join('');
  const dateStr = s.created_at ? s.created_at.slice(0, 10) : '';
  document.getElementById('lbMeta').textContent = `${s.uploader_name} が ${dateStr} にアップロード`;

  // 自分のアップロードのみ削除ボタン表示
  const delBtn = document.getElementById('lbDeleteBtn');
  delBtn.style.display = (s.uploader_id === currentUser?.id) ? 'inline-block' : 'none';
}

async function deleteScreenshot() {
  const s = filteredList[currentLbIndex];
  if (!s) return;
  if (!confirm('この画像を削除しますか？')) return;

  // Storage削除
  if (s.image_path) {
    await sb.storage.from(STORAGE_BUCKET).remove([s.image_path]);
  }

  // DB削除
  await sb.from('rulebook_screenshots').delete().eq('id', s.id);

  closeLightbox();
  await loadScreenshots();
  render();
}

// ===== サイドバートグル（モバイル） =====
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

// ===== 検索 =====
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('searchBox').addEventListener('input', render);
});

// ===== キーボード =====
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeLightbox();
    closeUpload();
  }
  if (document.getElementById('lightbox').classList.contains('visible')) {
    if (e.key === 'ArrowLeft') navLightbox(-1);
    if (e.key === 'ArrowRight') navLightbox(1);
  }
});

// ===== 初期化 =====
checkSession();
