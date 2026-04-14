/**
 * 薬品在庫管理システム - Google Apps Script v0.1
 * ドライブスルー診療プロジェクト
 *
 * スプレッドシートID: 13AId0dOUOrrZLnFnZi_V4NcOo5OT9pkaFr1UJPIK02c
 * GASプロジェクト: https://script.google.com/home/projects/1vVktinccj0Hm43dt_bEjCPIhXbIwVyhppdCQr87a1cweCGyayYJh55Nv/edit
 */

// ===== 設定 =====
const SPREADSHEET_ID = '13AId0dOUOrrZLnFnZi_V4NcOo5OT9pkaFr1UJPIK02c';

const SHEET_NAMES = {
  MEDICINE_MASTER: '薬品マスタ',
  STOCK_IN: '入庫履歴',
  STOCK_OUT: '出庫履歴',
  CURRENT_STOCK: '在庫サマリー',
  PATIENT_MASTER: '患者マスタ',
  STOCK_ADJUST: '修正（棚卸）履歴'
};

/**
 * スプレッドシートを取得（独立プロジェクト対応）
 * 注: GASが独立プロジェクトのため getActiveSpreadsheet() は使えない
 */
function getSpreadsheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

/**
 * コードを正規化（先頭ゼロを除去して数値として比較可能にする）
 * QRコード: 59000001 (8桁) と スプレッドシート: 059000001 (9桁) を一致させる
 */
function normalizeCode(code) {
  if (!code) return '';
  return String(parseInt(String(code), 10));
}

// ===== Web App エンドポイント =====

/**
 * GETリクエスト処理
 */
function doGet(e) {
  const action = e.parameter.action;

  let result;
  switch (action) {
    case 'getMedicines':
      result = getMedicineList();
      break;
    case 'getStock':
      result = getCurrentStock();
      break;
    case 'getHistory':
      result = getHistory(e.parameter.date, e.parameter.dateFrom, e.parameter.dateTo, e.parameter.search);
      break;
    case 'getPatients':
      result = getPatientList();
      break;
    default:
      result = { error: 'Unknown action' };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * POSTリクエスト処理
 */
function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  const action = data.action;

  let result;
  switch (action) {
    case 'stockIn':
      result = recordStockIn(data);
      break;
    case 'stockOut':
      result = recordStockOut(data);
      break;
    case 'stockAdjust':
      result = recordStockAdjust(data);
      break;
    default:
      result = { error: 'Unknown action' };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== 薬品マスタ操作 =====

/**
 * 薬品一覧を取得
 */
function getMedicineList() {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.MEDICINE_MASTER);

  if (!sheet) {
    return { error: 'シートが見つかりません' };
  }

  const data = sheet.getDataRange().getValues();
  const medicines = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[0]) {
      medicines.push({
        code: row[0],
        name: row[1],
        furigana: row[2],
        unit: row[3],
        receiptCode: row[4],
        price: row[5],
        threshold: row[6] || 10
      });
    }
  }

  return { success: true, medicines };
}

/**
 * 現在の在庫数を取得
 */
function getCurrentStock() {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.CURRENT_STOCK);

  if (!sheet) {
    return { error: 'シートが見つかりません' };
  }

  const data = sheet.getDataRange().getValues();
  const stock = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[0]) {
      stock.push({
        code: row[0],
        name: row[1],
        currentStock: row[2],
        unit: row[3],
        threshold: row[4],
        lastUpdated: row[5]
      });
    }
  }

  return { success: true, stock };
}

// ===== 入出庫記録 =====

/**
 * 入庫を記録
 */
function recordStockIn(data) {
  const { code, quantity, operator, note } = data;

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.STOCK_IN);

  if (!sheet) {
    return { error: 'シートが見つかりません' };
  }

  const now = new Date();
  const row = [
    Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'),
    code,
    getMedicineName(code),
    quantity,
    getUnit(code),
    operator || '',
    note || ''
  ];

  sheet.appendRow(row);

  // 在庫サマリーを更新
  updateCurrentStock(code, quantity);

  return { success: true, message: '入庫を記録しました' };
}

