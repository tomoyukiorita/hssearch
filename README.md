# HSコード検索AIエージェント

Google ADK (TypeScript) を使用したHSコード自動分類システム

## 機能

- 商品マスターExcelからHSコードを自動検索
- 商品名だけでは判定困難な場合はDeep Researchで商品情報を調査
- Web UIでインタラクティブに操作

## セットアップ

```bash
# 依存関係インストール
npm install

# TypeScriptコンパイル
npx tsc

# .envにGemini APIキーを設定
echo 'GEMINI_API_KEY="your-api-key"' > .env
```

## 起動方法

```bash
# Web UI起動（Express）
node server.js
```

http://localhost:8000 でアクセス

## Railwayにデプロイ

1) Railwayで新規プロジェクトを作成し、このリポジトリを接続  
2) Variables に最低限これを設定：
- `GEMINI_API_KEY`

3) デプロイ後、Railwayが割り当てたURLにアクセス  

補足：
- このアプリは `npm start`（=`node server.js`）で起動します
- Railway側が `PORT` を自動で渡します（`server.js` は `process.env.PORT` を参照します）

## 使い方

Web UIで以下のように指示：

1. **商品一覧を見る**: 「商品マスターの最初の5件を表示して」
2. **HSコード検索**: 「沈香のHSコードを検索して」
3. **詳細調査**: 「Gypsy Woodという商品を調査してHSコードを特定して」

## ファイル構成

```
hssearch/
├── server.js             # Web UI + API（Gemini + Web検索 + Excel処理）
├── results.json          # 調査結果（自動生成）
├── hscodedb.xlsx         # HSコードDB（参照DB）
└── .env                  # APIキー
```

## Web一致度（webMatchScore）と要確認（needsReview）

Web検索（Google Search grounding）の参照ソースが「メーカー名 + 商品名」に合っているかを、**ルールベースで0〜100点**に点数化します。別物ヒットを早期検知して、UI/Excelで「要確認」を促します。

### 入力データ
- Gemini応答の `groundingMetadata.groundingChunks[].web`（title / uri）
- `メーカー名` と `商品名`

### 参照ソースが無い場合
- `groundingMetadata` が取得できないなどで参照ソースが0件の場合は、`webMatchScore` は `null`（UI上は `-`）として **評価不可** 扱いにします（スコア0固定で全件「要確認」にならないようにするため）。

### 文字の正規化
- `NFKC` 正規化
- 小文字化
- 記号を空白に置換し、連続空白を1つに圧縮

### スコアリング（概要）
上位（最大5件）の参照ソースを見て、**上位ほど重み**を付けて合計します。

- **メーカー名トークン一致**（title/hostname内）
  - 一致あり: 加点（重め）
- **商品名トークン一致**（title/hostname内）
  - 一致数に応じて加点
- **観光/地名系の単語が強い**（visit/tourism/travel/hotel/guide 等）
  - 該当あり: 減点

最終的に 0〜100 にクランプして `webMatchScore` とします。

### 要確認（needsReview）になる条件（デフォルト）
**「別物ヒットの可能性が本当に高い」時だけ**要確認にします（全件レビューを避けるため）。

以下をすべて満たすときに要確認になります：
- **参照ソース件数が十分ある**（`WEB_MATCH_MIN_SOURCES_FOR_REVIEW` 以上）
- **商品名の“特徴的トークン”が2個以上ある**（サイズ/色などは除外）
- その特徴的トークンが **参照ソースに1つも出ない**（強い不一致）
- かつ、追加の強いサインがある（いずれか）
  - 低スコア（`webMatchScore <= WEB_MATCH_REVIEW_LOW_SCORE`）
  - 観光/地名系サイトが上位
  - 典型的な非商品ドメイン（Wikipedia等）が上位

### 閾値の調整（環境変数）
- `WEB_MATCH_THRESHOLD`（デフォルト: `60`）
  - 例: `WEB_MATCH_THRESHOLD=70`
- `WEB_MATCH_REQUIRE_MAKER`（デフォルト: `true`）
  - 例: `WEB_MATCH_REQUIRE_MAKER=false`
- `WEB_MATCH_MIN_SOURCES_FOR_REVIEW`（デフォルト: `2`）
  - 例: `WEB_MATCH_MIN_SOURCES_FOR_REVIEW=3`
- `WEB_MATCH_REVIEW_LOW_SCORE`（デフォルト: `15`）
  - 例: `WEB_MATCH_REVIEW_LOW_SCORE=10`

