import { FunctionTool } from '@google/adk';
import { z } from 'zod';
export declare const deepResearch: FunctionTool<z.ZodObject<{
    productName: z.ZodString;
    maker: z.ZodOptional<z.ZodString>;
    additionalContext: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    productName: string;
    maker?: string | undefined;
    additionalContext?: string | undefined;
}, {
    productName: string;
    maker?: string | undefined;
    additionalContext?: string | undefined;
}>>;
//# sourceMappingURL=deepResearch.d.ts.map