/**
 * 出庫を記録
 */
function recordStockOut(data) {
  const { code, quantity, patientId, patientName, operator, note } = data;

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.STOCK_OUT);

  if (!sheet) {
    return { error: 'シートが見つかりません' };
  }

  // 在庫チェック
  const currentStock = getStockByCode(code);
  if (currentStock < quantity) {
    return { error: '在庫が不足しています', currentStock };
  }

  const now = new Date();
  const row = [
    Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'),
    code,
    getMedicineName(code),
    quantity,
    getUnit(code),
    patientId || '',
    patientName || '',
    operator || '',
    note || ''
  ];

  sheet.appendRow(row);

  // 在庫サマリーを更新（マイナス）
  updateCurrentStock(code, -quantity);

  return { success: true, message: '出庫を記録しました' };
}

/**
 * 棚卸修正を記録（在庫を指定数量に直接設定）
 */
function recordStockAdjust(data) {
  const { code, newQuantity, reason, operator, note } = data;

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.STOCK_ADJUST);

  if (!sheet) {
    return { error: 'シートが見つかりません' };
  }

  // 現在の在庫数を取得
  const currentStock = getStockByCode(code);
  const diff = newQuantity - currentStock;

  const now = new Date();
  const row = [
    Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'),
    code,
    getMedicineName(code),
    currentStock,     // 修正前
    newQuantity,      // 修正後
    diff,             // 差分
    reason || '棚卸',
    operator || '',
    note || ''
  ];

  sheet.appendRow(row);

  // 在庫サマリーを直接更新（差分ではなく絶対値で設定）
  setCurrentStock(code, newQuantity);

  return { success: true, message: '在庫を修正しました', previousStock: currentStock, newStock: newQuantity, diff: diff };
}

/**
 * 在庫サマリーを更新
 */
function updateCurrentStock(code, delta) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.CURRENT_STOCK);

  if (!sheet) return;

  const data = sheet.getDataRange().getValues();
  const normalizedInput = normalizeCode(code);

  for (let i = 1; i < data.length; i++) {
    if (normalizeCode(data[i][0]) === normalizedInput) {
      const currentStock = data[i][2] || 0;
      const newStock = currentStock + delta;
      const now = new Date();

      sheet.getRange(i + 1, 3).setValue(newStock);
      sheet.getRange(i + 1, 6).setValue(
        Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss')
      );

      return;
    }
  }

  // 該当コードがない場合は新規追加
  const medicine = getMedicineByCode(code);
  if (medicine) {
    sheet.appendRow([
      code,
      medicine.name,
      delta,
      medicine.unit,
      medicine.threshold || 10,
      Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss')
    ]);
  }
}

/**
 * 在庫サマリーを絶対値で設定（棚卸修正用）
 */
function setCurrentStock(code, newQuantity) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.CURRENT_STOCK);

  if (!sheet) return;

  const data = sheet.getDataRange().getValues();
  const normalizedInput = normalizeCode(code);

  for (let i = 1; i < data.length; i++) {
    if (normalizeCode(data[i][0]) === normalizedInput) {
      const now = new Date();
      sheet.getRange(i + 1, 3).setValue(newQuantity);
      sheet.getRange(i + 1, 6).setValue(
        Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss')
      );
      return;
    }
  }

  // Not found - add new row
  const medicine = getMedicineByCode(code);
  if (medicine) {
    sheet.appendRow([
      code,
      medicine.name,
      newQuantity,
      medicine.unit,
      medicine.threshold || 10,
      Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss')
    ]);
  }
}

// ===== 履歴取得 =====

/**
 * 履歴を取得
 */
