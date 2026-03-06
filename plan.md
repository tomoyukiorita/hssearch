# Gemini構造化出力（Structured Output）導入計画

## 概要
現在プロンプトベースで「JSONで返して」とお願いしているのを、APIレベルで `responseMimeType: 'application/json'` + `responseSchema` を指定して確実にJSONを返させる。

## 対象の2関数

### 1. `investigateProduct` (server.js:524)
- モデル: `gemini-3-flash-preview` + Google Search grounding
- Gemini 3はstructured output + Google Searchの併用が**可能**（公式ドキュメント確認済み）

### 2. `determineHSCode` (server.js:597)
- モデル: `gemini-2.0-flash`（Google Search不使用）
- structured output対応済みだが、`propertyOrdering` が必要な場合あり

## 具体的な変更

### ステップ1: SchemaTypeのimport追加 (server.js:6)

```javascript
const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
```

### ステップ2: スキーマ定義を追加（関数の外に定数として定義）

```javascript
// investigateProduct用スキーマ
const investigationSchema = {
  type: SchemaType.OBJECT,
  properties: {
    productDescription: { type: SchemaType.STRING, description: '商品の説明（日本語、100文字程度）' },
    materials: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, description: '材質リスト' },
    usage: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, description: '用途リスト' },
    category: { type: SchemaType.STRING, description: '商品カテゴリ' },
    hsKeywords: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, description: 'HSコード検索用キーワード' },
    searchQuery: { type: SchemaType.STRING, description: '実際に使用した検索クエリ' },
  },
  required: ['productDescription', 'materials', 'usage', 'category', 'hsKeywords', 'searchQuery'],
};

// determineHSCode用スキーマ
const hsCodeSchema = {
  type: SchemaType.OBJECT,
  properties: {
    hsCode: { type: SchemaType.STRING, description: '6桁HSコード（数字のみ、ドットなし）。判断不能な場合のみ"不明"' },
    hsDescription: { type: SchemaType.STRING, description: '選んだHSコードの説明' },
    reason: { type: SchemaType.STRING, description: '選定理由（日本語、50文字程度）' },
    invoiceDescription: { type: SchemaType.STRING, description: 'Invoice用英語商品説明（30文字程度）' },
    confidence: { type: SchemaType.STRING, format: 'enum', enum: ['high', 'medium', 'low'], description: '確信度' },
  },
  required: ['hsCode', 'hsDescription', 'reason', 'invoiceDescription', 'confidence'],
};
```

### ステップ3: `investigateProduct` の変更

- `getGenerativeModel` に `generationConfig` を追加:
```javascript
const model = genAI.getGenerativeModel({
  model: 'gemini-3-flash-preview',
  tools: [{ googleSearch: {} }],
  generationConfig: {
    responseMimeType: 'application/json',
    responseSchema: investigationSchema,
  },
});
```
- 応答パース部分を簡素化: `text.match()` の正規表現による抽出を `JSON.parse(text)` に変更
- フォールバック: `JSON.parse` が万一失敗した場合のtry-catchは残す

### ステップ4: `determineHSCode` の変更

- `getGenerativeModel` に `generationConfig` を追加:
```javascript
const model = genAI.getGenerativeModel({
  model: 'gemini-2.0-flash',
  generationConfig: {
    responseMimeType: 'application/json',
    responseSchema: hsCodeSchema,
  },
});
```
- 同様にパース部分を簡素化
- フォールバック: catchブロックは維持

### ステップ5: プロンプトからJSON例示を削除

両方のプロンプトから「以下のJSON形式で回答してください：{...}」の部分を削除（スキーマが強制するので不要）。プロンプトはタスクの説明に集中させる。

## 注意点

- **Google Search + structured output の併用**: Gemini 3系でのみサポート。`investigateProduct`は`gemini-3-flash-preview`なのでOK
- **`determineHSCode`のgemini-2.0-flash**: structured outputは対応しているが、併用ツールは無いので問題なし
- **grounding metadata**: `responseMimeType` を設定しても `groundingMetadata` は引き続き取得可能（構造化出力はレスポンスのテキスト部分のみに影響）
- **フォールバック**: APIエラー時のtry-catchは維持し、既存のフォールバック値を返す

## 修正ファイル
- `server.js` のみ
