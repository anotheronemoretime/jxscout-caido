export type Settings = {
    port: number;
    host: string;
    filterInScope: boolean;
    enabled: boolean;
}

export type Response<T> = {
    success: true;
    data: T;
} | {
    success: false;
    error: string;
}