require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const XLSX = require('xlsx');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// PostgreSQL接続（DATABASE_URLがあればDB、なければローカルJSONにフォールバック）
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
    })
  : null;

// DB初期化（テーブル作成）
async function initDB() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hs_results (
      id SERIAL PRIMARY KEY,
      jan VARCHAR(50) UNIQUE NOT NULL,
      product_index INTEGER,
      product_name TEXT,
      maker TEXT,
      investigation JSONB,
      web_match_score INTEGER,
      needs_review BOOLEAN DEFAULT FALSE,
      web_match_reason TEXT,
      web_hit_risk VARCHAR(20),
      web_evidence JSONB,
      hs_code VARCHAR(20),
      hs_description TEXT,
      reason TEXT,
      invoice_description TEXT,
      confidence VARCHAR(20),
      hs_candidate_count INTEGER,
      hs_candidates TEXT,
      hs_keyword_debug TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ PostgreSQL テーブル初期化完了');
}

// File upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, __dirname),
  filename: (req, file, cb) => cb(null, Buffer.from(file.originalname, 'latin1').toString('utf8'))
});
const upload = multer({ storage });

// 結果DB（PostgreSQL or JSONフォールバック）
const RESULTS_FILE = path.join(__dirname, 'results.json');

async function loadResults() {
  if (pool) {
    const res = await pool.query('SELECT * FROM hs_results ORDER BY id');
    return res.rows.map(row => ({
      index: row.product_index,
      jan: row.jan,
      productName: row.product_name,
      maker: row.maker,
      investigation: row.investigation,
      webMatchScore: row.web_match_score,
      needsReview: row.needs_review,
      webMatchReason: row.web_match_reason,
      webHitRisk: row.web_hit_risk,
      webEvidence: row.web_evidence,
      hsCode: row.hs_code,
      hsDescription: row.hs_description,
      reason: row.reason,
      invoiceDescription: row.invoice_description,
      confidence: row.confidence,
      hsCandidateCount: row.hs_candidate_count,
      hsCandidates: row.hs_candidates,
      hsKeywordDebug: row.hs_keyword_debug,
      timestamp: row.updated_at?.toISOString() || row.created_at?.toISOString(),
    }));
  }
  // フォールバック: ローカルJSON
  if (fs.existsSync(RESULTS_FILE)) {
    return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
  }
  return [];
}

async function saveResults(results) {
  if (pool) {
    for (const r of results) {
      await pool.query(`
        INSERT INTO hs_results (
          jan, product_index, product_name, maker, investigation,
          web_match_score, needs_review, web_match_reason, web_hit_risk, web_evidence,
          hs_code, hs_description, reason, invoice_description, confidence,
          hs_candidate_count, hs_candidates, hs_keyword_debug, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
        ON CONFLICT (jan) DO UPDATE SET
          product_index = EXCLUDED.product_index,
          product_name = EXCLUDED.product_name,
          maker = EXCLUDED.maker,
          investigation = EXCLUDED.investigation,
          web_match_score = EXCLUDED.web_match_score,
          needs_review = EXCLUDED.needs_review,
          web_match_reason = EXCLUDED.web_match_reason,
          web_hit_risk = EXCLUDED.web_hit_risk,
          web_evidence = EXCLUDED.web_evidence,
          hs_code = EXCLUDED.hs_code,
          hs_description = EXCLUDED.hs_description,
          reason = EXCLUDED.reason,
          invoice_description = EXCLUDED.invoice_description,
          confidence = EXCLUDED.confidence,
          hs_candidate_count = EXCLUDED.hs_candidate_count,
          hs_candidates = EXCLUDED.hs_candidates,
          hs_keyword_debug = EXCLUDED.hs_keyword_debug,
          updated_at = NOW()
      `, [
        r.jan,
        r.index,
        r.productName,
        r.maker,
        JSON.stringify(r.investigation || {}),
        r.webMatchScore,
        r.needsReview,
        r.webMatchReason,
        r.webHitRisk,
        JSON.stringify(r.webEvidence || {}),
        r.hsCode,
        r.hsDescription,
        r.reason,
        r.invoiceDescription,
        r.confidence,
        r.hsCandidateCount,
        r.hsCandidates,
        r.hsKeywordDebug,
      ]);
    }
    return;
  }
  // フォールバック: ローカルJSON
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2), 'utf8');
}

// HSコードDB
let hsCodeDB = null;
function loadHSCodeDB() {
  if (hsCodeDB) return hsCodeDB;
  const dbPath = path.join(__dirname, 'hscodedb.xlsx');
  if (!fs.existsSync(dbPath)) return [];
  const workbook = XLSX.readFile(dbPath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet);
  hsCodeDB = data.map(row => ({
    code: String(row['番号'] || ''),
    description_ja: String(row['description_ja'] || ''),
    heading_description_ja: String(row['heading_description_ja'] || ''),
  })).filter(e => e.code);
  return hsCodeDB;
}

// アップロードされたファイルを保持
let uploadedProductFile = null;
let uploadedFiles = new Set();

// Webマッチ度スコア設定
const WEB_MATCH_THRESHOLD = Number(process.env.WEB_MATCH_THRESHOLD || 60);
const WEB_MATCH_REQUIRE_MAKER = String(process.env.WEB_MATCH_REQUIRE_MAKER || 'true') === 'true';
const WEB_MATCH_MIN_SOURCES_FOR_REVIEW = Number(process.env.WEB_MATCH_MIN_SOURCES_FOR_REVIEW || 3);  // 2→3
const WEB_MATCH_REVIEW_LOW_SCORE = Number(process.env.WEB_MATCH_REVIEW_LOW_SCORE || 10);  // 15→10

// 要確認フラグ改善用設定
const WEB_MATCH_MIN_DISTINCTIVE_TOKENS = Number(process.env.WEB_MATCH_MIN_DISTINCTIVE_TOKENS || 3);
const WEB_MATCH_NEGATIVE_THRESHOLD = Number(process.env.WEB_MATCH_NEGATIVE_THRESHOLD || 2);
const WEB_MATCH_REQUIRE_NEGATIVE_FOR_REVIEW = String(process.env.WEB_MATCH_REQUIRE_NEGATIVE_FOR_REVIEW || 'true') === 'true';
const WEB_MATCH_PRODUCT_DOMAINS = (process.env.WEB_MATCH_PRODUCT_DOMAINS || 'rakuten.co.jp,amazon.co.jp,yahoo.co.jp,thebase.in,stores.jp,minne.com,creema.jp,mercari.com').split(',');

