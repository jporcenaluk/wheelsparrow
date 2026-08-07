export interface BuiltAsset {
  kind: "JavaScript" | "stylesheet";
  path: string;
  url: URL;
}

export function extractBuiltAssets(html: string, address: URL): BuiltAsset[];
export function assertAssetResponse(
  asset: BuiltAsset,
  response: Response,
): Promise<void>;
export function productionSmoke(): Promise<void>;
