import { FunctionTool } from '@google/adk';
import { z } from 'zod';
export declare const searchHSCode: FunctionTool<z.ZodObject<{
    keywords: z.ZodArray<z.ZodString, "many">;
    limit: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    keywords: string[];
    limit?: number | undefined;
}, {
    keywords: string[];
    limit?: number | undefined;
}>>;
export declare const loadProductMaster: FunctionTool<z.ZodObject<{
    filePath: z.ZodOptional<z.ZodString>;
    startRow: z.ZodOptional<z.ZodNumber>;
    maxRows: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    filePath?: string | undefined;
    startRow?: number | undefined;
    maxRows?: number | undefined;
}, {
    filePath?: string | undefined;
    startRow?: number | undefined;
    maxRows?: number | undefined;
}>>;
//# sourceMappingURL=hsCodeSearch.d.ts.map