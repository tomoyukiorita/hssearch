"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deepResearch = void 0;
const adk_1 = require("@google/adk");
const zod_1 = require("zod");
const generative_ai_1 = require("@google/generative-ai");
// Gemini APIを使用した商品調査ツール
exports.deepResearch = new adk_1.FunctionTool({
    name: 'deep_research',
    description: `商品名やメーカー名だけでは不十分な場合に、Gemini APIを使って商品の詳細情報を調査します。
商品の材質、成分、用途、カテゴリなどの情報を取得し、HSコード検索に必要なキーワードを抽出します。
この情報は後のHSコード検索で使用します。`,
    parameters: zod_1.z.object({
        productName: zod_1.z.string().describe('調査する商品名'),
        maker: zod_1.z.string().optional().describe('メーカー名（オプション）'),
        additionalContext: zod_1.z.string().optional().describe('追加のコンテキスト情報'),
    }),
    execute: async ({ productName, maker, additionalContext }) => {
        try {
            const apiKey = process.env['GEMINI_API_KEY'];
            if (!apiKey || apiKey === 'YOUR_API_KEY') {
                return {
                    status: 'error',
                    message: 'GEMINI_API_KEYが設定されていません。.envファイルを確認してください。',
                };
            }
            const genAI = new generative_ai_1.GoogleGenerativeAI(apiKey);
            // Gemini 2.0 Flash with Google Search grounding
            const model = genAI.getGenerativeModel({
                model: 'gemini-2.0-flash',
                generationConfig: {
                    temperature: 0.3,
                },
            });
            const prompt = `以下の商品について調査し、HSコード分類に必要な情報を抽出してください。

商品名: ${productName}
${maker ? `メーカー: ${maker}` : ''}
${additionalContext ? `追加情報: ${additionalContext}` : ''}

以下の項目について日本語で回答してください：
1. 商品カテゴリ（例：香料、宝石、化粧品、食品など）
2. 主な材質・成分（例：天然樹脂、鉱物、プラスチックなど）
3. 主な用途（例：装飾用、工業用、食用など）
4. 商品の形状（例：粉末、液体、固体など）
5. HSコード検索に使えるキーワード（5〜10個）

JSON形式で回答してください：
{
  "category": "商品カテゴリ",
  "materials": ["材質1", "材質2"],
  "usage": ["用途1", "用途2"],
  "form": "形状",
  "keywords": ["キーワード1", "キーワード2", ...],
  "confidence": "high/medium/low",
  "notes": "その他の重要な情報"
}`;
            const result = await model.generateContent(prompt);
            const response = result.response;
            const text = response.text();
            // JSONを抽出
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const parsed = JSON.parse(jsonMatch[0]);
                    return {
                        status: 'success',
                        productName,
                        research: parsed,
                        rawResponse: text,
                    };
                }
                catch {
                    // JSONパースに失敗した場合はテキストをそのまま返す
                    return {
                        status: 'partial',
                        productName,
                        rawResponse: text,
                        message: 'JSON解析に失敗しましたが、テキスト情報は取得できました。',
                    };
                }
            }
            return {
                status: 'success',
                productName,
                rawResponse: text,
            };
        }
        catch (error) {
            return {
                status: 'error',
                message: `調査エラー: ${error instanceof Error ? error.message : 'Unknown error'}`,
            };
        }
    },
});
//# sourceMappingURL=deepResearch.js.map