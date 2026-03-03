"""
薬品QRコード生成スクリプト
ドライブスルー診療プロジェクト

使用方法:
  python generate_qr_codes.py

出力先:
  ./qr_codes/[コード]_[薬品名].png
"""

import qrcode
from pathlib import Path
import re

# 出力フォルダ
OUTPUT_DIR = Path(__file__).parent / "qr_codes"

# サンプル薬品データ（スプレッドシートの薬品マスタと同じ - 8桁形式）
MEDICINES = [
    {"code": "59000001", "name": "クロピドグレル錠75mg「SANIK」", "unit": "錠"},
    {"code": "59000002", "name": "ランソプラゾール15mg腸溶性口腔内崩壊錠", "unit": "錠"},
    {"code": "59000003", "name": "アムロジンOD錠10mg", "unit": "錠"},
    {"code": "59000004", "name": "トラゼンタ錠5mg", "unit": "錠"},
    {"code": "59000005", "name": "ロスバスタチン錠5mg「DSEP」", "unit": "錠"},
    {"code": "59000006", "name": "ジャディアンス錠10mg", "unit": "錠"},
    {"code": "59000007", "name": "センノシド錠12mg「サワイ」", "unit": "錠"},
    {"code": "59000008", "name": "ロキソプロフェンNaテープ100mg", "unit": "枚"},
    {"code": "59000009", "name": "万年筆型注入器用注射針（超微細型）", "unit": "本"},
    {"code": "59000010", "name": "ライゾデグ配合注 フレックスタッチ 300単位", "unit": "キット"},
]


def sanitize_filename(name: str) -> str:
    """ファイル名に使用できない文字を置換"""
    # Windowsで使えない文字を置換
    invalid_chars = r'[<>:"/\\|?*]'
    sanitized = re.sub(invalid_chars, '_', name)
    # 長すぎる場合は切り詰め
    if len(sanitized) > 50:
        sanitized = sanitized[:50]
    return sanitized


def generate_qr_code(code: str, name: str, output_dir: Path) -> Path:
    """QRコードを生成して保存"""
    # QRコード生成
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=4,
    )
    qr.add_data(code)
    qr.make(fit=True)

    # 画像生成
    img = qr.make_image(fill_color="black", back_color="white")

    # ファイル名作成
    safe_name = sanitize_filename(name)
    filename = f"{code}_{safe_name}.png"
    filepath = output_dir / filename

    # 保存
    img.save(filepath)
    return filepath


def main():
    """メイン処理"""
    print("=" * 60)
    print("薬品QRコード生成ツール")
    print("ドライブスルー診療プロジェクト")
    print("=" * 60)
    print()

    # 出力フォルダ作成
    OUTPUT_DIR.mkdir(exist_ok=True)
    print(f"出力フォルダ: {OUTPUT_DIR}")
    print()

    # QRコード生成
    print(f"生成中... ({len(MEDICINES)} 件)")
    print("-" * 60)

    for med in MEDICINES:
        filepath = generate_qr_code(med["code"], med["name"], OUTPUT_DIR)
        print(f"  [OK] {med['code']} : {med['name'][:30]}...")

    print("-" * 60)
    print()
    print(f"完了! {len(MEDICINES)} 件のQRコードを生成しました")
    print(f"保存先: {OUTPUT_DIR.absolute()}")
    print()

    # ファイル一覧表示
    print("生成されたファイル:")
    for f in sorted(OUTPUT_DIR.glob("*.png")):
        print(f"  - {f.name}")


if __name__ == "__main__":
    main()
