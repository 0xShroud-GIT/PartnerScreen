export type VideoGeometry = { width: number; height: number; rotation: number };

export function displayedVideoSize(geometry: VideoGeometry): { width: number; height: number } | null {
  const width = Math.round(geometry.width);
  const height = Math.round(geometry.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) return null;
  const rotation = ((Math.round(geometry.rotation) % 360) + 360) % 360;
  const swapped = rotation === 90 || rotation === 270;
  return swapped ? { width: height, height: width } : { width, height };
}