function normalizeForMatch(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’'"]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function insertSpacesForJPKeywords(s) {
  // 日本語の商品名は空白なしで連結されやすいので、よくある語の前後に空白を入れてトークン化しやすくする
  // （辞書ではなく軽量ヒューリスティック）
  const keywords = [
    'レディース', 'メンズ', 'キッズ',
    'ステテコ', 'ズボン', 'パンツ', 'ショーツ', '下着', 'インナー',
    'ルームウェア', 'パジャマ', 'ナイトウェア',
    'ショート', 'ロング',
  ];
  let out = String(s || '');
  for (const kw of keywords) {
    out = out.replace(new RegExp(kw, 'g'), ` ${kw} `);
  }
  return out;
}

function splitByScriptRuns(s) {
  // 文字種の切替点で分割（例: "m市松花レディースステテコ" -> ["m", "市松花レディースステテコ"]）
  const str = String(s || '');
  const classify = (ch) => {
    if (/[0-9]/.test(ch)) return 'num';
    if (/[a-z]/i.test(ch)) return 'latin';
    // ひらがな/カタカナ（全角含む）
    if (/[\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF\uFF66-\uFF9F]/.test(ch)) return 'kana';
    // 漢字
    if (/[\u4E00-\u9FFF]/.test(ch)) return 'kanji';
    return 'other';
  };

  const runs = [];
  let buf = '';
  let prev = null;
  for (const ch of str) {
    const t = classify(ch);
    if (!buf) {
      buf = ch;
      prev = t;
      continue;
    }
    if (t === prev) {
      buf += ch;
    } else {
      runs.push(buf);
      buf = ch;
      prev = t;
    }
  }
  if (buf) runs.push(buf);
  return runs;
}

function tokenizeForMatch(s) {
  if (!s) return [];
  // 1) まず日本語キーワードで分割しやすくする
  const pre = insertSpacesForJPKeywords(String(s).normalize('NFKC').toLowerCase());
  // 2) 記号を落として正規化
  const norm = normalizeForMatch(pre);
  if (!norm) return [];

  const base = norm
    .split(' ')
    .map(t => t.trim())
    .filter(t => t.length >= 2);

  // 3) 空白が無い/長いトークンは文字種で追加分割して補助トークンを作る
  const extra = [];
  for (const t of base) {
    if (t.length >= 8) {
      const runs = splitByScriptRuns(t).map(x => x.trim()).filter(x => x.length >= 2);
      extra.push(...runs);
    }
  }

  return Array.from(new Set([...base, ...extra]));
}

function filterDistinctiveProductTokens(tokens) {
  const drop = new Set([
    // 性別/属性（同一商品で揺れやすく、要確認判定には使いにくい）
    'レディース', 'メンズ', 'キッズ',
    // 仕様（短すぎる・一般的すぎるもの）
    'ショート', 'ロング',
    '小', '中', '大',
    'free', 'onesize', 'one', 'サイズ',
    // 色（HS一致判定に基本寄与しない）
    'black', 'white', 'gray', 'grey', 'red', 'blue', 'green', 'yellow', 'pink', 'beige', 'brown', 'navy',
    'ブラック', 'ホワイト', 'グレー', 'レッド', 'ブルー', 'グリーン', 'イエロー', 'ピンク', 'ベージュ', 'ブラウン', 'ネイビー',
  ]);

  const filtered = (tokens || []).filter(t => {
    const s = String(t || '').trim();
    if (!s) return false;
    if (drop.has(s)) return false;
    // サイズ表記
    if (/^(xs|s|m|l|xl|xxl|xxxl|ll|3l|4l|5l)$/i.test(s)) return false;
    // 数量/容量/寸法など（例: 500ml, 2個, 10枚, 30cm）
    if (/^\d+(ml|l|g|kg|cm|mm|m|枚|個|本|袋|パック|set)$/i.test(s)) return false;
    // ほぼ無意味な短い英数（例: ll, xl, 01）
    if (/^[a-z0-9]{1,3}$/i.test(s)) return false;
    return true;
  });

  return Array.from(new Set(filtered));
}

function stripMakerNoise(s) {
  // 法人格/会社種別など、タイトルに載らないことが多いノイズを落とす（日本語/英語）
  const norm = String(s || '').normalize('NFKC');
  return norm
    .replace(/[（(]\s*(株|有)\s*[）)]/g, '') // （株）, (株), （有）など（括弧付きのみ）
    .replace(/[㈱㈲]/g, '') // 囲み文字
    .replace(/(株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人)/g, '')
    .replace(/\b(co\.?|company|inc\.?|ltd\.?|llc|corp\.?|corporation)\b/gi, '')
    .trim();
}