function getHistory(dateStr, dateFrom, dateTo, search) {
  const ss = getSpreadsheet();
  const inSheet = ss.getSheetByName(SHEET_NAMES.STOCK_IN);
  const outSheet = ss.getSheetByName(SHEET_NAMES.STOCK_OUT);
  const adjustSheet = ss.getSheetByName(SHEET_NAMES.STOCK_ADJUST);

  // Date range: if dateFrom/dateTo provided, use range; else use single date
  let targetDateStart, targetDateEnd;
  if (dateFrom && dateTo) {
    targetDateStart = dateFrom;
    targetDateEnd = dateTo;
  } else {
    const singleDate = dateStr || Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    targetDateStart = singleDate;
    targetDateEnd = singleDate;
  }

  const searchLower = search ? search.toLowerCase() : '';

  function formatTimestamp(val) {
    if (val instanceof Date) {
      return Utilities.formatDate(val, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    }
    return String(val);
  }

  function matchesDateRange(ts) {
    const dateOnly = ts.substring(0, 10);
    return dateOnly >= targetDateStart && dateOnly <= targetDateEnd;
  }

  function matchesSearch(name) {
    if (!searchLower) return true;
    return String(name).toLowerCase().indexOf(searchLower) >= 0;
  }

  const history = [];

  // 入庫履歴
  if (inSheet) {
    const inData = inSheet.getDataRange().getValues();
    for (let i = 1; i < inData.length; i++) {
      const row = inData[i];
      const ts = formatTimestamp(row[0]);
      if (row[0] && matchesDateRange(ts) && matchesSearch(row[2])) {
        history.push({
          timestamp: ts, type: 'in', code: row[1], name: row[2],
          quantity: row[3], unit: row[4], operator: row[5], note: row[6]
        });
      }
    }
  }

  // 出庫履歴
  if (outSheet) {
    const outData = outSheet.getDataRange().getValues();
    for (let i = 1; i < outData.length; i++) {
      const row = outData[i];
      const ts = formatTimestamp(row[0]);
      if (row[0] && matchesDateRange(ts) && matchesSearch(row[2])) {
        history.push({
          timestamp: ts, type: 'out', code: row[1], name: row[2],
          quantity: row[3], unit: row[4], patientId: row[5],
          patientName: row[6], operator: row[7], note: row[8]
        });
      }
    }
  }

  // 修正（棚卸）履歴
  if (adjustSheet) {
    const adjData = adjustSheet.getDataRange().getValues();
    for (let i = 1; i < adjData.length; i++) {
      const row = adjData[i];
      const ts = formatTimestamp(row[0]);
      if (row[0] && matchesDateRange(ts) && matchesSearch(row[2])) {
        history.push({
          timestamp: ts, type: 'adjust', code: row[1], name: row[2],
          previousStock: row[3], newStock: row[4], diff: row[5],
          reason: row[6], operator: row[7], note: row[8]
        });
      }
    }
  }

  history.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return { success: true, history };
}

// ===== ヘルパー関数 =====

/**
 * コードから薬品情報を取得
 */
function getMedicineByCode(code) {
  const result = getMedicineList();
  const normalizedInput = normalizeCode(code);
  if (result.medicines) {
    return result.medicines.find(m => normalizeCode(m.code) === normalizedInput);
  }
  return null;
}

/**
 * コードから薬品名を取得
 */
function getMedicineName(code) {
  const medicine = getMedicineByCode(code);
  return medicine ? medicine.name : '';
}

/**
 * コードから単位を取得
 */
function getUnit(code) {
  const medicine = getMedicineByCode(code);
  return medicine ? medicine.unit : '';
}

/**
 * コードから現在在庫を取得
 */
function getStockByCode(code) {
  const result = getCurrentStock();
  const normalizedInput = normalizeCode(code);
  if (result.stock) {
    const item = result.stock.find(s => normalizeCode(s.code) === normalizedInput);
    return item ? item.currentStock : 0;
  }
  return 0;
}

// ===== 初期セットアップ =====

/**
 * スプレッドシートを初期化
 * メニューから一度だけ実行
 */
function initializeSheets() {
  const ss = getSpreadsheet();

  // 薬品マスタシート
  let sheet = ss.getSheetByName(SHEET_NAMES.MEDICINE_MASTER);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.MEDICINE_MASTER);
    sheet.appendRow(['コード', '名前', 'フリガナ', '単位', 'レセ電算コード', '単価', '発注点']);
    sheet.getRange(1, 1, 1, 7).setBackground('#4285f4').setFontColor('#ffffff').setFontWeight('bold');
  }

  // 入庫履歴シート
  sheet = ss.getSheetByName(SHEET_NAMES.STOCK_IN);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.STOCK_IN);
    sheet.appendRow(['日時', 'コード', '薬品名', '数量', '単位', '担当者', '備考']);
    sheet.getRange(1, 1, 1, 7).setBackground('#34a853').setFontColor('#ffffff').setFontWeight('bold');
  }

  // 出庫履歴シート
  sheet = ss.getSheetByName(SHEET_NAMES.STOCK_OUT);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.STOCK_OUT);
    sheet.appendRow(['日時', 'コード', '薬品名', '数量', '単位', '患者ID', '患者名', '担当者', '備考']);
    sheet.getRange(1, 1, 1, 9).setBackground('#ea4335').setFontColor('#ffffff').setFontWeight('bold');
  }

  // 在庫サマリーシート
  sheet = ss.getSheetByName(SHEET_NAMES.CURRENT_STOCK);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.CURRENT_STOCK);
    sheet.appendRow(['コード', '薬品名', '現在庫', '単位', '発注点', '最終更新']);
    sheet.getRange(1, 1, 1, 6).setBackground('#fbbc04').setFontColor('#000000').setFontWeight('bold');
  }

  // 修正（棚卸）履歴シート
  sheet = ss.getSheetByName(SHEET_NAMES.STOCK_ADJUST);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.STOCK_ADJUST);
    sheet.appendRow(['日時', 'コード', '薬品名', '修正前', '修正後', '差分', '理由', '担当者', '備考']);
    sheet.getRange(1, 1, 1, 9).setBackground('#ff9800').setFontColor('#ffffff').setFontWeight('bold');
  }

  Logger.log('シートを初期化しました');
}

