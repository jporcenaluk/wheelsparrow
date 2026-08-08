export interface BuiltAsset {
  kind: "JavaScript" | "stylesheet";
  path: string;
  url: URL;
}

export interface SchemaMigrationLedgerEntry {
  id: number;
  name: string;
  checksum: string;
}

export function extractBuiltAssets(html: string, address: URL): BuiltAsset[];
export function assertAssetResponse(
  asset: BuiltAsset,
  response: Response,
): Promise<void>;
export function resolveBuiltMain(bundleRoot?: string): string;
export function resolveFixturePrefix(temporaryDirectory?: string): string;
export function assertSafeFixturePath(
  temporaryDirectory: string,
  fixture: string,
): void;
export function assertCanonicalSchemaLedger(
  entries: SchemaMigrationLedgerEntry[],
  tables: string[],
  checksum: string,
): void;
export function productionSmoke(): Promise<void>;