function computeWebMatchScore(maker, productName, webChunks) {
  const makerTokensRaw = [
    ...tokenizeForMatch(maker),
    ...tokenizeForMatch(stripMakerNoise(maker)),
  ];
  const makerStop = new Set([
    '株', '有', '会社', 'co', 'inc', 'ltd', 'llc', 'corp', 'corporation', 'company'
  ]);
  const makerTokens = Array.from(new Set(makerTokensRaw)).filter(t => !makerStop.has(t));
  const productTokens = tokenizeForMatch(productName);
  const distinctiveProductTokens = filterDistinctiveProductTokens(productTokens);

  const negativeTokens = [
    'visit', 'tourism', 'travel', 'guide', 'hotel', 'flights', 'wikipedia',
    'britannica', 'history', 'map', 'weather', 'city', 'town', 'beach',
  ];
  const nonProductDomains = [
    'wikipedia.org',
    'wikidata.org',
    'britannica.com',
    'openstreetmap.org',
    'tenki.jp',
    'weather.com',
  ];

  const sources = (webChunks || [])
    .filter(c => c && c.web && (c.web.uri || c.web.title))
    .slice(0, 5)
    .map(c => {
      const uri = String(c.web.uri || '');
      let hostname = '';
      try { hostname = new URL(uri).hostname.toLowerCase(); } catch (_) {}
      return { title: String(c.web.title || ''), uri, hostname };
    });

  // 参照ソースが無い場合は評価不可（スコアを0固定にして全件要確認になるのを避ける）
  if (sources.length === 0) {
    return {
      webMatchScore: null,
      needsReview: false,
      webMatchReason: '参照ソースなし（評価不可）',
      webSources: [],
      webHitRisk: 'none',
      webEvidence: {
        sourcesCount: 0,
        makerFound: makerTokens.length === 0,
        productFound: productTokens.length === 0,
        negativeHit: false,
        makerHitsTotal: 0,
        productHitsTotal: 0,
      },
    };
  }

  let score = 0;
  let makerFound = makerTokens.length === 0; // maker未指定ならtrue扱い
  let productFoundAny = productTokens.length === 0;
  let negativeHitCount = 0;  // boolean → count-based
  let makerHitsTotal = 0;
  let productHitsTotal = 0;
  const foundDistinctiveTokens = new Set();

  const N = sources.length;
  sources.forEach((s, idx) => {
    const weight = (N - idx) / N; // 上位ほど重み
    const title = normalizeForMatch(s.title);
    const host = normalizeForMatch(s.hostname);
    const uri = normalizeForMatch(s.uri);
    const all = `${title} ${host} ${uri}`;

    // maker
    let makerHits = 0;
    for (const t of makerTokens) {
      if (all.includes(t)) makerHits++;
    }
    if (makerHits > 0) makerFound = true;
    makerHitsTotal += makerHits;

    // product
    let productHits = 0;
    for (const t of productTokens) {
      if (all.includes(t)) productHits++;
    }
    if (productHits > 0) productFoundAny = true;
    productHitsTotal += productHits;

    // distinctive product tokens (for review decision)
    for (const t of distinctiveProductTokens) {
      if (all.includes(t)) foundDistinctiveTokens.add(t);
    }

    // negative
    let negativeHitThis = false;
    for (const nt of negativeTokens) {
      if (all.includes(nt)) {
        negativeHitThis = true;
        break;
      }
    }
    if (negativeHitThis) negativeHitCount++;

    score += weight * (makerHits > 0 ? 50 : 0);
    score += weight * Math.min(40, productHits * 20);
    score += weight * (negativeHitThis ? -25 : 0);
  });

  // 0-100に正規化
  const clamped = Math.max(0, Math.min(100, Math.round(score)));

  // negativeHit判定（カウントベース）
  const negativeHit = negativeHitCount >= WEB_MATCH_NEGATIVE_THRESHOLD;  // デフォルト2件以上

  // 商品系ドメイン検出（楽天/Amazon等にヒットしていればニッチ商品でも信頼性あり）
  const productDomainHit = sources
    .slice(0, 3)
    .some(s => WEB_MATCH_PRODUCT_DOMAINS.some(d => String(s.hostname || '').includes(d)));

  const reasons = [];
  if (WEB_MATCH_REQUIRE_MAKER && makerTokens.length > 0 && !makerFound) reasons.push('メーカー名が参照ソースに無い');
  const distinctiveCount = distinctiveProductTokens.length;
  const foundDistinctiveCount = foundDistinctiveTokens.size;
  // strongProductMismatchの厳格化: 特徴トークン3個以上 + 0個ヒット + 商品系ドメインなし
  const strongProductMismatch =
    (distinctiveCount >= WEB_MATCH_MIN_DISTINCTIVE_TOKENS) &&  // 2→3
    (foundDistinctiveCount === 0) &&
    !productDomainHit;  // 商品系ドメインがあればfalse
  if (strongProductMismatch) reasons.push('商品名（特徴語）が参照ソースに無い');
  if (negativeHit) reasons.push('観光/地名系サイトが上位');
  if (reasons.length === 0) reasons.push('一致度は概ね良好');

  const sourcesCount = sources.length;
  const nonProductDomainHit = sources
    .slice(0, 3)
    .some(s => nonProductDomains.some(d => String(s.hostname || '').includes(d)));
  const webHitRisk =
    sourcesCount === 0 ? 'none' :
    (strongProductMismatch) ? 'very_high' :
    (WEB_MATCH_REQUIRE_MAKER && makerTokens.length > 0 && !makerFound) ? 'high' :
    (clamped < WEB_MATCH_THRESHOLD) ? 'medium' :
    'low';

  // 要確認は「本当に別物ヒットの可能性が高い場合」に限定する
  // - 参照ソースが弱い場合（件数不足）は要確認にしない
  // - "特徴的トークン"が3個以上あり、それが参照ソースに出ない（強い不一致）
  // - 追加の強い不一致サイン（低スコア かつ ネガティブ/非商品ドメイン）を伴うときのみ
  const evidenceStrong = sourcesCount >= WEB_MATCH_MIN_SOURCES_FOR_REVIEW;
  const hasNegativeSignal = negativeHit || nonProductDomainHit;
  const hasLowScore = clamped <= WEB_MATCH_REVIEW_LOW_SCORE;
  // AND条件化: ネガティブシグナルと低スコアの両方が必要（デフォルト）
  const strongSignal = WEB_MATCH_REQUIRE_NEGATIVE_FOR_REVIEW
    ? hasNegativeSignal && hasLowScore  // 両方必要（デフォルト）
    : hasNegativeSignal || hasLowScore;  // 従来モード
  const needsReview = evidenceStrong && strongProductMismatch && strongSignal;

  return {
    webMatchScore: clamped,
    needsReview,
    webMatchReason: reasons.slice(0, 2).join(' / '),
    webSources: sources,
    webHitRisk,
    webEvidence: {
      sourcesCount,
      makerFound,
      productFound: productFoundAny,
      negativeHit,
      negativeHitCount,      // 追加: デバッグ用
      productDomainHit,      // 追加: デバッグ用
      nonProductDomainHit,
      makerHitsTotal,
      productHitsTotal,
      distinctiveTokenCount: distinctiveCount,
      distinctiveTokens: distinctiveProductTokens.slice(0, 10),
      missingDistinctiveTokens: distinctiveProductTokens.filter(t => !foundDistinctiveTokens.has(t)).slice(0, 10),
    },
  };
}

// 商品マスター読み込み
function loadProductMaster(filename) {
  const targetFile = filename || uploadedProductFile;
  if (!targetFile) return [];
  const filePath = path.join(__dirname, targetFile);
  if (!fs.existsSync(filePath)) return [];
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet).map((row, idx) => ({
    index: idx,
    jan: String(row['JAN'] || ''),
    productName: String(row['商品名'] || ''),
    maker: String(row['メーカー名'] || ''),
  }));
}

// HSコード検索
function searchHSCode(keywords, limit = 5) {
  const db = loadHSCodeDB();
  const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const scored = db.map(entry => {
    let score = 0;
    const text = `${entry.description_ja} ${entry.heading_description_ja}`.toLowerCase();
    for (const kw of keywords) {
      if (text.includes(kw.toLowerCase())) {
        const safe = escapeRegExp(kw.toLowerCase());
        score += kw.length * (text.match(new RegExp(safe, 'g')) || []).length;
      }
    }
    return { entry, score };
  });
  return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
    .map(s => ({ code: s.entry.code, description: s.entry.description_ja }));
}

