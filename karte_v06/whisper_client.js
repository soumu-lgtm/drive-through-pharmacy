/**
 * Whisper-Karte クライアント (v0.6 カルテ統合版)
 * localhost:5000 の faster-whisper バックエンドと通信
 */

// ========================================
// 設定
// ========================================
const WHISPER_API = 'http://localhost:5000';
let whisperRecording = false;
let whisperMediaRecorder = null;
let whisperAudioChunks = [];
let whisperRecordTimer = null;
let whisperRecordSeconds = 0;
let whisperStream = null;

// ========================================
// 初期化
// ========================================
async function whisperInit() {
  // マイク一覧を取得
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');
    const select = document.getElementById('whisperMicSelect');
    select.innerHTML = '<option value="">マイク選択...</option>';
    mics.forEach(mic => {
      const opt = document.createElement('option');
      opt.value = mic.deviceId;
      opt.textContent = mic.label || `マイク ${select.options.length}`;
      select.appendChild(opt);
    });
    select.onchange = () => {
      document.getElementById('whisperRecBtn').disabled = !select.value;
    };
    // 最初のマイクを自動選択
    if (mics.length > 0) {
      select.value = mics[0].deviceId;
      document.getElementById('whisperRecBtn').disabled = false;
    }
  } catch (e) {
    console.warn('マイク列挙失敗:', e);
  }

  // プロンプト一覧を取得
  try {
    const res = await fetch(`${WHISPER_API}/prompts`);
    if (res.ok) {
      const data = await res.json();
      const sel = document.getElementById('whisperPromptSelect');
      sel.innerHTML = '';
      data.prompts.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        sel.appendChild(opt);
      });
      whisperSetStatus('Whisper-Karte 接続OK', 'success');
    } else {
      whisperSetStatus('Whisper-Karte 未起動 (localhost:5000)', 'error');
    }
  } catch (e) {
    whisperSetStatus('Whisper-Karte 未接続 — start.batで起動してください', 'error');
  }
}

// ========================================
// 録音開始/停止
// ========================================
async function whisperToggleRecord() {
  if (whisperRecording) {
    whisperStopRecord();
  } else {
    await whisperStartRecord();
  }
}

async function whisperStartRecord() {
  const micId = document.getElementById('whisperMicSelect').value;
  if (!micId) return;

  try {
    whisperStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: micId } }
    });
    whisperMediaRecorder = new MediaRecorder(whisperStream, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm'
    });
    whisperAudioChunks = [];

    whisperMediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) whisperAudioChunks.push(e.data);
    };

    whisperMediaRecorder.onstop = () => {
      whisperOnRecordStop();
    };

    whisperMediaRecorder.start(1000); // 1秒ごとにチャンク
    whisperRecording = true;

    // UI更新
    const btn = document.getElementById('whisperRecBtn');
    btn.classList.add('recording');
    btn.innerHTML = '<span class="rec-dot active"></span> 停止';
    document.getElementById('whisperBody').style.display = '';
    document.getElementById('whisperTranscript').value = '';
    document.getElementById('whisperKarte').value = '';
    document.getElementById('whisperGenBtn').disabled = true;
    document.getElementById('whisperApplyBtn').disabled = true;

    // タイマー
    whisperRecordSeconds = 0;
    whisperRecordTimer = setInterval(() => {
      whisperRecordSeconds++;
      const m = String(Math.floor(whisperRecordSeconds / 60)).padStart(2, '0');
      const s = String(whisperRecordSeconds % 60).padStart(2, '0');
      document.getElementById('whisperTime').textContent = `${m}:${s}`;
    }, 1000);

    whisperSetStatus('録音中...', 'recording');
  } catch (e) {
    whisperSetStatus('マイクアクセス失敗: ' + e.message, 'error');
  }
}

