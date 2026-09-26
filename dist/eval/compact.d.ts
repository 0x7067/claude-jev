interface Args {
    synth: number;
    seed: number;
    workers: number;
    explain: boolean;
    maxInflight: number;
    decisionModel?: string;
    out?: string;
    projects?: string;
}
export declare function cmdCompact(args: Args): Promise<number>;
export {};
