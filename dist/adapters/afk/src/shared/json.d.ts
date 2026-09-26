export type JsonValue = string | number | boolean | null | JsonValue[] | {
    [key: string]: JsonValue;
};
export type Json = {
    [key: string]: JsonValue;
};
export declare function isJsonObject(value: unknown): value is Json;
export declare function isJsonArray(value: unknown): value is unknown[];
export declare function isString(value: unknown): value is string;
export declare function isNumber(value: unknown): value is number;
export declare function parseJsonObject(text: string): Json | null;
export declare function parseJsonArray(text: string): unknown[] | null;