function whisperStopRecord() {
  if (whisperMediaRecorder && whisperMediaRecorder.state !== 'inactive') {
    whisperMediaRecorder.stop();
  }
  if (whisperStream) {
    whisperStream.getTracks().forEach(t => t.stop());
    whisperStream = null;
  }
  whisperRecording = false;
  clearInterval(whisperRecordTimer);

  const btn = document.getElementById('whisperRecBtn');
  btn.classList.remove('recording');
  btn.innerHTML = '<span class="rec-dot"></span> 録音';

  whisperSetStatus('文字起こし中...', 'processing');
}

// ========================================
// 録音停止後: 文字起こしAPI呼び出し
// ========================================
async function whisperOnRecordStop() {
  const blob = new Blob(whisperAudioChunks, { type: 'audio/webm' });

  const formData = new FormData();
  formData.append('audio', blob, 'recording.webm');

  try {
    const t0 = performance.now();
    const res = await fetch(`${WHISPER_API}/transcribe`, {
      method: 'POST',
      body: formData,
    });
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

    if (!res.ok) {
      const err = await res.json();
      whisperSetStatus(`文字起こしエラー: ${err.error}`, 'error');
      return;
    }

    const data = await res.json();
    document.getElementById('whisperTranscript').value = data.transcript;
    document.getElementById('whisperGenBtn').disabled = false;
    whisperSetStatus(`文字起こし完了 (${elapsed}秒)`, 'success');
  } catch (e) {
    whisperSetStatus('API通信エラー: ' + e.message, 'error');
  }
}

// ========================================
// カルテ生成
// ========================================
async function whisperGenerate() {
  const transcript = document.getElementById('whisperTranscript').value.trim();
  if (!transcript) return;

  const template = document.getElementById('whisperPromptSelect').value;
  whisperSetStatus('カルテ生成中...', 'processing');
  document.getElementById('whisperGenBtn').disabled = true;

  try {
    const t0 = performance.now();
    const res = await fetch(`${WHISPER_API}/generate-karte`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, template }),
    });
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

    if (!res.ok) {
      const err = await res.json();
      whisperSetStatus(`生成エラー: ${err.error}`, 'error');
      document.getElementById('whisperGenBtn').disabled = false;
      return;
    }

    const data = await res.json();
    document.getElementById('whisperKarte').value = data.karte;
    document.getElementById('whisperGenBtn').disabled = false;
    document.getElementById('whisperApplyBtn').disabled = false;
    whisperSetStatus(`カルテ生成完了 (${elapsed}秒)`, 'success');
  } catch (e) {
    whisperSetStatus('API通信エラー: ' + e.message, 'error');
    document.getElementById('whisperGenBtn').disabled = false;
  }
}

// ========================================
// カルテフィールドに反映
// ========================================
function whisperApplyToFields() {
  const karteText = document.getElementById('whisperKarte').value;
  if (!karteText) return;

  // AIカルテ出力をパース → 各フィールドにマッピング
  const sections = parseKarteSections(karteText);

  // 主訴フィールド
  if (sections.chiefComplaint) {
    const cc = document.getElementById('chiefComplaint');
    if (cc) cc.value = sections.chiefComplaint;
  }

  // 所見エディタ（リッチテキスト）に全文反映
  const editor = document.getElementById('findingsEditor');
  if (editor) {
    // 既存内容があれば追記、なければ置換
    const existing = editor.innerText.trim();
    if (existing) {
      editor.innerHTML += '<br><hr><br>' + karteText.replace(/\n/g, '<br>');
    } else {
      editor.innerHTML = karteText.replace(/\n/g, '<br>');
    }
  }

  // バイタルサインのパース・反映
  if (sections.vitals) {
    const v = sections.vitals;
    if (v.t) { const el = document.getElementById('vitalT'); if (el) el.value = v.t; }
    if (v.bps) { const el = document.getElementById('vitalBPS'); if (el) el.value = v.bps; }
    if (v.bpd) { const el = document.getElementById('vitalBPD'); if (el) el.value = v.bpd; }
    if (v.spo2) { const el = document.getElementById('vitalSpO2'); if (el) el.value = v.spo2; }
    if (v.p) { const el = document.getElementById('vitalP'); if (el) el.value = v.p; }
  }

  whisperSetStatus('カルテフィールドに反映しました', 'success');
  if (typeof showToast === 'function') showToast('音声カルテを反映しました');
}

