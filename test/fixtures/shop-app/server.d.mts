export interface ShopApp {
  port: number;
  url: string;
  setBug(on: boolean): void;
  close(): Promise<void>;
}

export const DEMO_EMAIL: string;
export const DEMO_PASSWORD: string;
export function startShopApp(options?: { port?: number; bug?: boolean }): Promise<ShopApp>;