/**
 * サンプルデータを投入
 */
function insertSampleData() {
  const ss = getSpreadsheet();
  const masterSheet = ss.getSheetByName(SHEET_NAMES.MEDICINE_MASTER);
  const stockSheet = ss.getSheetByName(SHEET_NAMES.CURRENT_STOCK);

  const sampleMedicines = [
    ['059000001', 'クロピドグレル錠75mg「SANIK」', 'クロピドグレルジョウ', '錠', '710010095', 15.5, 30],
    ['059000002', 'ランソプラゾール15mg腸溶性口腔内崩壊錠', 'ランソプラゾール', '錠', '710010096', 12.0, 20],
    ['059000003', 'アムロジンOD錠10mg', 'アムロジン', '錠', '710010097', 18.5, 50],
    ['059000004', 'トラゼンタ錠5mg', 'トラゼンタジョウ', '錠', '710010098', 145.0, 30],
    ['059000005', 'ロスバスタチン錠5mg「DSEP」', 'ロスバスタチンジョウ', '錠', '710010099', 22.0, 40],
    ['059000006', 'ジャディアンス錠10mg', 'ジャディアンスジョウ', '錠', '710010100', 180.0, 30],
    ['059000007', 'センノシド錠12mg「サワイ」', 'センノシドジョウ', '錠', '710010101', 5.6, 50],
    ['059000008', 'ロキソプロフェンNaテープ100mg', 'ロキソプロフェン', '枚', '710010102', 20.0, 30],
    ['059000009', '万年筆型注入器用注射針（超微細型）', 'マンネンヒツガタチュウシャバリ', '本', '710010103', 15.0, 50],
    ['059000010', 'ライゾデグ配合注 フレックスタッチ 300単位', 'ライゾデグ', 'キット', '710010104', 2500.0, 5],
  ];

  const sampleStock = [
    ['059000001', 'クロピドグレル錠75mg「SANIK」', 120, '錠', 30, ''],
    ['059000002', 'ランソプラゾール15mg腸溶性口腔内崩壊錠', 85, '錠', 20, ''],
    ['059000003', 'アムロジンOD錠10mg', 200, '錠', 50, ''],
    ['059000004', 'トラゼンタ錠5mg', 45, '錠', 30, ''],
    ['059000005', 'ロスバスタチン錠5mg「DSEP」', 150, '錠', 40, ''],
    ['059000006', 'ジャディアンス錠10mg', 60, '錠', 30, ''],
    ['059000007', 'センノシド錠12mg「サワイ」', 180, '錠', 50, ''],
    ['059000008', 'ロキソプロフェンNaテープ100mg', 25, '枚', 30, ''],
    ['059000009', '万年筆型注入器用注射針（超微細型）', 100, '本', 50, ''],
    ['059000010', 'ライゾデグ配合注 フレックスタッチ 300単位', 8, 'キット', 5, ''],
  ];

  if (masterSheet) {
    sampleMedicines.forEach(row => masterSheet.appendRow(row));
  }

  if (stockSheet) {
    sampleStock.forEach(row => stockSheet.appendRow(row));
  }

  SpreadsheetApp.getUi().alert('サンプルデータを投入しました');
}

