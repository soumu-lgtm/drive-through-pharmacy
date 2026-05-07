// ocr_engine.js - 保険証OCRエンジン（完全ローカル処理、外部送信なし）
// Tesseract.js v5 + 画像前処理 + スマートフィールド抽出

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
      // 数字と日本語の認識精度向上のためPSMを設定
      await worker.setParameters({
        tessedit_pageseg_mode: '6', // Assume a single uniform block of text
      });
      isInitialized = true;
      if (progressCb) progressCb('準備完了', 100);
    })();
    return initPromise;
  }

  // ===== 2. 画像前処理（Canvas） =====
  function preprocessImage(imgElement) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // 解像度を上げてOCR精度向上（最大2000px幅）
    const scale = Math.min(2000 / imgElement.naturalWidth, 2);
    canvas.width = Math.round(imgElement.naturalWidth * scale);
    canvas.height = Math.round(imgElement.naturalHeight * scale);
    ctx.drawImage(imgElement, 0, 0, canvas.width, canvas.height);

    // グレースケール変換 + コントラスト強化 + 二値化
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    // Step 1: グレースケール
    for (let i = 0; i < data.length; i += 4) {
      const gray = data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114;
      data[i] = data[i+1] = data[i+2] = gray;
    }

    // Step 2: コントラスト強化（CLAHE的な簡易版）
    let min = 255, max = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < min) min = data[i];
      if (data[i] > max) max = data[i];
    }
    const range = max - min || 1;
    for (let i = 0; i < data.length; i += 4) {
      const v = Math.round(((data[i] - min) / range) * 255);
      data[i] = data[i+1] = data[i+2] = v;
    }

    // Step 3: 適応的二値化（Otsu's method 簡易版）
    const histogram = new Array(256).fill(0);
    for (let i = 0; i < data.length; i += 4) histogram[data[i]]++;
    const totalPixels = data.length / 4;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * histogram[i];

    let sumB = 0, wB = 0, wF = 0, maxVariance = 0, threshold = 128;
    for (let t = 0; t < 256; t++) {
      wB += histogram[t];
      if (wB === 0) continue;
      wF = totalPixels - wB;
      if (wF === 0) break;
      sumB += t * histogram[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const variance = wB * wF * (mB - mF) * (mB - mF);
      if (variance > maxVariance) { maxVariance = variance; threshold = t; }
    }

    for (let i = 0; i < data.length; i += 4) {
      const v = data[i] > threshold ? 255 : 0;
      data[i] = data[i+1] = data[i+2] = v;
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  // ===== 3. OCR実行 =====
  async function recognize(imgSource, progressCb) {
    await init(progressCb);

    // 画像要素を作成
    let imgEl;
    if (imgSource instanceof HTMLImageElement) {
      imgEl = imgSource;
    } else if (imgSource instanceof HTMLCanvasElement) {
      imgEl = imgSource;
    } else if (typeof imgSource === 'string') {
      // base64 or URL
      imgEl = new Image();
      imgEl.src = imgSource;
      await new Promise((resolve, reject) => {
        imgEl.onload = resolve;
        imgEl.onerror = reject;
      });
    }

    // 前処理
    if (progressCb) progressCb('画像前処理中...', 0);
    const processed = (imgEl instanceof HTMLCanvasElement) ? imgEl : preprocessImage(imgEl);

    // OCR実行
    if (progressCb) progressCb('文字認識中...', 10);
    const result = await worker.recognize(processed);
    if (progressCb) progressCb('解析完了', 100);

    return result.data;
  }

  // ===== 4. OCRテキスト正規化（Tesseract.jsの文字間スペース除去） =====
  function normalizeOcrText(rawText) {
    // Tesseract.jsは日本語文字間にスペースを挿入する傾向がある
    // 例: "ヤマ ダ タロ ウ" → "ヤマダ タロウ"
    // 例: "愛知 県 北 名 古屋 市" → "愛知県北名古屋市"
    return rawText.replace(/\r\n/g, '\n').split('\n').map(line => {
      // カタカナ行: 1-2文字のカタカナ間のスペースを除去し、3文字以上の区切りは姓名の区切りとして残す
      if (/[ァ-ヶー]/.test(line) && !/[a-zA-Z0-9]/.test(line)) {
        // まず全スペースを除去してから、カタカナ列を分析
        const noSpace = line.replace(/\s+/g, '');
        if (/^[ァ-ヶー]+$/.test(noSpace) && noSpace.length >= 3) {
          // 全部カタカナ→姓名辞書で分割ポイントを推測
          return guessKanaSplit(noSpace);
        }
      }
      // 漢字・日本語文字間の不要スペース除去
      // 「漢字 漢字」のパターンで、両方が漢字/ひらがな/カタカナなら結合
      let normalized = line;
      // CJK文字間の1スペースを除去（数字・ラテン文字の前後は残す）
      normalized = normalized.replace(/([\u3000-\u9fff\uff00-\uffef])\s+([\u3000-\u9fff\uff00-\uffef])/g, '$1$2');
      // 繰り返し適用（3文字以上の連続に対応）
      normalized = normalized.replace(/([\u3000-\u9fff\uff00-\uffef])\s+([\u3000-\u9fff\uff00-\uffef])/g, '$1$2');
      normalized = normalized.replace(/([\u3000-\u9fff\uff00-\uffef])\s+([\u3000-\u9fff\uff00-\uffef])/g, '$1$2');
      // ラベルキーワードの後にスペースを復元
      normalized = normalized.replace(/(氏名|住所|記号|番号|性別|生年月日|有効期限|保険者番号|被保険者番号|保険者名称|資格取得)(?=[^\s])/g, '$1 ');
      return normalized;
    }).join('\n');
  }

  // カタカナ列を姓名に分割（辞書ベース）
  function guessKanaSplit(kataStr) {
    if (typeof NAME_DICT === 'undefined') return kataStr;
    // 前方一致で姓を探す（長い方優先）
    for (let len = Math.min(kataStr.length - 1, 5); len >= 2; len--) {
      const surPart = kataStr.substring(0, len);
      if (NAME_DICT.SURNAME[surPart]) {
        return surPart + ' ' + kataStr.substring(len);
      }
    }
    // 後方一致で名を探す
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
      insurerNumber: null,     // 保険者番号
      symbol: null,            // 記号
      memberNumber: null,      // 番号
      name: null,              // 氏名（漢字）
      nameKana: null,          // フリガナ
      dob: null,               // 生年月日（YYYY-MM-DD）
      sex: null,               // 性別
      address: null,           // 住所
      postalCode: null,        // 郵便番号
      expiry: null,            // 有効期限
      insurerName: null,       // 保険者名称
      qualifier: null,         // 資格取得年月日
      rawText: text,
      confidence: 0
    };

    // --- 保険者番号（6桁 or 8桁の数字列） ---
    const insurerPatterns = [
      /保険者[番号\s]*[:\s：]*(\d{6,8})/,
      /保険者番号\s*(\d{6,8})/,
      /(?:^|\s)(\d{8})(?:\s|$)/m,  // 単独の8桁数字
    ];
    for (const pat of insurerPatterns) {
      const m = fullText.match(pat);
      if (m) { result.insurerNumber = m[1]; break; }
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

    // 「番号」は「保険者番号」のマッチを避ける
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

    // --- 生年月日 ---
    const dobPatterns = [
      // 和暦パターン
      /(昭和|平成|令和)\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/,
      // 西暦パターン
      /(\d{4})\s*[年\/\-\.]\s*(\d{1,2})\s*[月\/\-\.]\s*(\d{1,2})\s*日?/,
      // 生年月日ラベル付き
      /生年月日[:\s：]*(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/,
      /生年月日[:\s：]*(昭和|平成|令和)\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/,
    ];
    for (const pat of dobPatterns) {
      const m = fullText.match(pat);
      if (m) {
        if (['昭和','平成','令和'].includes(m[1])) {
          const year = eraToWestern(m[1], parseInt(m[2]));
          result.dob = `${year}-${String(m[3]).padStart(2,'0')}-${String(m[4]).padStart(2,'0')}`;
        } else if (m.length === 5 && ['昭和','平成','令和'].includes(m[1])) {
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
    if (/男/.test(fullText) && !/女/.test(fullText)) result.sex = '男';
    else if (/女/.test(fullText) && !/男/.test(fullText)) result.sex = '女';
    else {
      // 「男」「女」の出現位置で判断（性別欄に近い方）
      const sexAreaMatch = fullText.match(/(?:性別|sex)[:\s：]*(男|女)/i);
      if (sexAreaMatch) result.sex = sexAreaMatch[1];
    }

    // --- フリガナ（カタカナ列の抽出） ---
    const kanaPattern = /([ァ-ヶー]{2,}[\s　]+[ァ-ヶー]{1,})/g;
    const kanaMatches = [];
    let km;
    while ((km = kanaPattern.exec(fullText)) !== null) {
      kanaMatches.push(km[1]);
    }
    // 最も長いカタカナ列を名前のフリガナとする
    if (kanaMatches.length > 0) {
      kanaMatches.sort((a, b) => b.length - a.length);
      result.nameKana = kanaMatches[0].replace(/[\s　]+/g, ' ').trim();
    }

    // --- 氏名（漢字） ---
    // 行単位で「氏名」ラベルを探し、その後ろの漢字を取る
    for (const line of lines) {
      const m = line.match(/氏名[\s：:]+(.+)/);
      if (m) {
        let name = m[1].replace(/[（(].*/,'').replace(/記号|番号|保険|住所|生年|証|被|健康/g,'').trim();
        // 漢字が連結されている場合（「山田太郎」）、姓名辞書で分割
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
    // fallback: フリガナの直前行を漢字氏名とみなす
    if (!result.name && result.nameKana) {
      for (let i = 1; i < lines.length; i++) {
        if (/[ァ-ヶー]{2,}/.test(lines[i]) && lines[i].includes(result.nameKana.replace(' ',''))) {
          // 前の行が漢字を含むか
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
    // 行単位で住所を探す（次のフィールドラベルで切る）
    for (const line of lines) {
      const m = line.match(/住\s*所[:\s：]*(.*)/);
      if (m && m[1].length >= 5) {
        result.address = m[1].replace(/電話|TEL|tel|保険者|有効期限|資格|事業所/g, '').trim();
        break;
      }
    }
    // fallback: fullTextから（ただし後続ラベルで切る）
    if (!result.address) {
      const addrPatterns = [
        /住\s*所[:\s：]*(.+?)(?=\s*(?:電話|TEL|有効期限|保険者|資格|事業所|$))/,
        /(?:〒\s*\d{3}[\-ー]\d{4}\s*)(.+?)(?=\s*(?:電話|TEL|有効期限|保険者|資格|事業所|$))/,
      ];
      for (const pat of addrPatterns) {
        const m = fullText.match(pat);
        if (m && m[1].length >= 5) {
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

    // --- 保険者名称 ---
    const insurerNameMatch = fullText.match(/保険者[名称\s]*[:\s：]*([^\n\d]{2,30})/);
    if (insurerNameMatch && !insurerNameMatch[1].match(/番号/)) {
      result.insurerName = insurerNameMatch[1].trim();
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

  // ===== 5. 数字特化OCR（保険者番号・郵便番号向け） =====
  async function recognizeNumbers(imgSource, progressCb) {
    await init(progressCb);

    // 数字認識用に whitelist 設定
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '7', // Treat the image as a single text line
    });

    const result = await worker.recognize(imgSource);

    // 設定を元に戻す
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

  // 住所から郵便番号推定（逆引き）はzipcloud APIでは不可なので、
  // 都道府県の抽出だけ行う
  function extractPrefecture(address) {
    if (!address) return null;
    const prefMatch = address.match(/(北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)/);
    return prefMatch ? prefMatch[1] : null;
  }

  // 住所分割（都道府県・市区町村・番地・建物）
  function splitAddress(address) {
    if (!address) return { pref: '', city: '', street: '', building: '' };
    const pref = extractPrefecture(address) || '';
    let rest = pref ? address.substring(address.indexOf(pref) + pref.length) : address;

    // 市区町村を抽出
    const cityMatch = rest.match(/^(.+?[市区町村郡])/);
    const city = cityMatch ? cityMatch[1] : '';
    rest = city ? rest.substring(rest.indexOf(city) + city.length) : rest;

    // 番地以降
    const buildingMatch = rest.match(/(\S*(?:ビル|マンション|アパート|ハイツ|コーポ|メゾン|荘|号室|棟|階).*)$/);
    const building = buildingMatch ? buildingMatch[1].trim() : '';
    const street = buildingMatch ? rest.substring(0, rest.indexOf(buildingMatch[1])).trim() : rest.trim();

    return { pref, city, street, building };
  }

  // クリーンアップ
  async function terminate() {
    if (worker) {
      await worker.terminate();
      worker = null;
      isInitialized = false;
      initPromise = null;
    }
  }

  return {
    init,
    recognize,
    recognizeNumbers,
    extractInsuranceFields,
    normalizeOcrText,
    preprocessImage,
    splitAddress,
    extractPrefecture,
    eraToWestern,
    terminate
  };
})();