/**
 * AIカルテ出力から各セクションをパース
 */
function parseKarteSections(text) {
  const result = { chiefComplaint: '', vitals: null };

  // 主訴抽出
  const ccMatch = text.match(/【主訴】\s*(.+?)(?=\n【|$)/s);
  if (ccMatch) result.chiefComplaint = ccMatch[1].trim();

  // バイタルサイン抽出
  const vitals = {};
  const tempMatch = text.match(/(\d{2}\.\d)\s*[°℃]/);
  if (tempMatch) vitals.t = tempMatch[1];

  const bpMatch = text.match(/(\d{2,3})\s*[\/／]\s*(\d{2,3})\s*mmHg/i);
  if (bpMatch) { vitals.bps = bpMatch[1]; vitals.bpd = bpMatch[2]; }

  const spo2Match = text.match(/SpO[₂2]\s*[:：]?\s*(\d{2,3})\s*%/i);
  if (spo2Match) vitals.spo2 = spo2Match[1];

  const pMatch = text.match(/[脈拍PR]\s*[:：]?\s*(\d{2,3})\s*[\/回]/);
  if (pMatch) vitals.p = pMatch[1];

  if (Object.keys(vitals).length > 0) result.vitals = vitals;

  return result;
}

// ========================================
// ユーティリティ
// ========================================
function whisperSetStatus(msg, type) {
  const el = document.getElementById('whisperStatus');
  if (!el) return;
  el.textContent = msg;
  el.className = 'whisper-status';
  if (type) el.classList.add('whisper-status-' + type);
}

// ========================================
// 音声ファイルアップロード → 文字起こし
// ========================================
async function whisperUploadFile(input) {
  const file = input.files[0];
  if (!file) return;

  // ファイル名表示
  const nameEl = document.getElementById('whisperFileName');
  if (nameEl) nameEl.textContent = file.name;

  // UI準備
  document.getElementById('whisperBody').style.display = '';
  document.getElementById('whisperTranscript').value = '';
  document.getElementById('whisperKarte').value = '';
  document.getElementById('whisperGenBtn').disabled = true;
  document.getElementById('whisperApplyBtn').disabled = true;
  whisperSetStatus('ファイル読込中...', 'processing');

  const formData = new FormData();
  formData.append('audio', file, file.name);

  try {
    const t0 = performance.now();
    const res = await fetch(`${WHISPER_API}/transcribe`, {
      method: 'POST',
      body: formData,
    });
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

    if (!res.ok) {
      const err = await res.json();
      whisperSetStatus(`文字起こしエラー: ${err.error}`, 'error');
      return;
    }

    const data = await res.json();
    document.getElementById('whisperTranscript').value = data.transcript;
    document.getElementById('whisperGenBtn').disabled = false;
    whisperSetStatus(`ファイル文字起こし完了 (${elapsed}秒) — ${file.name}`, 'success');
  } catch (e) {
    whisperSetStatus('API通信エラー: ' + e.message, 'error');
  }

  // inputをリセット（同じファイルの再選択を可能に）
  input.value = '';
}

function whisperCopy(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  navigator.clipboard.writeText(el.value).then(() => {
    if (typeof showToast === 'function') showToast('コピーしました');
  });
}

// ページ読み込み時に初期化
document.addEventListener('DOMContentLoaded', () => {
  // カルテ画面に遷移した時に初期化する（遅延初期化）
  // すぐ呼んでもOK（マイク権限は録音時に要求）
  setTimeout(whisperInit, 1000);
});
