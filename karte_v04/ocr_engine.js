// ocr_engine.js - 保険証OCRエンジン v3（完全ローカル処理、外部送信なし）
// Tesseract.js v5 + カード自動クロップ + HSV彩度フィルタv2 + 適応的閾値 + ノイズ除去 + マルチパスOCR

const OCR_ENGINE = (() => {

  let worker = null;
  let isInitialized = false;
  let initPromise = null;

  // ===== 1. Tesseract.js 初期化 =====
  async function init(progressCb) {
    if (isInitialized && worker) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      if (progressCb) progressCb('OCRエンジン読込中...', 0);
      const { createWorker } = Tesseract;
      worker = await createWorker('jpn', 1, {
        logger: m => {
          if (progressCb && m.progress !== undefined) {
            const pct = Math.round(m.progress * 100);
            const statusText = m.status === 'recognizing text' ? '文字認識中...' :
                               m.status === 'loading language traineddata' ? '日本語データ読込中...' :
                               m.status === 'initializing api' ? 'エンジン初期化中...' : m.status;
            progressCb(statusText, pct);
          }
        }
      });
      await worker.setParameters({
        tessedit_pageseg_mode: '6',
      });
      isInitialized = true;
      if (progressCb) progressCb('準備完了', 100);
    })();
    return initPromise;
  }

  // ===== 2. 画像前処理 v2: 保険証特化 =====

  // --- 2a. アンシャープマスク（カメラぼけ補正） ---
  function sharpen(ctx, w, h) {
    const imgData = ctx.getImageData(0, 0, w, h);
    const src = new Uint8ClampedArray(imgData.data);
    const dst = imgData.data;
    // 3x3 sharpen kernel (center=9, cross=-1, corners=-1 → edge-preserving sharpen)
    const amount = 0.4; // mix ratio
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        for (let c = 0; c < 3; c++) {
          const idx = (y * w + x) * 4 + c;
          const sharp = 5 * src[idx]
            - src[((y-1)*w+x)*4+c]
            - src[((y+1)*w+x)*4+c]
            - src[(y*w+x-1)*4+c]
            - src[(y*w+x+1)*4+c];
          dst[idx] = Math.max(0, Math.min(255, Math.round(src[idx] * (1 - amount) + sharp * amount)));
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  // --- 2b. カード領域自動クロップ ---
  function detectCardRegion(imgElement) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const sw = 400;
    const sh = Math.round(imgElement.naturalHeight * (sw / imgElement.naturalWidth));
    canvas.width = sw;
    canvas.height = sh;
    ctx.drawImage(imgElement, 0, 0, sw, sh);
    const imgData = ctx.getImageData(0, 0, sw, sh);
    const d = imgData.data;

    // 黄色〜ベージュ + 白領域を検出（保険証カード背景色）
    const mask = new Uint8Array(sw * sh);
    for (let i = 0; i < sw * sh; i++) {
      const r = d[i*4], g = d[i*4+1], b = d[i*4+2];
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const delta = maxC - minC;
      if (maxC === 0) continue;
      let h = 0;
      if (delta > 0) {
        if (maxC === r) h = 60 * (((g - b) / delta) % 6);
        else if (maxC === g) h = 60 * ((b - r) / delta + 2);
        else h = 60 * ((r - g) / delta + 4);
        if (h < 0) h += 360;
      }
      const s = delta / maxC;
      const v = maxC / 255;
      // 黄色〜ベージュ範囲 or 白っぽい領域
      if (((h >= 15 && h <= 75 && s > 0.05) || (s < 0.15 && v > 0.82)) && v > 0.4) {
        mask[i] = 1;
      }
    }

    let minX = sw, maxX = 0, minY = sh, maxY = 0, count = 0;
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        if (mask[y * sw + x]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          count++;
        }
      }
    }

    const ratio = count / (sw * sh);
    if (ratio < 0.25 || (maxX - minX) < sw * 0.25 || (maxY - minY) < sh * 0.15) {
      return null;
    }

    const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.03);
    const scaleBack = imgElement.naturalWidth / sw;
    return {
      x: Math.max(0, Math.round((minX - pad) * scaleBack)),
      y: Math.max(0, Math.round((minY - pad) * scaleBack)),
      w: Math.min(imgElement.naturalWidth, Math.round((maxX - minX + pad * 2) * scaleBack)),
      h: Math.min(imgElement.naturalHeight, Math.round((maxY - minY + pad * 2) * scaleBack)),
    };
  }

  // --- 2c. メイン前処理: カードクロップ + 彩度フィルタv2 + 適応的閾値 + ノイズ除去 ---
  function preprocessInsuranceCard(imgElement) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // カード領域を検出してクロップ
    const cardRect = detectCardRegion(imgElement);
    let srcX = 0, srcY = 0, srcW = imgElement.naturalWidth, srcH = imgElement.naturalHeight;
    if (cardRect) {
      srcX = cardRect.x;
      srcY = cardRect.y;
      srcW = cardRect.w;
      srcH = cardRect.h;
    }

    // 解像度を上げてOCR精度向上（最大2800px幅）
    const scale = Math.min(2800 / srcW, 3.5);
    canvas.width = Math.round(srcW * scale);
    canvas.height = Math.round(srcH * scale);
    ctx.drawImage(imgElement, srcX, srcY, srcW, srcH, 0, 0, canvas.width, canvas.height);

    // シャープニング
    sharpen(ctx, canvas.width, canvas.height);

    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imgData.data;
    const w = canvas.width, h = canvas.height, n = w * h;

    // ====== Phase 1: HSV彩度フィルタ v2（強化版） ======
    const gray = new Uint8Array(n);

    for (let i = 0; i < n; i++) {
      const r = d[i*4], g = d[i*4+1], b = d[i*4+2];
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const sat = maxC > 0 ? (maxC - minC) / maxC : 0;
      const lum = (r * 0.299 + g * 0.587 + b * 0.114);

      // テキスト判定: 暗い + 低彩度
      const isDarkText = lum < 100 && sat < 0.25;
      // 中間トーン: やや暗い + 低彩度（印字かすれ対応）
      const isMidText = lum < 150 && sat < 0.10;

      if (isDarkText || isMidText) {
        gray[i] = Math.round(lum);
      } else {
        gray[i] = 255;
      }
    }

    // ====== Phase 2: 適応的閾値（より細かいブロック） ======
    const blockSize = 24;
    const C_THRESH = 15;
    const dw = Math.ceil(w / blockSize);
    const dh = Math.ceil(h / blockSize);
    const blockMeans = new Float32Array(dw * dh);
    const blockCounts = new Uint32Array(dw * dh);

    for (let y = 0; y < h; y++) {
      const by = Math.min(Math.floor(y / blockSize), dh - 1);
      for (let x = 0; x < w; x++) {
        const bx = Math.min(Math.floor(x / blockSize), dw - 1);
        const bi = by * dw + bx;
        blockMeans[bi] += gray[y * w + x];
        blockCounts[bi]++;
      }
    }
    for (let i = 0; i < dw * dh; i++) {
      blockMeans[i] = blockCounts[i] > 0 ? blockMeans[i] / blockCounts[i] : 128;
    }

    for (let y = 0; y < h; y++) {
      const fy = (y + 0.5) / blockSize - 0.5;
      const by0 = Math.max(0, Math.min(Math.floor(fy), dh - 2));
      const by1 = by0 + 1;
      const ty = fy - by0;

      for (let x = 0; x < w; x++) {
        const fx = (x + 0.5) / blockSize - 0.5;
        const bx0 = Math.max(0, Math.min(Math.floor(fx), dw - 2));
        const bx1 = bx0 + 1;
        const tx = fx - bx0;

        const m00 = blockMeans[by0 * dw + bx0];
        const m10 = blockMeans[by0 * dw + bx1];
        const m01 = blockMeans[by1 * dw + bx0];
        const m11 = blockMeans[by1 * dw + bx1];
        const localMean = m00*(1-tx)*(1-ty) + m10*tx*(1-ty) + m01*(1-tx)*ty + m11*tx*ty;

        const idx = y * w + x;
        const threshold = localMean - C_THRESH;
        const v = gray[idx] < threshold ? 0 : 255;
        d[idx*4] = d[idx*4+1] = d[idx*4+2] = v;
      }
    }

    // ====== Phase 3: ノイズ除去（孤立黒点の白化） ======
    ctx.putImageData(imgData, 0, 0);
    const binData = ctx.getImageData(0, 0, w, h);
    const bd = binData.data;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = (y * w + x) * 4;
        if (bd[idx] === 0) {
          let blackN = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dy === 0 && dx === 0) continue;
              if (bd[((y+dy)*w+(x+dx))*4] === 0) blackN++;
            }
          }
          if (blackN <= 1) {
            bd[idx] = bd[idx+1] = bd[idx+2] = 255;
          }
        }
      }
    }
    ctx.putImageData(binData, 0, 0);

    return canvas;
  }

  // --- 2d. シンプル前処理（白背景カード用のフォールバック） ---
  function preprocessSimple(imgElement) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    const scale = Math.min(2400 / imgElement.naturalWidth, 3);
    canvas.width = Math.round(imgElement.naturalWidth * scale);
    canvas.height = Math.round(imgElement.naturalHeight * scale);
    ctx.drawImage(imgElement, 0, 0, canvas.width, canvas.height);

    sharpen(ctx, canvas.width, canvas.height);

    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imgData.data;
    const n = d.length / 4;

    // グレースケール変換
    for (let i = 0; i < n; i++) {
      const gray = Math.round(d[i*4] * 0.299 + d[i*4+1] * 0.587 + d[i*4+2] * 0.114);
      d[i*4] = d[i*4+1] = d[i*4+2] = gray;
    }

    // コントラスト強化
    let min = 255, max = 0;
    for (let i = 0; i < n; i++) {
      if (d[i*4] < min) min = d[i*4];
      if (d[i*4] > max) max = d[i*4];
    }
    const range = max - min || 1;
    for (let i = 0; i < n; i++) {
      const v = Math.round(((d[i*4] - min) / range) * 255);
      d[i*4] = d[i*4+1] = d[i*4+2] = v;
    }

    // Otsu二値化
    const histogram = new Array(256).fill(0);
    for (let i = 0; i < n; i++) histogram[d[i*4]]++;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * histogram[i];
    let sumB = 0, wB = 0, wF = 0, maxVar = 0, threshold = 128;
    for (let t = 0; t < 256; t++) {
      wB += histogram[t];
      if (wB === 0) continue;
      wF = n - wB;
      if (wF === 0) break;
      sumB += t * histogram[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > maxVar) { maxVar = v; threshold = t; }
    }
    for (let i = 0; i < n; i++) {
      const v = d[i*4] > threshold ? 255 : 0;
      d[i*4] = d[i*4+1] = d[i*4+2] = v;
    }

    ctx.putImageData(imgData, 0, 0);
    return canvas;
  }

  // ===== 3. OCR実行（マルチパス） =====
  async function recognize(imgSource, progressCb) {
    await init(progressCb);

    // 画像読み込み
    let imgEl;
    if (imgSource instanceof HTMLImageElement || imgSource instanceof HTMLCanvasElement) {
      imgEl = imgSource;
    } else if (typeof imgSource === 'string') {
      imgEl = new Image();
      imgEl.src = imgSource;
      await new Promise((resolve, reject) => {
        imgEl.onload = resolve;
        imgEl.onerror = reject;
      });
    }

    // === パス1: 保険証特化前処理 ===
    if (progressCb) progressCb('前処理中（カラーフィルタ）...', 5);
    const processed1 = preprocessInsuranceCard(imgEl);

    if (progressCb) progressCb('文字認識中（1回目）...', 10);
    const result1 = await worker.recognize(processed1);
    const text1 = result1.data.text;
    const fields1 = extractInsuranceFields(text1);

    // 信頼度が十分ならそのまま返す
    if (fields1.confidence >= 60) {
      if (progressCb) progressCb('解析完了', 100);
      return result1.data;
    }

    // === パス2: シンプル前処理で再試行 ===
    if (progressCb) progressCb('精度不足、別の前処理で再試行中...', 50);
    const processed2 = preprocessSimple(imgEl);
    const result2 = await worker.recognize(processed2);
    const text2 = result2.data.text;
    const fields2 = extractInsuranceFields(text2);

    // フィールドレベルでマージ（各フィールドで見つかった方を採用）
    if (progressCb) progressCb('結果統合中...', 90);
    const merged = mergeFields(fields1, fields2);

    // マージ結果のテキストを設定
    const bestData = merged._source2Better ? result2.data : result1.data;
    bestData._mergedFields = merged;
    if (progressCb) progressCb('解析完了', 100);
    return bestData;
  }

  // フィールドマージ: 2つの結果から各フィールドのベストを選択
  function mergeFields(f1, f2) {
    const result = { ...f1 };
    const fieldNames = ['insurerNumber','symbol','memberNumber','name','nameKana',
      'dob','sex','address','postalCode','expiry','insurerName','qualifier'];
    let f2Wins = 0;
    for (const key of fieldNames) {
      if (!f1[key] && f2[key]) {
        result[key] = f2[key];
        f2Wins++;
      }
    }
    // 信頼度を再計算
    let score = 0;
    if (result.insurerNumber) score += 25;
    if (result.dob) score += 20;
    if (result.nameKana) score += 15;
    if (result.name) score += 10;
    if (result.sex) score += 5;
    if (result.postalCode) score += 10;
    if (result.address) score += 10;
    if (result.memberNumber) score += 5;
    result.confidence = score;
    result._source2Better = f2.confidence > f1.confidence;
    result.rawText = f1.rawText + '\n---\n' + f2.rawText;
    return result;
  }

  // ===== 4. OCRテキスト正規化（Tesseract.jsの文字間スペース除去） =====
  function normalizeOcrText(rawText) {
    return rawText.replace(/\r\n/g, '\n').split('\n').map(line => {
      // カタカナ行: スペース除去後に辞書で姓名分割
      if (/[ァ-ヶー]/.test(line) && !/[a-zA-Z0-9]/.test(line)) {
        const noSpace = line.replace(/\s+/g, '');
        if (/^[ァ-ヶー]+$/.test(noSpace) && noSpace.length >= 3) {
          return guessKanaSplit(noSpace);
        }
      }
      let normalized = line;
      // CJK文字間のスペース除去（3回適用で連続対応）
      for (let i = 0; i < 3; i++) {
        normalized = normalized.replace(/([\u3000-\u9fff\uff00-\uffef])\s+([\u3000-\u9fff\uff00-\uffef])/g, '$1$2');
      }
      // ラベルキーワードの後にスペースを復元
      normalized = normalized.replace(/(氏名|住所|記号|番号|性別|生年月日|有効期限|保険者番号|被保険者番号|保険者名称|資格取得|保険者所在地|枝番)(?=[^\s])/g, '$1 ');
      return normalized;
    }).join('\n');
  }

  // カタカナ列を姓名に分割（辞書ベース）
  function guessKanaSplit(kataStr) {
    if (typeof NAME_DICT === 'undefined') return kataStr;
    for (let len = Math.min(kataStr.length - 1, 5); len >= 2; len--) {
      const surPart = kataStr.substring(0, len);
      if (NAME_DICT.SURNAME[surPart]) {
        return surPart + ' ' + kataStr.substring(len);
      }
    }
    for (let len = Math.min(kataStr.length - 1, 5); len >= 2; len--) {
      const givPart = kataStr.substring(kataStr.length - len);
      if (NAME_DICT.MALE_GIVEN[givPart] || NAME_DICT.FEMALE_GIVEN[givPart]) {
        return kataStr.substring(0, kataStr.length - len) + ' ' + givPart;
      }
    }
    return kataStr;
  }

  // ===== 5. 保険証フィールド抽出 =====
  function extractInsuranceFields(ocrText) {
    const text = normalizeOcrText(ocrText);
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const fullText = lines.join(' ');

    const result = {
      insurerNumber: null,
      symbol: null,
      memberNumber: null,
      name: null,
      nameKana: null,
      dob: null,
      sex: null,
      address: null,
      postalCode: null,
      expiry: null,
      insurerName: null,
      qualifier: null,
      rawText: text,
      confidence: 0
    };

    // --- 保険者番号（6桁 or 8桁の数字列） ---
    const insurerPatterns = [
      /保険者番号[:\s：]*(\d{6,8})/,
      /保険者[番号\s]*[:\s：]*(\d{6,8})/,
      // ボックス表示: 各桁がスペースで区切られている場合
      /保険者番号[:\s：]*(\d[\s]*\d[\s]*\d[\s]*\d[\s]*\d[\s]*\d[\s]*\d[\s]*\d)/,
    ];
    for (const pat of insurerPatterns) {
      const m = fullText.match(pat);
      if (m) {
        result.insurerNumber = m[1].replace(/\s/g, '');
        if (result.insurerNumber.length >= 6) break;
      }
    }
    // フォールバック: 行単位で保険者番号を探す
    if (!result.insurerNumber) {
      for (const line of lines) {
        if (/保険者番号/.test(line) || /保険者\s*番号/.test(line)) {
          const nums = line.match(/\d/g);
          if (nums && nums.length >= 6) {
            result.insurerNumber = nums.slice(0, 8).join('');
            break;
          }
        }
      }
    }

    // --- 記号・番号 ---
    const symbolPatterns = [
      /記号[:\s：]*([^\s番]{1,20})/,
      /記号\s+(\S+)/
    ];
    for (const pat of symbolPatterns) {
      const m = fullText.match(pat);
      if (m) { result.symbol = m[1].replace(/[番号]/g, '').trim(); break; }
    }

    const numPatterns = [
      /記号[^\n]*?番号[:\s：]*(\d{1,10})/,
      /被保険者番号[:\s：]*(\d{1,10})/,
      /(?<!保険者)番号[:\s：]*(\d{1,10})/,
      /番\s*号\s+(\d+)/
    ];
    for (const pat of numPatterns) {
      const m = fullText.match(pat);
      if (m && m[1] !== result.insurerNumber) { result.memberNumber = m[1]; break; }
    }

    // --- 枝番 ---
    const edaMatch = fullText.match(/枝番[:\s：）)]*(\d{1,2})/);
    if (edaMatch) result.branchNumber = edaMatch[1];

    // --- 生年月日 ---
    const dobPatterns = [
      /生年月日[:\s：]*(昭和|平成|令和)\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/,
      /(昭和|平成|令和)\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/,
      /生年月日[:\s：]*(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/,
      /(\d{4})\s*[年\/\-\.]\s*(\d{1,2})\s*[月\/\-\.]\s*(\d{1,2})\s*日?/,
    ];
    for (const pat of dobPatterns) {
      const m = fullText.match(pat);
      if (m) {
        if (['昭和','平成','令和'].includes(m[1])) {
          const year = eraToWestern(m[1], parseInt(m[2]));
          result.dob = `${year}-${String(m[3]).padStart(2,'0')}-${String(m[4]).padStart(2,'0')}`;
        } else {
          const y = parseInt(m[1]);
          if (y >= 1900 && y <= 2030) {
            result.dob = `${y}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
          }
        }
        if (result.dob) break;
      }
    }

    // --- 性別 ---
    const sexMatch = fullText.match(/性別[:\s：]*(男|女)/);
    if (sexMatch) {
      result.sex = sexMatch[1];
    } else if (/男/.test(fullText) && !/女/.test(fullText)) {
      result.sex = '男';
    } else if (/女/.test(fullText) && !/男/.test(fullText)) {
      result.sex = '女';
    }

    // --- フリガナ（カタカナ列の抽出） ---
    const kanaPattern = /([ァ-ヶー]{2,}[\s　]+[ァ-ヶー]{1,})/g;
    const kanaMatches = [];
    let km;
    while ((km = kanaPattern.exec(fullText)) !== null) {
      kanaMatches.push(km[1]);
    }
    if (kanaMatches.length > 0) {
      kanaMatches.sort((a, b) => b.length - a.length);
      result.nameKana = kanaMatches[0].replace(/[\s　]+/g, ' ').trim();
    }

    // --- 氏名（漢字） ---
    for (const line of lines) {
      const m = line.match(/氏名[\s：:]+(.+)/);
      if (m) {
        let name = m[1].replace(/[（(].*/,'').replace(/記号|番号|保険|住所|生年|証|被|健康/g,'').trim();
        if (/^[\u4e00-\u9fff]+$/.test(name) && name.length >= 3 && typeof NAME_DICT !== 'undefined') {
          for (let len = Math.min(name.length - 1, 4); len >= 1; len--) {
            const surPart = name.substring(0, len);
            for (const kanjis of Object.values(NAME_DICT.SURNAME)) {
              if (kanjis.includes(surPart)) {
                name = surPart + ' ' + name.substring(len);
                break;
              }
            }
            if (name.includes(' ')) break;
          }
        }
        if (name.length >= 2 && name.length <= 12 && /[\u4e00-\u9fff]/.test(name)) {
          result.name = name;
          break;
        }
      }
    }
    if (!result.name && result.nameKana) {
      for (let i = 1; i < lines.length; i++) {
        if (/[ァ-ヶー]{2,}/.test(lines[i]) && lines[i].includes(result.nameKana.replace(' ',''))) {
          const prev = lines[i-1];
          if (/[\u4e00-\u9fff]{1,}[\s　]+[\u4e00-\u9fff]{1,}/.test(prev)) {
            result.name = prev.trim();
            break;
          }
        }
      }
    }

    // --- 郵便番号 ---
    const zipMatch = fullText.match(/[〒〶]?\s*(\d{3})[ー\-ー](\d{4})/);
    if (zipMatch) {
      result.postalCode = zipMatch[1] + '-' + zipMatch[2];
    }

    // --- 住所 ---
    for (const line of lines) {
      const m = line.match(/(?:住\s*所|所在地)[:\s：]*(.*)/);
      if (m && m[1].length >= 3) {
        result.address = m[1].replace(/電話|TEL|tel|保険者|有効期限|資格|事業所/g, '').trim();
        break;
      }
    }
    if (!result.address) {
      const addrPatterns = [
        /(?:住\s*所|所在地)[:\s：]*(.+?)(?=\s*(?:電話|TEL|有効期限|保険者|資格|事業所|$))/,
        /(?:〒\s*\d{3}[\-ー]\d{4}\s*)(.+?)(?=\s*(?:電話|TEL|有効期限|保険者|資格|事業所|$))/,
      ];
      for (const pat of addrPatterns) {
        const m = fullText.match(pat);
        if (m && m[1].length >= 3) {
          result.address = m[1].replace(/電話|TEL|tel|保険者/g, '').trim();
          break;
        }
      }
    }

    // --- 有効期限 ---
    const expiryPatterns = [
      /有効期限[:\s：]*(令和|平成)\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/,
      /有効期限[:\s：]*(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/,
    ];
    for (const pat of expiryPatterns) {
      const m = fullText.match(pat);
      if (m) {
        if (['令和','平成'].includes(m[1])) {
          result.expiry = `${eraToWestern(m[1], parseInt(m[2]))}-${String(m[3]).padStart(2,'0')}-${String(m[4]).padStart(2,'0')}`;
        } else {
          result.expiry = `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
        }
        break;
      }
    }

    // --- 資格取得年月日 ---
    const qualPatterns = [
      /資格取得[年月日:\s：]*(令和|平成)\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/,
    ];
    for (const pat of qualPatterns) {
      const m = fullText.match(pat);
      if (m) {
        result.qualifier = `${eraToWestern(m[1], parseInt(m[2]))}-${String(m[3]).padStart(2,'0')}-${String(m[4]).padStart(2,'0')}`;
        break;
      }
    }

    // --- 保険者名称 ---
    for (const line of lines) {
      const m = line.match(/保険者名称[:\s：]*(.*)/);
      if (m && m[1].length >= 2 && !/番号/.test(m[1])) {
        result.insurerName = m[1].trim();
        break;
      }
    }
    if (!result.insurerName) {
      const insurerNameMatch = fullText.match(/保険者名称[:\s：]*([^\n\d]{2,30})/);
      if (insurerNameMatch && !insurerNameMatch[1].match(/番号/)) {
        result.insurerName = insurerNameMatch[1].trim();
      }
    }

    // --- 信頼度スコア計算 ---
    let score = 0;
    if (result.insurerNumber) score += 25;
    if (result.dob) score += 20;
    if (result.nameKana) score += 15;
    if (result.name) score += 10;
    if (result.sex) score += 5;
    if (result.postalCode) score += 10;
    if (result.address) score += 10;
    if (result.memberNumber) score += 5;
    result.confidence = score;

    return result;
  }

  // ===== 6. 数字特化OCR（保険者番号・郵便番号向け） =====
  async function recognizeNumbers(imgSource, progressCb) {
    await init(progressCb);
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '7',
    });
    const result = await worker.recognize(imgSource);
    await worker.setParameters({
      tessedit_char_whitelist: '',
      tessedit_pageseg_mode: '6',
    });
    return result.data.text.replace(/\s/g, '');
  }

  // ===== ユーティリティ =====
  function eraToWestern(era, year) {
    const base = { '明治': 1867, '大正': 1911, '昭和': 1925, '平成': 1988, '令和': 2018 };
    return (base[era] || 0) + year;
  }

  function extractPrefecture(address) {
    if (!address) return null;
    const prefMatch = address.match(/(北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)/);
    return prefMatch ? prefMatch[1] : null;
  }

  function splitAddress(address) {
    if (!address) return { pref: '', city: '', street: '', building: '' };
    const pref = extractPrefecture(address) || '';
    let rest = pref ? address.substring(address.indexOf(pref) + pref.length) : address;
    const cityMatch = rest.match(/^(.+?[市区町村郡])/);
    const city = cityMatch ? cityMatch[1] : '';
    rest = city ? rest.substring(rest.indexOf(city) + city.length) : rest;
    const buildingMatch = rest.match(/(\S*(?:ビル|マンション|アパート|ハイツ|コーポ|メゾン|荘|号室|棟|階).*)$/);
    const building = buildingMatch ? buildingMatch[1].trim() : '';
    const street = buildingMatch ? rest.substring(0, rest.indexOf(buildingMatch[1])).trim() : rest.trim();
    return { pref, city, street, building };
  }

  async function terminate() {
    if (worker) {
      await worker.terminate();
      worker = null;
      isInitialized = false;
      initPromise = null;
    }
  }

  // 後方互換: 旧 preprocessImage は preprocessInsuranceCard を使用
  function preprocessImage(imgElement) {
    return preprocessInsuranceCard(imgElement);
  }

  return {
    init,
    recognize,
    recognizeNumbers,
    extractInsuranceFields,
    normalizeOcrText,
    preprocessImage,
    preprocessInsuranceCard,
    preprocessSimple,
    detectCardRegion,
    splitAddress,
    extractPrefecture,
    eraToWestern,
    terminate
  };
})();