// ウェブ検索で商品調査 + HSコード特定
async function investigateProduct(product) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-3-flash-preview',
    tools: [{ googleSearch: {} }]  // Google Search grounding
  });

  // 1段階目: メーカー名 + 商品名の順で検索（メーカー優先）
  const searchQuery = `${product.maker || ''} ${product.productName}`.trim();
  const prompt = `以下の検索クエリでウェブ検索し、この商品について調査してください。

検索クエリ: 「${searchQuery}」

【重要な検索ルール】
- メーカーの公式サイトや販売サイト（ECサイト）からの情報を最優先してください
- 商品名が地名や一般的な言葉と一致する場合でも、必ず「商品」として調査してください
- 観光情報や地理情報ではなく、販売されている製品の情報を探してください

この商品について以下の情報を取得してください：
1. この商品は何か（材質、成分、用途）
2. HSコード分類に必要なキーワード

もし上記の検索で商品情報が見つからない場合は、別のクエリで再検索してください。

必ず以下のJSON形式で回答してください：
{
  "productDescription": "商品の説明（日本語、100文字程度）",
  "materials": ["材質1", "材質2"],
  "usage": ["用途1", "用途2"],
  "category": "商品カテゴリ",
  "hsKeywords": ["HSコード検索用キーワード1", "キーワード2", "キーワード3"],
  "searchQuery": "実際に使用した検索クエリ"
}`;

  try {
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();
    
    // Grounding metadata をログ出力
    const candidate = response.candidates?.[0];
    const groundingMetadata = candidate?.groundingMetadata;
    const webChunks = groundingMetadata?.groundingChunks || [];
    if (groundingMetadata) {
      console.log('🔍 Web Search実行:');
      if (groundingMetadata.searchEntryPoint?.renderedContent) {
        console.log('  検索クエリあり');
      }
      if (groundingMetadata.groundingChunks) {
        console.log('  参照ソース:', groundingMetadata.groundingChunks.length + '件');
        groundingMetadata.groundingChunks.slice(0, 3).forEach((chunk, i) => {
          if (chunk.web) {
            console.log(`    ${i+1}. ${chunk.web.title || chunk.web.uri}`);
          }
        });
      }
    } else {
      console.log('⚠️ Web Search未使用（groundingMetadataなし）');
    }
    
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const match = computeWebMatchScore(product.maker, product.productName, webChunks);
      return { ...parsed, ...match };
    }
    const match = computeWebMatchScore(product.maker, product.productName, webChunks);
    return { error: 'JSON解析失敗', rawResponse: text, ...match };
  } catch (e) {
    return { error: e.message };
  }
}

// HSコード特定 + Invoice説明生成
async function determineHSCode(product, investigation) {
  // HSコードDB検索
  const keywordsRaw = [];
  if (Array.isArray(investigation?.hsKeywords)) keywordsRaw.push(...investigation.hsKeywords);
  if (investigation?.category) keywordsRaw.push(investigation.category);
  if (Array.isArray(investigation?.materials)) keywordsRaw.push(...investigation.materials);
  if (Array.isArray(investigation?.usage)) keywordsRaw.push(...investigation.usage);
  if (product?.productName) keywordsRaw.push(product.productName);
  if (investigation?.productDescription) keywordsRaw.push(investigation.productDescription);

  // tokenizeして、空白なし日本語でもDBヒットしやすくする
  const keywords = Array.from(new Set(
    keywordsRaw
      .flatMap(k => [k, ...tokenizeForMatch(k)])
      .map(k => String(k || '').trim())
      .filter(k => k.length >= 2)
  ));

  const candidates = searchHSCode(keywords, 5);

  // Geminiで最適なHSコードを判定 + Invoice説明生成
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  
  const prompt = `商品情報と調査結果から、最適なHSコードを選び、Invoice用の英語商品説明を作成してください。

【重要】HSコード分類ルール：
- 完成品の場合は「用途・機能」を優先して分類してください
- 原材料名（ヒノキ、赤杉など）に惑わされないでください
- 例：ヒノキのお香 → 木材(44類)ではなく、室内芳香用調製品(3307.41)

【重要】出力制約（必ず守る）：
- 「HSコード候補」が1件以上ある場合は、原則として候補の中から選んでください。
  - ただし候補が明らかに不適切で、候補外の方が妥当な場合は候補外でも構いません。
  - その場合は confidence を "low" にし、reason に「候補が不適切」などを明記してください。
- HSコードは数字6桁（ドット無し）で出力してください。
- 候補が0件の場合も、LLMの知識に基づいて最も妥当な6桁HSコードを推定してください（confidence は原則 "low"）。
  - どうしても判断不能な場合のみ hsCode を "不明" にしてください。

商品名: ${product.productName}
調査結果: ${investigation.productDescription || '不明'}
材質: ${(investigation.materials || []).join(', ') || '不明'}
用途: ${(investigation.usage || []).join(', ') || '不明'}
カテゴリ: ${investigation.category || '不明'}

HSコード候補:
${candidates.map(c => `- ${c.code}: ${c.description}`).join('\n') || 'なし'}

※候補に適切なものがない場合は、用途に基づいて正しいHSコードを選んでください。

以下のJSON形式で回答してください：
{
  "hsCode": "6桁HSコード",
  "hsDescription": "選んだHSコードの説明",
  "reason": "選定理由（日本語、50文字程度）",
  "invoiceDescription": "Invoice用英語商品説明（30文字程度、通関士が理解できる内容）",
  "confidence": "high/medium/low"
}`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      // HSコードを6桁ドットなしに正規化
      if (parsed.hsCode) {
        parsed.hsCode = normalizeHSCode(parsed.hsCode);
      }
      // 候補ゼロ時のガード（原則は推定させるが、空なら不明にする）
      if (candidates.length === 0) {
        if (!parsed.hsCode || parsed.hsCode === '000000') parsed.hsCode = '不明';
        if (!parsed.confidence) parsed.confidence = 'low';
      }
      return { ...parsed, _debug: { keywords, candidates } };
    }
    return { hsCode: candidates[0]?.code || '不明', error: 'JSON解析失敗', _debug: { keywords, candidates } };
  } catch (e) {
    return { hsCode: candidates[0]?.code || '不明', error: e.message, _debug: { keywords, candidates } };
  }
}

function canonicalizeProductNameForConsistency(name) {
  const tokens = tokenizeForMatch(name);
  const drop = new Set([
    // サイズ/規格
    'xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl', 'll', '3l', '4l', '5l',
    'free', 'onesize', 'one', 'サイズ',
    // よくある色（HSに影響しにくいので統一に使う）
    'black', 'white', 'gray', 'grey', 'red', 'blue', 'green', 'yellow', 'pink', 'beige', 'brown', 'navy',
    'ブラック', 'ホワイト', 'グレー', 'レッド', 'ブルー', 'グリーン', 'イエロー', 'ピンク', 'ベージュ', 'ブラウン', 'ネイビー',
  ]);
  const filtered = tokens.filter(t => {
    if (drop.has(t)) return false;
    // 数量/容量/寸法など（例: 500ml, 2個, 10枚, 30cm）
    if (/^\d+(ml|l|g|kg|cm|mm|m|枚|個|本|袋|パック|set)$/i.test(t)) return false;
    return true;
  });
  return filtered.join(' ');
}

// HSコードを6桁ドットなしに正規化
function normalizeHSCode(code) {
  if (!code) return '不明';
  // ドットを除去し、数字のみ抽出
  const digits = String(code).replace(/[^0-9]/g, '');
  // 6桁に切り詰め（または6桁未満ならそのまま）
  return digits.slice(0, 6).padEnd(6, '0');
}