// ===== 患者マスタ機能 =====

const PATIENT_COLS = {
  ID: 0,
  NAME: 1,
  FURIGANA: 2,
  GENDER: 3,
  BIRTH_DATE: 4,
  AGE: 5,
  LAST_VISIT: 6,
  ZIP: 7,
  ADDRESS: 8,
  PHONE1: 9,
  PHONE2: 10,
  NORMALIZED: 11
};

/**
 * 患者一覧を取得
 */
function getPatientList() {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.PATIENT_MASTER);

  if (!sheet) {
    return { error: 'シートが見つかりません' };
  }

  const data = sheet.getDataRange().getValues();
  const patients = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[PATIENT_COLS.ID]) {
      patients.push({
        id: String(row[PATIENT_COLS.ID]),
        name: row[PATIENT_COLS.NAME],
        furigana: row[PATIENT_COLS.FURIGANA],
        gender: row[PATIENT_COLS.GENDER],
        birthDate: row[PATIENT_COLS.BIRTH_DATE],
        normalizedName: row[PATIENT_COLS.NORMALIZED] || normalizeNameForSearch(row[PATIENT_COLS.NAME])
      });
    }
  }

  return { success: true, patients };
}

/**
 * 名前を正規化（空白除去）
 */
function normalizeNameForSearch(name) {
  if (!name) return '';
  return name.replace(/[\s　]+/g, '');
}

/**
 * 患者マスタシートを初期化
 */
function initializePatientMasterSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAMES.PATIENT_MASTER);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.PATIENT_MASTER);
  } else {
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.deleteRows(2, lastRow - 1);
    }
  }

  sheet.getRange(1, 1, 1, 6).setValues([['患者ID', '患者氏名', 'フリガナ', '性別', '生年月日', '正規化氏名']]);
  sheet.getRange(1, 1, 1, 6).setBackground('#9c27b0').setFontColor('#ffffff').setFontWeight('bold');

  sheet.setColumnWidth(1, 80);
  sheet.setColumnWidth(2, 150);
  sheet.setColumnWidth(3, 150);
  sheet.setColumnWidth(4, 60);
  sheet.setColumnWidth(5, 100);
  sheet.setColumnWidth(6, 120);

  return sheet;
}

