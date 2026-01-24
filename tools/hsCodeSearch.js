"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadProductMaster = exports.searchHSCode = void 0;
const adk_1 = require("@google/adk");
const zod_1 = require("zod");
const XLSX = __importStar(require("xlsx"));
const path = __importStar(require("path"));
// HSコードDBをメモリにキャッシュ
let hsCodeDB = null;
// HSコードDBを読み込む
function loadHSCodeDB() {
    if (hsCodeDB)
        return hsCodeDB;
    const dbPath = path.join(process.cwd(), 'hscodedb.xlsx');
    const workbook = XLSX.readFile(dbPath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet);
    hsCodeDB = data.map(row => ({
        code: String(row['番号'] || ''),
        description_ja: String(row['description_ja'] || ''),
        heading_description_ja: String(row['heading_description_ja'] || ''),
    })).filter(entry => entry.code);
    return hsCodeDB;
}
// キーワードマッチングでHSコードを検索
function searchByKeywords(keywords, limit = 10) {
    const db = loadHSCodeDB();
    const scored = db.map(entry => {
        let score = 0;
        const text = `${entry.description_ja} ${entry.heading_description_ja}`.toLowerCase();
        for (const keyword of keywords) {
            const kw = keyword.toLowerCase();
            if (text.includes(kw)) {
                // 完全一致に近いほど高スコア
                const matches = (text.match(new RegExp(kw, 'g')) || []).length;
                score += matches * keyword.length;
            }
        }
        return { entry, score };
    });
    return scored
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(s => s.entry);
}
// HSコード検索ツール
exports.searchHSCode = new adk_1.FunctionTool({
    name: 'search_hs_code',
    description: `HSコードデータベースから商品に適したHSコードを検索します。
商品名、材質、用途などのキーワードを入力してください。
複数のキーワードを組み合わせると精度が上がります。`,
    parameters: zod_1.z.object({
        keywords: zod_1.z.array(zod_1.z.string()).describe('検索キーワードのリスト（商品名、材質、用途など）'),
        limit: zod_1.z.number().optional().describe('返す結果の最大数（デフォルト: 10）'),
    }),
    execute: ({ keywords, limit = 10 }) => {
        try {
            const results = searchByKeywords(keywords, limit);
            if (results.length === 0) {
                return {
                    status: 'no_results',
                    message: '該当するHSコードが見つかりませんでした。キーワードを変えて再検索してください。',
                    suggestions: [
                        '商品の材質（プラスチック、金属、木材など）を追加してみてください',
                        '商品の用途（装飾用、工業用など）を追加してみてください',
                        '商品カテゴリ（香料、宝石、化粧品など）で検索してみてください',
                    ],
                };
            }
            return {
                status: 'success',
                count: results.length,
                results: results.map(r => ({
                    hs_code: r.code,
                    description: r.description_ja,
                    details: r.heading_description_ja?.slice(0, 500) || '',
                })),
            };
        }
        catch (error) {
            return {
                status: 'error',
                message: `検索エラー: ${error instanceof Error ? error.message : 'Unknown error'}`,
            };
        }
    },
});
// 商品マスターExcelを読み込むツール
exports.loadProductMaster = new adk_1.FunctionTool({
    name: 'load_product_master',
    description: '商品マスターのExcelファイルを読み込み、商品リストを取得します。',
    parameters: zod_1.z.object({
        filePath: zod_1.z.string().optional().describe('Excelファイルのパス（デフォルト: 商品マスター.xlsx）'),
        startRow: zod_1.z.number().optional().describe('開始行（0から、デフォルト: 0）'),
        maxRows: zod_1.z.number().optional().describe('最大行数（デフォルト: 10）'),
    }),
    execute: ({ filePath = '商品マスター.xlsx', startRow = 0, maxRows = 10 }) => {
        try {
            const fullPath = path.join(process.cwd(), filePath);
            const workbook = XLSX.readFile(fullPath);
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const data = XLSX.utils.sheet_to_json(sheet);
            const products = data.slice(startRow, startRow + maxRows).map((row, idx) => ({
                index: startRow + idx,
                jan: String(row['JAN'] || ''),
                productName: String(row['商品名'] || ''),
                maker: String(row['メーカー名'] || ''),
            }));
            return {
                status: 'success',
                totalRows: data.length,
                returnedRows: products.length,
                products,
            };
        }
        catch (error) {
            return {
                status: 'error',
                message: `読み込みエラー: ${error instanceof Error ? error.message : 'Unknown error'}`,
            };
        }
    },
});
//# sourceMappingURL=hsCodeSearch.js.map