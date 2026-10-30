export type Region = { id: string; name: string; geolocation?: { latitude: number; longitude: number; radiusKm: number; source: string } | null };
export function regionLabel(project: { yandexRegionId: string; regionName?: string | null }): string;
export function resolveRegion(value: string): Region | null;
export function searchRegions(value: string, limit?: number): Region[];