/**
 * Google DriveのCSVファイルから患者マスタをインポート
 */
function importPatientMasterFromDrive() {
  const ui = SpreadsheetApp.getUi();

  const response = ui.prompt(
    'DriveからCSVインポート',
    'Google Driveに保存したCSVファイル名を入力してください\n（例: PatientList-20260303172116.csv）:',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() !== ui.Button.OK) return;

  const fileName = response.getResponseText().trim();
  if (!fileName) {
    ui.alert('ファイル名が入力されていません');
    return;
  }

  try {
    const files = DriveApp.getFilesByName(fileName);
    if (!files.hasNext()) {
      ui.alert('ファイルが見つかりません: ' + fileName);
      return;
    }

    const file = files.next();
    const csvText = file.getBlob().getDataAsString('Shift_JIS');

    const result = importPatientMasterFromCSVText(csvText);
    ui.alert(result.message);

  } catch (e) {
    ui.alert('エラー: ' + e.message);
  }
}

/**
 * CSVテキストから患者マスタをインポート（手動貼り付け）
 */
function importPatientMasterFromText() {
  const ui = SpreadsheetApp.getUi();

  const response = ui.prompt(
    '患者CSVインポート',
    'M3からダウンロードしたCSVの内容をここに貼り付けてください（先頭100行程度）:',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() !== ui.Button.OK) return;

  const csvText = response.getResponseText();
  if (!csvText) {
    ui.alert('CSVテキストが入力されていません');
    return;
  }

  const result = importPatientMasterFromCSVText(csvText);
  ui.alert(result.message);
}

/**
 * CSVテキストから患者マスタをインポート（内部処理）
 */
function importPatientMasterFromCSVText(csvText) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAMES.PATIENT_MASTER);

  if (!sheet) {
    sheet = initializePatientMasterSheet();
  }

  const lines = csvText.split('\n');
  let importCount = 0;
  let skipCount = 0;

  const existingData = sheet.getDataRange().getValues();
  const existingIds = new Set();
  for (let i = 1; i < existingData.length; i++) {
    if (existingData[i][0]) {
      existingIds.add(String(existingData[i][0]));
    }
  }

  const newRows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCSVLine(line);
    if (cols.length < 5) continue;

    const patientId = cols[0];
    const patientName = cols[1];
    const furigana = cols[2];
    const gender = cols[3];
    const birthDate = cols[4];

    if (!patientId || !patientName) continue;

    if (existingIds.has(patientId)) {
      skipCount++;
      continue;
    }

    const normalizedName = normalizeNameForSearch(patientName);
    newRows.push([patientId, patientName, furigana, gender, birthDate, normalizedName]);
    existingIds.add(patientId);
    importCount++;
  }

  if (newRows.length > 0) {
    const lastRow = sheet.getLastRow();
    sheet.getRange(lastRow + 1, 1, newRows.length, 6).setValues(newRows);
  }

  return {
    success: true,
    message: `インポート完了: ${importCount}件追加、${skipCount}件スキップ（重複）`
  };
}

/**
 * CSVの1行を解析
 */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());

  return result;
}

/**
 * 出庫履歴の患者IDを自動補完
 */