// 商品調査API (SSE対応)
app.get('/investigate-stream', async (req, res) => {
  const startIndex = parseInt(req.query.startIndex) || 0;
  const count = parseInt(req.query.count) || 5;
  
  // SSEヘッダー設定
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  const products = loadProductMaster();
  if (!products.length) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: '商品マスターが見つかりません' })}\n\n`);
    res.end();
    return;
  }

  const targetProducts = products.slice(startIndex, startIndex + count);
  const results = [];
  const total = targetProducts.length;

  // 同一商品（サイズ/色違い等）でHSコードが揺れないように、リクエスト内で結果を再利用
  const consistencyCache = new Map();

  for (let i = 0; i < targetProducts.length; i++) {
    const product = targetProducts[i];
    
    // 進捗を送信
    res.write(`data: ${JSON.stringify({ type: 'progress', current: i + 1, total, productName: product.productName })}\n\n`);
    
    console.log(`調査中: ${product.productName}`);
    
    const cacheKey = `${normalizeForMatch(product.maker)}::${canonicalizeProductNameForConsistency(product.productName)}`;
    let investigation;
    let hsResult;
    if (consistencyCache.has(cacheKey)) {
      ({ investigation, hsResult } = consistencyCache.get(cacheKey));
      console.log(`  ↳ キャッシュ再利用: ${cacheKey}`);
    } else {
      // 1. ウェブ検索で商品調査
      investigation = await investigateProduct(product);
      // 2. HSコード特定 + Invoice説明生成
      hsResult = await determineHSCode(product, investigation);
      consistencyCache.set(cacheKey, { investigation, hsResult });
    }
    
    const result = {
      index: product.index,
      jan: product.jan,
      productName: product.productName,
      maker: product.maker,
      investigation: investigation,
      webMatchScore: investigation?.webMatchScore ?? null,
      needsReview: investigation?.needsReview ?? false,
      webMatchReason: investigation?.webMatchReason ?? '',
      webHitRisk: investigation?.webHitRisk ?? '',
      webEvidence: investigation?.webEvidence ?? null,
      hsCode: hsResult.hsCode,
      hsDescription: hsResult.hsDescription,
      reason: hsResult.reason,
      invoiceDescription: hsResult.invoiceDescription,
      confidence: hsResult.confidence,
      hsCandidateCount: hsResult?._debug?.candidates?.length ?? null,
      hsCandidateCodes: (hsResult?._debug?.candidates?.map(c => c.code).join(', ') || ''),
      hsKeywordDebug: (hsResult?._debug?.keywords?.slice(0, 25).join(', ') || ''),
      timestamp: new Date().toISOString()
    };
    
    results.push(result);
    console.log(`完了: ${product.productName} -> ${hsResult.hsCode}`);
    
    // 完了した結果を送信
    res.write(`data: ${JSON.stringify({ type: 'result', result })}\n\n`);
  }

  // 結果をDB保存
  const allResults = await loadResults();
  for (const r of results) {
    const existingIndex = allResults.findIndex(x => x.jan === r.jan);
    if (existingIndex >= 0) {
      allResults[existingIndex] = r;
    } else {
      allResults.push(r);
    }
  }
  await saveResults(allResults);

  // 完了を送信
  res.write(`data: ${JSON.stringify({ type: 'complete', count: results.length, results })}\n\n`);
  res.end();
});

// 商品調査API (従来のPOST - 互換性維持)
app.post('/investigate', async (req, res) => {
  const { startIndex = 0, count = 5, filename } = req.body;
  
  const products = loadProductMaster(filename);
  if (!products.length) {
    return res.status(400).json({ error: '商品マスターが見つかりません' });
  }

  const targetProducts = products.slice(startIndex, startIndex + count);
  const results = [];

  const consistencyCache = new Map();

  for (const product of targetProducts) {
    console.log(`調査中: ${product.productName}`);
    
    const cacheKey = `${normalizeForMatch(product.maker)}::${canonicalizeProductNameForConsistency(product.productName)}`;
    let investigation;
    let hsResult;
    if (consistencyCache.has(cacheKey)) {
      ({ investigation, hsResult } = consistencyCache.get(cacheKey));
      console.log(`  ↳ キャッシュ再利用: ${cacheKey}`);
    } else {
      // 1. ウェブ検索で商品調査
      investigation = await investigateProduct(product);
      // 2. HSコード特定 + Invoice説明生成
      hsResult = await determineHSCode(product, investigation);
      consistencyCache.set(cacheKey, { investigation, hsResult });
    }
    
    const result = {
      index: product.index,
      jan: product.jan,
      productName: product.productName,
      maker: product.maker,
      investigation: investigation,
      webMatchScore: investigation?.webMatchScore ?? null,
      needsReview: investigation?.needsReview ?? false,
      webMatchReason: investigation?.webMatchReason ?? '',
      webHitRisk: investigation?.webHitRisk ?? '',
      webEvidence: investigation?.webEvidence ?? null,
      hsCode: hsResult.hsCode,
      hsDescription: hsResult.hsDescription,
      reason: hsResult.reason,
      invoiceDescription: hsResult.invoiceDescription,
      confidence: hsResult.confidence,
      hsCandidateCount: hsResult?._debug?.candidates?.length ?? null,
      hsCandidateCodes: (hsResult?._debug?.candidates?.map(c => c.code).join(', ') || ''),
      hsKeywordDebug: (hsResult?._debug?.keywords?.slice(0, 25).join(', ') || ''),
      timestamp: new Date().toISOString()
    };
    
    results.push(result);
    console.log(`完了: ${product.productName} -> ${hsResult.hsCode}`);
  }

  // 結果をDB保存
  const allResults = await loadResults();
  for (const r of results) {
    const existingIndex = allResults.findIndex(x => x.jan === r.jan);
    if (existingIndex >= 0) {
      allResults[existingIndex] = r;
    } else {
      allResults.push(r);
    }
  }
  await saveResults(allResults);

  res.json({ success: true, count: results.length, results });
});

// 結果取得API
app.get('/results', async (req, res) => {
  res.json(await loadResults());
});

// 結果をExcel出力
app.get('/export', async (req, res) => {
  const results = await loadResults();
  const data = results.map(r => ({
    'JANコード': r.jan,
    '商品名': r.productName,
    'メーカー': r.maker,
    'WebMatchScore': (r.webMatchScore ?? r.investigation?.webMatchScore ?? ''),
    '要確認': ((r.needsReview ?? r.investigation?.needsReview) ? '要確認' : ''),
    'WebMatchReason': (r.webMatchReason ?? r.investigation?.webMatchReason ?? ''),
    'WebHitRisk': (r.webHitRisk ?? r.investigation?.webHitRisk ?? ''),
    'Web参照(上位3)': ((r.investigation?.webSources || []).slice(0, 3).map(s => s.title || s.uri).join(' | ') || ''),
    'Web参照URL(上位3)': ((r.investigation?.webSources || []).slice(0, 3).map(s => s.uri).join(' | ') || ''),
    'Web根拠フラグ': (r.investigation?.webEvidence
      ? `maker:${r.investigation.webEvidence.makerFound ? 'OK' : 'NG'} product:${r.investigation.webEvidence.productFound ? 'OK' : 'NG'} src:${r.investigation.webEvidence.sourcesCount}`
      : ''),
    'HSコード': r.hsCode,
    'HS説明': r.hsDescription,
    '判定理由': r.reason,
    'Invoice説明(EN)': r.invoiceDescription,
    '確信度': r.confidence,
    'HS候補数': (r.hsCandidateCount ?? ''),
    'HS候補(コード)': (r.hsCandidateCodes ?? ''),
    'HS検索KW(先頭25)': (r.hsKeywordDebug ?? ''),
    '調査日時': r.timestamp
  }));
  
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Results');
  
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=hs_results.xlsx');
  res.send(buffer);
});

// ファイルアップロード
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルなし' });
  const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  
  // アップロードされたファイルを追跡
  uploadedFiles.add(name);
  
  // hscodedb.xlsx以外は商品マスターとして設定
  if (name !== 'hscodedb.xlsx') {
    uploadedProductFile = name;
  }
  hsCodeDB = null;
  res.json({ success: true, filename: name, isProductMaster: name !== 'hscodedb.xlsx' });
});

// ファイル一覧
app.get('/files', (req, res) => {
  const files = Array.from(uploadedFiles)
    .filter(f => fs.existsSync(path.join(__dirname, f)))
    .map(f => ({ name: f, size: fs.statSync(path.join(__dirname, f)).size }));
  res.json(files);
});

// ファイル削除
app.delete('/files/:filename', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const filePath = path.join(__dirname, filename);
  
  // セキュリティ: ディレクトリトラバーサル防止
  if (!filePath.startsWith(__dirname)) {
    return res.status(400).json({ error: '不正なファイルパス' });
  }
  
  // hscodedb.xlsx は削除禁止
  if (filename === 'hscodedb.xlsx') {
    return res.status(400).json({ error: 'HSコードDBは削除できません' });
  }
  
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    uploadedFiles.delete(filename);
    
    // 削除したファイルが商品マスターだった場合、クリア
    if (uploadedProductFile === filename) {
      uploadedProductFile = null;
    }
    
    res.json({ success: true, filename });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DB状態チェック
app.get('/db-check', (req, res) => {
  const dbPath = path.join(__dirname, 'hscodedb.xlsx');
  const exists = fs.existsSync(dbPath);
  res.json({ exists });
});

// HSコードDBアップロード
app.post('/upload-db', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルなし' });
  
  const uploadedPath = path.join(__dirname, Buffer.from(req.file.originalname, 'latin1').toString('utf8'));
  const dbPath = path.join(__dirname, 'hscodedb.xlsx');
  
  try {
    // アップロードされたファイルをhscodedb.xlsxにリネーム
    if (uploadedPath !== dbPath) {
      fs.renameSync(uploadedPath, dbPath);
    }
    hsCodeDB = null; // キャッシュクリア
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 商品マスター一覧
app.get('/products', (req, res) => {
  const { filename } = req.query;
  const products = loadProductMaster(filename);
  res.json({ 
    total: products.length, 
    products: products.slice(0, 100),
    filename: uploadedProductFile 
  });
});

// Web UI
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ja" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HSコード自動分類システム</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: {
            sans: ['Inter', 'Hiragino Sans', 'sans-serif'],
          },
          colors: {
            slate: {
              850: '#1e293b', // Custom dark background
            }
          }
        }
      }
    }
  </script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Inter', 'Hiragino Sans', sans-serif; }
    /* Custom Scrollbar */
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: #0f172a; }
    ::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: #475569; }
  </style>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen">

  <!-- Header -->
  <header class="sticky top-0 z-50 bg-slate-900/80 backdrop-blur-md border-b border-slate-700">
    <div class="container mx-auto px-4 h-16 flex items-center justify-between">
      <div class="flex items-center space-x-3">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <h1 class="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-sky-400 to-indigo-400">
          HSコード自動分類システム
        </h1>
      </div>
      <div class="text-sm text-slate-400">v1.0.0</div>
    </div>
  </header>

  <main class="container mx-auto px-4 py-8 space-y-6">
    
    <!-- Top Grid -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      
      <!-- File Management Card -->
      <div class="bg-slate-800 rounded-xl border border-slate-700 p-6 shadow-lg">
        <h2 class="text-lg font-semibold text-slate-200 mb-4 flex items-center">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-2 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          ファイル管理
        </h2>
        
        <div class="space-y-4">
          <!-- DB Status Section -->
          <div class="bg-slate-900/50 rounded-lg p-4 border border-slate-700">
            <div class="flex items-center justify-between">
              <div class="flex items-center">
                <div class="p-2 bg-indigo-500/10 rounded-lg mr-3">
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
                  </svg>
                </div>
                <div>
                  <div class="text-xs text-slate-400 uppercase tracking-wider font-semibold">参照データベース</div>
                  <div class="font-bold text-slate-200">HSコードDB</div>
                </div>
              </div>
              <div id="dbStatusBadge">
                <span class="px-2 py-1 rounded text-xs bg-slate-700 text-slate-400 animate-pulse">確認中...</span>
              </div>
            </div>
            <div class="mt-3 pt-3 border-t border-slate-700 flex items-center justify-between">
              <input type="file" id="dbFileInput" accept=".xlsx" onchange="uploadDBFile(this.files[0])" class="hidden">
              <button onclick="document.getElementById('dbFileInput').click()" class="text-sm bg-slate-700 hover:bg-slate-600 text-slate-300 px-3 py-1.5 rounded transition-colors flex items-center">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                DBを変更
              </button>
              <span id="dbUploadStatus" class="text-xs text-slate-500"></span>
            </div>
          </div>

          <!-- Upload Area -->
          <div class="group relative">
            <input type="file" id="fileInput" accept=".xlsx" onchange="uploadFile(this.files[0])" class="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10">
            <div class="border-2 border-dashed border-slate-600 rounded-lg p-8 text-center transition-all group-hover:border-sky-500 group-hover:bg-slate-700/50">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-10 w-10 mx-auto text-slate-400 mb-3 group-hover:text-sky-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p class="text-slate-300 font-medium">商品マスターExcelをアップロード</p>
              <p class="text-slate-500 text-sm mt-1">ドラッグ＆ドロップ または クリック</p>
            </div>
          </div>

          <!-- File List -->
          <div id="fileList" class="flex flex-wrap gap-2 min-h-[40px]">
            <span class="text-slate-500 text-sm italic">読み込み中...</span>
          </div>

          <!-- Status Message -->
          <div id="uploadStatus" class="hidden rounded-lg p-3 text-sm"></div>
        </div>
      </div>

      <!-- Settings Card -->
      <div class="bg-slate-800 rounded-xl border border-slate-700 p-6 shadow-lg flex flex-col">
        <h2 class="text-lg font-semibold text-slate-200 mb-4 flex items-center">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-2 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          調査設定
        </h2>

        <div class="space-y-6 flex-grow">
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-medium text-slate-400 mb-1">開始位置</label>
              <input type="number" id="startIndex" value="0" min="0" class="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-sky-500 transition-colors">
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-400 mb-1">調査件数</label>
              <input type="number" id="count" value="5" min="1" max="100" class="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-sky-500 transition-colors">
            </div>
          </div>

          <div class="space-y-3 pt-2">
            <button id="startBtn" onclick="startInvestigation()" disabled class="w-full bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-400 hover:to-indigo-500 text-white font-bold py-3 px-4 rounded-lg shadow-lg transform transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              調査開始
            </button>
            <div class="grid grid-cols-2 gap-3">
              <button onclick="loadResults()" class="bg-slate-700 hover:bg-slate-600 text-slate-200 font-medium py-2 px-4 rounded-lg transition-colors flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                結果を更新
              </button>
              <button onclick="exportResults()" class="bg-slate-700 hover:bg-slate-600 text-slate-200 font-medium py-2 px-4 rounded-lg transition-colors flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Excel出力
              </button>
            </div>
          </div>
          
          <div id="progress" class="hidden bg-slate-900/50 rounded-lg p-3 text-sm text-center border border-slate-700 animate-pulse"></div>
        </div>
      </div>
    </div>

    <!-- Results Table Card -->
    <div class="bg-slate-800 rounded-xl border border-slate-700 shadow-lg overflow-hidden">
      <div class="p-6 border-b border-slate-700 flex justify-between items-center">
        <h2 class="text-lg font-semibold text-slate-200 flex items-center">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-2 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          調査結果
        </h2>
        <div id="productInfo" class="text-sm"></div>
      </div>
      
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm text-slate-300">
          <thead class="bg-slate-700/50 text-slate-400 uppercase tracking-wider font-medium">
            <tr>
              <th class="px-6 py-4">商品名</th>
              <th class="px-6 py-4">Web一致度</th>
              <th class="px-6 py-4">HSコード</th>
              <th class="px-6 py-4">Invoice説明(EN)</th>
              <th class="px-6 py-4">確信度</th>
              <th class="px-6 py-4">判定理由</th>
            </tr>
          </thead>
          <tbody id="resultsBody" class="divide-y divide-slate-700">
            <!-- Results will be injected here -->
          </tbody>
        </table>
      </div>
      
      <!-- Empty State -->
      <div id="emptyState" class="p-12 text-center text-slate-500">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12 mx-auto mb-4 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <p>結果が表示されます</p>
      </div>
    </div>

  </main>

  <script>
    let productFile = null;
    
    async function loadFiles() {
      checkDBStatus();
      const res = await fetch('/files');
      const files = await res.json();
      const list = document.getElementById('fileList');
      
      if (files.length) {
        list.innerHTML = files.map(f => 
          \`<div class="bg-slate-700/50 border border-slate-600 rounded px-3 py-1.5 text-sm flex items-center group">
            <span class="mr-2 text-xl">📄</span>
            <span class="truncate max-w-[150px]">\${f.name}</span>
            <button onclick="deleteFile('\${f.name}')" class="ml-2 text-slate-500 hover:text-rose-400 transition-colors" title="削除">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>\`
        ).join('');
      } else {
        list.innerHTML = '<span class="text-slate-500 text-sm italic w-full">ファイルなし</span>';
      }
      
      // 商品数を取得
      const prodRes = await fetch('/products');
      const prodData = await prodRes.json();
      productFile = prodData.filename;
      
      const btn = document.getElementById('startBtn');
      const info = document.getElementById('productInfo');
      
      if (prodData.filename && prodData.total > 0) {
        info.innerHTML = \`<span class="bg-sky-900/30 text-sky-400 px-3 py-1 rounded-full border border-sky-800/50">📦 \${prodData.filename} (\${prodData.total}件)</span>\`;
        btn.disabled = false;
        btn.classList.remove('opacity-50', 'cursor-not-allowed');
      } else {
        info.innerHTML = '<span class="text-rose-400 flex items-center"><svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg> マスター未設定</span>';
        btn.disabled = true;
        btn.classList.add('opacity-50', 'cursor-not-allowed');
      }
    }
    loadFiles();

    async function deleteFile(filename) {
      if (!confirm(\`"\${filename}" を削除しますか？\`)) return;
      try {
        const res = await fetch('/files/' + encodeURIComponent(filename), { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
          loadFiles();
        } else {
          alert('削除失敗: ' + (data.error || '不明なエラー'));
        }
      } catch (e) {
        alert('削除エラー: ' + e.message);
      }
    }

    async function uploadFile(file) {
      if (!file) return;
      const status = document.getElementById('uploadStatus');
      status.style.display = 'block';
      status.className = 'rounded-lg p-3 text-sm bg-sky-900/20 text-sky-400 border border-sky-800/30';
      status.innerHTML = '<div class="flex items-center"><svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-sky-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> アップロード中...</div>';
      
      const formData = new FormData();
      formData.append('file', file);
      
      try {
        const res = await fetch('/upload', { method: 'POST', body: formData });
        const data = await res.json();
        status.className = 'rounded-lg p-3 text-sm bg-emerald-900/20 text-emerald-400 border border-emerald-800/30';
        status.innerHTML = \`<div class="flex items-center"><svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg> \${data.filename} をアップロードしました</div>\`;
        loadFiles();
        setTimeout(() => {
            status.style.display = 'none';
        }, 3000);
      } catch (e) {
        status.className = 'rounded-lg p-3 text-sm bg-rose-900/20 text-rose-400 border border-rose-800/30';
        status.textContent = 'アップロード失敗';
      }
    }

    async function startInvestigation() {
      const startIndex = parseInt(document.getElementById('startIndex').value);
      const count = parseInt(document.getElementById('count').value);
      const btn = document.getElementById('startBtn');
      const progress = document.getElementById('progress');
      
      btn.disabled = true;
      btn.classList.add('opacity-50', 'cursor-not-allowed');
      progress.style.display = 'block';
      
      const results = [];
      
      try {
        const eventSource = new EventSource(\`/investigate-stream?startIndex=\${startIndex}&count=\${count}\`);
        
        eventSource.onmessage = (event) => {
          const data = JSON.parse(event.data);
          
          if (data.type === 'progress') {
            const percent = Math.round((data.current / data.total) * 100);
            progress.innerHTML = \`
              <div class="space-y-2">
                <div class="flex items-center justify-between text-sm">
                  <span class="text-sky-400 flex items-center">
                    <svg class="animate-spin mr-2 h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    調査中: \${data.productName}
                  </span>
                  <span class="text-slate-400">\${data.current}/\${data.total}</span>
                </div>
                <div class="w-full bg-slate-700 rounded-full h-2">
                  <div class="bg-gradient-to-r from-sky-500 to-indigo-500 h-2 rounded-full transition-all duration-300" style="width: \${percent}%"></div>
                </div>
              </div>
            \`;
          } else if (data.type === 'result') {
            results.push(data.result);
            displayResults(results);
          } else if (data.type === 'complete') {
            progress.innerHTML = \`<div class="text-emerald-400 font-medium">✅ 完了: \${data.count}件を調査しました</div>\`;
            eventSource.close();
            btn.disabled = false;
            btn.classList.remove('opacity-50', 'cursor-not-allowed');
          } else if (data.type === 'error') {
            progress.innerHTML = \`<div class="text-rose-400">❌ エラー: \${data.message}</div>\`;
            eventSource.close();
            btn.disabled = false;
            btn.classList.remove('opacity-50', 'cursor-not-allowed');
          }
        };
        
        eventSource.onerror = () => {
          progress.innerHTML = \`<div class="text-rose-400">❌ 接続エラー</div>\`;
          eventSource.close();
          btn.disabled = false;
          btn.classList.remove('opacity-50', 'cursor-not-allowed');
        };
      } catch (e) {
        progress.innerHTML = \`<div class="text-rose-400">❌ エラー: \${e.message}</div>\`;
        btn.disabled = false;
        btn.classList.remove('opacity-50', 'cursor-not-allowed');
      }
    }

    async function loadResults() {
      const res = await fetch('/results');
      const results = await res.json();
      displayResults(results);
    }

    function displayResults(results) {
      const tbody = document.getElementById('resultsBody');
      const emptyState = document.getElementById('emptyState');
      
      if (!results || results.length === 0) {
        tbody.innerHTML = '';
        emptyState.style.display = 'block';
        return;
      }
      
      emptyState.style.display = 'none';
      tbody.innerHTML = results.map(r => {
        const confColor = r.confidence === 'high' ? 'text-emerald-400 bg-emerald-900/30 border-emerald-800/50' : 
                          r.confidence === 'low' ? 'text-rose-400 bg-rose-900/30 border-rose-800/50' : 
                          'text-amber-400 bg-amber-900/30 border-amber-800/50';

        const score = (r.webMatchScore ?? r.investigation?.webMatchScore);
        const needsReview = (r.needsReview ?? r.investigation?.needsReview);
        const matchReason = (r.webMatchReason ?? r.investigation?.webMatchReason ?? '');
        const webHitRisk = (r.webHitRisk ?? r.investigation?.webHitRisk ?? '');
        const webSources = (r.investigation?.webSources || []);
        const webSourcesText = webSources
          .slice(0, 3)
          .map(s => '- ' + String(s.title || s.uri || '').slice(0, 120) + ' (' + String(s.hostname || '').slice(0, 60) + ')')
          .join('\\n');
        const evidence = r.investigation?.webEvidence;
        const evidenceText = evidence
          ? ('maker:' + (evidence.makerFound ? 'OK' : 'NG') + ' product:' + (evidence.productFound ? 'OK' : 'NG') + ' src:' + evidence.sourcesCount)
          : '';
        const riskText = webHitRisk ? ('risk:' + webHitRisk) : '';
        const tooltipParts = [matchReason, evidenceText, riskText, webSourcesText].filter(Boolean);
        const tooltip = needsReview ? tooltipParts.join('\\n') : String(matchReason || '');
        const scoreText = (score === null || score === undefined || score === '') ? '-' : String(score);
        const matchBadge = needsReview
          ? \`<span class="px-2 py-1 rounded-full text-xs border text-rose-400 bg-rose-900/30 border-rose-800/50" title="\${tooltip}">要確認 \${scoreText}</span>\`
          : \`<span class="px-2 py-1 rounded-full text-xs border text-slate-300 bg-slate-900/30 border-slate-700/50" title="\${tooltip}">\${scoreText}</span>\`;
        
        return \`<tr class="hover:bg-slate-700/30 transition-colors">
          <td class="px-6 py-4 font-medium text-slate-200">\${r.productName || ''}</td>
          <td class="px-6 py-4">\${matchBadge}</td>
          <td class="px-6 py-4 text-sky-300 font-mono">\${r.hsCode || '不明'}</td>
          <td class="px-6 py-4 text-slate-400">\${r.invoiceDescription || ''}</td>
          <td class="px-6 py-4">
            <span class="px-2 py-1 rounded-full text-xs border \${confColor}">
              \${r.confidence || '-'}
            </span>
          </td>
          <td class="px-6 py-4 text-slate-400 max-w-xs truncate" title="\${r.reason || ''}">\${r.reason || ''}</td>
        </tr>\`;
      }).join('');
    }

    function exportResults() {
      window.location.href = '/export';
    }

    async function checkDBStatus() {
      try {
        const res = await fetch('/db-check');
        const data = await res.json();
        const badge = document.getElementById('dbStatusBadge');
        if (data.exists) {
          badge.innerHTML = '<span class="px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center"><svg class="w-3 h-3 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg> 登録済み</span>';
        } else {
          badge.innerHTML = '<span class="px-3 py-1 rounded-full text-xs font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20 flex items-center"><svg class="w-3 h-3 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg> 未登録</span>';
        }
      } catch(e) { console.error(e); }
    }

    async function uploadDBFile(file) {
      if (!file) return;
      const status = document.getElementById('dbUploadStatus');
      status.textContent = 'アップロード中...';
      status.className = 'text-xs text-sky-400';
      
      const formData = new FormData();
      formData.append('file', file);
      
      try {
        const res = await fetch('/upload-db', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.success) {
          status.textContent = '更新完了';
          status.className = 'text-xs text-emerald-400';
          checkDBStatus();
        } else {
          status.textContent = data.error || '失敗';
          status.className = 'text-xs text-rose-400';
        }
      } catch (e) {
        status.textContent = 'エラー';
        status.className = 'text-xs text-rose-400';
      }
      setTimeout(() => { status.textContent = ''; }, 3000);
    }
  </script>
</body>
</html>
  `);
});

const PORT = process.env.PORT || 8000;

// サーバ起動（DB初期化後）
(async () => {
  await initDB();
  app.listen(PORT, () => {
    console.log(`
+--------------------------------------------------+
| HSコード自動分類システム                            |
| http://localhost:${PORT}                           |
| DB: ${pool ? 'PostgreSQL' : 'ローカルJSON'}
+--------------------------------------------------+
    `);
  });
})();