function fillMissingPatientIds() {
  const ss = getSpreadsheet();
  const outSheet = ss.getSheetByName(SHEET_NAMES.STOCK_OUT);
  const patientSheet = ss.getSheetByName(SHEET_NAMES.PATIENT_MASTER);

  if (!outSheet) return { error: '出庫履歴シートが見つかりません' };
  if (!patientSheet) return { error: '患者マスタシートが見つかりません' };

  const patientData = patientSheet.getDataRange().getValues();
  const patientMap = new Map();

  for (let i = 1; i < patientData.length; i++) {
    const row = patientData[i];
    if (!row[PATIENT_COLS.ID] || !row[PATIENT_COLS.NAME]) continue;

    const id = String(row[PATIENT_COLS.ID]);
    const name = row[PATIENT_COLS.NAME];
    const normalizedName = row[PATIENT_COLS.NORMALIZED] || normalizeNameForSearch(name);

    if (!patientMap.has(normalizedName)) {
      patientMap.set(normalizedName, []);
    }
    patientMap.get(normalizedName).push({ id, name });
  }

  const outData = outSheet.getDataRange().getValues();
  let updateCount = 0;
  let multiMatchCount = 0;
  const updates = [];

  for (let i = 1; i < outData.length; i++) {
    const row = outData[i];
    const patientId = row[5];
    const patientName = row[6];

    if (patientName && !patientId) {
      const normalizedSearch = normalizeNameForSearch(patientName);
      const matches = patientMap.get(normalizedSearch);

      if (matches && matches.length > 0) {
        if (matches.length === 1) {
          updates.push({ row: i + 1, col: 6, value: matches[0].id });
          updateCount++;
        } else {
          const ids = matches.map(m => m.id).join(',');
          updates.push({ row: i + 1, col: 6, value: ids });
          multiMatchCount++;
          updateCount++;
        }
      }
    }
  }

  updates.forEach(update => {
    outSheet.getRange(update.row, update.col).setValue(update.value);
  });

  const message = `患者ID補完完了: ${updateCount}件更新（うち複数候補: ${multiMatchCount}件）`;
  Logger.log(message);

  return { success: true, message, updateCount, multiMatchCount };
}

/**
 * 患者マスタの正規化氏名（L列）を一括生成
 */
function generateNormalizedNames() {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.PATIENT_MASTER);

  if (!sheet) {
    SpreadsheetApp.getUi().alert('患者マスタシートが見つかりません');
    return;
  }

  const lastRow = sheet.getLastRow();

  const normalizedCol = PATIENT_COLS.NORMALIZED + 1;
  sheet.getRange(1, normalizedCol).setValue('正規化氏名');
  sheet.getRange(1, normalizedCol).setBackground('#9c27b0').setFontColor('#ffffff').setFontWeight('bold');

  if (lastRow < 2) {
    SpreadsheetApp.getUi().alert('データがありません');
    return;
  }

  const names = sheet.getRange(2, PATIENT_COLS.NAME + 1, lastRow - 1, 1).getValues();
  const normalizedNames = names.map(row => [normalizeNameForSearch(row[0])]);
  sheet.getRange(2, normalizedCol, lastRow - 1, 1).setValues(normalizedNames);

  SpreadsheetApp.getUi().alert(`正規化氏名を ${lastRow - 1} 件生成しました`);
}

/**
 * 毎日朝9時のトリガーを設定
 */
function setupDailyPatientIdTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === 'fillMissingPatientIds') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('fillMissingPatientIds')
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .create();

  SpreadsheetApp.getUi().alert('毎日朝9時の自動実行を設定しました');
}

/**
 * 患者ID補完を手動実行（メニュー用）
 */
function runFillMissingPatientIds() {
  const result = fillMissingPatientIds();
  SpreadsheetApp.getUi().alert(result.message || result.error);
}

/**
 * カスタムメニューを追加
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('在庫管理')
    .addItem('シートを初期化', 'initializeSheets')
    .addItem('サンプルデータ投入', 'insertSampleData')
    .addSeparator()
    .addSubMenu(ui.createMenu('患者マスタ')
      .addItem('患者マスタシートを作成', 'initializePatientMasterSheet')
      .addItem('DriveのCSVからインポート', 'importPatientMasterFromDrive')
      .addItem('テキスト貼り付けでインポート', 'importPatientMasterFromText')
      .addItem('正規化氏名を生成', 'generateNormalizedNames')
      .addSeparator()
      .addItem('患者ID自動補完（手動実行）', 'runFillMissingPatientIds')
      .addItem('毎日9時の自動実行を設定', 'setupDailyPatientIdTrigger'))
    .addToUi();
}
